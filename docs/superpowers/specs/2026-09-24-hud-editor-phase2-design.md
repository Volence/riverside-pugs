# HUD editor, Phase 2: own health, the infected panels, and everything else a HUD file can change

Date: 2026-09-24. Branch `worktree-hud-editor` (HEAD 248754a when written). Status: design, written
overnight while the owner slept; nothing here is built. The calls made without the owner are
listed at the end under "Decided overnight, for owner review".

Builds on, and assumes the reader has:

- the capability audit, `2026-09-22-hud-editor-capability-audit.md` (the "audit"), including its
  probe results section (T1 to T8);
- the teammate cards spec, `2026-09-22-hud-editor-teammate-cards-design.md` ("Phase 1"), whose
  machinery (the child registry in `web/src/hud/children.ts`, `childPass`, `fitPass`, `hidePass`,
  the aspect rule, the card background child, the state preview) is the model for everything here;
- the direct-editing spec, `2026-09-22-hud-editor-direct-editing-design.md` (selection levels,
  Layers panel, ContextPanel);
- the weapons spec, `2026-09-23-hud-editor-weapons-design.md` (how "the keys the game really reads"
  were established from `client.dll`, and the lesson that a registered key can still be unread).

The owner's goal, in their words: "super modular to what L4D can handle". Read as a rule: every
piece a HUD file can move, size, hide, recolour or retexture is editable, and the preview draws
exactly what the file will make the game draw. Where game code decides, the editor says so instead
of offering a control that does nothing.

## 0. How the evidence below was gathered

- **client.dll:** `left 4 dead/left4dead/bin/client.dll` (md5 `9be2860914a3e33cce82b91473148459`),
  dumped with `strings -a -n 3` (143,107 lines). Cited as "(dll: `A|B|C`)", a run of adjacent
  strings, which `grep -n -x` finds again. Adjacent runs matter: MSVC pools identical literals, so a
  bare `Head` or `Dead` proves nothing about a panel (both appear once, far from any HUD code), but a
  run such as `Voice|Items|HealthNumber|HealthIcon|HealthbarTextureBottom|HealthbarTextureTop|MediumGray|Incapacitated|DuckingIcon|Status`
  sits between the `TeammatePanel.res`/`LocalPlayerPanel.res` paths and the class names
  `TeammatePanel|LocalPlayerPanel`, so those names are looked up by that code. A
  `m_fooBar|foo_bar` pair is a `CPanelAnimationVar`: a key the class reads from its block.
- **Stock files:** `web/src/hud/base/stock/**` (byte-identical to the game, audit section 0) and
  the loose `left4dead/scripts/mod_textures.txt` and `resource/ui/spectatorinfected.res`.
- **Textures:** `pak01_dir.vpk` listed and read with the `vpk` and `srctools` modules from
  `/home/volence/l4d/hud/.venv`, the same way `scripts/export-hud-art.py` reads it.
- **In game:** the audit's T1 to T8, and the in-game findings recorded in the project memory
  (TargetID never shows, hidePass's hard hide, kill notices, weapons probes A and B, fonts, colours).

### 0.1 New evidence found for this spec

These were not in the audit and change the design:

1. **`HealthPanel` reads two keys: `monochrome_color` and `inset`**
   (dll: `HealthPanel|>m_monochromeColor|monochrome_color|m_inset|inset|vgui/hud/s_healthbar_outline|vgui/healthbar_grey|vgui/healthbar_white`).
   Stock uses `monochrome_color "Gray"` only on the Tab scoreboard's `SurvivorStatsHealth`
   (`base/stock/resource/ui/scoreboardsurvivor.res:129`). Probe T8 tested only the `healthbar_*`
   textures, never these keys. If `monochrome_color` on a HUD bar draws the fill in that one colour,
   audit hard limit C.7 ("a flat colour per state may not be achievable at all") is wrong for at
   least one flat colour. This is the single most valuable open probe (Q1 below).
2. **The Tank's frame is `PZ_healthbar_250`, not `_3000`.** The Tank reads `hunterhealth.res` (T1),
   whose `BackgroundImage` is `HUD/PZ_healthbar_250` (`hunterhealth.res`), and no string in the dll
   names any `PZ_healthbar_*`. `PZ_healthbar_3000` is named only by the dead `tankhealth.res:45`,
   so it is most likely never drawn. The preview must draw the Tank with the 250 frame.
3. **Ghost class icons are the same textures, pulsing.** The dll names `hud/GhostTeamImage_*`
   (`...hud/ZombieTeamImage_Hunter|icon_skull|resource/UI/HUD/ZombieTeamDisplayPlayer.res|...|hud/GhostTeamImage_Boomer|hud_zombieteam`).
   Those materials have no `.vtf` of their own: each `ghostteamimage_*.vmt` in pak01 points at the
   matching `ZombieTeamImage_*` texture with a `Sine` proxy on `$alpha` (0.02 to 0.3, period 1 s).
   The preview draws the ghost card's icon at alpha 0.16 (the sine's mean).
4. **The infected card's dead skull is `icon_skull`,** a 64x64 cell of `vgui/hud/iconsheet`
   (`mod_textures.txt:749`, x 320 y 192), drawn at `SkullIconPlacement`'s rect (a plain `Panel`).
5. **The ability icons are set by each ability's own code, not the HUD class.**
   `HUD/PZ_charge_lunge` sits beside `CLunge`, `HUD/PZ_charge_tank` beside the Tank's throw,
   `HUD/PZ_charge_smoker` beside `C_Tongue`, `HUD/PZ_charge_boomer` beside `CVomit`, and
   `HUD/PZ_charge_bg` beside the lunge strings (dll). `CHudAbilityTimer`'s own run is
   `?CHudAbilityTimer|Resource/UI/HUD/AbilityTimerHud.res|127 127 127 255|m_abilitySurpressed|ability_surpressed_color|m_abilityCharging|ability_charging_color|m_abilityReady|ability_ready_color|Progress|AbilityImage|BackgroundImage`:
   three colour keys and three looked-up children. `pz_charge_pounce` and `pz_charge_boomer_fill`
   exist in pak01 but no string names them (unused, strong evidence).
6. **`CircularProgressBar` reads `fg_image`, `bg_image`, `progress`, `variable`**
   (dll: `variable|progress|%s, string progress, string variable|SetProgress|CircularProgressBar|CircularProgressBar.BgColor|CircularProgressBar.FgColor|vgui/|?bg_image|fg_image`),
   and two scheme colours. `pz_charge_meter.vmt` is `UnlitTwoTexture` with a motion texture: the
   preview can draw only the base texture, a known small gap.
7. **`CHudTerrorCrosshair` owns the infected ability marker:**
   `?CHudTerrorCrosshair|PZ_crosshair_open|HUD/PZ_charge_crosshair|m_abilitySize|ability_size|255 0 0 255|m_abilityShouldAttack|ability_attack_color|12 206 206 255|m_abilityShouldAttack_ColorBlind|ability_attack_color_colorblind|AbilityProgress`.
   Its size and the "attack now" colour pair are file keys; the three state colours on
   `HudCrosshair` in `hudlayout.res` are the same names as the ability timer's.
8. **Progress bar keys confirmed:** `border_color`, `fill_color`, `empty_color`, `shadow_color`,
   `gap`, `border_thickness`, `shadow_thickness` (dll: `m_borderColor|border_color|m_fillColor|fill_color|ProgressBar.BgColor|m_emptyColor|empty_color|shadow_color|m_gap|m_borderThickness|border_thickness|m_shadowThickness|shadow_thickness`),
   and the icon is code-chosen (`icon_healing`, `icon_reviving`).
9. **Holdout timer keys:** `TimerYPosAlive`, `TimerYPosDead`, `TargetTransitionXOffset`,
   `TargetTransitionYOffset` (dll `m_nTimerYPosAlive|TimerYPosAlive|...`). Survival only.
10. **Frustration bar:** `east_aligned` (dll `m_bEastAligned|east_aligned|FrustrationBar`).

## 1. Re-audit: every HUD element and its insides

Legend. **Today:** what the editor at 248754a offers. **Game reads:** keys with evidence ("file" =
a stock file carries it and the class is live; "dll" = section 0.1 or the audit's dll evidence).
**Code:** what game code decides. **Probe:** a question in section 4 (Q-number).

### 1.1 Survivor side

**Own health.** `hudlayout.res` `CHudLocalPlayerDisplay` (r125, r91, 150x320) holds `LocalPlayer`
(`localplayerdisplay.res`, class `LocalPlayerPanel`, 130x85, `image ../vgui/s_panel_background`),
whose children are `localplayerpanel.res`. Today: move, scale 0.5 to 2, hide (whole element).
The preview draws the insides from `buildTrees` (`mock.ts:161` `paintOwnHealth`, clipped to
`LocalPlayer`).

| Piece | Stock rect | Game reads | Code | Today | Phase 2 | Probe |
|---|---|---|---|---|---|---|
| `LocalPlayer` (self) | 0,0 130x85 | position, size, which clips every child (inferred from how VGUI clips; T6 proved it for the teammate card) | the `image` key, probably never painted (T6 found the teammate card's own `image` unpainted) | none | written by fit (size) | Q2 |
| `Head` | 0,54 25x25 | rect, visible, zpos | portrait per character (`../vgui/s_panel_<char>`, dll run after `LocalPlayerPanel.res`) | drawn | move, square size, hide | |
| `Health` (HealthPanel) | 26,68 96x10 | rect, visible, zpos, **`monochrome_color`, `inset` (dll, new)** | fill and its health colour, temp-health stripes (`cl_temp_health_*` cvars) | drawn | move, size, hide, and colour/inset if Q1, Q3 pass | Q1, Q3 |
| `HealthbarTextureTop` / `Bottom` | 46,44 100x25 / 26,78 80x20 | rect, visible, zpos, `image` (file) | draw colour set to the health colour each update (dll names both in the panel run; owner's screenshot shows them green) | drawn, tinted by `healthRgb` | move, size, hide; art is the splatter spec's (section 5) | Q4 |
| `HealthIcon` (Label ",", `L4D_Icons`) | 26,48 70x26 | rect, font, alignment | colour by health (preview assumes so, `render.ts:294`) | drawn green | move, size, text size, hide | Q5 |
| `HealthNumber` (Label, `HUDHealth`) | 36,48 70x26 (`[$WINDOWS]` line) | rect, font, alignment | text and colour by health (memory: green/orange/red from client.dll) | drawn | move, size, text size, hide; no colour | |
| `Incapacitated` | 26,17 96x96 | rect, visible | art (`s_panel_<char>_incap`), when shown | hidden in preview | state piece: move, square size, hide; Down preview | Q9 |
| `DuckingIcon` | 97,32 25x25 `hud/crouch_survivor` | rect, `image` | when shown (crouched) | hidden in preview | state piece: move, square size, hide; Crouched preview toggle | Q8 |
| (added) `HudEdOwnBg` | none | an `ImagePanel` with `fillcolor` or `image` (Modern's `ModBg` proves a panel file can add one) | none | none | new: own-panel background | Q2 |

**Teammate cards.** Done in Phase 1 (fit, gap, Free slots, every child, card background, Healthy /
Down / Dead). Open items only: the teammate `BackgroundImage` swaps between `hud/healthbar_bg_1..4`
by code (dll run `terror_test_hud_glow|...|hud/healthbar_bg_4|..._3|..._2|..._1|?TeamDisplayPlayer`),
and the audit says "by damage" while `render.ts:90` says "one file per team colour". Neither is
proven (Q10). The `Health` bar gets the same `monochrome_color`/`inset` controls as own health if
Q1/Q3 pass.

**Weapons.** Done (weapons spec): the keys the PC paint reads, box styles and icon hiding via
`mod_textures.txt`, Ammo only preset, Holding preview. Nothing new in Phase 2.

**Use / revive bar** (`HudProgressBar`, `progressbar.res`). Today: move, hide, a flat mock
(`mock.ts:233`). Game reads (file + dll 0.1.8): `BarLabel` (Label, `MenuTitle_DropShadow`,
`fgcolor_override White`), `Bar` (`Panel` with `border_color`, `fill_color`, `empty_color`,
`shadow_color`, `gap`, `border_thickness`, `shadow_thickness`), `AwardIcon` (CIconPanel 24x24,
icon chosen by code: `icon_healing`, `icon_reviving`), `Subtext` (Label). Code: the texts
(`#L4D_progress_*`), the icon, when it shows, `cl_drawprogressbar`. Phase 2 slice 2.6.

**Chat.** Done (writes `basechat.res`, hard hide). Open: style (font size, background colour,
`chatscheme.res`), audit items 15 (the `DeathPanelOpen` offset) and 16. Slice 2.5.

**Kill / incap notices** (`HudPZDamageRecord`). Done (move, free size, hide). Rows are
`recordlabel0..4`; per-row font/colour are file keys; low value, not planned.

**Removed as impossible:** Target ID (`TargetIDLabel` never shows in L4D1, in game 2026-09-23),
the kill feed (no class), `tankhealth.res` (never loaded, T1).

**Other survivor elements, not in the editor, all HUD-file editable (move/hide at least):**
finale meter (`CHudFinaleMeter`, `finalemeter.res` `RescueLabel`, `RescueBar`), voice list
(`HudVoiceStatus`, keys `item_tall` etc., dll), own mic (`HudVoiceSelfStatus`, icon `voice_self`
glyph in `mod_textures.txt:76`), peril notice (`CHudTeamMateInPerilNotice`, `ypos` only), leaving
area warning (`leavingareawarning.res`), vote (`CHudVote`, `votehud.res`), close captions, history
list, damage indicator arcs, holdout timer (survival only, dll keys 0.1.9). Slice 2.8.

### 1.2 Infected side

**Own SI health** (`HudZombieHealth`, r387 r100 400x100). The live files are `hunterhealth.res`
(Hunter and Tank, T1), `smokerhealth.res`, `boomerhealth.res`; `zombiehealthleft_small/large.res`
are loaded (dll) but were never seen on PC (T1) and pair with the hudlayout block's
`if_split_screen_left` (**inferred:** console split screen only). Today: move, scale (all five
files), hide; preview draws the Hunter's file (`mock.ts:323`).

| Piece | Hunter / Smoker | Boomer | Game reads | Code | Phase 2 | Probe |
|---|---|---|---|---|---|---|
| `HudZombieHealth` (container) | 400x100 | same | position, size (clips, inferred) | which file | written by fit | Q11 |
| `BackgroundImage` | 250,0 200x100 `PZ_healthbar_250` | 320,0 100x100 `PZ_healthbar_50` | rect, `image`, `drawColor` (ImagePanel) | none known | move, size, tint, hide | Q12 |
| `Health` (HealthPanel) | 252,69 132x13 | 322,69 64x13 | rect, `monochrome_color`, `inset` | fill | move, size, hide (+Q1 colour) | Q1 |
| `HealthNumber` (Label `MenuTitle`, south-east) | 335,49 50x20 | same | rect, font, alignment, colour (unknown if code recolours) | text | move, size, text size, colour if Q13 passes | Q13 |
| `DuckingIcon` | 320,42 25x25 `hud/crouch_infected` | same | rect, `image` | when shown | state piece | |

Note that the Hunter and Smoker files are geometrically identical; only the Boomer's differs.

**Ability timer** (`CHudAbilityTimer`, r72 r120 80x70; `abilitytimerhud.res`). Today: move, hide,
a drawn arc mock (`mock.ts:327`). Game reads: the three colour keys (dll 0.1.5); children
`BackgroundImage` (ImagePanel 80x80, **no `image` key in the file**), `AbilityImage` (10,10 60x60,
no image key), `Progress` (CircularProgressBar 10,10 60x60, `fg_image HUD/PZ_charge_meter`,
`variable abilityProgress`). Code: `AbilityImage`'s texture (per ability, 0.1.5), very likely
`BackgroundImage`'s (`PZ_charge_bg`, Q14), progress, and which of the pieces take the state
colours (Q15). Modern hides `BackgroundImage` with a 0x0 size (`base/modern/.../abilitytimerhud.res`).

**Crosshair ability marker** (`HudCrosshair`, keys `ability_size` 17 and the three state colours in
`hudlayout.res`; hidden `ability_attack_color`, `ability_attack_color_colorblind`, dll 0.1.7).
Texture `HUD/PZ_charge_crosshair` (code). Today: the editor writes `never_draw` on this block for
"hide the game's crosshair" (T2: hides the engine crosshair for both teams); whether it also hides
the ability marker is unknown (Q16).

**Infected teammate cards** (`CHudZombieTeamDisplay`, 0 r75 f0x100, `HorizPanelSpacing` 140;
card `zombieteamdisplayplayer.res`, self block `ZombieTeamDisplayPlayer` 256x128). Today: move,
scale, spacing; the preview fits each card into the element's rect (`mock.ts:176`), which is not
what the game does.

| Piece | Stock | Game reads | Code | Phase 2 | Probe |
|---|---|---|---|---|---|
| `ZombieTeamDisplayPlayer` (self) | 256x128 | card size (audit A.2) | none | written by fit | Q17 |
| `BackgroundImage` | 0,10 128x64 `hud/infected_healthbar_bg_1`, `drawColor 64 64 64 255` | rect, image, `drawColor` | none known | move, size, tint, hide | Q18 |
| `PlayerImage` | 9,23 24x24 | rect | `hud/ZombieTeamImage_<class>`, ghost `GhostTeamImage_<class>` (0.1.3) | move, square size, hide | Q20 |
| `HealthPanel` | 38,41 86x12 | rect, `monochrome_color`, `inset` | fill | move, size, hide | Q1 |
| `NameLabel` | 13,55 120x12 `PlayerDisplayName`, white | rect, font, colour (raw only; a named colour draws nothing, audit C.9) | text | move, size, text size, colour | |
| `SpawnTimeLabel` | 39,40 55x12 | rect, font, colour | text, shown while dead/ghost (`render.ts:63`) | state piece with text size and colour | Q19 |
| `AbilityProgress` | 2,18 36x36 `fg_image HUD/PZ_charge_meter`, `progress 0.75` | rect, `fg_image` | progress, when shown | state piece, square | Q20 |
| `Dead` | 0,18 256x**0** `hud/overlay_dead` | rect, image | when shown; stock height 0 means the stock card never shows it unless code resizes it | state piece | Q19 |
| `SkullIconPlacement` | 8,24 24x24 (Panel) | rect | draws `icon_skull` there when dead (0.1.4) | state piece, square | Q19 |
| `Voice` | 38,14 16x16, `voice_icon voice_player` | rect, `voice_icon` | when shown | state piece, square | |

Layout: `HorizPanelSpacing` only; `VertPanelSpacing` is dead (audit C.2), so a column or free layout
of infected cards is impossible. `hud_zombieteam 0` hides the whole row and `hud_zombieteam_showself`
adds the player's own card (dll cvars; cvar companion text only).

**Ghost / spawn panel** (`HudGhostPanel`, `hudghostpanel.res`). Today: move, hide, text mock.
Game reads: `WhiteText`, `RedText`, `padding` (hudlayout), `Background` (Panel,
`bgcolor_override 0 0 0 245`, `PaintBackgroundType 2`), `ClassImage` (CIconPanel 85x85, code picks
`tip_<class>`, cells of `vgui/tipgraphic`, `mod_textures.txt:370`), labels `ClassName`
(`%classname%`), `SelectSpawn`, `Ready` (`%ready%`), `Info` (`%info%`), `SpawnLabel`, and
`SpawnBind` (CBindPanel). Code: texts, which lines show, their colour (`WhiteText`/`RedText`).
Slice 2.7.

**Too far / Tank takeover** (`HudZombiePanel`, `zombiepanel.res` `TooFarFromSurvivors`,
`TankTakeover`, dll `TooFarText|tip_crouch|SurvivorsImage|tip_tank_incap|TankImage`). Not in the
editor. Slice 2.7 (move/hide, then insides).

**Tank frustration** (`HudFrustrationMeter`, `frustrationmeter.res`: `Countdown`, `Warning`,
`Warning2`, `FrustrationBar` 150x8 `east_aligned 1`, `FrustrationLabel`). Today: move, hide, mock.
Slice 2.7.

**Dead-infected spawn countdown** (`spectatorinfected.res`, loose in the game, not in `base/`).
Slice 2.8 (a new base file, byte-identical test like the other 39).

**Infected voice** (`HudInfectedVOIP`, `infectedvoip.res`, hidden key `player_name_font_small`).
Slice 2.8.

### 1.3 Tab screens

Scoreboard (`scoreboard.res`, `scoreboardsurvivor.res`, `scoreboardinfectedplayer.res`) and the
versus score panel (`versusmodescoreboard.res`) are HUD-file editable (the files are loaded, dll
paths present), but they are menus, not the in-play HUD, and each is a large model. **Not in
Phase 2** (section 6).

### 1.4 Elements already in the editor: what the game still allows, and preview suspects

The owner asked for Phase 2 to "go hard", including what is already built. For each existing
element: capabilities the files have that the editor does not offer yet, and places where the
preview may not equal the game (each suspect has a probe in section 4, prefixed S for "suspect").

**Every element (cross-cutting).**

- *Hide.* `layoutPass` (`build.ts:183`) writes only `visible 0` for every element except the chat
  and the kill notices, which get `hardHide` (`build.ts:198-213`) because game code re-shows them.
  The same trap is likely for any panel whose class calls `SetVisible` itself (own health while
  alive, the teammate row, the weapon selection, the SI health, the ability timer, the ghost panel).
  Never tested. **S1**, and if any re-shows, a hard hide for that element (slice 2.F).
- *Aspect.* Every in-game check so far ran at the owner's 16:9. The `r`/`c` anchor maths
  (`units.ts`, `build.ts:155` `placed`) and the 853.33 to 853 rounding (memory: residual 1.5 px) are
  untested at 16:10 and 4:3, which the editor offers. **S2**.
- *Scale.* `scalePass` multiplies child rects and clones fonts at `tall * k`; the owner's in-game
  checks were at scale 1 (the owner used scale 2 only in the editor, 248754a). Small scales round
  fonts to sizes Trade Gothic may not hint well; large scales can push a panel off screen (known
  open). **S3**.
- *Title safe.* Most blocks carry `usetitlesafe 1` or `2`. On PC this is inferred to be a no-op;
  a moved panel at x 0 would show a gap if not. **S2** covers it (an element at x 0).

**Weapons** (`weaponSelection`). Built: every key the PC paint reads. Still possible, not offered:
(a) **custom icon art**: the build already repoints `icon_equip_*` in `mod_textures.txt` to a clear
texture (probe B), so it can repoint any of them to a player's uploaded texture (a per-weapon icon
pack, a common competitive HUD feature); (b) **box image upload**, the same path for
`rounded_background_glow`/`_noborder` (today flat, rounded or hidden only); (c) the panel's own
`wide`, which clips the slots (resize is `none`). Hard-coded, say so: box alpha 180, the active
slot's 1.2x growth, the 2-unit (640) slot gap, the 5/3-unit active nudge, clip numbers white.
Suspects: **S4** a flat box colour's own alpha against the game's fixed 180 (does the game
multiply, so a 50% flat box draws at 35%?); **S5** the Holding Item preview and a missing item
(no pills) drawn as the preview draws them.

**Teammate cards** (`teamColumn`). Built: everything in Phase 1. Still possible: (a) bar colour
and inset through `monochrome_color`/`inset` (Q1, Q3); (b) `Items` colour (`fgcolor_override`;
the registry offers none, `children.ts:83`, although the preview already tints by it,
`render.ts:615`); (c) `Head` tint (`drawColor`, unknown whether code resets it); (d) the voice
icon's glyph (`voice_player`, `mod_textures.txt:69`, dll-named) repointed to another glyph or
texture. Suspects: **S6** the stock splatter drawn at alpha 0.35 at full health (a guess from T6);
**S7** Down and Dead state guesses (`render.ts:75-78`: Head hidden when down; Items, bar and number
hidden and the name at half alpha when dead); **S8** `Status` text and colour (the dll's
`MediumGray` sits in the card's lookup run, likely the idle/dead name colour); **S9** the
`HudEdCardBg` flat and rounded backgrounds were never seen in game.

**Chat.** Built: position, size, hard hide, `basechat.res`. Still possible: history font size (a
`HudEd_` copy of `ChatFont` in `chatscheme.res`), background colour/alpha (`basechat.res`
`HudChat` `bgcolor_override`), hide the filters button, the input line's place; keep the
`DeathPanelOpen` offset (today all three events get one position, `build.ts:192`). Suspect:
**S10** a resized chat's history and input line (children rescaled by share, `build.ts:249`) in
game.

**Kill / incap notices** (`killNotices`). Built: move, free size, hard hide. Still possible:
`label_textalign` (hudlayout, west/east/center), per-row font and colour in
`pzdamagerecordpanel.res`, row spacing (the five `recordlabelN` y positions), the notice
background (`label4background`, 9-slice). Suspect: **S11** never seen in game after a move or a
resize.

**Crosshair** (`xhair`). Built: bundle/addon/none, hide the game's crosshair. Still possible: the
infected ability marker (slice 2.3). Suspects: **S12** the bundled texture's on-screen size at 16:10
and 4:3; **Q16** whether `never_draw` also removes the ability marker.

**Use / revive bar, ghost panel, tank frustration.** Mocks today (`mock.ts:233`, `:336`, `:345`), so
the preview's box is not the game's. Slices 2.6 and 2.7 replace the mocks with drawn files; until
then **S13** checks that a moved one lands where the preview's frame says.

**Own health, SI health, infected row, ability timer.** Covered by 1.1 and 1.2. Known open: a
scaled own panel can outgrow the screen (memory, 248754a).

**mod_textures.txt entries the dll names** (so a repoint can restyle them from an addon): the
weapon and item `icon_equip_*`, `rounded_background_*`, `voice_player`, `voice_teammate`,
`icon_painpills`, `SkullIcon` (plus `icon_skull`, `icon_healing`, `icon_reviving`, `tip_*` looked
up through `.res` icon keys). The `pain_*` and `d_skull_cs` entries are Counter-Strike leftovers no
string names.

## 2. The audit's gap table, re-marked

Items 13, 16, 20 to 24, 26, 27 and 35 re-marked after plan task V3 (in-game evidence: /home/volence/l4d/hud/probe-phase2-rest/RESULTS.md, V1).

| # | Gap | Status on 2026-09-24 |
|---|---|---|
| 1-4 | teammate fit, gap spacing, per-card slots, card background | **Done** (Phase 1) |
| 5-8 | teammate insides, items/status, health number, label colour/size | **Done** for the teammate card; Phase 2 extends the same controls to every panel |
| 9 | own-health insides incl. decals | **Open**, slice 2.1 |
| 10 | own-health background | **Open**, slice 2.1 (`HudEdOwnBg`, because `LocalPlayer`'s `image` is most likely unpainted, Q2) |
| 11 | weapon selection layout | **Done**, with the narrower key set the dll proved (audit update) |
| 12 | weapon boxes in normal mode | **Done** (`mod_textures.txt` repoint, probe B). The audit's "item 12 still open" line predates the weapons build |
| 13 | use/revive bar style | **Done** (slice 2.6): label colour and font, icon place and size, every bar key, Subtext colour (seen in V1a while bots revived the player) |
| 14 | target ID movable | **Impossible / removed**: the label never shows in L4D1 (in game 2026-09-23) |
| 15 | chat via `basechat.res` | **Done** (position, size, hard hide). The `DeathPanelOpen` offset is still open, slice 2.5 |
| 16 | chat style | **Done** for the text size (`ChatFont`, C1). The open chat's box colour stays behind gate C2: the chat opens only on a real key press, which the harness cannot send (V1a, V1e) |
| 17 | infected card fit plus insides | **Open**, slice 2.4 |
| 18 | SI health insides | **Open**, slice 2.2 |
| 19 | drop `tankhealth.res`, find the Tank's file | **Done** (hunterhealth, T1) |
| 20 | ghost panel restyle | **Done** (slice 2.7, G-verify) |
| 21 | ability ring and crosshair marker colours and sizes | **Done** (slice 2.3) |
| 22 | tank frustration layout | **Done**: move and hide, and every piece behind gate T1, which V1d passed (the bar's alignment against the stock control V1f) |
| 23 | dead-infected countdown | **Done** (M4): move, colour and size, the line seen in V1c |
| 24 | voice list, own mic | **Done** for your microphone (move, size, picture upload; M-verify). Voice lists: move and hide only, never seen (they list other players); the voice list row keys and the teammate talking icon upload (`voice_player`) wait on gate P2 (a second player talking), closed |
| 25 | server (SourceMod) menu | **Open**, deferred (section 6) |
| 26 | vote panel | **Done** (move, hide, background colour; M-verify) |
| 27 | minor panels | kill notices **done** incl. text size and alignment (gate K5 passed, V1a); too-far box and Tank offer box **done** (gate Z3 passed, V1b; the preview draws the too-far box only); peril, leaving area, finale meter: move and hide only, never seen; captions, damage arcs, history: not started. The hard hide of all nine slice 2.5 to 2.8 elements that show with one client was seen in game against a same-steps control (`/home/volence/l4d/hud/probe-phase2-rest/hide-verify/RESULTS.md`) |
| 28 | kill feed | **Done** (removed) |
| 29 | image tint on image children | **Partly done** (teammate splatter opacity); slices 2.1 to 2.4 add it wherever the game honours `drawColor` |
| 30 | decoration rectangles | **Partly done** (card background child); `HudEdOwnBg` in 2.1; a general "add a rectangle" is deferred |
| 31 | Tab scoreboard, versus panel | **Open**, deferred (not in-play HUD) |
| 32, 33 | global font size, scheme colour theme | **Open**, deferred (Phase 3 "themes") |
| 34 | zpos per child | **Open**, small; slice 2.0 adds Bring forward / Send back for every registry child |
| 35 | item pickup fly-in | **Done** (M3, K-verify) |
| C.7 | bar fill colour impossible | **Re-opened** by `monochrome_color` (0.1.1), pending Q1 |

## 3. Design

### 3.0 Slice 2.0: shared plumbing (no visible change; ships alone)

Phase 1 hard-codes the teammate card in about a dozen places: `children.ts:74` (`TEAM_PANEL`, one
`file`), `design.ts:526` (only `teamColumn` children validated), `build.ts:541` `cardWork`,
`build.ts:570` `cardFrame`, `build.ts:588` `cardChild`, `render.ts:50` `PANEL_FILE`,
`render.ts:63`/`:80` state rules, `selection.ts:28` (`children` selection has no panel),
`selection.ts:59` `hitAt`, `mock.ts:120` `childAt`, `LayersPanel.tsx:91-95`, `ContextPanel.tsx:383`,
`edit.ts:281`/`:382`. Slice 2.0 generalises them without changing any output, so every later slice
is data plus a painter.

**Registry** (`children.ts`):

```ts
export interface PanelChildren {
  panelId: string;                 // the element id: ownHealth, siHealth, abilityRing, infectedRow, progressBar, ...
  file: string;                    // the file the preview draws and the X/Y boxes read (siHealth: hunterhealth.res)
  /** Other files that take the same edits, and how (siHealth: smoker 'same', boomer 'delta'). */
  linked?: { file: string; rule: 'same' | 'delta' }[];
  /** The block that is the panel's own clip box, if fit writes one: { file, block }. */
  frame?: { file: string; block: string } | 'hudlayout';
  /** Card panels repeat per teammate; single panels draw once. */
  repeat: 'cards' | 'single';
  children: ChildDef[];
}
```

`ChildDef` gains:

- `keys?: KeyDef[]`, extra typed keys the child takes, each `{ key: string; label: string; type:
  'colour' | 'int' | 'bool'; range?: [number, number]; evidence: string }`. This is how the Bar's
  seven keys, `monochrome_color`, `inset`, `east_aligned`, `fg_image`-style switches and the like
  become controls without new code per key. `ChildOverride` gains `keys?: Record<string, string>`
  (values already validated as text, the form the file takes).
- `art?: 'splatter'`, a marker the custom-splatter work reads (section 5). Phase 2 sets it and does
  nothing else with it.
- `stateArt?: string`, which preview state shows a `role: 'state'` child (`'down'`, `'crouched'`,
  `'dead'`, `'ghost'`, `'talking'`), replacing the name lists in `render.ts:63-78`.

`ElementDef` (elements.ts) gains `keys?: KeyDef[]` for its own `hudlayout.res` block (the ability
colours, `ability_size`, `WhiteText`/`RedText`), stored as `ElementOverride.keys`.

**Honest registry test.** A committed `web/src/hud/dll-hud-strings.txt` (the strings of the
dll's HUD-related runs, a few hundred lines, generated by a documented one-liner) and a test that
every `KeyDef.key` and every registry child name that is not in the stock file appears in it. This
is the audit's section D "honest registry" item; it stops a registered-but-dead key (the weapons
lesson) from ever being offered. The test carries the dll md5 so a game update that changes the
dll fails loudly.

**Build.** `childPass` already loops over `design.children`; it gains the `linked` rule (write to
the panel's file, then to each linked file as `same` or `delta`, section 3.2). `cardWork`,
`cardFrame`, `cardChild` become `panelWork(design, panelId)`, `panelFrame`, `panelChild`, keyed by
panel; the teammate names stay as thin wrappers so no caller changes in this slice. `applyChild`
writes `keys` with `pcSet` (so a `[$WIN32]` line is replaced, not doubled, `build.ts:229`).

**Design.** `validateDesign` walks `PANEL_CHILDREN` instead of reading `TEAM_PANEL` only
(`design.ts:526`), and validates `keys` against each `KeyDef` (colour through the existing
four-byte check, int clamped to `range`, bool as `"0"`/`"1"`). Unknown panels, children and keys
are dropped, as today.

**Selection.** `{ kind: 'children'; panel: string; names: string[]; card: number | null }`. A
`single` panel's pieces have `card: null`. `hitAt` asks every visible element with a registry
entry for its deepest piece, not only `teamColumn`.

**Preview state.** `CardState` becomes a `PreviewState`:

```ts
interface PreviewState {
  survivor: 'healthy' | 'hurt' | 'down' | 'dead';   // 'hurt' is new: 40 health, orange (healthRgb > 0.15)
  crouched: boolean;                                // shows both DuckingIcons
  infected: 'alive' | 'ghost' | 'dead';
  siClass: 'hunter' | 'smoker' | 'boomer' | 'tank'; // own SI panel, ability icon, own card
  ability: 'ready' | 'charging';                    // ring colour and fill
}
```

The Toolbar shows the survivor tabs on the survivor side and the infected tabs plus a class picker
on the infected side. `hiddenInState` reads each child's `stateArt`.

**zpos.** Every registry child gets Bring forward / Send back in the context menu, written as
`zpos` (audit item 34); the preview already orders by zpos (`render.ts:141`).

Tests: every existing test passes unchanged; a golden test that a design with no Phase 2 fields
builds byte-identical files before and after; the registry and dll-strings tests.

### 3.0F Slice 2.F: correctness fixes from the first probe batches (ships as answers arrive)

Not a feature: whatever probe batches B1 to B4 (section 4) prove wrong in what is already built is
fixed here, before new panels, because a control that silently does nothing is worse than a
missing one. Expected contents, each conditional on its probe: a hard hide for every element that
re-shows (S1), anchor or rounding fixes at 16:10 and 4:3 (S2), the splatter alpha and the Down /
Dead state rules for teammate cards (S6, S7), a box-alpha formula in `weapons.ts` (S4), and any
mock-frame correction for elements not yet drawn from files (S13). Each fix lands with a test that
pins the probe's answer and the screenshot's path in its comment.

### 3.1 Slice 2.1: own health insides (first)

**Registry** (`ownHealth`, file `localplayerpanel.res`, frame `{ localplayerdisplay.res, LocalPlayer }`,
repeat `single`):

| Child | kind | role | box | font | colour | keys | note |
|---|---|---|---|---|---|---|---|
| `Head` | image | content | square | | | | "The game picks the portrait by character." |
| `Health` | bar | content | wh | | | `monochrome_color` (colour), `inset` (int 0..8), both only if Q1/Q3 pass | "The game fills the bar by health." |
| `HealthIcon` | label | content | wh | yes | no (Q5) | | "The game colours this by health." |
| `HealthNumber` | label | content | wh | yes | no | | "The game colours this by health." |
| `HealthbarTextureTop` | image | decor | wh | | no (Q4) | | `art: 'splatter'`; "The game tints these by health." |
| `HealthbarTextureBottom` | image | decor | wh | | no (Q4) | | same |
| `Incapacitated` | image | state (`down`) | square | | | | |
| `DuckingIcon` | image | state (`crouched`) | square | | colour if Q8 says the tint is kept | | |
| `ModBg` | image | decor | none | | | | Modern only; fit resizes it to the panel, as `fitStateArt` does for the card |

The scratch pieces are decor, so they never count toward the fit and are never canvas hit targets
(as the teammate splatter), but they are in Layers and can be moved, sized and hidden. Hiding uses
`hidePass`'s hard hide (size 0 and `drawColor` alpha 0), because code rewrites their draw colour and
may also re-show them (Q4 settles whether the alpha survives; if code rewrites the whole
`drawColor`, size 0 alone does the hiding).

**Fit** (`ElementOverride.fit` on `ownHealth`; default on for new designs, absent means off, as the
teammate card). Content box = union of visible `Head`, `Health`, `HealthIcon`, `HealthNumber`. On
stock that is x 0..122, y 48..79 (Head 0,54 25x25; HealthIcon 26,48 70x26; HealthNumber 36,48
70x26; Health 26,68 96x10), so 122x31. Every child shifts by the box's top-left; `LocalPlayer`
`wide`/`tall` = the box (the clip); the `CHudLocalPlayerDisplay` block's `wide`/`tall` = the box
times scale; `layoutPass` adds the box offset times scale to the element position so fitting
alone moves nothing on screen (the `teamPass` rule, read through `panelWork`, not recomputed).
State art: `Incapacitated` squared at the panel width with the band centred, exactly
`fitStateArt`'s rule for the teammate card (the own incap art is the same texture family);
`DuckingIcon` keeps its size and moves with the shift. Scratch decor keeps its size and position
relative to the content and is clipped by `LocalPlayer`, as today (stock `HealthbarTextureBottom`
already runs 13 units past the 85-unit clip).

**Background.** `LocalPlayer`'s own `image` is treated as never painted (Q2 confirms). A new style
slot `ownBg` ("Your health background", kinds stock/flat/rounded/image, same generator as
`panelBg`) injects `HudEdOwnBg` first in `localplayerpanel.res`, `zpos -5`, at the fitted size,
exactly as `HudEdCardBg` (`build.ts:425-453`). Stock injects nothing.

**Build output.** `resource/ui/hud/localplayerpanel.res` (children, `HudEdOwnBg`, zpos, keys,
`HudEd_` font copies of `HUDHealth` and `L4D_Icons` in `clientscheme.res`),
`resource/ui/hud/localplayerdisplay.res` (`LocalPlayer` size when fitted), `scripts/hudlayout.res`
(`CHudLocalPlayerDisplay` position and size), and for `rounded`/`image` backgrounds
`materials/vgui/hud/hudeditor/ownbg.vtf/.vmt`.

**Preview** (`render.ts`, `mock.ts:161`): `paintOwnHealth` already draws from `buildTrees` and
clips to `LocalPlayer`; it gains the state (`hurt` colours the number, icon and scratches orange via
`healthRgb(40, 100, false)`; `down` draws `Incapacitated` with `s_panel_namvet_incap`, the bar and
number at the incap sample 299 red, and hides `Head` pending Q9; `crouched` draws `DuckingIcon`).
If Q1 passes, `drawBar` draws a bar with a `monochrome_color` as a flat fill of that colour; if Q3
passes, `inset` insets the fill inside `s_healthbar_outline`. New art: `vgui/hud/crouch_survivor`
(128x128, 3.5 KB PNG) and `vgui/hud/s_healthbar_outline` (256x16, 1.7 KB), added to
`MATERIALS` in `scripts/export-hud-art.py` and `NEEDED_MATERIALS` in `art.ts`.

**UI.** Layers lists the own-health pieces under "Your health" like the teammate card's (Head,
Health bar, Health cross, Health number, Scratches top/bottom, Down picture, Crouch icon). The
ContextPanel's `ChildControls` works unchanged once it takes a panel id; the element's controls
gain the Fit checkbox and the `ownBg` style. The Toolbar gains Hurt and a Crouched toggle.

**Tests.** Registry names exist in both presets (Modern hides the scratches, so they must still be
present as blocks: they are); stock fitted box is 122x31 at (0,48); fitting alone leaves every
child's screen position unchanged at scale 1 and 2; `HudEdOwnBg` injected first at the fitted size;
hard hide on a scratch piece; `keys` written with `pcSet`; preview-equals-file parity extended to
`ownHealth` in every state.

### 3.2 Slice 2.2: own SI health (second)

**Registry** (`siHealth`, file `hunterhealth.res`, `linked: [{ smokerhealth.res, 'same' },
{ boomerhealth.res, 'delta' }]`, frame `'hudlayout'` (the `HudZombieHealth` block), repeat
`single`): `BackgroundImage` (image, decor, wh, colour as `drawColor` tint, pending Q12), `Health`
(bar, content, wh, keys as own health), `HealthNumber` (label, content, wh, font, colour pending
Q13), `DuckingIcon` (image, state `crouched`, square), `ModBg` (Modern, decor).

**Linking rule.** Stored numbers are in the Hunter's frame (as the v2 spec proposed). Smoker's file
is geometrically identical to the Hunter's, so it takes the same numbers (`same`). The Boomer's file
takes `x`, `y` as the delta from its own base (`stored - hunterBase + boomerBase`) and `w`, `h` as
the ratio (`stored * boomerBase / hunterBase`), so "bar 20 units shorter" on the Hunter shortens the
Boomer's 64-unit bar in proportion and "move up 10" moves it up 10. `visible`, `fontSize`, `color`,
`keys` apply as they are. The zombiehealthleft files are not child-edited (console only, inferred;
they keep today's scale-only treatment). **Decided overnight:** no per-class unlinking in Phase 2;
a later `children.siHealthBoomer` map can hold Boomer-only overrides without a migration.

**Fit.** Content = union, across the three live files, of visible `Health` and `HealthNumber`
(`BackgroundImage` is decor). Hunter: x 252..385, y 49..82; Boomer: x 322..386, y 49..82; union x
252..386, y 49..82 (134x33). Every child in all three files shifts by (252, 49); `HudZombieHealth`
`wide`/`tall` = 134x33 times scale; the element position gains the offset. `BackgroundImage`
keeps its size and relative place and is clipped by the container (it runs past it on stock too:
the Hunter's frame ends at x 450 in a 400-wide panel).

**Preview.** `paintSiHealth` draws the file of `state.siClass` (Hunter, Smoker, Boomer; Tank =
Hunter's file with the sample 6000 health), clipped to `HudZombieHealth`. The sample number per
class: 250, 250, 50, 6000. The bar is drawn red at full health (the stock SI bar colour; Q13's
screenshot confirms). `DuckingIcon` with `crouched`. New art: `vgui/hud/crouch_infected`.
`pz_healthbar_3000` stays exported but is documented as unused (0.1.2).

**UI.** A class picker on the Toolbar (infected side). The ContextPanel note on every siHealth
piece: "Shown as the <class>. Edits apply to every infected; the Boomer's smaller card moves the
same and sizes in proportion."

**Build output.** `hunterhealth.res`, `smokerhealth.res`, `boomerhealth.res` (children, keys,
fonts), `hudlayout.res` (`HudZombieHealth`), and the scheme copies.

### 3.3 Slice 2.3: ability timer and crosshair marker (with 2.2: "infected own panel")

**Element.** `abilityRing` gains `resize: 'scale'` and `children: ['resource/ui/hud/abilitytimerhud.res']`
(so `scalePass` scales its children) and `keys`: `ability_ready_color`, `ability_charging_color`,
`ability_surpressed_color` (sic, the game's spelling), all colours (dll 0.1.5).

**Registry** (`abilityRing`, file `abilitytimerhud.res`, single): `BackgroundImage` (image, decor,
square, hide), `AbilityImage` (image, content, square; note "The game picks the icon by class"),
`Progress` (other, content, square; key `fg_image` offered later as a ring-texture style, not in
this slice). All three are aspect-locked: the ring art is round.

**Crosshair marker.** A "Crosshair marker" group in the same context panel writes `HudCrosshair`
keys `ability_size` (int 4..64), `ability_ready_color`, `ability_charging_color`,
`ability_surpressed_color`, `ability_attack_color`, `ability_attack_color_colorblind`. They are
not stored on the `xhair` element, which is the editor's own image crosshair (the `xHair` block).
**Decided overnight:** a new non-movable element
`abilityMarker` (side infected, key `HudCrosshair`, `move: false`, `mockPos: c, c`) carries these
keys, so the marker has its own row in Layers and its own preview. It shares the `HudCrosshair`
block with `hideGameCrosshair`'s `never_draw`; the build merges both.

**Preview.** Replace `mock.ts:327`'s arc with the real pieces: `BackgroundImage` as
`vgui/hud/pz_charge_bg` (if Q14 says code sets it; otherwise nothing, as the file names none),
`AbilityImage` as `vgui/hud/pz_charge_<lunge|smoker|boomer|tank>` by `siClass`, `Progress` as
`pz_charge_meter` clipped to a pie wedge at the sample fill (1.0 ready, 0.6 charging), starting at
12 o'clock clockwise pending Q15's screenshot. The state colour is applied to the pieces Q15 names
(until then: to `Progress` only, the stock ready colour being white makes the default look right
either way). The marker draws `pz_charge_crosshair` at `ability_size` in the state colour at screen
centre on the infected side. New art (about 170 KB; downscale the four 256x256 class icons to 128 to
keep the total under the 1 MB cap, which stands at 419 KB today): `pz_charge_bg`,
`pz_charge_lunge`, `pz_charge_smoker`, `pz_charge_boomer`, `pz_charge_tank`, `pz_charge_meter`,
`pz_charge_crosshair`.

**Build output.** `abilitytimerhud.res` (children, scale), `hudlayout.res` (`CHudAbilityTimer`
position and colour keys; `HudCrosshair` marker keys).

### 3.4 Slice 2.4: infected teammate cards (third)

**Registry** (`infectedRow`, file `zombieteamdisplayplayer.res`, frame `{ same file,
ZombieTeamDisplayPlayer }`, repeat `cards`): `BackgroundImage` (image, decor, wh, colour as
`drawColor`, `art: 'splatter'` so the splatter work can offer infected art later), `PlayerImage`
(image, content, square), `HealthPanel` (bar, content, wh, keys as own health), `NameLabel` (label,
content, wh, font, colour), `SpawnTimeLabel` (label, state `dead`/`ghost`, wh, font, colour),
`AbilityProgress` (other, state `alive`, square), `Dead` (image, state `dead`, wh),
`SkullIconPlacement` (other, state `dead`, square), `Voice` (other, state `talking`, square),
`ModBg`-style fills in Modern (`BackgroundImage` there is a fill).

**Fit.** Content = visible `PlayerImage`, `HealthPanel`, `NameLabel`. Stock: x 9..133, y 23..67
(124x44). Every child shifts by (9, 23); the self block's `wide`/`tall` = 124x44. State art:
`Dead` is spread over the whole fitted card (x 0, y 0, card size; stock ships it 0 tall and Q19
says whether code resizes it); `SkullIconPlacement` and `AbilityProgress` keep their size and move
with the shift; `BackgroundImage` keeps its 2:1 shape at the card width, clipped, like the teammate
splatter.

**Spacing.** The row keeps `HorizPanelSpacing` as its only layout key. `infectedRow` moves from
`spacing` (final pitch) to `gap` like the survivor team (migration `gap = spacing / scale -
cardWidth`, clamped at 0, fitted when negative, exactly `teamFields`, `design.ts:386`), and writes
`HorizPanelSpacing = (cardWidth + gap) * scale`. Row only: the UI says why ("The game lays infected
cards in a row; a column is impossible").

**Preview.** `paintInfectedRow` stops fitting cards into the element rect (`mock.ts:176`) and draws
three cards at the file's card size and `HorizPanelSpacing` pitch, clipped to the container, as the
game does. Sample team: Smoker, Boomer, Hunter (the player's own card is not shown unless the
"Show yourself" companion note is ticked; `hud_zombieteam_showself` is a cvar). State `alive`: class
icon `ZombieTeamImage_<class>`, bar red, name. `ghost`: icon at alpha 0.16 (0.1.3), bar and
spawn time per Q20. `dead`: `Dead` overlay, `icon_skull` at `SkullIconPlacement`, `SpawnTimeLabel`
"12". New art: `zombieteamimage_hunter/smoker/boomer/tank` (64x64 each, about 11 KB), the
`icon_skull` iconsheet cell (the EQUIP cutter already cuts iconsheet cells), and the already
exported `infected_healthbar_bg_1` and `overlay_dead`.

**UI.** Cards are a selection level (as survivor cards, `selection.ts:81`) but there is no Free
layout, so dragging a card moves the row. Layers lists "Card 1..3" and the pieces.

**Build output.** `zombieteamdisplayplayer.res` (children, self block size), `hudlayout.res`
(`CHudZombieTeamDisplay` position, `HorizPanelSpacing`), scheme copies.

### 3.5 Slice 2.5: what the built elements still lack

By player value, all on the machinery of 2.0 (typed `keys`, registry children):

- **Weapon icon pack** (highest: competitive HUDs restyle these first). Per icon an upload
  (`icon_equip_<weapon>`, the three items, dual pistols) that the build writes as
  `materials/vgui/hud/hudeditor/icon_<name>.vtf/.vmt` and repoints in `mod_textures.txt` (the path
  probe B proved with the clear texture); the preview draws the upload in the slot's cell exactly
  as it draws the stock iconsheet cell (`weapons.ts`). Same path for a box image (the two
  `rounded_background_*` entries) as a third box kind `image`. Limits reuse `limits.ts` and the
  crosshair image-to-VTF path.
- **Teammate extras:** `Items` colour (registry `colour: true` once B1 (S-items) confirms the game keeps
  it), `Head` tint (if kept), bar colour and inset (Q1, Q3), and the voice glyph repoint
  (`voice_player`).
- **Kill notices:** `label_textalign` as an element key (west/center/east), row font size and
  colour (one control for all five `recordlabelN`, since game code fills them in turn), row
  spacing (rewrites the five y positions), and the background alpha of `label4background`.
- **Chat style:** history font size (a `HudEd_` copy of `ChatFont` in `chatscheme.res`),
  background colour and alpha (`basechat.res` `HudChat` `bgcolor_override`), hide the filters
  button, and keep `DeathPanelOpen`'s own offset when the chat moves.
- **Weapons panel width** (`wide`, resize `free` horizontally only), shown with the slots' clip.

### 3.6 Slice 2.6: use / revive bar

**Registry** (`progressBar`, file `progressbar.res`, single): `BarLabel` (label, font, colour),
`Bar` (other, wh; keys `fill_color`, `empty_color`, `border_color`, `shadow_color` colours, `gap`,
`border_thickness`, `shadow_thickness` ints 0..8), `AwardIcon` (other, square; note "The game
picks healing or reviving"), `Subtext` (label, font, colour). The element gains `resize: 'scale'`
and `children: ['resource/ui/hud/progressbar.res']`.

**Preview.** Replace `mock.ts:233` with a real draw: the bar from its keys (border of
`border_thickness` in `border_color`, a `gap`, the fill at a 0.6 sample in `fill_color`, the rest
`empty_color`, a `shadow_thickness` shadow in `shadow_color`), `BarLabel` "HEALING TEAMMATE"
(`#L4D_progress_heal_friend`, `resource/left4dead_english.txt`) in its font, `AwardIcon` as the
`icon_healing` iconsheet cell (`mod_textures.txt:782`). The exact border/gap geometry is Q22.

**Answered in slice 2.F (task X6).** The preview now draws this from `progressbar.res` through
`web/src/hud/progress.ts` (`barGeometry`): the ring is the Bar's rect less the shadow on its right
and bottom, the shadow is two strips pushed out by its thickness, each thickness is cut to whole
pixels, and the sample is "HEALING YOURSELF" at 0.4 (the B13 mid-heal shots), not the guess above.
The Bar's `border_thickness` and `gap` controls go through `progress.ts` `clampBarKeys` against the
Bar's `tall`, in `validateDesign` and in the control's max, and a Bar resize that would break
`2 * (border + gap) + shadow < tall` clamps the gap first (probe Q22,
`probe-phase2/b1/shots/crops/bar-d.png`).

**Build output.** `progressbar.res`, `hudlayout.res` (`HudProgressBar`).

### 3.7 Slice 2.7: ghost panel, too-far / Tank takeover, Tank frustration

The same pattern, label-heavy. Ghost panel: `Background` (other, wh, key `bgcolor_override`
colour; the alpha is the useful control, the owner's "it covers mid-screen" complaint in the
audit), `ClassImage` (square, hide), `ClassName`, `SelectSpawn`, `Ready`, `Info`, `SpawnLabel`
(labels: rect, font; colour is code's `WhiteText`/`RedText`, so the element offers those two keys
instead), `SpawnBind` (other, move only). Frustration: `Countdown`, `Warning`, `Warning2`,
`FrustrationLabel` (labels), `FrustrationBar` (other, wh, key `east_aligned` bool). Too far / Tank
takeover becomes a new element `zombiePanel` (move, hide), insides later. Preview texts come from
`left4dead_english.txt` ("Choose Spawn Location", "Press to play", "CONTROL"); the ghost class
art is `tip_<class>` from `vgui/tipgraphic` (128x128 cells; export one, the Hunter's).

### 3.8 Slice 2.8: leftovers (move and hide, a few keys)

New elements, each a registry row plus a small painter, no insides:

- `finaleMeter` (`HudFinaleMeter`, both sides), `voiceList` (`HudVoiceStatus`, keys `item_tall`,
  `item_wide`, `item_spacing`, `text_font` size), `ownMic` (`HudVoiceSelfStatus`, scale),
  `infectedVoice` (`HudInfectedVOIP`), `perilNotice` (`HudTeamMateInPerilNotice`, y only),
  `leavingArea` (`HudLeavingAreaWarning`), `vote` (`CHudVote`), `spawnCountdown` (a new base file
  `resource/ui/spectatorinfected.res`, `Countdown` label position and font), `holdoutTimer`
  (`HudHoldoutTimer`, survival only, marked so in the UI).
- Item pickup fly-in off: one switch that rewrites `StartItemPickup1..3` in `hudanimations.txt` to a
  zero-length path.

## 4. In-game probes, as launch batches

For the unattended harness at `/home/volence/l4d/hud/ingame-harness/` (it backs up and restores
every protected file by sha256, installs the test HUD as `addons/zz_harness_hud.vpk` and drives
the console over `-netconport`, `lib.sh`, `netcon.py`).

**Ground rules** (owner tips, 2026-09-24):

- A HUD takes effect only after a full game restart, so **one batch = one VPK = one game launch**.
  Every batch below packs several questions whose changes do not interfere (distinct colours, pieces
  that do not overlap), and takes a sequence of screenshots inside that one launch.
- Special infected cannot spawn in the saferoom, nor in the survivors' sight. Infected batches
  move the ghost first: `setpos` to a spot recorded once per map with `getpos` (out of the
  saferoom, out of the survivors' line of sight), wait 1 s, then `+attack` to spawn. If the
  director keeps the ghost in "waiting", `z_ghost_delay_min 0; z_ghost_delay_max 0` and stopping
  the survivor bots (`sb_stop 1` if L4D1 has it; the harness author checks with `find sb_`) help.
- Survivor batches use the owner's recipe (campaign, Expert, map 2): `sv_cheats 1;
  z_difficulty impossible; map l4d_hospital02_subway`. Infected batches need versus with the
  player on the infected team (`jointeam 3`) and `hud_zombieteam_showself 1` so the player's own
  card is on screen even with no other infected.
- Each batch's VPK is an editor download of the named design (so it is exactly what players get)
  plus the hand edits listed, made to the built files before packing. A solid magenta test
  texture is added at `materials/vgui/hud/hudeditor/probe_magenta.vtf/.vmt` (UnlitGeneric,
  `$translucent 1`, `$vertexcolor 1`, `$vertexalpha 1`, the flags of `crouch_survivor.vmt`), made
  with the editor's own VTF writer.
- **Preview parity:** for every batch the harness also saves the editor's preview of the same design
  at the same aspect via `canvas.toDataURL()` (never a CDP full-page capture, memory: it re-centres
  by 7 px), so each game shot has a preview shot to diff.
- Shots are named `<batch>-<letter>.jpg` and the batch's `probe.txt` lists every change and the
  question each shot answers, so a later reader needs nothing else.

Questions are numbered Q (a new panel's behaviour) or S (a suspect in something already built,
section 1.4).

### B1. Survivor: own panel, bars, card extras, weapon box alpha (one launch)

Design: stock, fitted teammate cards with the health number on, `panelBg` flat `0 0 128 200`
(S9), weapon active box flat `255 0 0 128` (S4). Hand edits:

| Q | File, change | Look at |
|---|---|---|
| Q1 | `localplayerpanel.res` `Health` + `"monochrome_color" "255 0 255 255"`; `teammatepanel.res` `Health` + `"monochrome_color" "0 255 255 255"` | own bar magenta, teammate bars cyan, or both still green; in shot (c) whether magenta holds when the bar would be orange |
| Q2 | `localplayerdisplay.res` `LocalPlayer` `"image" "hud/hudeditor/probe_magenta"`, `"wide" "100"` (height left at 85) | a magenta box behind the panel (image painted) or none; the own bar (to x 122) and top scratches cut at x 100 (clip works, fit is safe) |
| Q3 | own `Health` + `"inset" "3"`, `"tall" "16"` | the fill inset inside an outline, or a plain 16-tall bar |
| Q4 | `HealthbarTextureTop` + `"drawColor" "255 0 255 255"`; `HealthbarTextureBottom` `"visible" "0"` only | top still health-coloured (code tint wins) or magenta; bottom gone, or re-shown by code (hard hide needed) |
| Q5 | `HealthIcon` + `"fgcolor_override" "0 0 255 255"` | blue cross, or health colour |
| Q8 | `DuckingIcon` + `"drawColor" "255 0 255 255"` | shot (b): icon shown only crouched; magenta or white |
| S-items | `teammatepanel.res` `Items` + `"fgcolor_override" "255 255 0 255"` | yellow item icons, or white |
| S-head | teammate `Head` + `"drawColor" "255 128 128 255"` | pink-tinted portraits, or plain |
| S8 | teammate `Status` + `"fgcolor_override" "255 0 255 255"` | any status text and its colour |
| Q22 | `progressbar.res` `Bar` `"fill_color" "255 0 255 255"`, `"empty_color" "0 0 255 255"`, `"border_thickness" "3"`, `"gap" "3"` | shot (d): colours, border and gap geometry |

Shots: (a) full health standing, weapon slot 1 held; (b) `+duck` held 2 s; (c) survivor-hurt
(about 40 health); (d) mid-heal with a medkit (`give first_aid_kit`, select it, `+attack` held,
shot at 2 s); (e) holding pills with none of the other items (S5: missing items drawn as the
preview draws them). Also answers S4 (red box alpha against the preview) and S9 (card background).

**Answers and gates** (run 2026-09-24, `/home/volence/l4d/hud/probe-phase2/RESULTS.md`; slice 2.F G tasks):

- **Q5: NO, gate retired (G4).** `fgcolor_override` on `HealthIcon` is ignored: the cross always
  takes the panel's health colour, or `monochrome_color` when set (`b1v2/shots/b1/b1-a.png` green,
  `b1-c.png` orange; `b1/shots/b1/b1-a.png` magenta). The cross offers no colour control; `Q5` is
  gone from `probes.ts`.
- **Q8: YES, gate passed (G5).** The crouch icon keeps a file `drawColor` (magenta) and shows only
  while crouched (`b1v2/shots/crops/ownbig-b.png` shown at about x 1870 to 1905, y 955 to 1000;
  `ownbig-a.png` absent; in B1 the 100-wide panel clipped it away, `b1/shots/crops/duck-b.png`).
  The Tint control is offered; `stateArt: 'crouched'` stands, no preview change.
- **Q1: YES, whole panel, gate passed (G1).** `monochrome_color` on a HealthPanel recolours the own
  bar fill (tinting its shaded texture, FE00FE top to B600B6 bottom, not a flat paint), its outline,
  the HealthNumber, the HealthIcon cross and the scratches, at 100 and at 40 health
  (`b1/shots/crops/own-a.png`, `own-c.png`); on teammate cards the bar and the number, still cyan at
  35 health and on the down card's number (`b1/shots/crops/card1-a.png`, `b1v3/shots/crops/cards-hurt.png`).
  The control is "Panel colour" on the own and the teammate `Health`, each with a note of what it
  recolours; no Healthy-only branch. Audit C.7 ("bar fill colour impossible") is overturned.
- **Q3: YES, gate passed (G3).** `inset` keeps the outline at the rect and moves the fill inside it:
  stock 4 px between frame and fill at 1080p (the default, about 2 units), `inset 3` 6 px (column
  samples at x 1800, `b1v2` a against `b1v3` full-1). The preview draws the outline always and insets
  by 2 units, or the file's `inset`: 4.5 px and 6.75 px at 1080p, which land on the game's 4 and 6
  once the canvas's partial row is counted (slice 2.F X9). Offered on the own and the teammate `Health`
  (one HealthPanel class, B13 shows the same default inset on cards).
- **Q2: clips YES, image NO; gate passed (G2).** `LocalPlayer` clips its children (with `wide 100`
  the bar and the top scratch stop at x 1863, `b1/shots/crops/own-a.png`; with 130 the bar runs to
  1912, `b1v2`), and never paints its own `image` (no teal in two launches). The gate is worded as
  the clip, so it passes: a new design fits your own health by default (`DEFAULT_DESIGN`), a saved
  one stays as saved (the golden's "saved before" cases keep the old bytes). The "image painted"
  branch is closed for good: `ownBg` (`HudEdOwnBg`) is the only background the own panel can have.
  History: the default was held back once (ccc87af7) because launch R (`probe-2f/x12/incap.steps`,
  `parity/x12-incap-own.png`) showed a fitted bar 26 units left after an incap and revive. client.dll
  (1023f5df to 1023f6da) moves `Health` to `Incapacitated`'s x while down (y kept) and, on the revive,
  to the `Items` child's x, or nowhere when there is none. The fit rule now starts `Incapacitated` at
  the bar's x, and every own panel whose bar and down picture differ gets a hidden `Items` anchor at
  the bar's x (b3cb108b). Launch X14 (`probe-2f/x14`, `parity/x14-incap-own.png`): fitted stock, a
  dragged bar and Modern all keep the bar in place through two incap and revive cycles.

### B2. Survivor: every element hidden with `visible 0` only (one launch)

Design: stock; hand edits set `"visible" "0"` and nothing else on `CHudLocalPlayerDisplay`,
`CHudTeamDisplay`, `HudWeaponSelection`, `HudProgressBar`, `HudPZDamageRecord`, `HudChat` (and
`basechat.res` `HudChat`), `HudFinaleMeter`, `HudVoiceStatus`, `HudVoiceSelfStatus`. **S1**: shots
(a) idle, (b) hurt, (c) mid-heal, (d) after `say probe` (chat), (e) 3 s after `z_spawn hunter` in
front of the bots (a kill notice). Every element still drawn needs the hard hide.

### B3. Infected: every element hidden with `visible 0` only (one launch)

The same as B2 for `CHudZombieTeamDisplay`, `HudZombieHealth`, `CHudAbilityTimer`,
`HudGhostPanel`, `HudZombiePanel`, `HudInfectedVOIP`. Shots: (a) ghost, (b) spawned, (c) after
the ability, (d) after `kill`. **S1** for the infected side.

### B4. Scale and fonts (one survivor launch, one infected launch)

Design: own health scale 2, teammates scale 0.5 fitted with the health number, weapons default;
infected launch: SI health scale 1.5, infected row scale 2. **S3**: diff each shot against the
preview; look for font sizes the game rounds differently and for anything cut at the screen edge.

### B5, B6. Aspect 16:10 and 4:3 (one launch each)

Launch at `-w 1680 -h 1050` and `-w 1024 -h 768` (launch options, so the protected `video.txt` is
untouched; the harness needs this option). Design: own health at bottom right, teammates Free
(one card at x 0, one centred, one at the right edge), weapons moved to the left half, chat top
right, kill notices centred, bundled crosshair. **S2**, **S12**: every element against the preview
at that aspect; the element at x 0 also shows any title-safe margin.

### B7. Teammate states and splatter (one launch; needs bots hurt, incapacitated and dead)

Design: stock, fitted, health number on, `teammatepanel.res` `Incapacitated` and `Dead` +
`"drawColor" "255 0 255 255"`. The harness sets the three bots to about 90, 40 and 10 health
(shot a), then incapacitates one (shot b), then kills one (shot c), by whatever console route L4D1
allows (`ent_fire <bot> sethealth N` if the input exists; the harness author confirms). Look:
**Q10** which `healthbar_bg_N` splatter each health level gets (shape, not colour: the four
textures differ); **S6** the splatter's strength at 90 health; **S7** portrait, bar, number, items
and name in the down and dead states; whether the tint on the state art is kept.

### B8. Own survivor down (optional, one launch)

**Q9**: `localplayerpanel.res` `Incapacitated` + `"drawColor" "255 0 255 255"`. Incapacitate the
player (a fall, or `sethealth 1` then damage). Look: `Head` hidden or not, incap art shape at
96x96, tint kept, number 299 red.

### B9. Infected: tints, colours, marker, ghost panel (one launch)

Design: stock. Hand edits:

| Q | File, change | Look at |
|---|---|---|
| Q12 | `hunterhealth.res`, `smokerhealth.res`, `boomerhealth.res` `BackgroundImage` + `"drawColor" "0 255 0 255"` | a green frame, or stock |
| Q13 | the same three files, `HealthNumber` + `"fgcolor_override" "0 0 255 255"` | a blue number, or code's colour |
| Q14 | `abilitytimerhud.res` `BackgroundImage` + `"image" "hud/hudeditor/probe_magenta"` | a magenta square (the file wins) or the stock backdrop (code sets `PZ_charge_bg`) |
| Q15 | `hudlayout.res` `CHudAbilityTimer` `"ability_ready_color" "255 0 255 255"`, `"ability_charging_color" "0 255 255 255"` | which of icon, ring and backdrop turn magenta when ready and cyan while charging; the fill's start angle and direction |
| Q16a | `hudlayout.res` `HudCrosshair` `"ability_size" "40"`, `"ability_ready_color" "255 255 0 255"` | a big yellow marker at the centre |
| Q18 | `zombieteamdisplayplayer.res` `BackgroundImage` `"drawColor" "255 0 0 255"`; `NameLabel` `"fgcolor_override" "0 255 0 255"` | a red backdrop and a green name on the own card |
| Q19 | `zombieteamdisplayplayer.res` `Dead` `"tall" "40"` | shot (e): the dead overlay, the skull, the countdown text |
| Q20 | none | shot (a): the ghost card: faint pulsing icon, bar and spawn time shown or not, `AbilityProgress` shown or not |
| Q21 | `hudghostpanel.res` `Background` `"bgcolor_override" "0 0 0 100"`; `ClassImage` `"visible" "0"` | shot (a): a lighter box with no class art |
| Q23 | `resource/ui/spectatorinfected.res` (a new file in the addon) `Countdown` `"fgcolor_override" "255 0 255 255"` | shot (e): a magenta countdown (an addon copy of this file is honoured) |

Shots: (a) ghost in the saferoom (ghost panel, ghost card); (b) after `setpos` and `+attack`,
spawned, ability ready; (c) 0.3 s after using the ability (`+attack` 0.5 s), charging; (d) `+duck`
held (the SI crouch icon); (e) 2 s after `kill` (dead card, spawn countdown). Record the class; run
again until Hunter, Smoker and Boomer have each been seen.

### B10. Infected: clips and never_draw (one launch)

| Q | File, change | Look at |
|---|---|---|
| Q11 | `hudlayout.res` `HudZombieHealth` `"wide" "150"` | the Hunter bar and number (x 252 and on) gone: the container clips |
| Q17 | `zombieteamdisplayplayer.res` self block `"wide" "60"`, `"tall" "40"` | the own card cut to 60x40 |
| Q16b | `hudlayout.res` `HudCrosshair` `"never_draw" "1"` | the ability marker gone as well, or still drawn |
| S-ring | `abilitytimerhud.res` `Progress` `"wide" "30"`, `"tall" "30"` | the ring follows its rect (square resize works) |
| S-spacing | `CHudZombieTeamDisplay` `"HorizPanelSpacing" "70"` | cards 70 apart (needs a second infected; skip if none) |

Shots (a) ghost, (b) spawned, (c) ability used.

### B11. Tank (optional, one launch; only if the harness can put the player in a Tank)

`hunterhealth.res` `BackgroundImage` `"image" "hud/hudeditor/probe_magenta"`;
`frustrationmeter.res` `FrustrationBar` `"east_aligned" "0"`, `Countdown` `"fgcolor_override"
"255 0 255 255"`. Look: the magenta frame under the Tank's 6000 (the Tank's frame is file-driven,
0.1.2); the frustration bar direction and colour.

### B12. Survivor: kill notices and chat (one launch)

Design: kill notices moved to the centre and resized 300x75, chat moved top right and resized
400x200. Hand edits: `hudlayout.res` `HudPZDamageRecord` `"label_textalign" "east"`;
`pzdamagerecordpanel.res` `recordlabel0` `"fgcolor_override" "255 0 255 255"`; `basechat.res`
`HudChat` `"bgcolor_override" "0 0 64 128"`. Shots: (a) after `say` five lines; (b) 3 s after
`z_spawn hunter` and `z_spawn smoker` near the bots (notices). Look: **S10** history and input line
fill the resized chat; **S11** notices where the preview puts them, right-aligned, first row
magenta; the chat background colour.

### B13. Parity baseline (three launches)

The editor's stock download, its Modern download and the owner's imported HUD (as installed now),
each unchanged, at 16:9, survivor shots (a) full, (b) hurt, (c) mid-heal and an infected launch for
stock. Each diffed against the preview. This is the regression baseline every later slice
re-runs.

### Top 10, in order of what they unblock

1. **Q1** `monochrome_color` on HUD bars (could re-open bar colour on every panel, B1).
2. **S1** which elements re-show under `visible 0` (hide is broken for players today if any do, B2, B3).
3. **Q2** `LocalPlayer` clip and `image` (slice 2.1's fit and background, B1).
4. **S2** 16:10 and 4:3 against the preview (every element, B5, B6).
5. **Q4** plus **Q5** own scratches and cross colour, and whether code re-shows a hidden scratch (B1).
6. **Q11** plus **Q13** SI container clip and number colour (slice 2.2, B9, B10).
7. **Q14** plus **Q15** which ability pieces code textures and colours (slice 2.3, B9).
8. **Q16** crosshair marker keys, and whether `never_draw` also hides the marker (B9, B10).
9. **Q17** to **Q20** infected card clip, tint, dead and ghost looks (slice 2.4, B9, B10).
10. **Q10**, **S6**, **S7** teammate splatter mapping and the Down/Dead rules (B7).

Every slice can be built before its probes run: an uncertain control ships hidden behind its
registry flag until the answer is in, and the preview uses the stated default meanwhile.

## 5. The custom damage splatter work (parallel spec)

Another agent is specifying custom splatter art. Boundaries:

- **What "own health splatter" is.** The own panel has no `BackgroundImage`; its damage decoration
  is `HealthbarTextureTop` and `HealthbarTextureBottom` (`detail_scratches_top_1`,
  `_bottom_1`), which client.dll looks up by name and tints to the health colour
  (`render.ts:117-124`). B1 shot (c), hurt, shows whether any other own-panel damage art appears. This
  spec registers both as `role: 'decor'`, `art: 'splatter'` children with move, size and hide; the
  splatter spec owns their `image` key and the art. The teammate `BackgroundImage` (Phase 1) and the
  infected card `BackgroundImage` (slice 2.4) carry the same `art: 'splatter'` marker.
- **The tint trap.** Code rewrites the scratches' draw colour to green/orange/red every update, so
  custom scratch art is multiplied by that colour: white art shows the pure health colour, coloured
  art is darkened. The splatter spec's preview must tint by `healthRgb` exactly as today, and its UI
  should say so (Q4 confirms).
- **Hiding.** Hard hide (size 0) is the reliable hide for these pieces; a custom art slot on a
  hidden piece is moot, and the splatter UI should grey out.
- **Fit.** Slice 2.1's fit treats the scratches as decor that keeps its size and is clipped; a
  custom splatter drawn larger than the panel is cut at the `LocalPlayer` box. If the splatter spec
  wants art that spills outside the panel, fit must grow the clip box to include decor; that is a
  one-line policy switch (`role: 'decor'` counted or not) to agree between the two specs.
- **Order.** Either can ship first. Slice 2.0's `art` marker and the registry are the seam: if the
  splatter work lands first on the teammate card only, slice 2.1 adds the own-health entries to the
  same list.

## 6. Out of Phase 2

- **Impossible:** per-teammate different contents (C.1), a column or free infected row (C.2), a kill
  feed (C.3), new data such as temp health numbers (C.4, C.5), portraits per player (C.6), the
  target ID label, `_minmode` alternate layouts (T3).
- **Deferred:** Tab scoreboard and versus panel (L each, menus not HUD), themes (global font size,
  colour theme, audit 32, 33), a general "add rectangle" tool (30), sibling anchoring, server menu
  (25), animations beyond the pickup switch, per-class SI unlinking.

## 7. Slices, in shipping order

Probe batches B1, B2, B3 and B13 run first (they need nothing new built) and feed 2.F.

1. **2.0 Shared plumbing**: registry per panel, typed keys, dll-strings test, PreviewState, panel-aware selection; no visible change.
2. **2.F Correctness fixes**: whatever B1 to B7 and B13 prove wrong in what is built (hide, aspect, splatter, states, box alpha).
3. **2.1 Own health insides**: every piece, fit, own background, Hurt/Down/Crouched preview.
4. **2.2 Own SI health**: linked Hunter/Smoker/Boomer editing, fit, class picker.
5. **2.3 Ability timer and crosshair marker**: pieces, scale, state colours, marker size and colours.
6. **2.4 Infected teammate cards**: pieces, fit, gap spacing, alive/ghost/dead preview.
7. **2.5 What built elements still lack**: weapon icon pack and box images, teammate extras, kill notice rows, chat style, weapons panel width.
8. **2.6 Use/revive bar**: label, bar colours and thickness, icon.
9. **2.7 Ghost panel, too-far/Tank takeover, frustration**: insides and colours.
10. **2.8 Leftovers**: finale, voice, mic, infected voice, peril, leaving area, vote, spawn countdown, holdout, pickup fly-in.

## Decided overnight, for owner review

1. Own-health "splatter" is taken to be the two scratch decals; the own panel has no other damage
   art in its files. B1 shot (c) checks.
2. A separate `ownBg` style slot ("Your health background") instead of sharing the teammate
   `panelBg`, so the two panels can differ.
3. Fit is default-on for new designs on own health, SI health and infected cards (as the teammate
   card), absent means off so saved designs render unchanged.
4. SI health edits are linked (Hunter = Smoker = Tank exactly, Boomer by delta and ratio); no
   per-class unlinking in Phase 2.
5. The zombiehealthleft files are treated as console split-screen and not child-edited.
6. The crosshair ability marker is its own non-movable element (`abilityMarker`), not part of the
   `xhair` element.
7. The infected row migrates from `spacing` to `gap`, matching the survivor team.
8. A new "Hurt" preview state (40 health, orange) and a "Crouched" toggle are added; the infected
   side gets Alive / Ghost / Dead and a class picker.
9. Uncertain controls (bar colour, inset, colour on the cross, SI number colour, frame tint) ship
   hidden until their probe passes; the preview uses the "code decides" default meanwhile.
10. The Tab scoreboard and versus panel stay out of Phase 2.
11. The four ability class icons are exported downscaled to 128x128 to keep the preview art under
    its 1 MB cap.
12. Order by player value: correctness of what is built (2.F) goes right after the plumbing,
    because a control that silently does nothing costs players more than a missing panel. The
    weapon icon pack leads slice 2.5 as the most-asked-for competitive restyle; it follows the
    owner's own order (own health, infected own panel, infected cards) rather than jumping it.
13. Probe batches are one VPK per game launch with several non-interfering questions each; the
    harness saves the editor's preview of the same design for every shot so each answer is also a
    parity check.
