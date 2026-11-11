# 3D theatre on the match page

Written 2026-11-11 on branch `theatre-3d`. Ready to deploy: the R2 CORS rule and the Caddy frame
rule it needs are live (owner, 2026-11-11). Deploying is the steps under "Deploy"; undoing it is
"Rollback".

## What it is

Every finished match (completed, or aborted with whatever was recorded) has a 2D / 3D switch in
its map panel, for each map that has a SourceTV demo. 3D plays that map's demo (both rounds, one
demo per map ordinal) in the theatre viewer: real player models and animations, the map with
baked light, commons, shots, sound, chat, the site's bookmarks on the timeline. An aborted match
that never reached a map result (no `match_maps` row, 70 of them on 2026-11-11) still gets a map
panel for each demo, marked "not recorded", so its demo plays in 3D too.

**Which view a visitor starts on** (owner 2026-11-11: 3D is the default):

1. a link: `#map-2-3d` opens map 2 in 3D; a clip's deep link (`?ordinal=&half=&t=`) opens the 2D
   replay at its moment;
2. else what this browser picked last with the switch (`localStorage['theatre.view']`, read and
   written in try/catch, so a private window just forgets);
3. else 3D, except on a phone or without hardware WebGL (`deviceView` in `web/src/theatre.ts`):
   - phone: a mobile user agent (`Mobi|Android|iPhone|iPod`) or `(pointer: coarse) and (max-width: 900px)`;
   - no WebGL2 context;
   - a software renderer: the WebGL renderer string (`WEBGL_debug_renderer_info`, else `RENDERER`)
     matches `swiftshader|llvmpipe|softpipe|software|basic render`. The viewer runs there at
     4 to 6 fps.
   Those start on 2D; the switch still offers 3D.

A default of 3D falls back to 2D for a map 3D cannot show (not converted, a mirror the viewer
cannot draw yet, or no manifest at all), so nobody lands on an explanation instead of a replay.
Clicking 3D there says why. The pick is written to the hash (`#map-N-3d`, or `#map-N` for 2D)
and to localStorage.

**Mirror maps** come from the manifest, not from a list of names. The sync lists every mirror whose
original is converted, with `mirror_of`, and records whether the synced viewer draws mirrors
(`viewer.mirrors`: true once the viewer reads `<map>.mirror.json`, map/README.md "Mirror maps at
load"). Until then a mirror says "played mirrored, not in 3D yet"; the first sync after the viewer
learns it turns mirrors on with no site change. For a mirror the site leaves out `map=` and the
viewer resolves the original's files itself.

`/live` is unchanged: live 3D needs a relay (phase 2 below). A match still being played never
gets 3D: its demo shows the infected ghosts.

| Piece | Where |
|---|---|
| The 3D tab, `useTheatreManifest` | `web/src/replay/Theatre3D.tsx`, wired in `web/src/routes/MatchDetail.tsx` (`withDemoMaps`, `viewFor`) |
| URL, manifest, mirror rule, default view | `web/src/theatre.ts` (+ `theatre.test.ts`, the `3D view` tests in `routes.test.tsx`) |
| Copy from the spike, version, privacy scan | `tools/sync-theatre.sh` |
| Upload to R2 | `scripts/upload-theatre.ts`, `src/theatreAssets.ts` (+ `tests/theatreAssets.test.ts`) |
| Ship the small set, R2 check | `deploy-web.sh` |
| Dev: `/theatre/<version>/` from `theatre-assets/`, missing `/theatre/*` = 404 | `theatreDev` in `vite.config.ts`; `isPageRequest` in `src/server.ts` |

## The iframe

The viewer is embedded in an iframe on `/theatre/viewer/index.html` with the parameters of the
viewer README "Site embedding" (`~/l4d/research/theatre-spike/viewer/README.md`):

| Param | Value |
|---|---|
| `embed=1` | the embedded look (no debug panel, file picker, live or match box; title "Riverside 3D") |
| `site=self`, `match=<id>`, `ord=<ordinal>` | bookmarks from this origin's `/api/matches/<id>` and `/api/replays/timeline/<id>/<ord>/<half>` |
| `demo=` | `/api/matches/<id>/demos/<ordinal>`: a 302 to the demo on R2 in production, the local file in dev |
| `assets=` | `<THEATRE_ASSET_HOST><version>/`: maps, models, fx, sounds |
| `ambbase=` | `<assets>light/`: the character light files, which otherwise load beside the page |
| `map=` | `<assets>map/<map>.glb`, so the map loads while the demo downloads (not for a mirror) |

`THEATRE_ASSET_HOST` (`web/src/theatre.ts`) is `https://assets.riversidepug.com/theatre/` in a
production build and `/theatre/` in dev and tests; `VITE_THEATRE_ASSETS` overrides it at build
time (the local R2 stand-in test below). `<version>` comes from `/theatre/manifest.json`.

An iframe rather than a component: the viewer is a whole page with its own styles, import map,
render loop and key bindings, and it keeps changing. The frame isolates it, keeps three.js out of
the site bundle, and unmounting it (switch or map change) frees the GPU memory a map takes.
"Open in its own tab" opens the same URL full size.

## Two sets: what is served from where

The viewer page and its workers must be same-origin (module workers), everything heavy goes to R2.
`tools/sync-theatre.sh` copies the spike (read-only; other sessions own it) into two places, both
gitignored, nothing committed:

| Set | Where | Content | Size 2026-11-11 (version `85b5d89e3f12`) |
|---|---|---|---|
| small, ships with the site | `web/public/theatre/` | `viewer/` (index.html, the ES modules, `demo-worker.js`, `vendor/`: three.js 0.160.0, Draco, meshoptimizer), `sound/sound-worker.js`, `sound/sounddecode.js`, `sound/out/js/`, `manifest.json` | 3.5 MB, 43 files |
| heavy, R2 | `theatre-assets/<version>/` | `map/` (143 maps: `.lit.glb`, `.lit.low.glb`, `.lighting.json`, atlas png, `.proplight.bin`, `.dynamic.json`, `.ladders.json`; 42 mirrors: `.mirror.json`, `.dynamic.json`, `.ladders.json`), `models/out/`, `sound/out/manifest.json`, `sound/out/a/*.ogg`, `sound/map.json`, `light/`, `manifest.json` | 3,791.5 MB, 2,879 files (maps 3,701, models 51.6, sound 13.9, light 25.0) |

- `theatre-assets/` is outside `web/`, so a Vite build never copies it; `dist/public/` stays small
  (58 MB in this worktree, of which `theatre/` 3.5 MB and the old 1x overviews 49 MB).
- The **version** is the first 12 hex digits of a SHA-256 over every heavy file's path and content
  hash (cached by size and mtime in `theatre-assets/.hashes.json`). An unchanged spike gives the
  same version, so a re-sync uploads nothing; any change gives a new folder. `theatre-assets/stage/`
  is the working copy, `theatre-assets/<version>/` a snapshot of hard links into it (stage files
  are only ever replaced by rename, so a snapshot keeps its bytes), `theatre-assets/current` the
  newest version's name. Older version folders stay until deleted by hand.
- Never copied: the spike's backups (`*before*`), logs, stats, screenshots, test pages, check
  scripts, `viewer/bookmarks/` (raw SteamID64 keys), `parser/` (its `sample-*.json` research outputs
  hold raw SteamIDs), `sound/out/streams/`. Every JSON / JS / HTML file of both sets is scanned for
  SteamIDs (SteamID64, `STEAM_X:Y:Z`, `[U:1:N]`; the SteamID64 base constant in the worker is
  allowed) and the sync fails on a hit. The upload repeats the check on the JSON it sends.
- Maps with a file younger than two minutes (the batch converter may be writing it) or missing a
  side file are skipped and listed; a mirror is copied only with its original.
- The sync refuses to run while `viewer/demo-worker.js` is stale against `parser/`
  (`--allow-stale` overrides).

```sh
tools/sync-theatre.sh                       # everything
tools/sync-theatre.sh --maps 'l4d_vs_*'     # only some maps (others already staged are kept)
tools/sync-theatre.sh --no-maps             # viewer, models, sounds, light; staged maps kept
```

**R2 and caching.** Each heavy file is `theatre/<version>/<path>` in the bucket, served at
`https://assets.riversidepug.com/theatre/<version>/<path>` with
`Cache-Control: public, max-age=31536000, immutable` (safe because a version never changes) and
these types: `.glb` `model/gltf-binary`, `.json` `application/json`, `.bin`
`application/octet-stream`, `.png` `image/png`, `.webp` `image/webp`, `.ogg` `audio/ogg` (anything
else is refused). The bucket's CORS rule (live since 2026-11-11 ~08:45, Cloudflare dashboard, bucket
`riverside-demos`) allows `https://riversidepug.com`, GET and HEAD, headers `*`, exposes
`Content-Length, Content-Range, ETag`, max age 86400. It covers the demo redirect too.

**Framing.** Caddy on Dallas sends `X-Frame-Options: DENY` everywhere except `/theatre/viewer/*`,
which gets `SAMEORIGIN` (changed 2026-11-11 with the owner's approval; backup
`/etc/caddy/Caddyfile.before-theatre-<ts>`). The deploy repo's mirror
`deploy/state/dallas/system/etc/caddy/Caddyfile` does not have that change yet.

**The manifest** (`theatre-manifest/2`) is same-origin at `/theatre/manifest.json` (it names the
version every other URL is built from) and also in the R2 folder. `version`, `generated`,
`viewer.mirrors`, `bytes` per folder, and `maps`: `{lit, low, bytes}` per map (`bytes`: what a GPU
viewer downloads), plus `mirror_of` for a mirror.

**Missing files are 404s.** The viewer probes optional files (`.lit.low.glb`, `.ladders.json`) and
takes any 200 as the file, so `/theatre/` is excluded from the SPA fallback (`src/server.ts`) and
from Vite's (dev).

## Deploy

The site part is ordinary (this branch merged into master, `deploy-web.sh` from a checkout); the
two extra steps are the sync, in the checkout that deploys (`web/public/theatre/` is not in git),
and the upload, before the deploy (deploy-web.sh refuses a theatre version that is not on R2).

1. In the checkout that will run `deploy-web.sh` (after the merge):
   ```sh
   tools/sync-theatre.sh            # prints "theatre <version>: ...", small and heavy sizes
   npm run typecheck && npx vitest run && npx vite build && du -sh dist/public dist/public/theatre
   ```
2. Upload the heavy set. The R2 keys live in the box's `/home/pug/app/.env`; use a private copy
   and delete it afterwards:
   ```sh
   scp root@45.32.199.85:/home/pug/app/.env /tmp/pug-r2.env && chmod 600 /tmp/pug-r2.env
   npx tsx scripts/upload-theatre.ts --env=/tmp/pug-r2.env              # dry run: what would go
   npx tsx scripts/upload-theatre.ts --env=/tmp/pug-r2.env --upload     # ~3.8 GB the first time
   rm /tmp/pug-r2.env
   ```
   It checks every file first (forbidden names, unknown types, SteamIDs, the manifest's version),
   uploads 8 at a time (`--jobs=`), skips objects already there with the same size, verifies each
   PUT with a HEAD, and uploads `manifest.json` last and only over a complete set. A failed run is
   simply run again. Options: `--version=<v>` (default: `web/public/theatre/manifest.json`'s),
   `--dir=`, `--force` (re-upload all).
3. Check R2 from outside:
   ```sh
   V=$(cat theatre-assets/current)
   curl -sI https://assets.riversidepug.com/theatre/$V/manifest.json | head -1          # 200
   curl -sI -H 'Origin: https://riversidepug.com' \
     https://assets.riversidepug.com/theatre/$V/map/l4d_vs_hospital01_apartment.lit.glb \
     | grep -i -E '^(HTTP|access-control-allow-origin|content-type|cache-control)'
   ```
4. Deploy the site as usual (DB backup first, the deploy lock, then verify):
   ```sh
   flock ~/l4d/.pug-deploy.lock ./deploy-web.sh
   ```
   Before its main rsync it reads the version from `web/public/theatre/manifest.json`, refuses if
   `web/public/theatre/` still holds heavy folders from an old sync, and refuses unless
   `https://assets.riversidepug.com/theatre/<version>/manifest.json` answers 200
   (`THEATRE_SKIP_R2_CHECK=1` skips that). The main rsync excludes `theatre-assets/` and
   `web/public/theatre/`; a second rsync then sends `web/public/theatre/` alone (only when the
   checkout has a manifest). Because the main sync excludes it, a later deploy from a checkout that
   never ran the sync leaves the box's copy alone instead of deleting it.
5. Verify:
   ```sh
   curl -s https://riversidepug.com/theatre/manifest.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])'
   curl -sI https://riversidepug.com/theatre/viewer/index.html | grep -i -E '^(HTTP|x-frame-options)'   # 200, SAMEORIGIN
   curl -sI https://riversidepug.com/match/1081 | grep -i x-frame-options                               # DENY
   ```
   Then open https://riversidepug.com/match/1081 in a browser with a GPU: 3D first, the map and
   players load, bookmarks on the timeline, the 2D switch works and is remembered, no console
   errors, requests only to riversidepug.com and assets.riversidepug.com (plus the site's fonts).
   On a phone it opens on 2D.

Updating the viewer later is steps 1 to 5 again: a new version folder on R2, the old one stays.

## Rollback

- **Off switch, no deploy:** `ssh root@45.32.199.85 rm /home/pug/app/dist/public/theatre/manifest.json`.
  With no manifest every map opens on 2D and the 3D switch says "not available right now" (the
  page fetches the manifest with `cache: no-cache`). The next deploy from a synced checkout puts
  it back.
- **Undo the branch:** `git revert` its commits on master and run `deploy-web.sh`. The box keeps
  `web/public/theatre/` (deploy excludes it from `--delete`), so the viewer page stays reachable at
  its URL with nothing linking to it; remove it by hand if wanted
  (`ssh root@45.32.199.85 rm -rf /home/pug/app/web/public/theatre` before the deploy).
- **Back to an older viewer:** R2 keeps every uploaded version (`theatre/<version>/`), but the
  small set (the viewer page) is not versioned in this checkout; restoring an older viewer means
  syncing from a spike in that older state. Do not delete old R2 versions while a deployed build
  may still name them.

## Testing locally

```sh
gunzip -c ~/l4d/backups/pug/pug-<latest>.db.gz > data/pug.db
# neutralise the copy: no box, no webhook
sqlite3 data/pug.db "UPDATE servers SET host='127.0.0.1', port=9, rcon_port=9, rcon_password='', ftp_host=NULL, ftp_password=NULL, ssh_key_path=NULL, enabled=0, status='offline'; UPDATE settings SET value='' WHERE key='discord_webhook_url'; UPDATE matches SET state='aborted' WHERE state='live';"
# DEMO_DIR: a folder with the match's demos under their stored names (match_demos.filename),
# e.g. symlinks to the spike's parser/demos/match1081-hospital01.dem
DB_PATH=data/pug.db DEV_MODE=1 PORT=8093 LOG_LISTEN_PORT=27593 DEMO_DIR=/path/to/demos npx tsx src/index.ts &
API_PORT=8093 npx vite --port 5193 --strictPort &
# http://localhost:5193/match/1081  (assets same-origin from theatre-assets/<version>/)
```

With R2 stood in by another origin: serve `theatre-assets/` at `http://127.0.0.1:8894/theatre/`
with the bucket's CORS rule (allowed origin `http://localhost:5193`, GET / HEAD, OPTIONS preflight)
and start Vite with `VITE_THEATRE_ASSETS=http://127.0.0.1:8894/theatre/`.

Checked 2026-11-11 that way (headless Chrome over CDP, any other host unresolvable, every request of
the page, frame and workers logged): GPU (RTX 2080 Ti, ANGLE Vulkan) opens match 1081 on 3D, the
viewer loads (map, models, light, sound manifest from the asset host; page, vendor, workers, demo
and API same-origin); 2D click is remembered (`theatre.view`, hash `#map-1`), reload stays 2D, 3D
click and reload stay 3D; an emulated Android phone opens on 2D. SwiftShader opens on 2D, and 3D on
click loads the `.lit.low.glb`. No console errors from the site's 3D code or the viewer; requests
went only to the dev origin and the asset host (plus the site's own Google Fonts stylesheet).

## Phase 2: live 3D (site side built on `live-3d`, not deployed)

**In progress, 2026-11-11 from 19:50Z: session l4d-fb (Claude), worktree `.claude/worktrees/live-3d`, branch
`live-3d`.** Plan:

1. Site: `POST /api/demos/push` (token from the demo filename is the credential, as for the `.rpl` push;
   offset-append into a live dir, arrival time per chunk) and a Dallas mode that reads `DEMO_DIR` directly
   (no box change).
2. Site: `GET /api/demos/live/match/:id` (WebSocket + HTTP stream, the relay wire format from the spike's
   `live/README.md`), releasing a byte only 10 s after the site received it (`DEFAULT_DELAY_MS`), fanned out
   from one buffer per recording. The filename (token) never leaves the server.
3. Viewer: `live=` with `match=`, follow and the live timeline; site embed on `/live` and the ongoing match
   page.
4. Remote boxes: a stdlib python sidecar tailing `pug_*.dem` and posting the new bytes once a second.
   Owner's go-ahead before it is installed on any box.

### Site side (steps 1 and 2): built, not deployed

Commits on `live-3d`: the feed (`src/demoLive.ts`, `src/demoFrames.ts`), the routes
(`src/routes/demoLive.ts`, registered in `src/server.ts`), tests (`tests/demoLive.test.ts`). Not deployed;
no game box touched.

**Config.**

| Key | Default | Meaning |
|---|---|---|
| `DEMO_LIVE_DIR` | empty (push off) | where pushed demo copies are kept, `live_<token>_<ordinal>_<started>.dem`; must not be `DEMO_DIR` |
| `DEMO_LIVE_LOCAL` | off | `1`: Dallas mode, follow the growing `pug_<token>_<ordinal>_<map>.dem` in `DEMO_DIR` itself (needs `DEMO_DIR`) |

With neither on, every route below answers 404. Dallas mode is an explicit opt-in rather than "on whenever
`DEMO_DIR` is set", so merging this changes nothing on Dallas until the flag is set.

**`POST /api/demos/push`** (the box sidecar, step 4). Body: the raw new bytes,
`Content-Type: application/octet-stream`, at most 1 MiB per request. Fields are headers (never the URL,
which gets logged):

| Header | Value |
|---|---|
| `X-Demo-Token` | the 32-hex token from the file name `pug_<token>_<ordinal>_<map>.dem` |
| `X-Demo-Ordinal` | the ordinal from the file name (0 to 999) |
| `X-Demo-Map` | the map from the file name (`[A-Za-z0-9_.-]`, up to 96) |
| `X-Demo-Offset` | where in the file these bytes start |
| `X-Demo-Started` | the box's id for this recording, a positive integer that grows for a new recording at the same name (unix seconds the sidecar first saw this file, or its birth time) |

Rules (as `/api/replays/push`): only a match in state `live` accepts; an unknown, finished or aborted token
gets the same 404. The first batch (offset 0) must carry the whole 1072-byte demo header (`HL2DEMO`). A batch
must start where the copy ends; otherwise 409 `{ length }` and the sidecar resumes from `length` (an exact
retry of bytes already there is 200, an empty body asks for the length). Offset 0 with a larger `Started`
is a new recording at that name: the copy is replaced and viewers get `restart`. A smaller `Started` at
offset 0, or a different `Started` at any other offset, is 409 `{ length, error: 'stale recording' }`. A
brand new copy is refused with 507 while the directory holds over 2 GiB or its filesystem has under 2 GiB
free. A file over 256 MiB is 413. A write failure is 503 with a fixed body; logs carry the errno code and
the match id only. Replies never name the token or a file. Copies of matches no longer live (or untouched
for a day) are deleted every minute.

**`GET /api/demos/live/match/:id/ws`** (WebSocket) and **`GET /api/demos/live/match/:id/live.dem`**
(HTTP stream, gzip with a sync flush when accepted). The spike relay's wire format unchanged
(`research/theatre-spike/live/README.md` "Wire format"), so the viewer's `live=` takes these URLs as they
are: text `hello { id, offset, size, complete, demoT, wall }`, binary demo bytes, `pos { off, wall, demoT }`
every tick (250 ms), `end { size }`, `restart`; HTTP headers `X-Demo-Id`, `X-Demo-Size`, `X-Demo-Offset`;
resume with `?offset=N&id=X`. No CORS headers (the viewer is same-origin). Differences from the spike:
`size` and `X-Demo-Size` are the bytes released so far, not received; `wall` in `pos` is when that frame
was released; `id` is 16 random hex per recording (never derived from the token). Served only for a match in
state `live` the viewer may see (`canViewMatch`, the same rule as the 2D live viewer) that has a recording;
everything else is the same 404 `{ error: 'no live demo for that match' }` (WebSocket: refused before the
upgrade).

**The hold.** Every appended range is stamped with the time the site had it (push: when the batch was
applied; Dallas: when a size poll first saw the bytes). A byte is released only once that stamp is at
least `DEFAULT_DELAY_MS` (10 s) old; the site's stamp is never earlier than srcds wrote the byte, so the hold
is at least 10 s behind the recording. Every failure mode releases less: bytes reloaded from disk after a
site restart are stamped at the reload, a clock stepping back cannot date new bytes before older ones, a
delay of zero or less releases nothing.

**Which recording, and when it ends.** One in-memory buffer per recording (token, ordinal), shared by every
viewer. A match serves its highest ordinal that has released anything, so the next map takes over only
once its own first bytes are out; the old map's viewers get its last bytes, then `restart`. `end` goes
out once every byte is released and the recording reached `dem_stop`, its match left `live`, or it has
not grown for 150 s (`IN_PROGRESS_MS`). A late joiner gets everything released so far (256 KiB pieces,
waiting for the socket), then live bytes. Memory is dropped once a recording has no viewers and is over or
replaced.

**Dallas mode.** Lists `DEMO_DIR` every 2 s for `pug_<token>_*.dem` of live matches written within the
last 150 s (pulled demos from other boxes arrive finished, with old mtimes, and are skipped), then polls
known files by size every tick. A file that shrank, got another inode or whose fixed header part (the
first 1056 bytes: magic, protocols, server, client, map, game dir) changed is a new recording. The last 16
header bytes are excluded on purpose: srcds rewrites playback time, ticks, frames and signon length when
it stops recording. A push for a (token, ordinal) the Dallas mode already follows is 409 `recorded locally`.

**Verified** (`tests/demoLive.test.ts`, 29 tests; `npm run typecheck`): randomised arrivals never release a
byte before its stamp is 10 s old and always release everything that old; to the millisecond; zero and
negative delays; a clock stepping back; a reload after a site restart is held 10 s again. The token is in
no push reply, header, WebSocket message or log line (including a failing write). Offset gaps, overlapping
and changed bytes, stale recordings, a header-less first batch, a token in the query instead of the header
are refused; 507 under the floor and over the cap; 413 over the body cap. Restart at the same name (old
viewers get `restart`, the new recording is held again, an old id resumes at 0), next-map handover, idle
end, match-over end after the hold, HTTP stream bytes and gzip, resume by offset and id. Non-live,
completed, private, unknown, non-numeric and not-yet-recording matches all get the same 404 on both routes.
Dallas mode: dating by first sight, a rewritten file restarting viewers, old files, non-live matches and
non-demo files ignored. Against a real demo (`hospital02.dem`, 25 MB, pushed in random pieces): the frame
scanner reaches the end, sees `dem_stop`, demo time 758.7 s.

**Open.**

- The box sidecar (step 4) is not written. It must: tail the newest `pug_<token>_<ordinal>_<map>.dem`
  read-only (no lock, nothing written beside it, not inside srcds); wait until the file has 1072 bytes
  before the first push; POST new bytes about once a second in pieces of at most 1 MiB with the five
  headers above over HTTPS; pick `X-Demo-Started` once per file (and a larger one when the file shrinks or
  is replaced at the same path); on 409 resume from `length`, on 409 `stale recording` stop pushing that
  file, on 404 (match not live) stop, on 507 / 503 back off and retry; never log the token. Also push the
  previous map's last bytes when a new map's file appears.
- srcds' write and flush pattern while recording is still unmeasured (the spike only saw finished files):
  if srcds buffers a lot, live lags by that much on top of the 10 s.
- `demoT` during a recording uses a 100 tick fallback: the header's ticks and playback time are only
  filled in when the recording stops.
- Dallas mode cannot tell a same-map re-recording that reuses the file (same inode, same header) and grows
  past the old size within one 250 ms poll from a continuation. Unlikely (the signon data alone is written
  first), not handled.
- No per-viewer or total viewer limit, and no per-IP rate limit on the stream routes yet. The join burst
  (up to ~30 MB per late viewer) is the load to watch.
- Viewer and site embed (step 3) not started.

Owner decision: anyone can watch live, with the same delay as the existing live viewer (10 s,
anchored to the replay file's mtime so a pause cannot shrink it; `src/replayTail.ts`). What it
needs:

- **A feed of the growing demo.** The spike has `live/relay.ts` (`--tail <growing .dem>`,
  WebSocket plus an HTTP gzip fallback; incremental parse proven equal to a whole-file parse).
  The `.dem` is only on the game box, so either a read-only tail on each box pushing to the site
  (like the `.rpl` live push, `/api/replays/push`, offset-append) or a relay process on the box.
  Touches game boxes: owner's go-ahead at deploy time.
- **The delay on the server, not the viewer.** The relay must hold bytes back 10 s against the
  file's mtime clock (same anchor as `replayTail.ts`), because a demo carries the infected
  ghosts: a client-side delay is a wallhack for anyone who opens the socket.
- **Load.** About 44 KB/s raw (22 gzip) per viewer, and a late join replays the map so far (up
  to ~29 MB). Fan-out from the site (or from R2-like storage of the growing file) rather than
  from the box.
- **Viewer.** `live=` mode has no `match=` / `follow=` support yet, and bookmarks would need the
  live timeline.
- **Site.** The same switch on the ongoing-match page (`OngoingMatch` in MatchDetail.tsx) and on
  `/live` (owner: 3D replaces the 2D map in place, opening on the top-down overview; cards start 2D
  when several matches run) with `live=<relay URL>` instead of `demo=`; this branch keeps 3D off
  unfinished matches on purpose.
