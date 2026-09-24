# Finished replays move to R2; nothing changes for viewers

Status: design approved by the owner in conversation 2026-09-23. Not built.

## Why

On 2026-09-23 the Dallas disk dropped under `replay_free_floor_gb` (10 GB free; the disk had
9.5 GB). The replay pruner's floor rule takes the oldest replays until the floor would be
cleared, but all replays together are about 0.5 GB, so the floor can never be reached and every
pass deletes more. It runs on a timer and on every pug-web start. 559 replays went that day
(matches 14 to 91, every file), well inside the 90-day retention. Replays were the only source
from which missed stats could be recovered: 38 quads were backfilled from replays and a
transcript the same day, and the quads of matches 44 to 91 are gone for good.

Demos already solved this: `src/demoOffload.ts` uploads a finished match's demos to the R2
bucket and records the key. Replays get the same treatment.

## The one hard rule

**Nothing changes for anyone using the site.** Same routes, same query parameters, same
response bodies and headers, same live behaviour. The viewer is not touched. The only
difference is where Dallas reads a finished replay's bytes from.

## Pieces

### 1. One-time side stamp (script)

Format 3 replays carry an infected-side mask in header bytes 156/157. Older files do not, and
the replay route writes the mask into the header on the wire from the database (roster team plus
the round's survivor side, `infectedMaskFor`). A script writes it into the files themselves, once:

- `scripts/stamp-replay-sides.ts <dir> [--commit]`: for every `match_replays` row whose file is
  in `<dir>` and whose header has no mask, compute the mask the same way the route does and write
  bytes 156/157 in place. Dry run by default. Touches nothing else in the file.
- Run on Dallas's replay directory and on the local backups.
- The on-the-wire stamp in the route stays, as a fallback for any file the script could not
  resolve, so behaviour cannot change.

### 2. Upload after the match (hourly sweep)

`src/replayOffload.ts`, shaped like `demoOffload.ts`, with the R2 operations injected for tests.
A replay is eligible when all of these hold:

- its match is `completed` or `aborted`;
- its row has no `r2_key`;
- its local file is closed (header frame count not zero) and has not changed for 10 minutes.
  Replays from Chicago and Riverside reach Dallas through pull timers 2 to 5 minutes after a round
  ends; the quiet period keeps a half-arrived copy from being uploaded.

For each: copy the file to a temp file with the session token bytes zeroed (and the side mask
stamped if still missing), upload, HEAD to confirm the size, then record `r2_key` and `r2_at` on
the row. Any failure leaves the row untouched and the local file where it is. The sweep does not
delete local files; the pruner does (section 4).

**Object key:** `replays/<matchId>/<ordinal>_<half>.rpl`. Replay filenames contain the match
token, which seeds that match's server password, so the key must not be derived from the
filename. The bucket is public by URL, so the uploaded bytes must not contain the token either.

The sweep runs on the existing hourly demo-offload timer, only when R2 is configured.

New columns on `match_replays`: `r2_key TEXT`, `r2_at TEXT` (via `ensureColumn`, like
`match_demos`).

### 3. Viewing

`GET /api/replays/match/:id/:ordinal/:half` resolves in this order:

1. the local file, exactly as today (including the live directory and the live-round logic);
2. otherwise, if the row has an `r2_key`, a ranged GET from R2 for the bytes from `since` to
   the end, sent through the same slice code path: same `X-Replay-Next` (the object size),
   `X-Replay-Closed: 1`, `Cache-Control: no-store`, token blanking and side stamping;
3. otherwise 404, as today for a pruned replay.

An R2 error is answered like a missing file. The live routes never read R2. `r2.ts` gains a
signed ranged `get`. The by-name route (`/api/replays/file/:name`, standalone sessions with no
row) is unchanged.

### 4. Pruning (the actual fix)

`replayPrune.ts`: when R2 is configured, both selection rules (retention window and free-space
floor) consider only rows with an `r2_key`. A replay that is not safely in R2 is never deleted,
whatever the disk says. With R2 not configured (dev), today's behaviour is kept. The "floor
unreachable from replays alone" log line stays.

### 5. Backfill

- The 451 replays still on Dallas: the first sweeps upload them (a one-off run with a raised
  limit, like the demo migration).
- Rows already pruned: `scripts/upload-replay-backups.ts <dir> [--commit]` finds each row with
  `pruned_at` set and no `r2_key` whose file is in `<dir>` (the workstation's
  `backups/replays`), stamps, blanks and uploads it through the same function, and records the
  key. Matches 44 to 91 have no backups and stay unrecoverable.

## Tests

Faked R2, the way `demoOffload` is tested:

- an upload failure leaves the row and the file alone;
- a size mismatch after upload is not recorded;
- the uploaded bytes never contain the token, and carry the side mask;
- an open file, a file changed inside the quiet period, and a live match are not eligible;
- the route serves an R2-only replay with a body and headers identical to the same replay served
  from disk, including `since` offsets;
- the pruner never selects a row without `r2_key` when R2 is configured, and behaves as today when
  it is not;
- the stamp script writes only bytes 156/157 and skips files that already carry a mask.

## Out of scope

- Serving replays to browsers straight from R2 (redirects). Rejected: it needs bucket CORS and a
  second viewer mode, for no saving that matters at about 1 MB a round.
- Live replays, the live directory and the remote pull scripts.
- Deleting R2 objects: replays are kept indefinitely (about 1 MB a round).
- Demo object keys contain the match token (`demos/<id>/<filename>`). Noted, not changed here.
- Whatever else fills the Dallas disk (35 GB used, replays about 0.5 GB of it).
