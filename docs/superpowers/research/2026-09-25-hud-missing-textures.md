# Kong's HUD checkerboards: research (2026-09-25)

Read-only research. Nothing was deployed, pushed, or sent over RCON. No live server was touched.

## The report, in short

Kong streams with a custom client HUD. Purple and black checkerboards fill the rounded
background boxes, and nothing else:

- the Tab scoreboard's team score boxes
- the "Survival Multiplier: x4" bar (Dead Air, chapter 2)
- one kill-feed entry ("fyd killed adam")
- the versus score panel ("Average Distance / Health Bonus")

One frame was on Chicago. Portraits, bars and text draw fine.

The checkerboard is Source's "material not found" texture. So the game looked for a
material and got nothing back.

## Bottom line

1. **Most likely: `sv_pure 2` on all four servers, together with a HUD installed as loose
   files.** Under `sv_pure 2` the client refuses any `materials/`, `models/` or `sound/` file
   that did not come from Steam content. Loose files on disk count as "not from Steam". The
   HUD's `.res` layout files are in `resource/` and `scripts/`, which `sv_pure 2` does not
   guard. So the layout loads and its custom materials do not. A panel that points at a
   material only the HUD has draws the checkerboard. This matches the picture exactly.
2. **Next: the HUD names a material it does not ship.** For example, the art is in a second
   addon that is turned off, or was never installed. This happens on every server, and
   offline too.
3. **Ruled out: the file consistency list.** It has no `materials/vgui/`, `resource/` or HUD
   script paths. And when a file does differ, the client disconnects. It never blanks a
   texture.
4. **Ruled out: something only Chicago does.** Chicago runs the same `sv_pure`, the same
   consistency list and the same HUD-relevant plugins as the other three.

**Our HUD editor's output: low risk as shipped, with one real hole.** Every texture the
editor makes goes under `materials/vgui/hud/hudeditor/` (plus `materials/vgui/hud/altcrosshair`).
None of these exist in Steam content. They are safe only because the editor ships them inside
a VPK, and files inside a VPK count as "from Steam". The owner's probes support this: the
editor's textures drew in game under `sv_pure 2`. **If a player unpacks the VPK into loose
files, every editor texture turns into a checkerboard on our servers.** That was not tested
on a dedicated server with Steam authentication.

## Findings with evidence

### 1. All four servers run `sv_pure 2` and have no whitelist

- `deploy/state/{chicago,dallas,riverside-a,riverside-b}/left4dead/cfg/server.cfg:34-36`:
  `sv_consistency "1"`, `sv_pure "2"`, `sv_pure_kick_clients "1"`. The four files are the same
  on these lines. The Chicago `server.cfg` differs only in NFO rates, `sv_downloadurl`
  (line 94) and SourceTV.
- `deploy/state/*/left4dead/cfg/autoexec.cfg:3` sets `sv_pure "1"` at boot. `+exec server`
  runs before `+map` on the launch line (`deploy/l4d1.service`, `ExecStart`). A new
  `sv_pure` value only takes effect at the next map load. So `2` is in force from the first
  map. Chicago's NFO launch line is not in the repo, but its `server.cfg` sets `2` on every
  map load too.
- No `pure_server_whitelist.txt` exists anywhere: not in the deploy repo, not in the local
  test server, not in the game install, and not in any `pak01_dir.vpk` (a grep of the three
  directory files finds 0 hits). It would not matter anyway. The engine's own help text says
  sv_pure 2 "will force all client files to come from Steam (and it will not load
  pure_server_whitelist.txt)" (strings in `left 4 dead/bin/engine.dll` and
  `~/l4d1-ds/server/bin/engine.so`).
- **Which folders `sv_pure 2` guards.** `engine.so` is not stripped. Its
  `IsProtectedBySvPure2(char const*)` (at 0x178f70) checks a path against
  `g_SvPure2_ProtectedDirs` (at 0x2d41c0). That list is exactly `sound`, `models` and
  `materials`. So `resource/` and `scripts/` (HUD layout, schemes, fonts,
  `hudlayout.res`, `mod_textures.txt`) are never blocked. `materials/vgui/...` always is,
  unless it comes from Steam content.
- **What counts as "from Steam".** In the filesystem code (in `~/l4d1-ds/server/bin/dedicated.so`),
  `CBaseFileSystem::HandleOpenFromPackFile` calls `CFileTracker::NoteFileLoadedFromSteam`.
  Loose files go through `NoteFileLoadedFromDisk` (both are in `CFileOpenInfo::HandleFileCRCTracking`).
  So files opened from a pack or VPK are treated as Steam content, and loose files are not.
- **Where `sv_pure 2` came from.** `Rotoblin-AZMod/Changelogs/2021_04_19 Roto-AZMod v8.2.4.txt:12`
  and `:104`: "sv_pure 2 (was 1)". Our servers took the upstream config. In the deploy repo it
  first appears in 91ce5e3 (2026-09-20, "Catch the repo up with what the four servers
  actually run") and 3548473 (2026-09-21, the state snapshot). Both commits recorded what was
  already running. **Nothing in the deploy history has changed `sv_pure` since.**

### 2. Local evidence that pure blocks loose materials and lets VPK files through

- `docs/superpowers/specs/2026-09-19-file-consistency-phase2-design.md:191-205`, the sv_pure
  spike of 2026-09-19. A hunter `.vmt` edited inside `pak01_dir.vpk` loaded. The loose `.vtf`
  it pointed at did not, and "the client saw the missing-texture checkerboard". That is this
  exact failure: a trusted file pointing at a loose file, and the loose file refused.
- `docs/superpowers/specs/2026-09-18-file-consistency-design.md:96-101`: under `sv_pure 2` a
  client with an extra loose file "connected untouched". That test measured kicks, not
  whether the loose file was used. The two notes do not contradict each other. `sv_pure 2`
  refuses the loose file without a word, and does not kick.
- The owner's HUD probes ran under `sv_pure 2`. The client's own
  `left 4 dead/left4dead/cfg/autoexec.cfg:80` sets `sv_pure "2"`. Every probe console log says
  `Server using sv_pure 2.` and, on the client side, `Got pure server whitelist: sv_pure = 2.`
  (for example `/home/volence/l4d/hud/probe-2f/x14/runs/modern/console.log`,
  `/home/volence/l4d/hud/probe-phase2-rest/r4/shots/console.log`). Under those settings the
  editor's own textures in `materials/vgui/hud/hudeditor/`, shipped in an addon VPK, drew
  correctly (`/home/volence/l4d/hud/probe-phase2-rest/RESULTS.md:43`, K4 `probe_blue`). The
  caveat: these were listen servers (`Executing listen server config file`) with no Steam
  authentication. The local dedicated test server (`~/l4d1-ds`) also sets `sv_pure "2"`
  (`server/left4dead/cfg/server.cfg:35`), but it runs `sv_lan 1` (`start-test.sh:22`).

### 3. What the affected boxes draw

Each box Kong lists is a stock rounded background. There are two kinds.

- **Nine-slice image panels** (`ScalableImagePanel`, key `image`):
  - kill feed: `web/src/hud/base/stock/resource/ui/hud/pzdamagerecordpanel.res:100`,
    `label4background` → `../vgui/hud/ScalablePanel_bgBlack_outlineGrey`
  - versus score panel (Distance, Health): `resource/ui/versusmodescoreboard.res:15`
    (`ScalablePanel_bgBlack_outlineGrey`), and `:329`, `:357`, `:384` (`..._outlineRed`)
  - holdout / timer bar: `resource/ui/hud/hudholdouttimer.res:29,82`
    (`ScalablePanel_bgMidGrey_glow`)
- **`PaintBackgroundType 2` panels** (rounded corners drawn by VGUI code). `client.dll`
  (md5 9be28609…) holds `vgui/hud/800corner1` to `800corner4`. Each sits next to a
  `.res` key that overrides it: `Texture1` to `Texture4`, stored in
  `m_nBgTextureId1` to `4` (`web/src/hud/dll-hud-strings.txt:1226-1240`; checked again against
  the installed dll). **So a HUD can point any rounded panel at its own corner material with
  `"Texture1" "..."` in a `.res` file.** Stock uses type 2 widely, for example
  `scripts/hudlayout.res:830-1058` and `resource/ui/zombiepanel.res:89,171`.
- All the stock materials are in `pak01`. `800corner` has 20 hits and
  `scalablepanel_bgblack_outlinegrey` 6 hits in `left4dead/pak01_dir.vpk`. A stock name can
  always fall back to Steam content. **A checkerboard means the name the HUD asked for is not
  in any VPK.**
- I could not tie "Survival Multiplier: x4" to a stock file. `client.dll` has
  `m_iVersusSurvivalMultiplier`, but no `.res` in our stock set names it. It is probably a
  code-built panel with a type 2 or ScalablePanel background.

### 4. How popular L4D1 HUDs are built: exactly the risky pattern

`github.com/l4d/hud_2` is a widely copied competitive L4D1 HUD (cloned read-only to a temp
folder).

- It installs as **loose files** in a `left4dead_custom` folder, added as the first
  `Game` search path in `gameinfo.txt` (its `left4dead/gameinfo.txt:74`). Its README even
  tells players to extract `pak01_dir.vpk` and rename it.
- Its kill feed points at a **custom material name**: `resource/ui/hud/pzdamagerecordpanel.res:104`
  `"image" "../vgui/hud/sigh"`, which ships only as loose `materials/vgui/hud/sigh.vmt/.vtf`.
  Under `sv_pure 2` that is a checkerboard kill-feed box.
- It adds `PaintBackgroundType 2` to the versus scoreboard team boxes
  (`versusmodescoreboard.res:115,162`), the holdout bar (`hudholdouttimer.res:32,84`) and the
  Tab scoreboard (`scoreboard.res:267`). It also ships loose stock-named
  `scalablepanel_bgmidgrey_glow.vmt/.vtf` and more custom names (`blocky`, `blocker`).
- Loose `.vmt` files that swap `$baseTexture` or `$color` for a custom `.vtf` are the usual way
  to recolour panels in these HUDs. Web reports of "sv_pure prevents some custom HUD elements
  from working" in Source games match this.

Kong's four boxes line up one for one with the panels this style of HUD restyles. His layout
works because `.res` files are not guarded. The custom materials behind those panels are loose,
so they are refused.

### 5. File consistency: not the cause

- Live list: `deploy/overrides/left4dead/addons/sourcemod/configs/l4d_consistency.cfg`, 1,531
  paths. By top folder: `sound/player` 693, `materials/particle` 245, `models/props_foliage`
  218, `models/props_plants` 143, `materials/models` 84, `models/infected` 35, `sound/npc` 30,
  `materials/effects` 10, plus a few `sound/weapons`, `materials/detail`, `models/props_debris`
  and `scripts/game_sounds*`. **There are no `materials/vgui/`, `resource/`, `scripts/hud*`
  or `mod_textures.txt` paths.** (The `state/*` copies are an older list of 651 paths. They
  match each other, md5 1012dd67…, and they have no HUD paths either.)
- What happens on a mismatch: the client drops itself with "Server is enforcing consistency
  for this file: <path>" (`consistency/plugin/l4d_consistency.sp:10-25`; phase 1 result in
  `docs/superpowers/specs/2026-09-18-file-consistency-design.md:67-73`). **It disconnects the
  player. It does not force a file, and it does not make the client drop one file.** A HUD
  player who trips it cannot join at all, which is not what Kong sees.
- The batch 2 gate (phase 2 spec, lines 420-424) passed with the owner's client carrying a
  custom HUD.
- Dates: consistency plugin 0.2.2 was carried in 09c0df5 (2026-09-21). The list first went
  into the repo in 91ce5e3 (2026-09-20). Batch 2 (1,531 paths) went live in 28feb32
  (2026-09-23 11:57 -0400).
- `l4d_texture_manager_block` (`configs/l4d_texture_manager_block.cfg`) only checks client
  `mat_*` cvars and kicks. It cannot make a texture go missing.

### 6. Chicago: nothing HUD-relevant is different

`diff -rq state/chicago state/<other>` finds only these differences: hostname, NFO rates and
`sv_downloadurl` (FastDL, maps only), `l4d_itemlimiter` and some extra `cfg/sourcemod/*.cfg`,
the inputstats binary, and SourceTV. Chicago's snapshot also leaves out metamod and other
folders. Sv_pure, consistency and the texture plugin are the same on all four. Any of the four
servers would show the same checkerboards.

### 7. Our HUD editor's output

Every material the editor writes, all in `web/src/hud/build.ts`:

| Feature | Material path | Where |
|---|---|---|
| Kill notice box (Restyle / None) | `materials/vgui/hud/hudeditor/noticebg.vmt/.vtf` | 317, 345-346 |
| Splatter / panel images | `materials/vgui/hud/hudeditor/<splatter id>` (`splatter.ts:46`) | 1386-1388 |
| Restyled slots (panel bg, own bg, incap, dead) | `materials/vgui/hud/hudeditor/<slot id>`; advanced mode also writes stock names `vgui/s_panel_*_incap`, `vgui/s_panel_dead` (`slots.ts:44-52`) | 1976-1980 |
| Weapon boxes | `materials/vgui/hud/hudeditor/weaponboxactive`, `weaponboxinactive` | 2013, 2126 |
| Weapon / item icon uploads | `materials/vgui/hud/hudeditor/<icon entry>` | 2110, 2134 |
| Hidden weapon box / icon | `materials/vgui/hud/hudeditor/clear` | 2012, 2147 |
| Voice icon uploads | `materials/vgui/hud/hudeditor/<entry>` | 2169-2173 |
| Bundled crosshair | `materials/vgui/hud/altcrosshair` (`crosshair/texture.ts:17`, `crosshair/vpk.ts:16`) | 2279 |
| Imported HUDs | every file of the upload, including its own `materials/` | 2362-2375 |

- The editor never sets `Texture1` to `Texture4` and never repoints `ScalablePanel_*`. So of
  Kong's four boxes, **only the kill-feed box could come from us** (noticebg). The other three
  must come from another HUD, or from an imported HUD.
- Normal mode ships one VPK for `left4dead/addons/`. Advanced mode ships
  `riversidehud/pak01_dir.vpk` for a `gameinfo.txt` search path (`build.ts:2396-2425`). **Both
  are VPKs, so on the evidence above they are trusted under `sv_pure 2`.** The owner's own
  setup (`modernhud/pak01_dir.vpk` as a search path, `my_hud.vpk` in addons) works the same
  way.
- **At risk:** a player who unpacks the VPK into loose files. Every path in the table above is
  then refused on our servers, because none of them exist in Steam content:
  - the kill notice box is a checkerboard
  - restyled panels and splatters are checkerboards
  - weapon boxes and uploaded icons are checkerboards
  - hidden boxes show a checkerboard instead of nothing
  - uploaded voice icons are checkerboards
  - the crosshair is a checkerboard

  Advanced-mode stock names (`s_panel_*`) would fall back to stock art instead.
- An imported HUD that the editor re-packs as a VPK is *fixed* by our packaging, because its
  loose materials become VPK content. That may be the simplest fix to offer Kong.
- Not yet proven: the same test on a dedicated server with Steam authentication. All the
  editor evidence comes from listen servers or `sv_lan 1`.

## Likely causes, most likely first, and the fix for each

1. **Loose custom materials refused by `sv_pure 2`** (all four servers).
   - Server side (policy decision for the owner):
     - Keep `sv_pure 2` and tell players to pack their HUD as a VPK. Or:
     - Drop to `sv_pure 1` with a whitelist that allows `materials/vgui/...` from disk. The
       2026-09-19 spike found problems with `sv_pure 1` for sounds and dual paths, so it
       needs its own test. Or:
     - Go to `sv_pure 0`. File consistency, not pure, is what actually enforces the skin
       rules (see the consistency spec).
   - Player side, today: pack the HUD into a VPK in `addons/`, or import it into our editor
     and download the VPK.
   - Editor side: nothing is broken as shipped. Add a line to the download note and the "How
     to play" page: "Keep it as a .vpk. Do not unpack it. Unpacked HUD art shows as
     purple-black squares on our servers." Consider an import warning when an uploaded HUD has
     a `gameinfo.txt`, or loose-install instructions that name `left4dead_custom`.
2. **The HUD names a material it does not ship** (a missing or disabled second addon, as
   with `altcrosshair` on 2026-09-23). The fix is on the player's side: install or enable the
   missing piece. Editor side: `crosshairPass` already refuses to ship an empty crosshair. An
   import check could flag `.res` `image` or `TextureN` values that point at a material that
   is neither in the upload nor in pak01.
3. **Consistency or a Chicago difference.** No evidence for either. No fix needed.

## How to confirm (read-only for the servers)

- Ask Kong for his console after joining. Material-load errors name the missing path.
  (`sv_pure_trace 1` is a server cvar. Test it on `~/l4d1-ds`, not live.)
- Local repro on `~/l4d1-ds`, which already runs `sv_pure 2`: copy `hud_2` or Kong's HUD in
  as loose `left4dead_custom`, connect, and check whether the kill feed box turns into a
  checkerboard. Then pack the same files into a VPK in `addons/`, and check that the
  checkerboard goes away. Do the same with an editor VPK that has been unpacked into loose
  files. If possible, repeat once with `sv_lan 0` so the "from Steam" check runs with
  authentication.

## Questions for the owner

1. Which HUD does Kong use? Is it a VPK in `addons/`, or loose files / a `left4dead_custom`
   folder with a `gameinfo.txt` edit? Did he build it with our editor, or import it into our
   editor?
2. Does it happen on all four servers? On community servers with `sv_pure 0`? In a local
   game?
3. Since when? `sv_pure 2` has been on since the servers were built (upstream 2021 config).
   So a start date near 2026-09-23 would point to a change on his side, not to batch 2.
4. Do other custom-HUD players see checkerboards? Is anyone running an unpacked editor HUD?
5. Should the servers stay on `sv_pure 2`? It gives little protection (consistency does the
   real work) and it breaks loose-file HUDs.
