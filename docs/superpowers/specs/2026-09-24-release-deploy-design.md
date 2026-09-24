# Releases: stage and deploy (sub-project 2b of the balance catalogue roadmap)

Date: 2026-09-24. Status: design approved in brainstorming; spec awaiting owner
review.

Builds on the fleet view (`2026-09-24-fleet-view-design.md`, sub-project 2a) and
the direction in `2026-09-24-balance-catalogue-and-triage-design.md` ("Release
pipeline"). The site becomes the one door to the game servers: changes are
committed to the deploy repo, reviewed on the site against what each box has, and
deployed from the site with backups, an optional canary and per-box undo.

## Decisions (owner, 2026-09-24)

1. **The site pulls from GitHub.** A read-only deploy key for
   `Volence/l4d-deploy`; a release is a commit that exists on GitHub. No upload
   script.
2. **The review shows the commit against what is live on each box** (the fleet
   readings), and has a **target picker, default all enabled boxes**.
3. **Per-box layers in the repo:** `overrides/` is shared; `boxes/<box>/` holds
   each box's own files and wins over the shared copy. Seeded once from today's
   live per-box files.
4. **Deletions:** a deploy removes a file only if the repo (shared or that box's
   layer) shipped it before and no longer does. Backed up first; listed in the
   review. Files the repo never shipped are never touched.
5. **Rollout:** all target boxes as each becomes free, with an optional
   **"canary first"** per release (off by default).
6. **Balance link:** every deploy asks balance (name, notes) / not balance /
   decide later, with a suggestion from the diff, never decided automatically.
7. **Undo** restores that deploy's backups per box (or all). Deploying an older
   commit is also always possible.
8. **The private anti-cheat repo is ignored for now.** Its files are never
   touched by a deploy (rule 4) and show in the fleet view as "neither".
   Releases are built from a list of **sources** so it can be added later as a
   second, names-only source (see "Next: 2c").

## Repo layout (deploy repo)

```
overrides/left4dead/...          shared, every box
overrides/left4dead_dlc4/...     shared, every box
boxes/dallas/left4dead/...       Dallas only (wins over overrides/)
boxes/chicago/left4dead/...
boxes/riverside-3/left4dead/...
boxes/riverside-4/left4dead/...
```

- Box slugs map to `servers` rows through a new column `servers.deploy_slug`
  (`dallas`, `chicago`, `riverside-3`, `riverside-4`), set once by hand.
- **Seeding commit** (done during 2b, not by the site): copy each box's live
  `left4dead/cfg/local.cfg`, `left4dead/cfg/server.cfg` and
  `left4dead/addons/sourcemod/configs/hostname/server_hostname.txt` into its
  `boxes/<slug>/` folder, and remove the shared `overrides/left4dead/cfg/local.cfg`
  (Dallas's copy moves to `boxes/dallas/`). After seeding, the fleet view's
  per-box files compare against the box layer instead of being exempt.
- Riverside #3 and #4 share `left4dead_dlc4` through
  `/home/l4d/shared/left4dead_dlc4` (a symlink). A file there is written once;
  the second box's write of the same bytes is a no-op, and its backup/verify must
  tolerate that (see "Per-box deploy").

## The site's copy of the repo

- A bare clone at `<dataDir>/deploy-repo.git`, fetched with a read-only deploy key
  (`DEPLOY_REPO_URL`, `DEPLOY_REPO_KEY` in the site's env; the key file lives on
  Dallas, readable by `pug` only).
- **Fetch** when the Deploy page opens (at most once a minute) and on "Refresh".
- The page lists the latest 30 commits on `master`: short hash, subject, author,
  time, and whether a release already exists for it.
- The fleet view's **repo reference** comes from this clone (the commit the
  latest release deployed, or `master` when none has). `push-manifest` is only
  needed for the base manifest.

## Sources

A release records its sources:

```ts
interface ReleaseSource {
  id: 'deploy';                  // 'anticheat' later
  repo: string;                  // Volence/l4d-deploy
  commit: string;                // full hash
  layers: 'overrides+boxes';     // how paths map to a box
  visibility: 'full' | 'names';  // 'names': never show contents or line diffs
}
```

One source in 2b. The staging code resolves a box's file list by applying each
source's layers in order; a later source wins over an earlier one for the same
path.

## Staging

Picking a commit stages a release (state `staged`). For each enabled box with a
`deploy_slug`, the site computes the **wanted** file list: every file under
`overrides/` mapped to game-dir paths, then `boxes/<slug>/`, with size and sha256.

**Refused at staging** (the release is `invalid` and cannot deploy, with the
reasons listed):

- any path outside the managed roots or failing `isManaged` (fleet view rules)
- `secrets.cfg` anywhere
- symlinks, `..` segments, files over 20 MB

**Per box, against its latest fleet reading:**

- **add:** wanted, not on the box
- **update:** wanted, on the box with a different hash
- **delete:** on the box, shipped by the box's previous release (or, before any
  release, present in the repo's previous commit's wanted list for that box),
  and not wanted now
- **unchanged:** everything else (not shown)

## Review screen (Admin > Setup > Deploy)

- **Commit:** subject, author, time, link to the GitHub diff.
- **Per box** (boxes with identical changes are grouped): added / updated /
  deleted files in plain words ("plugin updated: l4d_skypounce", "cfg changed:
  local.cfg (Chicago only)", "plugin removed: specrates"). For `.cfg` files,
  changed cvar lines as values ("z_tank_health 8000 → 7500"). The old text comes
  from the clone: the file as the box's previous release shipped it, used only
  when the box's hash still equals it. Otherwise (hand-edited, or never shipped)
  the line reads "changed on the box since; line diff unavailable". Only hashes
  are read from the box at review time.
- **Warnings:**
  - a box's latest reading is over 24 h old ("check it now first", with the
    fleet view's Check now)
  - a box drifted: a file this release will update or delete differs from
    what the previous release shipped (a hand edit; it will be backed up)
  - a box has no transport or is disabled
- **Choices:**
  - target boxes (checkboxes, default all enabled boxes with a slug)
  - canary first (off), and which box (default Dallas)
  - balance: **balance patch** (name required, notes) / **not balance** /
    **decide later**. A suggestion is shown: "not balance" when every change
    is a plugin outside knobs.json's watched plugins and no watched cvar line
    changed, else "possibly balance"; never preselected.
- **Deploy** (audited `release_deploy`).

## Per-box deploy

States: `pending` → `waiting` (for idle) → `writing` → `written` → `restarted` →
`confirmed`, or `failed`, `skipped` (not targeted), `undone`.

For each target box, one box at a time, canary first when chosen:

1. **Wait** until the box is enabled and `idle` (or `offline`). A box that is
   `reserved`/`live` waits; the release path runs it after the match, as the
   balance writer does.
2. **Hold:** set the box `reserved` (the matchmaker cannot claim it) for the
   duration, restoring its previous status afterwards.
3. **Backup:** read every file to be updated or deleted into
   `<dataDir>/releases/<releaseId>/<serverId>/<path>`, with a manifest of what
   existed. A file that no longer exists on the box is recorded as absent.
4. **Write:** each add/update written to `<path>.part` then renamed into place
   (local, sftp and FTP; FTP falls back to delete-then-rename as
   `ftpTransport.put` does). Then deletions.
5. **Verify:** hash every add/update path and check every deletion is gone. A
   path under a directory shared with another box that already has the wanted
   hash counts as verified.
6. **Restart** when the box is empty (rcon `restarter.restart`), then release the
   hold. `restarted` → `confirmed` when the box's first match reports a
   fingerprint (balance link below).

**Any failure in 3 to 5:** write the backups back, verify them, mark the box
`failed` with the error, release the hold, **do not restart**. Other boxes
continue. A failed **canary** stops the release: the remaining boxes become
`skipped` and the admin sees "Canary failed: …".

**After a successful canary**, the release waits for "Continue to the rest"
(audited `release_continue`).

**One release in flight at a time:** staging is always allowed; deploying while
another release has boxes in `pending`/`waiting`/`writing` is refused.

**Transport additions** (`fleetTree.ts` or a sibling `fleetWrite.ts`):
`readBytes(path)`, `writeAtomic(path, bytes)`, `remove(path)`, `mkdirp(dir)`
for local, sftp (ssh `cat > .part && mv`, `rm`, `mkdir -p`) and FTP
(`uploadFrom` stream to `.part`, `rename`, `remove`, `ensureDir`), all guarded
by `isManaged` on the path and forbidden for `secrets.cfg`.

## Undo

- Per box, or all boxes the release reached. Restores exactly the backed-up files
  (recreating ones that were deleted), removes files the release added, verifies,
  restarts when empty. Same wait/hold rules as a deploy. Recorded as its own
  history entry (`undo of release N`), audited `release_undo`.
- Backups are kept **30 days** after a release; then removed by a daily sweep,
  and the undo button shows "backups expired".

## Balance link

- The release row stores `balance_decision` (`balance` | `not_balance` | `later`),
  `balance_name`, `balance_notes`.
- When a box written by the release reports its **first new fingerprint**
  afterwards (a sighting whose patch is new, or whose patch differs from the
  box's previous one), the patch is tagged `release_id`, and:
  - `balance`: the patch gets the name/notes and triage `balance` (announced
    before any box ran it: the release row appears on the Patches tab as
    "announced by release N" from deploy time).
  - `not_balance`: the patch is folded into the patch the box was on before
    (triage `fold`), audited as by release N.
  - `later`: the patch stays `pending`; its triage card says "from release N".
- Later boxes reporting the same fingerprint land on the same patch as usual.
- A deploy that changes nothing the fingerprint sees produces no new patch; the
  decision is then unused.

## History and fleet view

- **History** (on the Deploy page): every release and undo: commit, admin, time,
  targets, per-box state, balance decision, undo buttons.
- **Fleet view:** each cell names its origin: "shipped by release 12" when the
  box's hash equals what release 12 wrote there, "not from any release" for
  files no release shipped.
- **Admin feed** (Discord): one line per state change worth hearing about:
  deployed, canary waiting, failed (with error), undone.

## Storage

```sql
CREATE TABLE releases (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('deploy','undo')),
  undo_of INTEGER REFERENCES releases(id),
  sources_json TEXT NOT NULL,      -- ReleaseSource[]
  state TEXT NOT NULL CHECK (state IN ('staged','invalid','deploying','canary_wait','done','halted')),
  invalid_json TEXT,               -- reasons when invalid
  canary_server_id INTEGER,
  balance_decision TEXT CHECK (balance_decision IN ('balance','not_balance','later')),
  balance_name TEXT, balance_notes TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  deployed_by TEXT, deployed_at TEXT,
  backups_expired INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE release_boxes (
  release_id INTEGER NOT NULL REFERENCES releases(id),
  server_id INTEGER NOT NULL,
  state TEXT NOT NULL,             -- per-box states above
  error TEXT,
  plan_json TEXT NOT NULL,         -- adds/updates/deletes with wanted size+hash
  updated_at TEXT NOT NULL,
  PRIMARY KEY (release_id, server_id)
);
-- balance_patches gains release_id INTEGER REFERENCES releases(id)
-- servers gains deploy_slug TEXT UNIQUE
```

## Safety

- Writes only inside the managed roots, never `secrets.cfg`, never a path that
  fails `isManaged`, never a symlink.
- **Dev mode refuses every deploy and undo** (the local dev database is a copy of
  production with real server rows).
- The deploy key is read-only; nothing the site does can change the repo.
- Everything audited; the Discord admin feed hears about every deploy.

## The old deploy scripts

When 2b is live:

- `deploy.sh` and `nfo/ftpsync.py` print "Deploy from the site (Admin > Setup >
  Deploy): this bypasses review, backups and undo" and exit unless given
  `--bypass-site`.
- The deploy repo's README and agent instructions say: push commits, never
  deploy to live servers.
- Anything that still bypasses the site is caught by triage (config changes) and
  the fleet view (file drift).

## Testing

- **Staging:** layers (box wins), refusals (`secrets.cfg`, symlink, `..`, outside
  roots, over 20 MB), add/update/delete per box, deletions only of previously
  shipped files, cvar-line diff wording, grouping of identical boxes, warnings.
- **Per-box deploy** against fake transports: the happy path; a failure at
  backup, write and verify each restores and marks failed without restart;
  canary failure halts; continue after canary; one release in flight; busy box
  waits and runs after the match; hold and status restore; shared dlc4 path.
- **Undo:** exact restore including deleted and added files; expired backups
  refused.
- **Balance link:** balance names the new patch; not balance folds it; later
  leaves it pending with "from release N"; no new fingerprint leaves no patch.
- **Git:** fetch and commit listing against a local bare repo fixture; staging
  reads the tree at a commit (not the working tree).
- **Routes:** admin only; audited; dev mode refuses deploy and undo.
- **Page:** commit list, review per box, target picker, canary, balance choice,
  per-box states, history and undo.
- **Before live:** (1) the seeding commit, then stage it and check the review
  shows no changes for any box; (2) a one-line comment change deployed to Dallas
  only, verified in the fleet view, then undone.

## Next: 2c, the private anti-cheat source

Its files change very often and are copied to the boxes by hand today. As a
second source: a second read-only deploy key, `visibility: 'names'` (the review
shows "file changed: <name>" only; no contents, no line diffs, no GitHub link
beyond admins), layered after the deploy repo. Its own short spec when needed.
