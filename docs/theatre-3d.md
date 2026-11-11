# 3D theatre on the match page (phase 1)

Written 2026-11-11 on branch `theatre-3d`. Local only: nothing here has shipped, and shipping
needs the owner's go-ahead plus the steps under "Shipping".

## What it is

Every finished match (completed, or aborted with whatever was recorded) gets a Replay / 3D
switch in its map panel, for each map that has a SourceTV demo. 3D plays that map's demo (both
rounds, one demo per map ordinal) in the theatre viewer: real player models and animations,
the map with baked light, commons, shots, the site's bookmarks on the timeline. The choice
rides in the hash beside the map: `/match/1081#map-2-3d` opens map 2 in 3D.

The viewer was built in the theatre spike (`~/l4d/research/theatre-spike`, not git, owned by
other sessions) and is still changing. It is not copied into this repo by hand and nothing of
it is committed: `tools/sync-theatre.sh` copies it into `web/public/theatre/` (gitignored), and
the site only knows its URL and its URL parameters.

| Piece | Where |
|---|---|
| The 3D tab | `web/src/replay/Theatre3D.tsx`, wired in `web/src/routes/MatchDetail.tsx` |
| URL, manifest, hash rules | `web/src/theatre.ts` (+ `theatre.test.ts`) |
| Copy from the spike | `tools/sync-theatre.sh` |
| Missing `/theatre/*` file = 404, not the app shell | `isPageRequest` in `src/server.ts`, `theatre404` in `vite.config.ts` |

The viewer is embedded in an iframe pointing at `/theatre/viewer/index.html` with:

| Param | Value | Why |
|---|---|---|
| `demo=` | `/api/matches/<id>/demos/<ordinal>` | the site's own demo route; the viewer's worker fetches and parses it |
| `match=`, `ord=` | the match id and map ordinal | the viewer reads `/api/matches/<id>` and `/api/replays/timeline/<id>/<ord>/<half>` for bookmarks |
| `map=` | `<assets>/map/<map>.glb` | the map starts loading while the demo downloads, and the assets can move host |
| `site=self` | | bookmarks from this origin's API (needs the viewer change below) |
| `modelbase=` | only when the assets are on another host | the viewer's models default to `../models/out/` |

An iframe rather than a component: the viewer is a whole page with its own styles, import
map, render loop and key bindings, and it keeps changing. The frame isolates it, keeps three.js
out of the site bundle, and unmounting it (tab or map switch) frees the GPU memory a map takes.
"Open in its own tab" opens the same URL full size.

When a map cannot be shown the tab says why instead of loading anything: no demo for the map,
a mirrored map (not converted; the viewer will mirror the original at load later), or a map
not converted yet. Which maps exist comes from `/theatre/manifest.json`, written by the sync.

## Syncing the assets

```sh
tools/sync-theatre.sh                       # viewer, models, sounds, every finished map
tools/sync-theatre.sh --maps 'l4d_vs_*'     # only some maps (others already there are kept)
tools/sync-theatre.sh --no-maps
```

It refuses to run while `viewer/demo-worker.js` is stale against `parser/`
(`node build-worker.ts --check`; `--allow-stale` overrides), skips any map with a file younger
than two minutes (the spike's batch converter may be writing it) or missing a side file, and
never copies the spike's backups (`*before*`), logs, stats or screenshots. Copies are atomic
per file (`.part` then rename) and only changed files are copied.

What it copies (layout kept, because the viewer loads by relative paths):

| Folder | Content | Size 2026-11-11 |
|---|---|---|
| `theatre/viewer/` | `index.html`, the ES modules, `demo-worker.js` | 0.9 MB |
| `theatre/models/out/` | survivors, SI, witch, commons, weapons, view models, items, props, fx textures | 47.0 MB |
| `theatre/sound/` | 1,569 Opus waves, manifest, `map.json`, the sound worker | 13.9 MB |
| `theatre/map/` | per map: `.lit.glb`, `.lit.low.glb`, `.lighting.json`, the atlas png, `.proplight.bin`, `.dynamic.json`, `.ladders.json` | 1,026.9 MB (40 maps) |
| total | | 1,088.8 MB |

A viewer downloads one map at a time: the full lit glb and its side files on a GPU (8 to 37 MB
a map, `bytes` in the manifest; the software tier takes the smaller `.lit.low.glb`), the demo
(15 to 100 MB), and the models it needs once (browser cached).

## Serving: decisions and trade-offs

**The page (`theatre/viewer/`, under 1 MB) must be same-origin with the site.** The viewer
starts `demo-worker.js` as a module worker, which has to come from the page's origin, and it
reads the bookmarks from `/api/...` with no CORS involved (the site sends no CORS headers).

**The heavy assets (maps, models, sounds, ~1.09 GB and growing with every converted map)
belong in R2**, under `theatre/` at `assets.riversidepug.com`, for the reasons the overview
layers and the demos went there (src/r2.ts, scripts/upload-overviews.ts): written once, read
whole, unmetered egress, and the Dallas box has neither the disk nor the bandwidth to spare next
to srcds. `THEATRE_ASSETS` in `web/src/theatre.ts` is the one switch. Locally (and until R2 is
set up) everything is served same-origin from `web/public/theatre/`.

**The demo.** `/api/matches/<id>/demos/<ordinal>` answers with a 302 to
`https://assets.riversidepug.com/demos/...`. A `fetch` follows it, but a cross-origin response
needs `Access-Control-Allow-Origin`, and the bucket sends none today (checked 2026-11-11: a GET
with `Origin: https://riversidepug.com` has no ACAO header, a preflight OPTIONS gets 403). The
redirect itself is fine: the request starts same-origin, so its Origin stays
`https://riversidepug.com` (not `null`) after the hop. Choice: **add a CORS rule to the R2
bucket** rather than stream the demo through the site. A same-origin proxy would work with no
bucket change, but every 3D view would pull 15 to 100 MB through the Node process on the box
that holds 100 tick, which is exactly what moving demos to R2 got rid of (the demo route's own
comment). The same rule covers the maps, models and sounds once they move there:

```json
[{ "AllowedOrigins": ["https://riversidepug.com"], "AllowedMethods": ["GET", "HEAD"],
   "AllowedHeaders": ["*"], "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"],
   "MaxAgeSeconds": 86400 }]
```

(Add `http://localhost:5173` only if local dev should ever read R2; it does not need to:
locally the demo route streams the file from `DEMO_DIR`.)

**Framing.** Caddy on Dallas sends `X-Frame-Options: DENY` on every response
(`~/l4d/deploy/state/dallas/system/etc/caddy/Caddyfile`), and DENY blocks even a same-origin
frame. Locally there is no Caddy, so the tab works. In production the viewer path needs:

```
@theatre path /theatre/viewer/*
header @theatre X-Frame-Options "SAMEORIGIN"
```

(after the site-wide `header` block, or replace DENY with SAMEORIGIN everywhere; nothing else on
the site is framed). Without it the tab shows a blocked frame; "Open in its own tab" still works.

**Missing files are 404s.** The viewer probes for optional files (`.lit.low.glb`,
`.ladders.json`, `./bookmarks/match-<id>.json`) and takes any 200 as the file. The site's SPA
fallback used to answer every unknown GET with the app shell (200, HTML), which the viewer
would parse as a glb or JSON. `/theatre/` is now excluded from the fallback in `src/server.ts`
and, for dev, in `vite.config.ts`.

**Caching.** Asset names are not versioned (a re-converted map keeps its name), so R2 objects
under `theatre/` should get a short cache (an hour) or the sync should grow a versioned prefix
before long caches are used.

## Viewer changes needed (the spike owns `viewer/`; not done here)

1. **`site=self`** (required for bookmarks on the site). `loadSiteBookmarks` in
   `viewer/index.html` first fetches `./bookmarks/match-<id>.json` (a 404 on the site, logged as
   a console error), then reads `https://riversidepug.com/api/...`. In production that happens
   to be the page's own origin, but anywhere else (local dev, a staging host) it is a CORS
   error and there are no bookmarks. The exact change (verified locally on a scratch copy: 107
   site bookmarks placed for match 1081 map 1, 193 for map 2, no console errors):

   ```diff
   -const SITE = 'https://riversidepug.com';
   +// site=self: the page is served by the PUG site itself (its match page 3D tab), so the bookmarks come
   +// straight from this origin's /api and no ./bookmarks/ file is looked for; site=<origin> names another site
   +const SITE_ARG = qs.get('site');
   +const SITE = SITE_ARG === 'self' ? location.origin : (SITE_ARG || 'https://riversidepug.com');
   ...
   -      const r = await fetch(`./bookmarks/match-${id}.json`);
   -      if (r.ok) file = await r.json();
   +      const r = SITE_ARG === 'self' ? null : await fetch(`./bookmarks/match-${id}.json`);
   +      if (r && r.ok) file = await r.json();
   ```

   The site already passes `site=self`; until the viewer reads it, it is ignored.
2. **Sound base** (needed once the assets move to R2): `sound.js` resolves `../sound/out/` from
   its own URL, so it follows the page, not `modelbase=`. Needs a `soundbase=` param passed into
   `TheatreSound({ baseUrl, mapUrl, workerUrl })`. The sound worker must stay same-origin (module
   worker), so only `out/` and `map.json` would move.
3. **An embed mode** (`embed=1`, wanted, not blocking): hide the help/debug text panel, the
   file picker, the Live box and the match id box, and title the page for the site rather than
   "Theatre Spike". In the 1,022 px frame the help panel covers a third of the view.
4. **Vendor three.js** (security): the page runs on the site's origin and imports three@0.160.0,
   the Draco decoder and meshoptimizer from cdn.jsdelivr.net. A compromised CDN file would run as
   riversidepug.com. Copy them into the viewer folder (the sync can fetch them once) or add
   integrity hashes.

## Testing locally

```sh
gunzip -c ~/l4d/backups/pug/pug-<latest>.db.gz > data/pug.db
# neutralise the copy: no box, no webhook
sqlite3 data/pug.db "UPDATE servers SET host='127.0.0.1', port=9, rcon_port=9, rcon_password='', ftp_host=NULL, ftp_password=NULL, ssh_key_path=NULL, enabled=0, status='offline'; UPDATE settings SET value='' WHERE key='discord_webhook_url'; UPDATE matches SET state='aborted' WHERE state='live';"
# DEMO_DIR: a folder with the match's demos under their stored names (match_demos.filename),
# e.g. symlinks to the spike's parser/demos/match1081-hospital01.dem
DEV_MODE=1 PORT=8093 LOG_LISTEN_PORT=27593 DEMO_DIR=/path/to/demos npx tsx src/index.ts &
API_PORT=8093 npx vite --port 5193 --strictPort &
# http://localhost:5193/match/1081#map-1-3d
```

Without R2 settings the demo route streams the local file, so everything is same-origin.

## Shipping (owner's go-ahead first)

1. R2 bucket CORS rule (above).
2. Upload `theatre/{map,models,sound}` to R2 under `theatre/` (a script like
   `scripts/upload-overviews.ts` with the right content types: `model/gltf-binary`, JSON, PNG,
   WebP, `audio/ogg`), set `THEATRE_ASSETS` to `https://assets.riversidepug.com/theatre`, and land
   the sound-base viewer change.
3. Caddy frame rule for `/theatre/viewer/*`.
4. Ship the page: `deploy-web.sh` excludes all of `web/public/theatre/` today; narrow that to
   the heavy folders so `theatre/viewer/` and `manifest.json` go with the site. Owner call:
   commit a synced viewer snapshot (the repo is public) or sync before each deploy.
5. Check a real match in a browser with no extensions, GPU on and off.

## Phase 2: live 3D (not built)

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
- **Site.** The same tab on the ongoing-match page (`OngoingMatch` in MatchDetail.tsx) with
  `live=<relay URL>` instead of `demo=`; this branch keeps 3D off unfinished matches on purpose.
