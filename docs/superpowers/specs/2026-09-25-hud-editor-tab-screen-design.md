# HUD editor: the Tab screen (scoreboard and versus score panel)

Date: 2026-09-25. Branch `hud-overnight`. Status: design, written overnight while the owner slept;
nothing here is built. The calls made without the owner are listed at the end under "Decided
overnight, for owner review".

Builds on the Phase 2 spec, `2026-09-24-hud-editor-phase2-design.md` (the "phase 2 spec"): its
evidence standard (section 0), the child registry, the probe gates, and the rule that the preview
draws what the file makes the game draw. Section 6 of that spec deferred the Tab screen as "menus,
not HUD". This spec picks it up.

The goal, in the owner's words from phase 2: "super modular to what L4D can handle". Here that
means: every Tab screen piece a file can recolour, retexture, move or hide is editable, and the
editor says so where game code decides instead.

## 0. How the evidence was gathered

- **client.dll:** the same dll as the phase 2 spec (md5 `9be2860914a3e33cce82b91473148459`),
  dumped with `strings -a -n 3` (143,107 lines). Cited as "(dll: `A|B|C`)", a run of adjacent
  strings, with the line numbers of the dump so a reader can find them again. The committed dump,
  `web/src/hud/dll-hud-strings.txt`, does **not** hold the scoreboard runs yet: its anchors
  (`scripts/dll-hud-strings.sh`) stop at the HUD classes. Task 1 adds them.
- **Stock files:** `web/src/hud/base/stock/resource/ui/scoreboard.res`, `scoreboardsurvivor.res`,
  `scoreboardinfectedplayer.res`, `versusmodescoreboard.res`. Modern's copies are in
  `web/src/hud/base/modern/resource/ui/`. Modern differs from stock in only a few lines (listed in
  1.6), and those lines are tonight's best evidence, because the shots show them honoured.
- **Textures:** read from `pak01_dir.vpk` with the `vpk` and `srctools` modules, as phase 2 did.
- **In game, tonight:** three shots at 1920x1080, Tab held in versus on No Mercy 2, as a survivor,
  from `/home/volence/l4d/hud/probe-modern-art/tab.steps`:
  - stock: `/home/volence/l4d/hud/probe-modern-art/runs/stock/tab/tab-a.png`
  - Modern with its textures: `.../runs/after/tab/tab-a.png`
  - Modern without them (the missing texture shows every box's exact extent): `.../runs/before/tab/tab-a.png`
  Pixel values below were read from these files with PIL. Units are HUD units (480 tall); at
  1080p one unit is 2.25 px.

## 1. The evidence: every piece of the Tab screen

### 1.1 The scoreboard dialog and where it sits

`scoreboard.res` block `scores` is the dialog itself, class `CClientScoreBoardDialog`, subclassed
by `CTerrorClientScoreBoardDialog` (dll 104089-104098:
`CClientScoreBoardDialog|south-east|south|south-west|east|west|north-east|north|north-west|scoreboard_position`;
dll 109197: `?CTerrorClientScoreBoardDialog|VersusModeScoreboard|spectators|...`).

- The file says `xpos 0`, `ypos 42`, `wide f0`, `tall 480`, `scoreboard_position north-west`
  (`scoreboard.res:7-16`).
- **Code places the dialog, not the file's ypos.** Everything in the shots measures from screen
  y 0, not y 42. The versus stat box is at `ypos 70` inside the versus panel, which is at `c-215`
  (25 units) inside the dialog: 95 units, 214 px. The Modern box's top edge is at 214 px. With the
  dialog at y 42 it would be at 308 px. So `scoreboard_position` puts the dialog in the top-left
  corner and its xpos and ypos are not used. `wide f0` makes it the full screen width.
- So every top-level block of `scoreboard.res` is placed in screen units from the top-left corner.
- The `infected_*` widths (`scoreboard.res:19-24`) are `CPanelAnimationVar`s of the dialog
  (dll 109254-109265: `m_infectedAvatarSize|infected_avatar_size|...|m_infectedPingWidth|infected_ping_width`).
  The file's own comment says they size an "Infected sectioned list panel". On PC the infected
  rows are panels loaded from `ScoreBoardInfectedPlayer.res` (the path is in the same run), so
  these widths most likely do nothing on PC. Not offered.
- The same run names `BaseBorder` and `SectionedListPanel.BgColor`. The shots show no border and
  no second background, so neither is drawn in versus. Not offered.

**Block conditionals are a trap here.** `scoreboard.res` has two blocks named `BackgroundImage`:
`[$X360]` first (`:27-40`, 400 wide) and `[$WIN32]` second (`:42-55`, 340 wide). It also has
console-only labels (`MoveSelectionButton`, `VoteKickLabel`, `GamerCardLabel` and so on,
`:611-729`, all `[$X360]`). The parser keeps a block's conditional (`kv.ts` `KvNode.cond`), but
`kvFind` ignores it and returns the first match. Without a fix, an edit to the backdrop would land
on the console block and the preview would draw console labels. Task 2 adds a PC-aware lookup.

### 1.2 The backdrop

`BackgroundImage [$WIN32]` is a plain `Panel` at 0,0, 340 x 480, `bgcolor_override "0 0 0 230"`
(`scoreboard.res:42-55`). On screen: 0 to 765 px wide, the full height, in both shots.

- **File controls:** colour and opacity (`bgcolor_override`), size, visibility.
- **Proven:** Modern writes `0 0 0 200` and its backdrop reads visibly lighter (a dark wall at
  20,20 is 7 6 3 in stock and 13 11 7 in Modern).
- **The HUD draws under the Tab screen.** Modern's own health bar reads 2 165 42 in a normal shot
  (`/home/volence/l4d/hud/probe-phase2/b13/b13-modern/survivor-full/full-1.png` at 185,1036) and
  1 74 13 under the backdrop in tonight's shot: darkened by it. The preview must draw the Tab screen
  over the HUD.
- **The game hides the teammate cards while Tab is held.** The stock survivor HUD has three cards
  along the bottom (b13 stock `full-1.png`). The stock Tab shot has none; the weapons and your own
  health still show. The scoreboard lists the team, so code hides the HUD copy. Other elements were
  not on screen in the shots; probe TAB-1 shot `hud-a` against `tab-a` checks the rest.
- `PaintBackgroundType` is a `Panel` key with rounded corner art (dll 112031-112044:
  `m_nPaintBackgroundType|PaintBackgroundType|vgui/hud/800corner1|...|Texture4`). A rounded backdrop
  or row is possible but unproven (TL4).

### 1.3 The title lines

- `MissionTitle` (`:78-98`): a Label, font `FrameTitle`, `fgcolor_override White`. Code writes the
  text ("No Mercy, Versus Mode" in the shots; dll 109227-109228 `MissionObjective|MissionTitle`
  sit in the dialog's run). File controls colour, font, place, visibility. Colour unproven on this
  class (TS1).
- `MissionObjective` (`:100-121`): empty in versus (nothing drew in the shots). Not offered in v1.
- `ServerName` (`:58-76`): `visible 0`. Not offered.

### 1.4 The coop and survival pieces (not in versus)

`ImgGoldMedal` to `LblBronzeMedalTime` (survival medals, `:123-229`), `Map1` to `Map5` (the coop
chapter strip, `:231-315`, `fillcolor_override DarkGray`), `CurrentMap`, `CurrentMapArrow`,
`OpponentMap`, `RescueMap`, `RescueMapArrow` (`:317-425`, "code sets this to the xpos of the
correct MapN control"). All are looked up by name in the dialog's run (dll 109205-109226). None drew
in the versus shots, so code shows them only in coop or survival. **Later** (section 2.2).

### 1.5 The rows

`Survivor1` to `Survivor4` (`:428-498`) and `Infected1` to `Infected5` (`:500-588`) are
`DontAutoCreate` blocks: code creates one row panel per player and gives it the block's place. The
survivor rows load `ScoreBoardSurvivor.res`, the infected rows `ScoreBoardInfectedPlayer.res`
(both paths in dll 109267-109268). The file places are used as written: rows at `c-95` plus the
row background's `ypos 22` is 167 units, 376 px, and the stock red row starts at 376 px; the four
rows start at 376, 444, 512 and 579 px (30 units apart), 45 px from the left (`xpos 20`).

**Survivor row** (`scoreboardsurvivor.res`; class `SurvivorStatsPanel` on `BasePlayerStatsPanel`,
dll 109603-109613 `?BasePlayerStatsPanel|InfectedStatsPanel|maxHealth|healthBuffer|NoAvatarStatus|PingLabel|PingImage|NoAvatarName|playerindex|PlayerBackground_Selected|PlayerBackground`
and dll 110025-110035 `SurvivorHoldoutRecordImage|SurvivorHoldoutRecord|SurvivorStatsHealth|SurvivorStatsItems|SurvivorStatsNoAvatarStatus|SurvivorStatsStatus|SurvivorStatsNoAvatarName|SurvivorStatsName|SurvivorStatsHead|SurvivorStatsAvatar|#L4D_Scoreboard_Incapacitated`):

| Piece | File (lines) | What the file controls | What code decides |
|---|---|---|---|
| `PlayerBackground` | ImagePanel, `image background_survivor`, 300 x 28 at 0,22 (`:229-246`) | the row art (texture), or a flat `fillcolor` | nothing seen |
| `PlayerBackground_Selected` | Panel, `visible 0`, `bgcolor_override "140 0 0 255"` (`:248-263`) | the colour | shows it on **your** row |
| `SurvivorStatsHead` | ImagePanel 24 x 24 at 2,24 (`:3-15`) | place, size | the portrait |
| `SurvivorStatsAvatar` | `DontAutoCreate`, 16 x 16 at 30,23, `color_outline` (`:16-32`) | place, size, outline colour (dll 102263-102268 `CAvatarImagePanel|vgui::ImagePanel|0o0|Black|m_clrOutline|color_outline`) | the Steam picture; shown for humans only |
| `SurvivorStatsName` / `...NoAvatarName` | Labels at x 50 / x 30 (`:33-75`) | place, font, colour? | the text; which of the two shows (a human gets the avatar and `Name`, a bot `NoAvatarName`: "Mal" at 157 px = x 50, "Bill" at 112 px = x 30) |
| `SurvivorStatsStatus` / `...NoAvatarStatus` | Labels (`:76-113`) | place, font | the text ("DOWN", "DEAD", from `resource/left4dead_english.txt`) |
| `SurvivorStatsHealth` | `HealthPanel` 96 x 7 at 30,40, `monochrome_color Gray` (`:114-130`) | the bar colour (`monochrome_color`, phase 2 Q1 on this class) | the fill fraction |
| `SurvivorStatsItems` | Label, font `L4D_Icons` (`:131-145`) | place, font | which icons |
| `SurvivorHoldoutRecord*` | (`:146-178`) | | survival only |
| `PingImage` / `PingLabel` | Labels (`:179-214`) | place, font | the glyph and number; shown for humans only (the bots' rows have none) |
| `Voice` | 0 x 0, `visible 0` (`:216-227`) | | "disabled in scoreboard" |

**Infected row** (`scoreboardinfectedplayer.res`, class `InfectedStatsPanel`, same run): `Avatar`,
`Name`, `NoAvatarName`, `Status`, `NoAvatarStatus` (`visible 0`), `Score` (`%score%`, font
`MenuTitle`), `PingImage`, `PingLabel`, `PlayerBackground` (a Panel, `bgcolor_override "40 40 40 255"`,
`:150-166`) and `PlayerBackground_Selected` (`140 0 0 255`, `:168-182`). No infected row was on
screen tonight (the infected team was all bots, none spawned), so none of this is seen. TS5.

**The colours, measured.** This is the question the owner asked: which are code and which are file.

- **Your red row is the file.** Stock reads 141 0 0 across the whole row (45 to 720 px), exactly
  `PlayerBackground_Selected`'s `140 0 0 255`. Modern writes `120 20 20 200` and reads 109 18 15.
  That is 120 20 20 at 200 over a dark scene blended in linear light, as the game blends (the
  phase 2 kill notice finding). Code only decides *which* row shows it: yours. In all three shots
  your row was also the first; code sorts you first.
- **The blue-grey teammate rows are the file.** They are the texture `vgui/background_survivor`
  (256 x 8, DXT5): 66 83 90 from the left, fading from about 550 px to the scene at 720 px. Modern
  replaces `image` with `fillcolor "ModPanelBg"` (0 0 0 140) and its rows read dark: an ImagePanel
  `fillcolor` is honoured (dll 112155-112157 `drawcolor|fillcolor|%s, string image, string border, string fillcolor, bool scaleImage`).
- **The grey bars are the file.** Both shots read 155 156 155 in the bar: the white bar texture
  tinted `Gray` (192) by `monochrome_color`. It is the same `HealthPanel` class phase 2 probed
  (Q1: one colour for the whole bar in every state). Without the key the bar may colour by health
  like the HUD's; TL3 asks.
- **Names are code white.** Every name reads 255 255 255. The file gives no colour, and a
  `brighttext` Label takes `Label.TextBrightColor`, which is `FgColor`, which is `Gray` (192) in both
  schemes. The ping number, with no colour either, reads 193: the scheme default. So code sets the
  names white. Whether a file colour beats it is TS6.

### 1.6 The versus score panel, and `if_embedded`

`scoreboard.res` block `CVersusModeScoreboard` (`:731-743`): class `CVersusModeScoreboard`, at
`xpos 15`, `ypos c-215 [$WIN32]` (25 units), 354 x 120. Its pieces are in
`versusmodescoreboard.res` (dll 110709-110754 and 110871-110942, the class name, its labels by
name, the format strings, then `EnemyTeamHighlightImage|YourTeamHighlightImage|Resource/UI/VersusModeScoreboard.res`).
On screen at 1080p: the panel's corner is 34, 56 px.

**`if_embedded`.** The same panel class is also shown on its own (the file's first line: "the
dialogue you see when you are joining the survivor team"). Inside the Tab screen it is
*embedded*, and every child's `if_embedded` sub-block overrides its plain keys (dll 110618-110620
`if_embedded|m_bEmbedded|embedded`; one pooled literal, so the scoreboard's code and the
`CThirdPartyServerPanel` beside it share it). `scoreboard.res` does not set `embedded`: the dialog
sets it when it creates the panel. The shots prove the overrides:

- `BackgroundImage` (`:3-28`) and `ModeTitle` (`:30-54`) carry `if_embedded { visible 0 }`: neither
  drew.
- `TeamYours`, `TeamYourScoreSurvivors`, `YourTeamHighlightImage` carry `if_embedded { xpos 20 }`
  (plain 25). Modern's red box's left edge is at 78 px = (15 + 20) x 2.25.
- `TeamEnemy`, `TeamEnemyScoreSurvivors`, `EnemyTeamHighlightImage` carry `xpos 160` (plain 200).
- `StatBreakdownHighlightImage` carries `if_embedded { wide 320 }` (plain 354): Modern's box spans
  33 to 753 px, 720 px = 320 units.

Only `visible`, `xpos` and `wide` appear in stock `if_embedded` blocks. Whether any other key
(ypos, say) works there is TS8.

The pieces:

| Piece | File (lines) | File controls | Code decides |
|---|---|---|---|
| `YourTeamHighlightImage` | ScalableImagePanel, `image ../vgui/hud/ScalablePanel_bgBlack_outlineRed`, 125 x 32 at 20,43 embedded (`:317-342`) | the texture, place, size, corners | when it shows |
| `EnemyTeamHighlightImage` | the same at 160,43 (`:344-370`) | the same | **hidden in the shots**: only your team's box drew (stock and the missing-texture shot alike) |
| `StatBreakdownHighlightImage` | the same texture, 320 x 45 at 0,70 embedded (`:372-398`) | the texture, place, size | nothing seen |
| `TeamYours` / `TeamEnemy` | Labels "Your Team" / "Enemy Team", `InstructorTitle_ss`, White (`:76-127`) | colour, font, place | nothing seen |
| `TeamYourScoreSurvivors` / `TeamEnemyScoreSurvivors` | `%YourSurvivor%` / `%EnemySurvivor%`, `InstructorTitle`, `dulltext 1`, no colour (`:129-178`) | font, place; colour? | the text ("262", "N/A" for a half not played yet, dll 110739 `#L4D_VSScoreboard_Unplayed`) **and the colour**: both read 146 146 146 in stock and Modern, though `dulltext` would give `Label.TextDullColor` = `DarkGray` (64). TS2 |
| `DistanceLabel` / `HealthLabel` | "Average Distance:" / "Health Bonus:", White, `auto_wide_tocontents 1` (`:180-198`, `:225-248`) | colour, font, place | nothing seen |
| `DistanceAmount` / `HealthAmount` | `%distance%` / `%healthbonus%`, MediumGray, pinned to the label before (`:200-223`, `:250-272`) | colour, font, offset | the number. **Proven:** Modern writes `ModText` (235) and both read 236 |
| `SurvivalMultLabel` / `...Amount` | "Survival Multiplier:" at 100,95, `%survivalmult%` pinned (`:274-315`) | colour, font, place | **when it shows**: not in the shots. It sits in the stat box's empty bottom half (70 to 115). Kong's "Survival Multiplier: x4" bar (research note, `2026-09-25-hud-missing-textures.md:11`, which could not tie it to a file) is almost surely this line in this box, later in a round |
| `StatAnimationBreakdownLabel`, `TeamWinLabel`, `TeamFlipExplanationLabel` | `visible 0` (`:400-460`) | | round-end animations |

**The chain.** `DistanceAmount` pins its top-left corner to `DistanceLabel`'s top-right
(`pin_to_sibling`, `pin_corner_to_sibling 0`, `pin_to_sibling_corner 1`), 10 units right; then
`HealthLabel` to it, 30 right; then `HealthAmount`, 10 right. `DistanceLabel` and `HealthLabel`
are as wide as their text (`auto_wide_tocontents 1`). The keys are the Panel's and Label's own
(dll 112017-112019 `pin_to_sibling_corner|pin_corner_to_sibling|pin_to_sibling`, dll 112163
`auto_wide_tocontents`). Stock shot: the label starts at 62 px, "1%" at about 256 px. So hiding or
recolouring one piece is simple, but moving `DistanceLabel` moves the whole line, and a hidden
label (0 wide) pulls the rest left.

**The boxes take no tint.** `ScalableImagePanel`'s run holds only the image and the four corner
keys (dll 113287-113303 `ScalableImagePanel|...|vgui/%s|draw_corner_width|draw_corner_height|src_corner_width|src_corner_height|%s string image, int src_corner_height, int src_corner_width, int draw_corner_height, int draw_corner_width`).
So a box's colour can only come from its texture. That is why the editor ships generated flat
textures, as the kill notice box does (`build.ts` `NOTICE_BOX_TEXTURE`). **Proven:** Modern's
flat `mod_panel_flat` and `mod_panel_flat_red` (build.ts `MODERN_ART`) draw as flat fills in these
exact boxes (the "after" shot: the team box reads 86 22 21, `95 22 22 205` over the backdrop). The
stock art is 128 x 128 DXT5 with 16-texel corners; a 32- or 64-texel flat square nine-slices to a
flat fill at any size.

Modern's other lines (`versusmodescoreboard.res`): the team labels moved up 6 units, the boxes 3
down and 4 shorter, `PlayerDisplayName` and `DefaultMedium` fonts. All honoured in the after shot.

### 1.7 Other panels on the Tab screen

- `ThirdPartyServerPanel` (`scoreboard.res:745-756`, `r300` 15, 300 x 130, `visible 1 [$WIN32]`):
  class `CThirdPartyServerPanel`, file `Resource/UI/ThirdPartyServerPanel.res`, keys
  `HostnameLabel`, `playercount`, `rank` (dll 110588-110617). It did not draw on the harness's
  local game. It most likely shows on community dedicated servers, which is every Riverside
  server. The file is not in the editor's bases and not on the community allowlist
  (`src/hudFiles.ts`). **Later**, and only with the owner's say on a server probe (TL6).
- `Spectators` (`:590-609`): `%spectators%`, font `ScoreboardVerySmall`, which neither scheme
  defines. Nothing drew (no spectators). Not offered in v1.
- The round-end screens (`FullscreenVersusModeScoreboard.res`, `TransitionStatsSurvivor.res`,
  dll 110698-110710) are separate files and out of scope. `CTransitionStatsPanel` may embed the
  versus panel too; if so, a versus panel edit shows there as well. Not probed (hard to reach).

### 1.8 Fonts

Every font the Tab files name is in `clientscheme.res` except `ScoreboardVerySmall`: `FrameTitle`,
`Default`, `DefaultMedium`, `DefaultDropShadow`, `InstructorTitle`, `InstructorTitle_ss`,
`MenuTitle`, `BodyText_small`, `GameUIButtons`, `L4D_Icons`. So the HUD's `HudEd_` font copies
would work the same way for text sizes. Not in v1 (section 2.2).

## 2. Scope

The rule from phase 2: a control whose effect no in-game shot has seen ships hidden behind its
probe gate, and the preview draws the "code decides" default meanwhile. Tonight's shots already
prove several controls (1.2, 1.5, 1.6), so those ship open.

### 2.1 v1: colours, the versus boxes, one move, a few hides

Open at ship (a shot already proves each):

1. **Backdrop colour and opacity.** `BackgroundImage [$WIN32]` `bgcolor_override`. Opacity 0 is
   the "no backdrop" look.
2. **Versus stat box** (the "Average Distance / Health Bonus" box): Stock, Flat colour, Rounded,
   Image, or none (Flat at opacity 0). A style slot, `tabStatBox`, targeting
   `StatBreakdownHighlightImage`'s `image`.
3. **Team score box** (your team's, and the enemy's when code shows it): one slot, `tabTeamBox`,
   targeting both highlight blocks. One slot, because code shows one box at a time and a player
   thinks of it as one thing.
4. **Versus label colours:** `TeamYours`, `TeamEnemy`, `DistanceLabel`, `DistanceAmount`,
   `HealthLabel`, `HealthAmount`, `SurvivalMultLabel`, `SurvivalMultAmount`. `fgcolor_override`,
   proven on this class by Modern's amounts.
5. **Your row colour:** survivor `PlayerBackground_Selected` `bgcolor_override`.
6. **Teammate row art:** a style slot, `tabRowBg`, targeting survivor `PlayerBackground`'s
   `image`: Stock (the blue-grey fade), Flat, Image. The image key on this block is what the game
   draws today, so a different texture through the same key is the same path.

Built in v1, hidden behind a gate until batch TAB-1 answers (same night):

7. **Title colour** (`MissionTitle` `fgcolor_override`): gate TS1.
8. **Score colour** (262 and N/A): gate TS2, because code colours them now.
9. **Row bar colour** (`SurvivorStatsHealth` `monochrome_color`): gate TS3.
10. **Move the versus panel** (`CVersusModeScoreboard` `xpos`/`ypos`, the element `tabVersus`):
    gate TS4. Its insides stay as they are and move with it.
11. **Infected row colours** (`PlayerBackground` and `_Selected` in the infected row file): gate TS5.
12. **Name colour** (survivor `SurvivorStatsName`, `SurvivorStatsNoAvatarName`; infected `Name`,
    `NoAvatarName`): gate TS6.
13. **Hides:** the whole versus panel (element hide), `MissionTitle`, each versus label and box
    listed above, the ping pieces of the survivor row. Gate TS7.

Nothing else is written. In v1 no Tab piece moves or resizes on its own, and no text size changes.

### 2.2 Later (possible, not v1)

- Moving and sizing pieces inside the versus panel and inside a row (the registry supports it; each
  needs its `if_embedded` rule and the pin chain in the preview, and a probe).
- Text sizes (`HudEd_` font copies; 1.8).
- Moving the survivor list and the infected list (`Survivor1..4` with `moveWith`, TL2).
- The backdrop's size; the whole Tab screen on the right (`scoreboard_position`, TL1).
- Rounded backdrop and rows (`PaintBackgroundType 2`, TL4).
- Status text colours (DOWN, DEAD), the item icons, the portrait and avatar places.
- A "second half" preview state: both scores, the enemy box, the survival multiplier line.
- The coop chapter strip and the survival medals (1.4).
- `ThirdPartyServerPanel` (1.7).
- The versus panel shown on its own, and the round-end screens (1.7).
- Uploading a different texture for your own row (it is a Panel, colour only).

### 2.3 Impossible

- Different colours per teammate row, beyond "your row" and "the others": one file serves every
  row (the Tab twin of phase 2's C.1).
- The row order (code puts you first), how many rows show, what they say (names, scores, 262,
  N/A, distance, health bonus, ping, status), the portraits and avatars.
- Which team's box highlights: code picks.
- The ping glyph's colours: code and the `GameUIButtons` font.
- Anything that needs new data (per-player damage, a round timer).

## 3. The preview

### 3.1 A "Tab held" toggle

A new toolbar button, **Tab held**, beside **Occasional panels**, on both sides. Its title says:
"Preview only: draw the Tab screen (scoreboard and versus score) as the game shows it while you
hold Tab in versus." It is `PreviewState.tab` (`render.ts`), never part of the design.

With it on:

1. The HUD is drawn as now, minus what the game hides under Tab: the teammate cards (1.2). Each
   such element gets `HudElement.underTab: 'hidden'`, so the list lives in data. More join it only
   when TAB-1 shows them gone.
2. The Tab screen is drawn over it, from the design's built files (`buildTrees`), as every other
   panel is.
3. Tab pieces are hit-tested before the HUD, and the HUD under the backdrop stays clickable only
   where no Tab piece is.

Selecting a Tab element or piece in Layers draws the Tab screen even with the toggle off, as a
selected occasional panel is drawn today.

### 3.2 What the tree gives the painter, generically

A new painter module, `web/src/hud/tabscreen.ts`, called from `mock.ts` `drawHud`. It reads the
four files through `buildTrees` and a PC-aware block list (task 2), and draws:

- **Panel** with `bgcolor_override`: a filled rect, blended in linear light (`paintLinearOver`),
  because the backdrop's 230 alpha looks very different blended in gamma.
- **ImagePanel**: its `image` stretched (`scaleImage 1`), or its `fillcolor` (`drawImageChild`
  already does both); a `vgui/hud/hudeditor/` image draws its slot's style.
- **ScalableImagePanel**: a nine-slice (`weapons.ts` `drawNineSlice`) of its texture with the
  file's `src_corner_*` and `draw_corner_*`. The stock `ScalablePanel_bgBlack_outlineRed` is added to
  the exported art; a slot style or a Modern flat panel (`MODERN_ART`) draws as its flat colour or
  its rounded texture, nine-sliced the same way.
- **Label**: text in the file's font, colour and alignment (`fillFontText`, `paintPanelLabel`).
- **HealthPanel**: `render.ts` `drawBar`, tinted by `monochrome_color` (Q1).
- **zpos order, visibility, `if_embedded`**: each versus block is read through `embeddedView`, its
  PC keys with its `if_embedded` keys over them.
- **`auto_wide_tocontents` and `pin_to_sibling`**: a small layout step (task 11) that sizes a label
  to its text and places a pinned block from its sibling's corner. Corners are VGUI's: 0 top-left,
  1 top-right, 2 bottom-left, 3 bottom-right.

### 3.3 What needs a painter (code, not file)

Kept in one table in `tabscreen.ts`, each with its evidence:

| What | The preview's choice |
|---|---|
| The dialog's place | 0,0, the full screen (1.1) |
| Rows: which players | survivor side: you in row 1, then three bots; infected side: TS5 decides |
| Row 1 | `PlayerBackground_Selected` shown, `SurvivorStatsAvatar` a grey square, `SurvivorStatsName` "Player", ping glyph and "25" |
| Bot rows | `NoAvatarName` "Francis", "Louis", "Zoey", no avatar, no ping, the card preview's sample items |
| Portraits | the HUD cards' portrait art (`render.ts` `CARD_PORTRAITS`, `OWN_PORTRAIT`) |
| Ping glyph | three small green bars (a `GameUIButtons` glyph the editor does not export) |
| Health bars | full |
| Versus: which box | `YourTeamHighlightImage` only (1.6) |
| Versus: hidden by code | `SurvivalMult*`, `StatAnimationBreakdownLabel`, `TeamWinLabel`, `TeamFlipExplanationLabel` |
| Hidden in versus | `ServerName`, `MissionObjective`, medals, map strip, `CurrentMap` and the rest, `Spectators`, holdout record, `ThirdPartyServerPanel` |
| Sample texts | `MissionTitle` "No Mercy, Versus Mode"; `%YourSurvivor%` "262"; `%EnemySurvivor%` "N/A"; `%distance%` "1%"; `%healthbonus%` "200"; the `#L4D_VSScoreboard_*` tokens in English from `resource/left4dead_english.txt` ("Your Team", "Enemy Team", "Average Distance:", "Health Bonus:") |
| Score colour | 145 145 145 (MediumGray, as measured), until TS2 says a file colour wins |
| Name colour | white, until TS6 says a file colour wins |

### 3.4 Parity

Tonight's two shots are the baseline: the untouched stock and Modern designs with Tab held must
match them (P0 in section 5): box and row edges within 2 px, colours within the linear-blend
tolerance the kill notice work used.

## 4. The design model, validation, the download

### 4.1 No new top-level field

Every Tab control fits what `HudDesign` already has:

- `elements`: four new entries in `elements.ts`, each with `tab: true` and `file:
  'resource/ui/scoreboard.res'`:
  - `tabBoard`, key `scores`, `move: false`, `resize: 'none'`, `mockPos { x: '0', y: '0' }`, no hide.
  - `tabVersus`, key `CVersusModeScoreboard`, `move: true` (gate TS4), `resize: 'none'`, hide (gate TS7).
  - `tabSurvivors`, key `Survivor1`, `moveWith` `Survivor2..4`, `move: false` in v1.
  - `tabInfected`, key `Infected1`, `moveWith` `Infected2..5`, `side: 'infected'` until TS5,
    `move: false` in v1.
- `children`: four new panels in `children.ts`, `panelId` equal to the element id, as today:
  - `tabBoard` (`scoreboard.res`, frame `hudlayout`): `BackgroundImage` (decor, key
    `bgcolor_override` "Backdrop colour"), `MissionTitle` (label, `colourGate: 'TS1'`).
  - `tabVersus` (`versusmodescoreboard.res`, frame `hudlayout`, new `embedded: true`): the three
    boxes (decor, colour through their slot), and the eight labels of 2.1 item 4 (colour open),
    the two score labels (`colourGate: 'TS2'`).
  - `tabSurvivors` (`scoreboardsurvivor.res`, `repeat: 'cards'`): `PlayerBackground` (decor, art
    through `tabRowBg`), `PlayerBackground_Selected` (decor, key `bgcolor_override` "Your row
    colour"), `SurvivorStatsHealth` (bar, key `monochrome_color` gate TS3), the two name labels
    (`colourGate: 'TS6'`), `PingImage` and `PingLabel`.
  - `tabInfected` (`scoreboardinfectedplayer.res`, `repeat: 'cards'`): `PlayerBackground` and
    `PlayerBackground_Selected` (keys `bgcolor_override`, gate TS5), `Name`, `NoAvatarName`
    (`colourGate: 'TS6'`).
  Every Tab child in v1 has `move: false`, `box: 'none'`, `font: false`, and a new `hideGate: 'TS7'`.
- `styles`: three new slots in `slots.ts`, not advanced-only, `stockNames: []` (the stock
  ScalablePanel textures are shared with the kill notices and must never be overwritten):
  - `tabStatBox` "Versus score box", 64 x 64, targets `versusmodescoreboard.res`
    `StatBreakdownHighlightImage` `image`, default `0 0 0 160`.
  - `tabTeamBox` "Team score box", 64 x 64, targets both highlight blocks, default `140 0 0 200`.
  - `tabRowBg` "Teammate rows", 256 x 32, targets `scoreboardsurvivor.res` `PlayerBackground`
    `image`, default `60 80 90 230` (the stock fade's left end, opaque-ish).
  A 64-texel box keeps a rounded style's radius (16) inside the file's 16-texel source corners.

### 4.2 Registry and model additions

- `ChildDef.hideGate?: ProbeId`: while closed, the page offers no Visible control for the piece
  and `validateDesign` drops a stored `visible: false`.
- `PanelChildren.embedded?: true`: the file's children are read and written through their
  `if_embedded` sub-blocks (4.4).
- `HudElement.tab?: true` and `HudElement.underTab?: 'hidden'`.
- `PreviewState.tab?: boolean`.
- Probes `TS1` to `TS8` in `probes.ts`, all `passed: false` (the ids avoid the existing `T1`).

### 4.3 Validation

`validateDesign` needs no new branch: `childOverride` and `validKeys` already read `colourGate`
and key gates from the registry, element overrides already take `x`, `y` and `visible` by the
element's `move` and props, and slot styles are validated by slot id. What changes:

- `childOverride` drops `visible` when `def.hideGate` is closed.
- The element's `move` is gated: `tabVersus` x and y are dropped while TS4 is closed (a new
  `HudElement.moveGate?: ProbeId`, read in the same place).
- `tabVersus` x is clamped so the panel stays on screen at the design's aspect: 0 to
  `screenW - 354`, y 0 to 360.

### 4.4 The build

- **PC-aware lookup (task 2).** Every Tab read and write goes through a lookup that skips blocks
  whose conditional is false on PC. `kvFind` itself is left alone in v1; switching it everywhere is
  a separate change that the golden tests would have to prove harmless.
- **`if_embedded` writes (task 5).** For an `embedded` panel, `applyChild` writes a key into the
  child's `if_embedded` block when that block already has the key, and into the plain block
  otherwise. So a colour lands on the plain key (both views), and a later x edit on `TeamYours` would
  land on `if_embedded`'s `xpos`. The standalone versus panel gets the colours too, which is
  wanted: it is the same panel.
- **`if_embedded` hides.** `hardHide` also zeroes `wide` and `tall` and sets `visible 0` in the
  block's `if_embedded` when it has any of them. Without that, `StatBreakdownHighlightImage`'s
  `if_embedded { wide 320 }` would undo a hide.
- **File elements with conditionals (task 7).** `layoutPass` writes a file element's `xpos` and
  `ypos` with `pcSet`, not `kvSet`: `CVersusModeScoreboard` has `ypos [$WIN32]` and `[$X360]`, and
  only the PC line may change.
- **Slots.** `stylePass` already writes the textures under `materials/vgui/hud/hudeditor/` and
  repoints the targets; the three new slots need nothing new there. The preview and
  `pictures.build.test.ts` already check that every named picture ships.
- **No Tab edit, no Tab file.** A pass may only open a Tab file when the design has a Tab edit.
  Opening one marks it parsed, and on an imported HUD without its own copy the build would then
  ship the stock file into the download. All the paths above key on the design's own entries
  (`design.children.tab*`, `design.elements.tab*`, `design.styles.tab*`), so an untouched design
  opens none.

### 4.5 The download stays byte for byte

A design with no Tab edit builds exactly the files it builds today, on stock, Modern and imports:

- the existing hashes in `download.golden.test.ts` must not move (the task that changes them has
  failed);
- a new case: an untouched design with `PreviewState.tab` on in the page builds the same bytes
  (the toggle is preview only);
- a new case, added after TAB-4 passes: a stock design with every v1 control set, pinned.

## 5. In-game probes, as launch batches

Same ground rules as phase 2 section 4: one batch is one VPK and one game launch; several
scenarios can share the launch (`run.sh <vpk> a.steps,b.steps`). Before the build lands, each VPK
is the editor's untouched **stock** download plus the hand edits listed (the coordinator's
`build.mts` pattern from `/home/volence/l4d/hud/probe-modern-art/`). Flat test textures are 32 x 32,
UnlitGeneric, `$translucent 1`, `$vertexcolor 1`, `$vertexalpha 1`, made with the editor's VTF
writer, at `materials/vgui/hud/hudeditor/probe_<colour>.vtf/.vmt`. Every shot gets a preview shot of
the same design (the harness's `canvas.toDataURL()` capture), once the preview exists.

Pixel positions below are at 1920x1080; one unit is 2.25 px.

### P0. Parity, no launch

After tasks 12 and 13: the untouched stock and Modern designs with Tab held, captured from the
preview, against tonight's `runs/stock/tab/tab-a.png` and `runs/after/tab/tab-a.png`. Pass: the
backdrop edge at 765 px, the red row at 45 to 720 x 376 to 439 px, the stat box at 33 to 753 x 214
to 315 px (Modern), the team box's left edge at 78 px, text baselines within 2 px, fills within the
linear-blend tolerance.

### TAB-1. Colours, boxes, the move, versus hides (one launch, two scenarios)

Hand edits:

- `scoreboard.res`: `BackgroundImage [$WIN32]` `bgcolor_override "0 0 96 200"` (item 1);
  `MissionTitle` `fgcolor_override "255 0 0 255"` (TS1); `CVersusModeScoreboard` `xpos "420"`,
  the `[$WIN32]` `ypos "20"` (TS4).
- `versusmodescoreboard.res`: `StatBreakdownHighlightImage` `image ../vgui/hud/hudeditor/probe_green`
  (item 2); `YourTeamHighlightImage` `probe_magenta`, `EnemyTeamHighlightImage` `probe_cyan`
  (item 3, and when the enemy box shows); `TeamYours` `fgcolor_override "255 255 0 255"`,
  `DistanceAmount` `"255 0 255 255"` (item 4); `TeamYourScoreSurvivors` and
  `TeamEnemyScoreSurvivors` `"255 128 0 255"` (TS2); `HealthLabel` and `TeamEnemy` hard-hidden
  the way `build.ts` `hardHide` writes (visible 0, 0 x 0, `auto_wide_tocontents 0`) (TS7).
- `scoreboardsurvivor.res`: `PlayerBackground_Selected` `bgcolor_override "0 128 0 255"` (item 5);
  `PlayerBackground` `image ../vgui/hud/hudeditor/probe_purple` (item 6); `SurvivorStatsHealth`
  `monochrome_color "255 0 0 255"` (TS3); `SurvivorStatsName` and `SurvivorStatsNoAvatarName`
  `fgcolor_override "0 255 255 255"` (TS6); `PingImage` hard-hidden (TS7).
- `scoreboardinfectedplayer.res`: `PlayerBackground` `bgcolor_override "0 0 255 255"`,
  `PlayerBackground_Selected` `"255 255 0 255"` (TS5); `Name`, `NoAvatarName`
  `fgcolor_override "0 255 255 255"` (TS6).

`tab-survivor.steps` (proposed):

```
# TAB-1, survivor: Tab held in versus with a teammate at 40 and one down, then with an AI Hunter alive.
cmd sb_all_bot_team 1; sb_dont_shoot 1; sb_stop 1; director_no_mobs 1; director_no_bosses 1; director_no_specials 1
map l4d_vs_hospital02_subway versus
cmd jointeam 2
sleep 3
cmd director_no_death_check 1
survivors
cmd sb_takecontrol $BOT1
sleep 0.8
cmd ent_fire !self sethealth 40
sleep 0.5
cmd sb_takecontrol $BOT2
sleep 0.8
cmd hurtme 100
sleep 0.8
cmd sb_takecontrol $ME
sleep 1.5
shot hud-a
cmd +showscores
sleep 1.5
shot tab-a
cmd -showscores
cmd z_spawn hunter
sleep 1.5
cmd +showscores
sleep 1.5
shot tab-b
cmd -showscores
```

`tab-infected.steps` (proposed):

```
# TAB-1, infected: Tab held as a ghost, then as a spawned Hunter with an AI Smoker on the team.
cmd sb_all_bot_team 1; sb_dont_shoot 1; sb_dont_bash 1; sb_stop 1; director_no_mobs 1; director_no_bosses 1
map l4d_vs_hospital02_subway versus
cmd jointeam 3
sleep 3
shot ghost-hud
cmd +showscores
sleep 1.5
shot tab-c
cmd -showscores
cmd director_no_specials 1
cmd z_spawn hunter
sleep 0.8
cmd sb_takecontrol hunter
sleep 1
cmd z_spawn smoker
sleep 1.5
cmd +showscores
sleep 1.5
shot tab-d
cmd -showscores
```

Questions and passes:

- **Items 1 to 6 (confirm):** tab-a shows a navy backdrop (0 to 765 px), a flat green stat box, a
  flat magenta team box, a yellow "Your Team", a magenta "1%", a green row 1, flat purple rows 2
  to 4.
- **TS1:** "No Mercy, Versus Mode" is red. Fail: white.
- **TS2:** 262 and N/A are orange. Fail: grey 146 (code colours them; the control is dropped and
  the note says so).
- **TS3:** every row bar is red, the 40-health and the down teammate's too. Partial (red only when
  full): record the rule, keep the gate closed.
- **TS4:** the versus panel's stat box starts at 945, 202 px ((420 + 0) x 2.25, (20 + 70) x 2.25),
  over the game, right of the backdrop. Fail: it stays at 34, 56 (code places it).
- **TS5:** tab-c and tab-d show infected rows, blue, with your row yellow. Also answers which lists
  each side sees: does tab-b show an infected row for the AI Hunter to a survivor, and do tab-c
  and tab-d show the survivors?
- **TS6:** every name is cyan, the bots' (`NoAvatarName`) and yours (`Name`), on both sides. Fail:
  white.
- **TS7 (versus pieces):** "Enemy Team" gone; "Health Bonus:" gone,
  and "200" drawn 40 units (90 px) right of "1%" (the chain: 30 + 10 from a 0-wide label); no
  ping glyph on row 1, the ping number still there. Fail: a hidden piece drew.
- **Under Tab:** `hud-a` against `tab-a` and `ghost-hud` against `tab-c`: which HUD elements the
  game hides while Tab is held (the teammate cards are known; the infected cards likely).
- **Enemy box:** does `probe_cyan` show in any shot? Expected: no (first half).
- **Status:** the down teammate's row shows "DOWN"; record its colour (a later control).

### TAB-2. Write rules and later questions (one launch)

Hand edits (the versus panel stays where stock puts it):

- `versusmodescoreboard.res`: `TeamYours` `if_embedded` gains `"ypos" "60"` (TS8);
  `StatBreakdownHighlightImage` hard-hidden, its `if_embedded` `wide` set to 0 too (the 4.4 rule).
- `scoreboard.res`: `scores` `wide "340"` and `scoreboard_position "north-east"` (TL1);
  `Survivor1..4` `xpos "60"` (TL2); `CVersusModeScoreboard` `wide "200"` (TL5).
- `scoreboardsurvivor.res`: `SurvivorStatsHealth` without `monochrome_color` (TL3);
  `PlayerBackground_Selected` `"PaintBackgroundType" "2"` (TL4).

Scenario: `tab-survivor.steps` again.

- **TS8:** "Your Team" is 30 units (67 px) lower than stock's. Fail: unchanged (only stock's keys
  work in `if_embedded`, so edits to other keys must go to the plain block).
- **Stat box hide:** no stat box. Fail: a box drew (the `if_embedded` wide won).
- **TL1:** the whole Tab screen sits at the right edge, the backdrop from 1155 px. Fail: unchanged.
- **TL2:** the rows start 135 px (60 units) right of the backdrop's left edge, not 45. Fail: unchanged.
- **TL3:** the bars are green at full, the 40-health one yellow or orange, the down one red. Fail:
  grey or white.
- **TL4:** your row's corners are rounded.
- **TL5:** the versus panel's content is cut at 200 units (450 px from its left): "Health Bonus"
  cut or gone. Tells whether the panel clips its children, which a later "fit" needs.

### TAB-3. Hides that cannot share TAB-1 (one launch)

Hand edits, all as `hardHide` writes them: `CVersusModeScoreboard` (the whole panel);
`MissionTitle`; survivor `SurvivorStatsName` and `SurvivorStatsNoAvatarName`; `PingLabel`;
infected `Name` and `NoAvatarName`. And `BackgroundImage [$WIN32]` `bgcolor_override "0 0 0 0"`.

Scenarios: `tab-survivor.steps`, `tab-infected.steps`.

- **TS7 (the rest):** no versus panel at all, no title, no names, no ping number. A name that
  still draws means code shows it, as it does the HUD teammate `Name` (phase 2 launch P): then
  names join `CODE_SHOWN` (move off the panel) instead of a plain hide.
- **No backdrop:** the scene undarkened on the left, the rows still drawn.

### TAB-4. Regression from the built editor (one launch, after task 16)

The editor's own download of a design with every v1 control set to TAB-1's values (and the gated
ones the earlier batches passed). Both scenarios. Pass: the same as TAB-1, and each shot matches
its preview shot within P0's tolerances. Pins the golden hash of 4.5.

### Later, owner's call

- **TL6:** `ThirdPartyServerPanel` on a dedicated server. The harness would have to `connect` to
  the local test server (`~/l4d1-ds`). Never a live server.

### Order

P0 needs the preview; TAB-1 to TAB-3 need nothing built and can run now. TAB-1 opens most of v1,
so it goes first.

## 6. Tasks

Each task is test first, then code, then the tests green. Files are under `web/src/hud/` unless
given in full.

1. **dll strings.** Add the anchors `CClientScoreBoardDialog|CTerrorClientScoreBoardDialog|BasePlayerStatsPanel|SurvivorStatsPanel|CVersusModeScoreboard|if_embedded`
   to `scripts/dll-hud-strings.sh`; regenerate `dll-hud-strings.txt`. Test: `dllstrings.test.ts`
   passes and finds `PlayerBackground_Selected`, `YourTeamHighlightImage`, `scoreboard_position`.
2. **PC-aware block lookup.** `pcFind(nodes, path)` and `pcBlocks(nodes)` in `kv.ts`, skipping
   blocks whose conditional fails on PC. Tests (`kv.test.ts`): stock `scoreboard.res`
   `BackgroundImage` is the 340-wide `[$WIN32]` block; `pcBlocks` drops `MoveSelectionButton`.
3. **Probe gates.** `TS1`..`TS8` in `probes.ts`, closed. `probes.test.ts`.
4. **Tab elements.** The four entries in `elements.ts` with `tab`, `underTab: 'hidden'` on
   `teamColumn`, `moveGate` on `tabVersus`. Tests (`elements.test.ts`): keys found in both presets'
   `scoreboard.res`; `tabBoard` at 0,0 by `mockPos`.
5. **Registry.** `TAB_BOARD`, `TAB_VERSUS` (`embedded`), `TAB_SURVIVOR_ROW`, `TAB_INFECTED_ROW` in
   `children.ts`, `hideGate` on `ChildDef`, `embedded` on `PanelChildren`. Tests
   (`children.test.ts`): every name in stock and Modern; gates as 4.1 says.
6. **`if_embedded` in the build.** `applyChild` and `hardHide` per 4.4 for `embedded` panels.
   Tests (`build.test.ts`): a colour on `TeamYours` lands on the plain block; a hide on
   `StatBreakdownHighlightImage` zeroes its `if_embedded` `wide`; `DistanceLabel`'s hide turns
   `auto_wide_tocontents` off.
7. **File element moves.** `layoutPass` writes `el.file` blocks with `pcSet`. Test: moving
   `tabVersus` changes the `[$WIN32]` `ypos` and leaves the `[$X360]` line.
8. **Tab slots.** `tabStatBox`, `tabTeamBox`, `tabRowBg` in `slots.ts`. Tests (`build.test.ts`,
   `pictures.build.test.ts`): a flat stat box ships `materials/vgui/hud/hudeditor/tabstatbox.vtf`
   and `.vmt` and repoints `image`; the team slot repoints both highlight blocks; no slot, no file.
9. **Validation.** `hideGate`, `moveGate`, the `tabVersus` clamp in `design.ts`. Tests
   (`design.test.ts`): a stored hide or move is dropped while its gate is closed and kept once
   forced open (`_setProbe`); a gated colour is dropped.
10. **Golden.** `download.golden.test.ts`: every existing hash unchanged; the new untouched-with-
    Tab-preview case.
11. **Art.** Add `vgui/hud/scalablepanel_bgblack_outlinered` and `vgui/background_survivor` to
    `art.ts` `NEEDED_MATERIALS` and `scripts/export-hud-art.py` `MATERIALS`; run the export (well
    under the 1 MB cap: the folder holds 697 KB). `art.test.ts`.
12. **Tab layout helper.** New `tablayout.ts`: `embeddedView(block)`, label width from text,
    `pin_to_sibling`. Tests (`tablayout.test.ts`) from the stock file: `DistanceAmount` starts 10
    units right of `DistanceLabel`'s text end; a 0-wide `HealthLabel` puts `HealthAmount` 40 units
    right of `DistanceAmount`'s end (30 + 10).
13. **Tab painter: backdrop, title, versus panel.** New `tabscreen.ts`, called from `mock.ts`
    `drawHud` when `PreviewState.tab` is on or a Tab element is selected; the code table of 3.3.
    Tests (`tabscreen.test.ts`, with the existing canvas stubs): draw calls for the backdrop rect,
    the nine-slice of the team box at the embedded x, no enemy box, the sample texts.
14. **Tab painter: rows.** The survivor rows through `render.ts` `drawPanel` with per-row options
    (you, bot); a `BAR_COLOUR` entry for `tabSurvivors` (gate Q1, so the file's `Gray` draws).
    Infected rows on the infected side. Tests: row 1 draws `PlayerBackground_Selected` and
    `SurvivorStatsName`, rows 2 to 4 `NoAvatarName` and no ping.
15. **Hiding the HUD under Tab, and picking.** `drawHud` skips `underTab` elements; `hitTest` and
    `selection.ts` `childAt` put Tab pieces first; `mock.ts` `panelBoxes` gives the four row boxes
    (each row's `PlayerBackground` rect, since the blocks overlap). Tests in `mock.test.ts` and
    `selection.test.ts`.
16. **The page.** `routes/hud/Toolbar.tsx`: the Tab held button. `routes/Hud.tsx`: a "Tab screen"
    group in Styles (the three slots) and in Layers (the four elements). Tests in
    `routes/Hud.test.tsx`: the toggle sets `preview.tab`; the slots render; a gated control is
    absent.
17. **Probe batches (coordinator, outside the repo).** The TAB-1 to TAB-3 VPKs and steps files
    under `/home/volence/l4d/hud/probe-tab/`, a `RESULTS.md` there.
18. **Gate flips.** One task per gate that passes, each updating the tests that pin it hidden
    (phase 2's rule: never folded into another task). A gate that fails retires its control and
    its note says what code does.
19. **Parity (P0) and TAB-4,** then pin the new golden hash.

## Decided overnight, for owner review

1. **Scope is versus.** The coop chapter strip, the survival medals and `ThirdPartyServerPanel`
   are left for later. Riverside plays versus. *Owner: confirm.*
2. **Colours first.** v1 is colours, the box textures, one move and a few hides, no piece moves or
   text sizes, because tonight's shots already prove the colour paths and each move needs its
   `if_embedded` rule and a probe.
3. **Six controls ship open** on tonight's shots alone (backdrop, stat box, team box, versus label
   colours, your row, teammate rows). The rest wait on TS1 to TS8.
4. **The row bar colour is gated (TS3)** even though phase 2's Q1 proved the class, because the Tab
   was never probed and code may treat a scoreboard bar differently (it is grey, not by health).
5. **One team box slot for both teams.** Code shows one box at a time; two slots would be
   fussy. *Owner: say if you want them apart.*
6. **Survivor and infected rows are coloured separately,** not linked, because they are different
   classes and different keys (an image on one, a Panel colour on the other).
7. **Box colours are style slots, not a new design field.** Slots already give Flat, Rounded and
   Image with the upload UI; the kill notice's `noticeBox` field was not copied.
8. **Colour edits on the versus panel go to the plain keys,** so the standalone versus panel gets
   them too. Position and size edits (later) go to `if_embedded` where it holds the key.
9. **`kvFind` is not changed globally.** Tab code uses a new PC-aware lookup; changing `kvFind`
   everywhere waits for its own change and golden proof.
10. **The preview's samples:** "No Mercy, Versus Mode", 262, N/A, 1%, 200, "Player" and three bots,
    ping 25, you in row 1, first-half state (no enemy box, no survival multiplier).
11. **Under Tab, only the teammate cards are hidden** in the preview until TAB-1 shows more.
12. **The Tab elements carry no scale,** and the backdrop no size control, in v1.
13. **Probe ids are TS1 to TS8** (and TL1 to TL6 for later questions), to stay clear of phase 2's
    `T1`.
14. **TL6 (a dedicated server probe) needs the owner.** Even the local test server is a server
    process; the coordinator does not run it without a yes.

Open questions for the owner:

- Is a Tab screen on the right (TL1) wanted, if the game allows it? It changes the whole screen.
- Where does the Tab screen rank against the phase 2 work still open?
- Should Riverside's own `ThirdPartyServerPanel` (the server name box players see on our
  servers) be styled? It needs the allowlist in `src/hudFiles.ts` to grow.

## 7. Probe results (TAB-1 to TAB-3, run 2026-09-25 03:52 to 03:56)

Full table: `/home/volence/l4d/hud/probe-tab/RESULTS.md`. What changes in the scope above:

- **Open at ship, confirmed:** items 1 to 6 of 2.1. The enemy team's box does show (to the
  infected side), so the one `tabTeamBox` slot for both boxes is right.
- **Gates passed** (set `passed: true`, cite the RESULTS file): **TS1** title colour, **TS3** row bar
  colour, **TS4** move the versus panel, **TS7** hides, **TS8** (`if_embedded` takes new keys, so a
  later position edit may write there).
- **TS5 split:** your infected row colour (`PlayerBackground_Selected`) **passed**; the other
  infected rows (`PlayerBackground`) were never on screen (they need a second infected player):
  a new gate **TS5b**, closed.
- **TS6 split:** infected names (`Name`, `NoAvatarName` in the infected file) **passed**; survivor
  names stay white whatever the file says: **no control** for them (code), and the preview draws
  them white.
- **TS2 failed:** 262 and N/A stay grey (code). No control; the preview keeps 145 145 145.
- **Hiding `HealthLabel` also hides `HealthAmount`** (pinned to it). The page hides the pair
  together, and the preview draws neither.
- **New, cheap and proven, added to v1:** "Row bars: grey (stock) / by health / one colour". By
  health removes `monochrome_color` (TL3 showed green, orange, red); one colour writes it (TS3).
- **Proven, left for later (owner's call):** the whole Tab screen on the right (TL1), moving the rows
  (TL2). TL4 (rounded row) was not seen. TL5: the versus panel clips its children, so a later
  resize must grow it.

## 8. Owner's answers (2026-09-25 morning)

- Versus-only scope, one team-box slot, and the rest of the "Decided overnight" list: **yes**.
- The whole Tab screen on the right (TL1): wanted as a later option (confirm the exact control then).
- `ThirdPartyServerPanel` (the server-name box): **eventually**, not now.
