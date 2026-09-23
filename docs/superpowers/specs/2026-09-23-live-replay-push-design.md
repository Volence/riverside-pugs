# Live replay push: live view on every server

Designed 2026-09-23 with the owner. Root cause and feasibility were measured first
(evidence below). Approach A was chosen; the owner's rulings are marked.

## The problem

The live match viewer only works for matches on Dallas. The site runs on the Dallas box and
reads Dallas's replay file while it grows (measured about 5.2 KB/s served; the browser polls
every second, `POLL_MS = 1000` in `web/src/replay/source.ts:47`). Replays from the other
servers reach the site by copy jobs on a 2-minute timer that only take a file once it has
stopped growing:

- Chicago: `/usr/local/bin/pug-pull-chicago` (FTP only; a file whose size matched the previous
  run). A round arrives 2 to 4 minutes after it ends (measured 2m07s and about 2m22s on match
  #139).
- Riverside #3/#4: `/usr/local/bin/pug-pull-riverside1` (rsync over SSH, 3 minutes untouched):
  3 to 5 minutes after.

So during a remote match the newest file on disk is the previous, finished round.
`currentFileFor` (`src/replaySessions.ts:148-159`) returns it, the live route
(`src/routes/replays.ts:245-257`) serves it as finished, and `liveStatusText`
(`web/src/replay/ReplayHud.tsx:52-67`) prints "Round over, waiting for the next round" while a
round is being played. Earlier client-side fixes (the 1 s buffer, the "catching up" snap) could
not help: the bytes were not on the box.

## Owner's rulings

- Every server pushes, Dallas included: one live path, so Dallas is the first real test of what
  Chicago and Riverside run.
- Approach A: the plugin makes one HTTPS request per second to the site, with REST in Pawn.
- CPU and tick timing must not suffer; measured, not assumed.
- Adding servers must not need per-server streaming setup.

## Feasibility (checked read-only, 2026-09-23)

- All four servers run SourceMod 1.12.0.7239 and Metamod 1.12.0-dev+1224, 32-bit srcds.
- REST in Pawn (`rip.ext.so`, ripext 1.3.2) and its CA bundle are already installed on all four,
  Chicago included (from the 2026-09-17 full upload), and have never been loaded (no plugin
  requires them). Chicago already loads our own `l4d_consistency.ext.so`, so the host allows
  custom extensions.
- Not yet verified: that ripext loads on L4D1, and that Chicago may make outgoing HTTPS
  connections (outgoing UDP 27500 for logs already works).
- ripext POST/PUT take JSON only, so frames travel base64-encoded (about 7 KB/s).
- Each match already has a secret 32-hex token (`sm_pug_match`, `plugin/pug-match.sp:380`;
  replay names follow `pug_<token>_<map>_<half>.rpl`, `src/replaySessions.ts:17`), and each
  server a log secret (`servers.log_secret`, `src/logAuth.ts`).

## Design

### 1. Plugin

- The recorder is unchanged: `Timer_RplFrame` (`plugin/pug-match.sp:1361`) builds each frame
  and writes it with one `WriteFile` (`:1568`); `RplOpen` (`:1154`) writes the header;
  `RplClose` (`:1210-1290`) finishes the file.
- A new include, `plugin/pug-livepush.inc`, keeps a per-round byte buffer. The header and every
  frame written to the file are also appended to it. Everything the site has not confirmed stays
  in the buffer, capped at about 60 seconds of data (about 300 KB).
- Once a second, if pushing is enabled (`sm_pug_live_push`, default 0), ripext is loaded
  (optional dependency: `MarkNativeAsOptional`, checked with `LibraryExists`), and the match has
  a token, the plugin posts `{ token, map, half, offset, closed, data }` where `offset` is the
  file byte the data starts at and `data` is base64 of every unconfirmed byte.
- At most one request in flight. If a request is still pending or failed, nothing is queued: the
  next second sends from the confirmed offset. Short timeouts.
- The reply carries the site's confirmed length; the buffer drops everything before it. If the
  unconfirmed backlog passes the cap, pushing stops for that round (the file copy covers it).
- On round close, a final request with `closed: true`.
- Reply callbacks carry the round's identity and ignore replies for a round that is no longer
  current; they never touch per-round state otherwise.
- Target URL `sm_pug_live_push_url` (Dallas: `http://127.0.0.1:<port>/api/replays/push`, others:
  `https://riversidepug.com/api/replays/push`).
- If ripext is absent or fails to load, pushing is simply off and recording is exactly as today.

### 2. Site

- `POST /api/replays/push`: looks the token up among live matches (`matches.state = 'live'`;
  refuses unknown, finished or aborted), caps the body size, and validates `map` and `half`.
- Pushed bytes go to a separate live directory (`REPLAY_LIVE_DIR`, default a `live/` directory
  beside the replay store), file name identical to the final one. Separate because on Dallas the
  plugin writes its own file straight into the replay directory the site reads, and the pushed
  copy must not race it.
- A batch is accepted only if `offset` equals the live file's current length (then appended); any
  other offset is refused with the current length, which the plugin resumes from. A batch that
  starts before the current length and overlaps only already-written bytes is answered with the
  length without writing. The live file is therefore always an exact prefix of the real file.
- `closed: true` marks the live file finished.
- The live view (`currentFileFor`, the live route) prefers, for a given token, whichever of the
  live file and the replay-directory file is further along, so Dallas's own file and the push can
  never make the viewer go backwards, and the pulled final file takes over when it lands. Both
  pull jobs already write a temp file and rename (atomic), so a viewer never reads a half-written
  final file.
- The 10-second anti-ghosting delay (`src/replayTail.ts`, `DEFAULT_DELAY_MS`) is unchanged and
  keys off the live file's mtime, which is now the arrival time of the last batch.
- Live files are deleted once the match is no longer live and a final file of at least the same
  length exists in the replay directory, and in any case after 24 hours.

### 3. Honest status on the page

- The live route checks which round the plugin reports as current (the match's live phase) and
  never presents an older finished file as the current round.
- When the current round has no file yet, the viewer says "Live view is catching up" for up to
  30 seconds after the round went live, then "Live view isn't available for this server right
  now", never "Round over". `liveStatusText` respects the server's live phase over "file
  finished".

### 4. Security

- Only the match's token can push, the token only travels over HTTPS (or stays inside the Dallas
  box), bodies are capped, and only live matches accept data. No per-batch HMAC: the transport
  protects integrity and signing 5 KB/s in SourcePawn would cost tick time for nothing.

### 5. Adding servers

No per-server streaming setup: a new server needs SourceMod with ripext (part of the standard
install copied from Dallas), the plugin, `sm_pug_live_push 1`, and its row in admin Servers. One
check per host: outgoing HTTPS allowed. Load is about 7 KB/s and one request per second per
running match.

## Testing

- Site: endpoint accepts the right token and refuses a wrong, finished or unknown one; offset
  rule (append, refuse with length, overlap answered without writing); size cap; `closed`; live
  file vs replay file preference; cleanup; the honest status (a live round with no data never
  shows "Round over").
- Plugin: compiles; with ripext absent, pushing is off and recording is unchanged.
- Local test server (`/home/volence/l4d1-ds`): ripext loads on L4D1; a bot round pushes to a
  locally running site; the viewer follows it live; l4d_tickstats compared with pushing on and
  off (baseline p99 11.25 ms).

## Rollout (each step undone by `sm_pug_live_push 0`, no restart)

1. Site deploy: the endpoint is dormant.
2. Plugin staged on empty servers with pushing off (no behaviour change).
3. Dallas on; watch one real match: live view, tickstats, site logs.
4. Riverside #3/#4 on.
5. Chicago last, after a one-off check that it can make outgoing HTTPS connections; if it cannot,
   Chicago stays on the delayed copy and the page says live view is unavailable.

## Out of scope

- Replacing the pull jobs (they stay as the backup and the record).
- Changing the replay format, the viewer's playback, or the 10-second delay.
