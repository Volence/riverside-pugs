# Fleet view (sub-project 2a of the balance catalogue roadmap)

Date: 2026-09-24. Status: design approved in brainstorming; spec awaiting owner
review.

Builds on `2026-09-24-balance-catalogue-and-triage-design.md` ("Release pipeline
(direction for sub-project 2)"). Sub-project 2 is split in two:

- **2a, this spec: the fleet view.** Read-only. The site reads the files on every
  game server and shows, per file, what each box has against the deploy repo and
  the Rotoblin-AZMod base install.
- **2b, later spec: stage and deploy.** Releases from a deploy repo commit,
  review, balance decision, canary and deploy. It reuses 2a's box readings and
  reference manifests.

## Why

Today nobody can see what is actually on the four boxes. Changes arrive by
`deploy.sh` (rsync without delete, so stale files stay), `nfo/ftpsync.py`
(Chicago), the Riverside env and hand copies. The balance fingerprint only sees
what the plugin reports at go-live and deliberately hides versionless and ignored
plugins. Known today: Dallas runs a different pug-match build (81639 bytes)
from Chicago and Riverside #3 (81241), and Riverside #4 has never reported a
balance inventory at all.

## Decisions (owner, 2026-09-24)

- Fleet view first, read-only; deploy gets its own spec afterwards.
- Compare boxes **against each other and against references** (option C).
- Read boxes **on demand and automatically once a day** while idle.
- Rows cover **the full managed tree**, with **two references**: the deploy
  repo's `overrides/` at a commit, and the Rotoblin-AZMod **v8.6.4** release ZIP
  the boxes were installed from.
- The site reads boxes over the **existing transports** (local, FTP, sftp).
  Nothing is installed on the boxes.

## The boxes

From the `servers` table:

| id | name | transport | game dir (from `addons_dir`) |
|----|------|-----------|------------------------------|
| 1 | Dallas | local (the site's own box) | `/home/l4d/l4d1-server` |
| 2 | Chicago | FTP (NFO, rented) | `/` (FTP root) |
| 3 | Riverside #3 | sftp | `/home/l4d/l4d1-a` |
| 4 | Riverside #4 | sftp | `/home/l4d/l4d1-b` |

Riverside #3 and #4 are one machine with two separate game dirs, so they are
two columns, read one after the other.

## What is read

The game dir is `addons_dir` minus `/left4dead/addons`. Under it, the
**managed roots** are:

- `left4dead/addons` (SourceMod: plugins including `plugins/disabled`,
  configs, data, gamedata, extensions, translations; metamod; stripper)
- `left4dead/cfg`
- `left4dead_dlc4/missions`

**Skipped:** `addons/sourcemod/logs`, any `logs/` dir, `*.log`, `*.dem`,
replay files (`*.rip` and the replay dir), `*.sq3` / `*.sqlite` / `*.db`, and
campaign `*.vpk` files in `addons/` (the campaign installer manages those). No
symlink is followed. Files over **20 MB** get their size recorded but are not
hashed (hash shown as "too large").

Each file is recorded as `path` (relative to the game dir, `/`-separated),
`size`, and `sha256` (hex, stored in full, shown as the first 8 characters).
**Only hashes are stored, never contents**, so `secrets.cfg` on a box is a row
with a hash and its password never reaches the database.

### Transport additions

`AddonsTransport` today puts, sizes, removes and reads single files by plain
name in one directory. The fleet reader needs a tree walk. A separate
interface, built from the same `servers` row fields as `transportFor`:

```ts
interface TreeReader {
  /** Every regular file under `root` (relative to the game dir), recursively,
   *  with its size; symlinks are not followed and are not listed. */
  list(root: string): Promise<{ path: string; size: number }[]>;
  /** sha256 of each path, in one round trip where the transport allows it. */
  hash(paths: string[]): Promise<Map<string, string>>;
}
```

- **local:** `fs` walk and a streamed hash.
- **sftp:** one `ssh` running `find <roots> -type f -printf '%s %P\n'` and one
  running `sha256sum` over the paths (batched), so nothing is downloaded.
- **FTP:** recursive `LIST` (MLSD where supported), then each file is
  downloaded into memory and hashed. This is the slow one; about 150 repo files
  plus the base tree is tens of MB, once a day.

Paths are checked against the managed roots before any call: no `..`, no
absolute paths, nothing outside a root.

## References

`tools/push-manifest` (in the **deploy repo**, run on the owner's machine):

1. Refuses when `overrides/` has uncommitted changes or untracked files.
2. **Repo manifest:** every tracked file under `overrides/`, mapped to game dir
   paths (`overrides/left4dead/...` to `left4dead/...`,
   `overrides/left4dead_dlc4/...` to `left4dead_dlc4/...`), with size and
   sha256, plus the commit id and commit time. Git-ignored files
   (`secrets.cfg`) are never included; the script reads `git ls-files`, not the
   directory.
3. **Base manifest:** downloads `l4d1_Roto-AZMod.zip` for v8.6.4 (the URL in
   `install-server.sh`, cached locally after the first run) and lists the two
   layers `install-server.sh` copies, in order: `Files Here/Linux Server
   Files/left4dead/` then `Files Here/Roto-AZMod Main files/left4dead/` (a file
   in both takes the second). Mapped to `left4dead/...`. Drops the 64-bit
   binaries `install-server.sh` removes.
4. Writes `repo.json` and `base.json` over ssh into the site's data dir on Dallas
   (`/home/pug/app/data/fleet/`), atomically (write then rename), owned by `pug`.

The site reads those two files when the page loads. There is no upload endpoint
and no new token. A missing or unreadable file shows as "no repo manifest yet".

Manifest format:

```json
{ "kind": "repo", "label": "57add2c", "at": "2026-09-24T14:00:00Z",
  "files": { "left4dead/cfg/pug_match.cfg": { "size": 1234, "sha256": "..." } } }
```

## Storage

Latest reading per box only; history arrives with releases in 2b.

```sql
CREATE TABLE fleet_readings (
  server_id   INTEGER PRIMARY KEY,
  read_at     TEXT,          -- last successful read
  attempt_at  TEXT NOT NULL, -- last attempt
  error       TEXT           -- last attempt's error, NULL when it succeeded
);
CREATE TABLE fleet_files (
  server_id INTEGER NOT NULL,
  path      TEXT NOT NULL,
  size      INTEGER NOT NULL,
  sha256    TEXT,            -- NULL when over the size cap
  PRIMARY KEY (server_id, path)
);
```

A successful read replaces the box's `fleet_files` rows in one transaction. A
failed read leaves them and records `attempt_at` and `error`.

## Reading a box

- `FleetReader.read(serverId)`: refuses unless the box is enabled and its
  `status` is `idle` or `offline` (a reserved or live box: "busy, try after the
  match"). Rechecks status right before hashing. Walks the managed roots, applies
  the skip rules, hashes, stores.
- **One box at a time**, queued like the balance writer (a second request for
  a box already queued joins it).
- **Time limits:** local 1 min, sftp 3 min, FTP 10 min. A time-out is a failed
  read.
- **Per-box isolation:** one box failing never stops or changes another.
- **Daily:** a timer (hourly tick) reads any enabled, idle box whose `read_at`
  is over 24 h old. Not in dev mode.
- **On demand:** "Check now" per box and "Check all" (queues every enabled box).

## Comparison

For each path in the union of repo, base and every box's files:

- **Reference** = the repo's entry if the repo has the path, else the base's
  entry if the base has it, else none.
- **With a reference:** a box cell is **highlighted** when its hash differs
  from the reference or the file is missing, except that when all boxes agree
  with each other and differ only from the base (not the repo), the row reads
  "base, patched on all boxes" and nothing is highlighted (`install-server.sh`
  appends `exec local.cfg` hooks and edits the boot config after install).
- **Without a reference:** the boxes in the minority are highlighted (with a
  tie, every box). A file on some boxes and not others: the "missing" cells are
  highlighted.
- Each box cell carries a label: `repo`, `base`, `neither` or `missing`. A cell
  compared by size only (over the cap) says so.
- A box never read shows "not read yet" and takes no part in the majority.
- Nothing is hidden: versionless plugins (pug-match) and ignored plugins
  (tvwatch, spec_stays) show like any other file.

Computed in `src/fleetCompare.ts` as a pure function of the two manifests and
the stored readings.

## Page: Admin > Setup > Fleet

- **Header:** "Repo: 57add2c, pushed 2 h ago · Base: Rotoblin-AZMod v8.6.4".
  One chip per box: name, "read 3 h ago" or "never read", the last error if the
  last attempt failed ("last read failed: FTP timeout; read 1 d ago"), and
  **Check now** (disabled while busy or queued). A **Check all** button.
- **Summary line:** "3 differences: pug-match.smx (Dallas), ...", so the answer
  is visible without scrolling.
- **Filters:** "Differences only" (on by default); area: Plugins, Configs (cfg),
  Data, Gamedata, Extensions, Stripper, Everything else.
- **Table:** rows grouped by area, one per path; columns Repo, Base, then each
  box. A cell shows size and short hash ("81639 · f7ee35c3") and its label;
  highlighted cells use the existing admin warning style. Scrolls sideways inside
  its panel on narrow screens.
- The Patches tab's Server drift panel stays: it is the balance view; this is
  the file view.

## API (admin only)

- `GET /api/admin/fleet` returns the references' labels and times, each box's
  reading state, and the compared rows.
- `POST /api/admin/fleet/check` with body `{ serverId }` or `{ all: true }`
  queues reads and answers at once with each box's state (`queued`, `busy`,
  `disabled`, `no transport`). Audited (`fleet_check`).

## Testing

- **Tree readers:** local against a temp dir (skip rules, symlinks not
  followed, size cap); sftp and FTP against the existing test doubles
  (command lines, parsing `find` and `sha256sum` output, recursive LIST).
- **FleetReader:** fake reader; busy box refused; recheck before hashing;
  time-out keeps the old reading and records the error; one box failing leaves
  the others alone; queue joins duplicates; the daily tick picks only stale,
  idle, enabled boxes.
- **Comparison:** repo beats base; base patched on all boxes not highlighted;
  majority without a reference; ties; missing; over the cap; never read.
- **push-manifest:** refuses a dirty tree; never includes git-ignored files;
  path mapping; base layering (second layer wins) and the dropped 64-bit
  binaries; atomic write.
- **Routes:** admin only; busy box answered `busy`; audit row.
- **Page:** render tests for the chips, the summary, filters and highlighting.
- **Before ship (owner):** run `push-manifest`, then Check all against the real
  boxes (read-only). Expected: Dallas's pug-match build differs; Riverside #4
  gets its first reading.

## Out of scope (2b and later)

- Staging, diffing and deploying releases; "bring this box up to the current
  release"; per-file "shipped by release N".
- History of readings.
- **Future topic:** more game servers per machine, possibly sharing the
  read-only game content (the `.vpk` files, `bin/`, `hl2/`) by bind mount while
  each instance keeps its own `left4dead/addons` and `left4dead/cfg`. The fleet
  view already treats each instance as its own box, so it works either way.
