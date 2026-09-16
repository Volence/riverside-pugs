# Overview tiled recapture: design

Date: 2026-09-16
Status: approved design, spec under review
Tooling repo: `/home/volence/l4d/overviews` (git, branch `main`)
Web repo: `/home/volence/l4d/pug`

## Goal

The replay viewer's map overviews go soft past about 2x zoom. Each layer is a single
2048x1271 client screenshot covering the whole map at 5 to 8 world units per pixel. This
work recaptures layers as a 2x2 grid of half-scale tiles, stitched into 4096x2542 images at
half the units per pixel (four times the pixels), and does it with nobody at the keyboard.

## Scope

**Phase 1 (this spec): Blood Harvest 1 end to end, then live.**
`l4d_vs_farm01_hilltop` only: build the tooling, capture it unattended, pass the acceptance
checks below, integrate it into the web app alongside the 21 unchanged maps, and deploy it
so the owner can view it against real match data.

**Phase 2 (separate go-ahead):** the other 21 maps with the same tooling, including the
`airport05_runway` layer that is 86% green today.

**Out of scope:** changing map framing, changing the viewer (zoom limits, layer
selection), changing which camera heights are captured.

## What the design relies on

All established by the 2026-09-16 spike (`overviews` commit `3eb43b5`), not assumed:

- The ortho view is centred exactly on the camera: `world_upper_left + (w, h) * upp / 2`
  equals `getpos` x/y to the unit on every existing layer.
- `getpos` reports eye position, 62 units above the `setpos` z. Existing `cut_height`
  values are eye heights.
- `wait` blocks the command buffer at about 300 fps in overview mode, but only after
  `sv_allow_wait_command 1`, and it collapses before the client has spawned no matter
  which cfg issues it. No engine-only trigger exists: `listenserver.cfg` runs at
  `Host_NewGame` but before the client connects; `server.cfg`, `<map>.cfg` and
  `game_mode.cfg` never run on the `+map` launch path.
- `Redownloading all lightmaps` in `console.log` marks the client being in the world,
  about 14 s after launch.
- One synthetic F9 works: a KWin script over `qdbus6` activates the window (focus-stealing
  prevention otherwise swallows the key), then python-evdev presses F9 through
  `/dev/uinput`, which the user can write to.
- A camera move needs more than 2 frames to show up; 120 frames is pixel-identical to 960.
- With noclip off, `setpos` is refused and the player stays where they are. `noclip` is a
  toggle, so it must run exactly once per map load.
- The game runs under Proton as `left4dead.exe`. Process matching needs the bracket trick
  (`[l]eft4dead\.exe`) or it matches its own shell.
- Outputs: DP-1 is 2844x1600 logical at 1.35 scale (4K), DP-2 is 1920x1080. A window
  created on DP-2 captures at 1920x1080. The 2026-09-12 set was 2048x1271, from DP-1.
- Pure green `(0, ~254, 0)` appears where the renderer finds no surface at a low cut. It is
  not water in general (the houseboat lake has none). `gen-overviews.py` already treats it
  as void.

## Architecture

New units in `overviews/`. The manual F9/F10 flow (`run_overview.sh`, `prepare_all.py`,
`finish.py`) stays as it is, as a fallback.

| unit | responsibility | depends on |
|---|---|---|
| `plan.py` | For one map, produce the shot list and the command chain | `gen_overview_cfg.compute_framing`, `prepare_all.height_ladder`, `out/<map>.layers.json` |
| `runner.py` | Run one or more maps unattended, verify each, retry | `plan.py` output, `profile.sh`, KWin, uinput |
| `stitch.py` | Turn a verified run into stitched, cleaned layers | run directory |
| `acceptance.py` | Phase 1 checks against the existing 1x layers | `out4x/`, `out/`, `verify.py` |

Data flow for one map:

```
plan.py <map>
  -> runs/<map>/plan.json          shot list: index, layer z, quadrant, x, y, scale
  -> <game>/cfg/ov_run.cfg         the chain; written only for the map about to run
runner.py <map> [<map> ...]
  -> runs/<map>/attempt-N/         raw tiles (*.tga), console.log, timeline.log, verdict.json
  -> runs/<map>/verified           marker naming the attempt that passed
stitch.py <map>
  -> out4x/<map>_z<+NNNN>.4x.png, .4x.json, <map>.layers.json
acceptance.py <map>
  -> runs/<map>/acceptance.json + comparison crops
```

`out/` is never written. It is the source of what is deployed today.

## Capture geometry

For a map with framing centre `(cx, cy)`, engine scale `s`, and the capture size
`W x H = 2048 x 1271`:

- Full-frame spans: `spanY = 1024 * s`, `spanX = spanY * W / H`, `upp = spanY / H`.
- Tiles use engine scale `s / 2`. Their centres are `(cx - spanX/4, cy + spanY/4)` for top
  left, `(cx + spanX/4, cy + spanY/4)` for top right, and the matching two with
  `cy - spanY/4`.
- The stitched layer is `2W x 2H = 4096 x 2542` at `upp / 2`, with the same
  `world_upper_left` as the 1x layer: `(cx - spanX/2, cy + spanY/2)`.
- Tile centres go to `setpos` with fractional coordinates, so each tile's upper-left falls
  exactly on pixel `(0|W, 0|H)` of the canvas. No resampling anywhere.

**Heights.** When `out/<map>.layers.json` exists, reuse its cut heights exactly
(`setpos z = cut_height - 62`), so each 4x layer compares 1:1 with the 1x layer it replaces.
Otherwise fall back to `height_ladder`. For farm01 that is 5 layers (326, 582, 838, 1406,
2270), 20 tiles, scale 9.0 to 4.5, `upp` 7.251 to 3.626.

## The command chain (`ov_run.cfg`)

Generated per map. No alias defined anywhere else is referenced, and nothing is latched.

1. **Setup, once:** `unbind F9` first, so a second keypress can never start a second
   interleaved chain. Then `echo [OV] run begin`, `sv_allow_wait_command 1`, `sv_cheats 1`
   (a no-op with no notification when the launch line already set it), the capture render
   state from today's `ov_quality`/`ov_vis`/`ov_view` (fullbright, no tonemapping,
   `r_novis 1`, `r_portalsopenall 1`, `r_visocclusion 0`, `r_drawskybox 0`, fog off, HUD,
   crosshair and viewmodel off), director and bots stopped, and finally `noclip`.
2. **Fade wait:** `wait 3000` (about 10 s) before the first shot. `sv_cheats 1` moves to the
   launch command line, so its "Server cvar changed" notification appears during loading
   and is gone before any shot.
3. **Per shot:** `setpos x y z; setang 0 90 0; cl_leveloverview s/2; wait 120; getpos;
   screenshot; wait 30`.
4. **Control shot:** after the last tile, repeat tile 0's pose exactly. Used only for
   verification (see Runner).
5. **End:** `echo [OV] run done; wait 120; quit`.

F9 is bound to the chain's entry alias, and the chain unbinds it. Nothing else is bound.

## Runner

For each map, in order:

1. **Preflight.** Refuse to start if `[l]eft4dead\.exe` is running. Check `/dev/uinput`
   is writable and `qdbus6` reaches KWin. Park any stray `screenshots/*.tga` and
   `console.log` into the attempt directory (never into `out/raw`, where filenames collide
   with the 2026-09-12 captures).
2. **Profile on.** `profile.sh off`, then `profile.sh on 2048 1600` (video settings,
   addons parked, modernhud unmounted), then write `ov_run.cfg`. The `off` comes first
   because `on` exits early with "already active" when a crashed run left its backups
   behind, which would silently keep a stale profile.
3. **Window placement.** Load a KWin script that, when a window with caption
   `Left 4 Dead` appears, sends it to DP-1 and activates it. Unloaded when the map's
   attempt ends.
4. **Launch.** `steam -applaunch 500 -novid -console -condebug -window -w 2048 -h 1600
   +sv_lan 1 +sv_cheats 1 +exec ov_run.cfg +map <map>`. The four dead flags
   (`mat_antialias`, `mat_forceaniso`, `gpu_level`, `cpu_level`) are dropped.
5. **Trigger.** Tail `console.log`, timestamping every line into `timeline.log`. On
   `Redownloading all lightmaps`, wait 3 s, activate the window, press F9. Expect
   `[OV] run begin` within 10 s. If it is absent, activate and press once more. That is safe
   whatever happened: the chain's first command unbinds F9, so a press that did land makes
   the second one inert. Still absent after that: fail the attempt.
6. **Early size check.** When the first tile appears in `screenshots/`, read its TGA
   header. If it is not 2048x1271, kill the game and fail the attempt immediately, with the
   actual size in the verdict, rather than shooting the remaining tiles.
7. **Wait for exit.** The chain quits the game. Timeout: 120 s from launch to spawn, then
   `3 x` the planned chain duration.
8. **Collect.** Move tiles and `console.log` into `runs/<map>/attempt-N/`.
9. **Profile off, and prove it.** `profile.sh off`, then assert no `ov_run.cfg`, no
   `listenserver.cfg`/`server.cfg`/`<map>.cfg` containing capture markers, no `ov_` binds
   in `config.cfg`, both addon VPKs present, modernhud mounted. This runs on every exit
   path, including exceptions and Ctrl-C.
10. **Verify** (writes `verdict.json`):
    - tile count equals the plan, plus the control shot;
    - every `getpos` is within 0.5 units of its planned x/y and planned z + 62, with angle
      `0 90 0`, paired by order;
    - no `setpos into world` after `[OV] run begin`;
    - every tile is 2048x1271;
    - the control shot is pixel-identical to tile 0, proving nothing transient (notification
      text, exposure drift, a spawned entity) differed across the run.
11. **Retry.** On failure, retry up to 2 more attempts, then stop the whole run and report.
    A map already marked `verified` is skipped, so the runner is resumable.

The owner should not type in other windows during a run: each map takes keyboard focus for
about a second.

## Stitching and cleanup (`stitch.py`)

1. **Stitch.** For each layer, paste its 4 tiles at the offsets computed from their
   verified `getpos`. Assert every offset is within 0.01 px of `(0|W, 0|H)`.
2. **Void.** Pixels with `R + G + B < 12`, or with the pure-green signature
   (`R <= 8, B <= 8, G >= 240`), become black. The exact green bounds get confirmed against
   `airport05_runway_z-0378` before Phase 2.
3. **Dip fill.** Walking layers from the lowest up, each layer's void pixels take the
   nearest lower layer's non-void pixel at that position. The lowest layer is unchanged.
   Real void outside the map stays black because it is black in every layer.
4. **Write.** `out4x/<map>_z<+NNNN>.4x.png` plus a `.4x.json` with the same fields as
   today's layer JSON (`image`, `image_w/h`, `engine_scale`, `units_per_pixel`,
   `world_upper_left`, `world_span`, `camera`, `cut_height`, `transform`), and additionally
   `tiles` (source attempt and filenames) and `dip_filled_px`. Then
   `out4x/<map>.layers.json` in today's manifest format.

The `.4x` in the filename is deliberate. The web images are served from fixed URLs with no
content hash, so reusing today's names would let browsers keep showing the old 1x image.

## Acceptance for Blood Harvest 1 (`acceptance.py`)

All automated, results in `runs/l4d_vs_farm01_hilltop/acceptance.json`:

1. **Unattended run** passed verification with no manual input.
2. **Geometry:** each stitched layer, **before dip fill**, downscaled 2x (box filter), is
   compared against the 1x layer at the same cut height, as mean absolute difference (MAD)
   per quadrant. Calibrated in the same run the way `verify.py` calibrates against a
   shifted transform: the 1x layer is also compared against itself shifted by 32 px, which
   is what a misplaced tile looks like. **Pass:** every quadrant's MAD is below half of
   that shifted baseline, and no quadrant is more than 2x the layer's best quadrant.
3. **Seams:** for each seam, the MAD between the two pixel lines either side of it, against
   the MAD between adjacent lines 8 px away on both sides. **Pass:** the seam value is at
   most 1.5x its neighbourhood.
4. **Entity projection:** `verify.py` on each 4x layer, **before dip fill**, scores at least
   96%, the existing set's bar. Before, because filled pixels could otherwise mask a
   misplaced layer.
5. **Visual:** an artifact with matched 1x and 4x crops at the same zoom, for the owner to
   judge. Dip-filled regions get a toggle overlay.

Gate to the web step: checks 1 to 4 pass and the owner approves check 5. The measured
numbers are written back into this spec, so Phase 2 starts from observed values rather than
guesses.

## Web integration (pug)

- `tools/convert-overviews.sh` takes an override source: maps with a manifest in
  `overviews/out4x/` come from there, all others from `overviews/out/` as today. Only the
  overridden maps' WebP files are re-encoded (quality 82), and that map's old WebP files are
  deleted, so the other 21 maps produce no diff.
- `tools/gen-overviews.py` reads both sources with the same precedence. `EXPECTED_SIZE`
  becomes a check that all layers of one map share a size from the known set
  `{2048x1271, 4096x2542}`. The fixed notification mask `HUD_TEXT_BOX` applies only to
  2048x1271 layers.
- `src/mapOverviews.ts` is regenerated, never hand-edited. farm01's entries change to
  `.4x.webp` images, `width: 4096, height: 2542`, and half the `unitsPerPixel`. Its
  `contentBox` is recomputed in 4x pixel space.
- No viewer changes: the viewer already reads per-layer `width`/`height` through
  `mapTransform.ts` and decodes only the layer on screen, so browser memory goes from about
  10 MB to 41 MB for that one image.
- Existing tests, typecheck and build must pass. farm01's added WebP weight is recorded in
  the commit message.

## Deploy

1. Commit the pug changes on `master`, matching how the other overview commits landed.
2. **Gate:** the owner confirms at that moment, and the game server is checked empty with
   no match live. `deploy-web.sh` restarts the `pug-web` service, which hosts the Discord
   bot and match tracking in-process.
3. `./deploy-web.sh`.
4. **Post-deploy:** each farm01 `.4x.webp` URL returns 200 with the expected byte size, and
   a farm01 replay page loads and draws the map.
5. **Rollback:** `git revert` the pug commit and redeploy. `out/` and the other 21 maps
   are untouched throughout.

## Docs and memory

- `overviews/MAP_OVERVIEWS.md` gains a section for the `out4x/` set (4096x2542, `.4x`
  naming, dip fill, green as void) and stops saying every image is 2048x1271.
- The spike scripts are deleted from `overviews/` once `runner.py` has passed farm01.
- The overview memory records Phase 1 as live and Phase 2 as pending.

## Risks

- **Seams from culling.** Props straddling a tile edge might be culled in one tile and not
  the other. Seam check 3 detects it. Fallback: capture tiles with a small overlap and crop,
  which needs resampling and is only worth doing if the check fails.
- **Window placement.** Moving the window to DP-1 may not change the resolution the game
  picked at creation. The early size check stops a bad attempt within one tile. Fallback: the
  runner asks the owner to put focus on DP-1 before launching.
- **Control shot too strict.** If something harmless animates in view (a flickering light),
  the pixel-identical control check fails every attempt. If that happens, compare within a
  noise tolerance instead of exactly, recorded here with the observed difference.
- **Dip fill on real void.** A layer black because it is genuinely outside the map at that
  height would take the lower layer's pixels. Since void outside the map is black in every
  layer, only interior dips should change; `dip_filled_px` and the visual toggle make any
  surprise visible.
