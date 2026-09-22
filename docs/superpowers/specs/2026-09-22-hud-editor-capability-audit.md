# HUD editor: capability audit, what L4D1's HUD files allow versus what the editor exposes

Status: research, 2026-09-22. Read-only audit to design the next version of `/hud`. Nothing
here is built. Builds on `2026-09-21-hud-editor-design.md` (v1) and
`2026-09-22-hud-editor-panel-internals-design.md` (v2, "Plan 2" below means that spec's second
plan, "editing the insides", designed and not built).

## How this was established

- **Base files.** Every file under `web/src/hud/base/stock/**` was compared with `cmp` against the
  installed game (`~/.steam/steam/steamapps/common/left 4 dead/left4dead/`): all 39 are
  byte-identical to the loose files on disk. `pak01_dir.vpk` holds only `materials/` (9143),
  `models/` (11694) and `particles/` (32): no `resource/` or `scripts/` file lives in the archive,
  so every HUD layout file is loose and an addon copy of any of them is a legal override.
- **What game code reads.** The Windows client binary `left4dead/bin/client.dll` was dumped with
  `strings`. Three kinds of evidence came out of it, cited below as "(dll)":
  1. RTTI class names (`.?AVCHudGhostPanel@@` and so on): the complete list of HUD element classes
     that exist. A `hudlayout.res` block with no class is inert.
  2. Literal `.res` paths the client loads (`Resource/UI/HUD/HunterHealth.res`, ...). A file with
     no path in the binary is never loaded.
  3. `CPanelAnimationVar` pairs (`m_flBoxGap` then `BoxGap`): the extra keys each HUD class reads
     from its `hudlayout.res` block or its `.res`, including keys no stock file uses ("hidden
     keys").
  Absence of a string is strong evidence, not proof (a string could be built at runtime). Every
  conclusion drawn from absence is marked as such.
- **What players have already proven by hand.** The owner's Modern HUD (`/home/volence/l4d/hud`,
  also the editor's `modern` preset) and the Phase 0 results in the v1 spec.
- Anything not read in a file or the binary is marked **inferred**.

### Files the editor ships (`web/src/hud/base/`)

`stock/` (39 files, all byte-identical to the game):

- `scripts/`: `hudlayout.res`, `hudanimations.txt`, `hud_textures.txt`
- `resource/`: `clientscheme.res`, `chatscheme.res`
- `resource/ui/`: `basechat.res`, `hudghostpanel.res`, `zombiepanel.res`, `scoreboard.res`,
  `scoreboardsurvivor.res`, `scoreboardinfectedplayer.res`, `versusmodescoreboard.res`
- `resource/ui/hud/` (all 27 the game has): `abilitytimerhud`, `boomerhealth`, `finalemeter`,
  `frustrationmeter`, `hitspanel`, `hudholdouttimer`, `hunterhealth`, `infectedvoip`, `itempickup`,
  `killspanel`, `localplayerdisplay`, `localplayerpanel`, `progressbar`, `pzdamagerecordpanel`,
  `smokerhealth`, `spawnspanel`, `statspanel`, `survivorteamstatushud`, `tankhealth`, `targetid`,
  `teamdisplayhud`, `teamdisplayhud_vertical`, `teammatepanel`, `votehud`,
  `zombiehealthleft_large`, `zombiehealthleft_small`, `zombieteamdisplayplayer` (all `.res`)

`modern/` (25 files, overrides only, falls back to stock): the same 3 scripts, 2 schemes and 7
`resource/ui` files, plus 13 of the `resource/ui/hud` files: `abilitytimerhud`, `boomerhealth`,
`hunterhealth`, `localplayerdisplay`, `localplayerpanel`, `pzdamagerecordpanel`, `smokerhealth`,
`tankhealth`, `teamdisplayhud`, `teammatepanel`, `zombiehealthleft_large`,
`zombiehealthleft_small`, `zombieteamdisplayplayer`. Plus `fonts/RobotoCondensed-{Regular,Bold}.ttf`
and `index.ts`.

### HUD files the game has that the editor does not ship

Loose on disk, loaded by the client (dll path present), not in `base/`:

| File | What it is | Player value |
|---|---|---|
| `scripts/mod_textures.txt` | Icon and background texture map (weapon boxes `rounded_background_glow`/`_noborder`, `icon_equip_*`, `zombie_team_*`, `voice_*`, `pain_*`, tip icons) | High: Phase 0 Q5 proved an addon copy is honoured |
| `resource/ui/spectatorinfected.res` | Dead-infected spawn countdown (`Countdown` 10,240 32x24; `Seconds_1/2`), ghost title bar (`BackgroundImage` f0 x 75, `../vgui/ghost_title_bg`) | Med-high for infected |
| `resource/ui/spectatorsurvivor.res`, `spectator.res`, `bottomspectator.res`, `resource/spectatormenu.res`, `spectatormodes.res` | Spectator and dead-survivor overlays | Low-med |
| `resource/ui/deathinfected.res` (23 KB) | The infected "that life" death summary | Low |
| `resource/ui/leavingareawarning.res` | Red "please wait" warning label (180x14) | Low |
| `resource/ui/locator.res` + `scripts/instructor_lessons.txt` | Game instructor hints (CLocatorPanel) | Low |
| `resource/ui/tippanel.res`, `takeoversurvivorbar.res`, `readycountdown.res`, `zombieintropanel.res`, `hudachievementfloatingnumber.res`, `radialmenu.res` + `scripts/radialmenu.txt` | Tips, takeover bar, ready countdown, infected intro, floating numbers, radial vocalize menu | Low |
| `resource/ui/fullscreenversusmodescoreboard.res`, `vsmodeshutdown.res`, `transitionstats*.res`, `personalstatsummary.res` | Round-end screens | Low |
| `scripts/weapon_*.txt` (`TextureData` blocks) | Weapon selection icons are font glyphs (`"weapon" { "font" "L4D_WeaponsSmall" "character" "*" }`) | Med, but these are gameplay scripts; do not ship (see C) |

`scripts/hudanimations_manifest.txt` is named by the client (dll) but no such file exists on
disk; an addon could add one to load extra animation files (**inferred**, untested).

## A. Inventory

Units are HUD units, 480 tall. "Editor today" means v1 plus Plan 1 as built. Keys common to every
VGUI control (xpos, ypos, wide, tall, zpos, visible, enabled, and the Label/ImagePanel keys
listed in D) are not repeated per row.

### A.0 Generic control vocabulary the files support (dll, `vgui_controls` strings)

- **Any panel:** `xpos`/`ypos` with `r`/`c` prefixes, `wide`/`tall` with `f` (fill), `zpos`,
  `visible`, `enabled`, `pinCorner`, `autoResize`, `usetitlesafe`, `proportionalToParent`,
  `proportional_xpos`/`proportional_ypos`, **`pin_to_sibling`, `pin_corner_to_sibling`,
  `pin_to_sibling_corner`** (a child can be anchored to a sibling's corner), `bgcolor_override`,
  `fgcolor_override`, `paintbackground`, `paintborder`, `PaintBackgroundType` plus `Texture1` to
  `Texture4` (corner textures, default `vgui/hud/800corner1..4`), `IgnoreScheme`, `alpha`.
- **Label:** `labelText` (literal, `#localization` token or `%dialogvariable%`), `font`,
  `textAlignment` (north-west ... south-east, center), `wrap`, `centerwrap`, `allcaps`,
  `textinsetx`/`textinsety`, `use_proportional_insets`, `auto_wide_tocontents`, `dulltext`,
  `brighttext`, `associate`.
- **ImagePanel:** `image`, `scaleImage`, `scaleAmount`, `fillcolor`, `fillcolor_override`,
  `drawcolor`, `drawcolor_override`, `border`, `frame`. **ScalableImagePanel** (9-slice):
  `src_corner_width/height`, `draw_corner_width/height`. **CIconPanel**: `icon`, `iconColor`.
  **CircularProgressBar / ContinuousProgressBar**: `fg_image`, `bg_image`, `progress`, `variable`.
- **Conditional tags:** `[$WIN32]`, `[$WINDOWS]`, `[$OSX]`, `[$X360]`, `[$ENGLISH]`, `[$!ENGLISH]`
  and code-driven sub-blocks (`if_split_screen_*`, `if_embedded`, `left_survivor_only`). There is
  no aspect-ratio or resolution conditional; `cl_hud_minmode` plus `_minmode`-suffixed keys exist
  in the binary (strings `_minmode`, `cl_hud_minmode`) and in other Source games select an
  alternate value per key (**inferred** for L4D1, untested).
- **Scheme:** `clientscheme.res` `Colors` (39 named colours), `BaseSettings` (widget colours,
  `FgColor`, `SelectionTextFg`, `Ability.Clock.*` etc.), `Fonts` (55 entries, each with `name`,
  `tall`, `weight`, `antialias`, `additive`, `dropshadow`, `outline`), `Borders`,
  `CustomFontFiles` (4 vfonts stock: Futurot, Toolbox, TG, TGB, HalfLife2). `chatscheme.res`
  carries its own copy for the chat.
- **Animations:** `hudanimations.txt` events can `Animate` FgColor, BgColor, Position, Size,
  Alpha, Blur, TextColor and panel vars, and `RunEvent`, `StopEvent`, `SetFont`, `SetTexture`,
  `SetString`, with Linear, Accel, Deaccel, Spline, Pulse, Flicker, Bounce. Code decides when an
  event fires; the file decides what it does.
- **Dialog variables** (the only live data a label can show), by panel: `%HealthNumber%`
  (local panel, teammate card, SI health), `%classname%` `%ready%` `%info%` (ghost panel),
  `%tanktitle%` `%tanktext%` (zombie panel), `%distance%` `%healthbonus%` `%survivalmult%`
  `%YourSurvivor%` `%EnemySurvivor%` (versus score panel), `%score%`, `%spectators%`
  (scoreboard). A variable only resolves in the panel whose code sets it.

### A.1 Survivor side

| Element (class) | Files and keys | Files can control | Code controls (evidence) | Editor today |
|---|---|---|---|---|
| **Own health** `CHudLocalPlayerDisplay` | `hudlayout.res` `CHudLocalPlayerDisplay` r125,r91 150x320; `localplayerdisplay.res` `LocalPlayer` 130x85 `image ../vgui/s_panel_background`; `localplayerpanel.res` children: `Head` 0,54 25x25, `DuckingIcon` 97,32 25x25 `hud/crouch_survivor`, `Incapacitated` 26,17 96x96, `Health` (HealthPanel) 26,68 96x10, `HealthbarTextureTop` 46,44 100x25 and `HealthbarTextureBottom` 26,78 80x20 (scratch decals), `HealthIcon` Label "," font `L4D_Icons` 26,48, `HealthNumber` Label `%HealthNumber%` font `HUDHealth` (18) 36,48 70x26 | Container position; every child's rect, visibility, zpos; label fonts, alignment, colours; decal images; background image of `LocalPlayer`; added children (Modern adds `ModBg` ImagePanel `fillcolor 0 0 0 140`) | Portrait texture per character (`../vgui/s_panel_<char>`, `_incap`) (dll); when Incapacitated/Ducking show; bar fill and its colour; the health number's colour follows health state in game (owner's screenshot: green in game while the file says nothing, **inferred** code sets it each frame); decal tint | Move, scale (0.5 to 2, children and fonts multiplied), hide. Plan 1 draws real insides. Plan 2: Head, Health, HealthNumber, HealthIcon, DuckingIcon, Incapacitated |
| **Teammate cards** `CHudTeamDisplay`, card class `TeammatePanel` | `hudlayout.res` `CHudTeamDisplay` 0,r75 f0x100; `teamdisplayhud.res` `TeamPlayer1..4` each with **own** xpos/ypos (0/140/280/420, y 0), wide 150, tall 150, `pinCorner 2`, `image ../vgui/s_panel_background`; `teammatepanel.res` (one file for all cards): `BackgroundImage` 0,0 256x128 `hud/healthbar_bg_1` zpos -1, `Voice` 10,15 16x16 (visible 0), `Head` 13,38 23x23, `Incapacitated` 10,4 96x96, `Dead` 12,9 96x96, `Health` 37,52 96x7, `Name` 13,60 120x12 font `PlayerDisplayName` (14), `Status` 64,38 70x12 east, `Items` 39,36 50x14 font `L4D_Icons_medium` (18) | Per slot: position, card size (clip box), card background image. Per card file (shared): every child's rect, visibility, zpos, font, colour, alignment; added children (`HealthNumber` label, background rects). The visible strip is x 10..133, y 36..72 (123x36) of a 150x150 card | Which player sits in which slot; portraits (`../vgui/s_panel_<char>`, `_incap`), `BackgroundImage` swapped to `hud/healthbar_bg_1..4` by damage (dll) and hidden at full health (owner's screenshot); Items glyphs and Status text; when Incapacitated/Dead/Voice show. `teamdisplayhud_vertical.res` is an alternate file with `left_survivor_only` blocks, chosen by code (**inferred**: split screen) | Move; scale; Row/Column; one spacing number for all cards (teamPass writes `TeamPlayerN` at `spacing*(n-1)`). Style slot `panelBg` repoints the four `TeamPlayerN` `image` keys. Plan 2: children list (BackgroundImage, Head, Health, Name, HealthNumber addable; Incapacitated, Dead, Voice as "other"); **Status and Items deliberately excluded** |
| **Weapon selection** `CHudWeaponSelection` | `hudlayout.res` `HudWeaponSelection` r98,c-75 100x160 with `LargeBoxWide/Tall` 150/32, `SmallBoxWide/Tall` 150/24, `BoxGap` 1, `BoxDirection` 0 (0 up, 1 down, 2 left, 3 right), `SelectionNumberXPos/YPos` 4/4, `IconXPos/IconYPos` -55/-5 (negative = from right), `IconSize` 24, `Ammo1XPos/YPos`, `Ammo2XPos/YPos`, `TextYPos`, `TextColor`, `MaxSlots` 5, `RightSideIndent`, `ReserveAmmoColor`, `InactiveItemColor`, `PrimaryAmmoFont`, `SelectionGrowTime`, and the "360 mode" block (`PrimaryWeaponBoxWide` etc.). Hidden keys (dll, unused by stock): `Ammo1Font`, `Ammo1Color`, `Ammo2Font`, `NumberColor`, `EmptyBoxColor`, `SelectedBoxClor` (sic), `PistolAmmoFont`, `PistolWide`, `PrimaryBindingXPos`, `BindingsFont`, `DPadXPos/YPos`. Box art: `mod_textures.txt` `rounded_background_glow` / `_noborder` (Modern README, verified) | Box sizes, gap, stacking direction, icon/number/ammo offsets, colours, fonts, the box textures (normal mode via `mod_textures.txt`, Phase 0 Q5) | Slot content and order; weapon icons are glyphs of the `L4D_WeaponsSmall`/`L4D_Weapons` fonts named in `scripts/weapon_*.txt` | Move, hide. Box restyle only in Advanced (`weaponBoxActive/Inactive`, overwrites stock names) |
| **Use / revive bar** `CHudProgressBar` | `hudlayout.res` c-114,c10 300x45; `progressbar.res`: `BarLabel` 28,1 290x12 font `MenuTitle_DropShadow`, `Bar` 28,15 200x8 with `border_color`, `fill_color`, `empty_color`, `shadow_color`, `gap`, `border_thickness`, `shadow_thickness`, `AwardIcon` CIconPanel 2,0 24x24 `icon_healing`, `Subtext` 2,24 | Bar size, colours, border and shadow thickness; label font/colour/place; icon place and size | Text, icon choice, when it shows; `cl_drawprogressbar` cvar | Move, hide |
| **Name under crosshair** `CTargetID` | `hudlayout.res` `TargetID` c-320,c-240 640x480; `targetid.res` `TargetID` `normal_fgcolor`, `normal_bgcolor`, `downgrade_fgcolor`, `downgrade_bgcolor` (all dll); `TargetIDLabel` 290x25 font `TargetID` (16). **Label position comes from `hudanimations.txt`** events `TargetIDNormal` (`Position "c-10 c+20"`) and `TargetIDReviveProgress` (`"c-86 c+54"`), per the comment in `targetid.res` | Label position (via the two events), size, font, alignment, colours | Text; when shown; `hud_showtargetid`, `hud_targetid_health`, `hud_targetid_rangefinder`, view cone cvars | Hide only; registry says "the game places this one" (see B: it can be moved) |
| **Overhead names** `CPlayerLabel` | `hudlayout.res` `PlayerLabel` full screen | Nothing useful beyond hide | 3D projected; heights from `hud_targetid_name_height*` cvars (dll) | Not listed |
| **Chat** `CHudChat` | `hudlayout.res` `HudChat` 10,275 320x120 ("BaseChat.res overrides many of these values"); `basechat.res` `HudChat` 10,r205 280x120, `HudChatHistory` RichText 10,17 260x75 font `ChatFont` `autoResize 1`, `ChatInputLine`, `ChatFiltersButton`; `chatscheme.res` fonts/colours; 3 animation events move it (`ResetChatPosition` 10,275; `DeathPanelOpen` 200,275; `ZombieIntroPanelOpen` 10,135) | Position, size, history box size, font, background, colours | Line fade (`hud_saytext_time` cvar), content | Move and free-resize via `hudlayout.res` only, rewrites all three events to one position. Does **not** write `basechat.res` (the Modern HUD writes both) |
| **Voice list** `CHudVoiceStatus` | `hudlayout.res` `HudVoiceStatus` r130,0 150x290 `item_tall` 15, `item_wide` 120, `item_spacing` 2, `icon_xpos/ypos/tall/wide`, `text_xpos` 18, `text_font`, `inverted` | Place, row size, spacing, icon and text offsets, font, inverted style | Who is listed | Not listed |
| **Own mic** `CHudVoiceSelfStatus` | r125,r58 24x24 | Place, size | Icon (`voice_self` in `mod_textures.txt`) | Not listed |
| **Teammate in peril** `CHudTeamMateInPerilNotice` | `hudlayout.res` ypos 50 only | Vertical place, hide | Content | Not listed |
| **Vote** `CHudVote` | `hudlayout.res` 10,c-80 210x200; `votehud.res` `VoteActive` 280x140 (Header, Issue, Yes/No rows, `VoteBar` 11,113 260x18), `VotePassed`, `VoteFailed`, `CallVoteFailed`; keys `box_size`, `spacer`, `box_inset`, `yes_texture`, `no_texture` (dll) | Place, all inner rects, fonts, colours, textures | When shown, text | Not listed |
| **Item pickup fly-in** `CItemPickupPanel` | full screen; `itempickup.res` `image1..3` 24x24; motion in `StartItemPickup1..3` (`c20 c-10` to `c60 c-65` to `r10 c-50`) | Icon size, path and timing (animations), hide | Which icon | Not listed |
| **History / pickup list** `CHudHistoryResource` | r640 640x330 `history_gap` 55; hidden keys `icon_inset`, `text_inset`, `NumberFont`, `TextFont` (dll) | Place, spacing, fonts | Content | Not listed |
| **Damage direction** `CHudDamageIndicator` | `MinimumWidth` 40, `MaximumWidth` 80, `StartRadius` 120, `EndRadius` 80, `MinimumHeight/MaximumHeight`, `MinimumTime`; hidden `MaximumDamage`, `MaximumTime`, `TravelTime`, `FadeOutPercentage`, `Noise` (dll); texture `vgui/damageindicator`. The `dmg_*` and `DmgColor*` keys are Counter-Strike leftovers the client never reads (dll) | Arc size, radius, timing | Direction and trigger; `cl_damageindicator_3d` cvar | Not listed |
| **Close captions** `CHudCloseCaption` | c-150,r220 300x135, `BgAlpha`, `GrowTime`, fade times, `topoffset`; fonts `CloseCaption_*` | Place, size, background, timing, font | Content | Not listed |
| **SourceMod / server menus** `CHudMenu` | full screen `zpos 1`, `TextFont`, `ItemFont`, `ItemFontPulsing`; hidden `LabelFont`, `LabelColor`, `ItemColor`, `MenuItemColor`, `MenuBoxColor` (dll); animation `MenuOpen` colours | Offset (moving the panel shifts the menu; the chat events already move it), fonts, colours | Menu layout inside the panel | Not listed |
| **Finale meter** `CHudFinaleMeter` | c-100,12 200x20; `finalemeter.res` `RescueLabel`, `RescueBar` | Place, inner layout, font | Progress | Not listed |
| **Leaving area warning** `CHudLeavingAreaWarning` | 10,c26 200x14; `leavingareawarning.res` `Warning` red label | Place, colours, font | When | Not listed |
| **Holdout timer** `CHudHoldoutTimer` | survival only; `hudholdouttimer.res` | Everything positional | | Not listed (low value in versus) |
| **Scope, blood, zoom** `CHudScope`, `CHudBlood` | full-screen overlays | Hide | Art is textures | Not listed |

### A.2 Infected side

| Element (class) | Files and keys | Files can control | Code controls (evidence) | Editor today |
|---|---|---|---|---|
| **Infected teammates** `CHudZombieTeamDisplay`, card `CHudZombieTeamDisplayPlayer` | `hudlayout.res` `CHudZombieTeamDisplay` 0,r75 f0x100, `HorizPanelSpacing` 140 (`VertPanelSpacing` 45 is dead: not in dll); `zombieteamdisplayplayer.res`: **the card's own size is its self block** `ZombieTeamDisplayPlayer` 256x128; children `BackgroundImage` 0,10 128x64 `hud/infected_healthbar_bg_1` `drawColor 64 64 64 255`, `NameLabel` 13,55 120x12, `SpawnTimeLabel` 39,40, `HealthPanel` 38,41 86x12, `Dead` 0,18 256x0 `hud/overlay_dead`, `SkullIconPlacement` 8,24 24x24, `PlayerImage` 9,23 24x24, `Voice` 38,14 16x16, `AbilityProgress` 2,18 36x36 `fg_image HUD/PZ_charge_meter` | Row start, card spacing, card size, every child, background tint via `drawColor`, colours (raw only: `fgcolor_override "White"` draws nothing here, Modern notes) | Horizontal only (dll); class images `hud/ZombieTeamImage_*` and ghost `hud/GhostTeamImage_*` (dll); spawn timer text; `hud_zombieteam`, `hud_zombieteam_showself` cvars | Move, scale, spacing. Plan 2: BackgroundImage, PlayerImage, HealthPanel, NameLabel, SpawnTimeLabel, and AbilityProgress/Dead/Voice/SkullIconPlacement as "other" |
| **Own SI health** `CHudZombieHealth` | `hudlayout.res` r387,r100 400x100; per class file, each with `BackgroundImage` (`HUD/PZ_healthbar_50/250/3000`), `Health`, `HealthNumber` font `MenuTitle` (18), `DuckingIcon`. **Loaded (dll): `HunterHealth`, `BoomerHealth`, `SmokerHealth`, `ZombieHealthLeft_Small`, `ZombieHealthLeft_Large`. `TankHealth.res` is never named.** Hunter: Health 252,69 132x13, bg 250,0 200x100; Boomer: Health 322,69 64x13; Left_* variants start at x 0/2 | Every child per file; added children (Modern adds `ModBg`) | Which file per class (the Tank's file is unknown, **inferred** one of the five; `tankhealth.res` edits do nothing); bar fill | Move, scale (all six files). Plan 2: four children via Hunter-relative deltas, and v2 cites the Tank's 278-wide bar, which lives in the dead file |
| **Ability ring** `CHudAbilityTimer` | `hudlayout.res` r72,r120 80x70 with `ability_surpressed_color`, `ability_charging_color`, `ability_ready_color`; `abilitytimerhud.res` `BackgroundImage` 80x80 (no image key), `AbilityImage` 10,10 60x60, `Progress` CircularProgressBar 60x60 `fg_image HUD/PZ_charge_meter` `variable abilityProgress` | Place, ring and icon sizes, the three state colours, meter texture name | Class icon (`pz_charge_*`), progress | Move, hide |
| **Crosshair ability marker** `CHudTerrorCrosshair` / `CHudCrosshair` | `hudlayout.res` `HudCrosshair` 640x480 `ability_size` 17 and the three state colours; hidden `ability_attack_color` (default "255 0 0 255") and `ability_attack_color_colorblind` ("12 206 206 255") (dll); hidden `never_draw` (`m_bHideCrosshair`, dll) | Marker size and colours; possibly hide the engine crosshair entirely (**inferred** from `never_draw`) | Shape (`HUD/PZ_charge_crosshair`), survivor crosshair style is `cl_crosshair_*` cvars | `xHair` image marker only (position preview, not movable) |
| **Ghost / spawn panel** `CHudGhostPanel` | `hudlayout.res` c-175,c10 350x155, `WhiteText`, `RedText`, `padding` (dll); `hudghostpanel.res`: `Background` 10,5 330x110 `bgcolor_override 0 0 0 245`, `ClassImage` CIconPanel 15,10 85x85, `ClassName` `%classname%` font `FrameTitle` (24), `SelectSpawn`, `Ready` `%ready%`, `Info` `%info%`, `SpawnBind`, `SpawnLabel` | Place, box size and colour, hide the class art, fonts, the two text colours | Texts, which lines show | Move, hide |
| **Too far / tank takeover** `CHudZombiePanel` | `hudlayout.res` c-160,c10 320x155; `zombiepanel.res` two sub-panels `TooFarFromSurvivors` and `TankTakeover`, each with Background, image, title, text | Place, inner layout, colours, fonts | Which shows | Not listed |
| **Tank frustration** `CHudFrustrationMeter` | `hudlayout.res` 10,c0 300x84; `frustrationmeter.res` `Countdown` font `FrameTitle`, `Warning`, `Warning2`, `FrustrationBar` 0,53 150x8 `east_aligned`, `FrustrationLabel` | Place, bar size and direction, fonts, colours | Blink (`z_frustration_blink_*` cvars) | Move, hide |
| **Infected damage record** `CHudPZDamageRecordPanel` | `hudlayout.res` 10,170 f20x75 `label_textalign`; `pzdamagerecordpanel.res` `recordlabel0..4` 15 apart, `label4background` 9-slice | Place, alignment, font, colours, row spacing | Lines; persist times `hud_dmgrecord_persisttime_*` cvars | Not listed |
| **Infected voice** `CHudInfectedVOIP` | r130,c100 120x84; `infectedvoip.res` `Head`, `Avatar`, `Name`; hidden `player_name_font_small` (dll) | Place, inner layout | Who | Not listed |
| **Dead infected countdown** (spectator GUI) | `spectatorinfected.res` (not shipped) | Countdown place, colours, font; title bar art/size | Values | Not listed |

### A.3 Shared and Tab screens

| Element | Files | Files can control | Editor today |
|---|---|---|---|
| Scoreboard `CTerrorClientScoreBoardDialog` | `scoreboard.res` (rows `Survivor1..4`, `Infected1..5` as `DontAutoCreate`, map strip, medals); `scoreboardsurvivor.res` (row: head, avatar, name, `SurvivorStatsHealth` HealthPanel with `monochrome_color`, items, ping, `PlayerBackground` image `background_survivor`); `scoreboardinfectedplayer.res`; column keys `infected_avatar_size`, `infected_name_width` etc. | Row layout, widths, fonts, colours, backgrounds | Ships preset copy; nothing editable |
| Versus score panel `CVersusModeScoreboard` | `versusmodescoreboard.res` (9-slice `BackgroundImage`, team score labels, `%distance%` etc., `if_embedded` Tab variant) | Layout, fonts, colours, backgrounds | Preset copy only |
| Spectator, round end, death summary | files listed above | Layout and style | Not shipped |

### A.4 Dead entries (in files, not in the game)

No class or no path in `client.dll`, so editing them changes nothing:

- `hudlayout.res`: `HudDeathNotice` (**the kill feed; L4D1 has no `CHudDeathNotice` at all**, and
  `MaxDeathNotices` is not in the binary), `CHudSurvivorTeamStatus`, `HudAnnouncement`, `HudArmor`,
  `HudSuit`, `HudRoundTimer`, `HudAccount`, `HudShoppingCart`, `HudC4`, `HudDefuser`,
  `HudHostageRescueZone`, `HudScenarioIcon`, `HudFlashlight`, `HudTerritory`, `TerritorySCore`,
  `HudGeiger`, `HUDQuickInfo`, `HudCredits`, `HudMOTD`, `ScorePanel`, `HudFlashbang`,
  `CVProfPanel`, `CBudgetPanel`, `CTextureBudgetPanel`. Debug-only: `HudIntensityGraph`,
  `HudPredictionDump`, `HudAnimationInfo`, `HudHDRDemo`, `HudCommentary`.
- `resource/ui/hud/`: `tankhealth.res`, `killspanel.res`, `spawnspanel.res`, `hitspanel.res`,
  `statspanel.res`, `survivorteamstatushud.res` (no path in the binary).
- `hud_textures.txt` `WeaponBackgroundActive/Inactive` do not draw the weapon boxes (Modern
  README, verified in game).
- `healthbar_green`, `healthbar_orange`, `healthbar_red` exist in `pak01` but no string in
  `client.dll` names them. `HealthPanel` names only `vgui/healthbar_grey`, `vgui/healthbar_white`
  and `vgui/hud/s_healthbar_outline` (dll), which suggests the fill is `healthbar_white` tinted
  by code. **Inferred, verify in game:** the Advanced slots `barGreen`, `barOrange`, `barRed` may
  have no effect, while `barWhite` and an outline slot would.

## B. Gap table

Value: what players get. Cost: S (a registry entry or a key write), M (a new pass, preview work
or a new file), L (new model plus preview plus UI). "P2" = the Plan 2 design already covers it.

| # | Capability | Files / keys | Value | Cost | P2 |
|---|---|---|---|---|---|
| 1 | **Fit teammate card to content** (feedback 1): card `wide`/`tall` shrink to the content box and every child shifted by the same offset, with a policy for the full-size state art (`Incapacitated`/`Dead` 96x96, `BackgroundImage` 256x128 splatter) which would otherwise be clipped. Modern's 120x34 card is the proof | `teamdisplayhud.res` `TeamPlayerN` wide/tall; `teammatepanel.res` all children | High | M | No (P2 moves children one by one, never the card) |
| 2 | **Spacing that means the gap** (feedback 1): today stock Row to Column reuses the row's 140 x-delta as the y step, so a 36-unit strip gets about 104 units of air, and the container becomes 140*3+150 = 570 tall, taller than the screen | `build.ts` `teamLayout` | High | S | No |
| 3 | **Per-teammate card positions** (feedback 2): four `TeamPlayerN` blocks each have their own xpos/ypos (and wide/tall/image) | `teamdisplayhud.res` | High | M | No |
| 4 | Card background covering only the content: follows from 1; today `panelBg` fills the whole 150x150 | `TeamPlayerN` `image` + size | High | S after 1 | No |
| 5 | Teammate insides: hide/move/resize portrait, bar, name | `teammatepanel.res` | High | M | P2 |
| 6 | **Teammate item icons and status** (feedback 3, "icons above a shorter bar"): `Items` (glyph label, size is its font `L4D_Icons_medium` tall 18, not w/h) and `Status` | `teammatepanel.res` `Items`, `Status` | High | M (preview needs stand-in glyphs; ToolBox is a Valve font) | No (P2 excludes them) |
| 7 | Teammate health number, placed and styled | added `HealthNumber` label | High | S on P2 | P2 |
| 8 | Label colour and size inside panels | `fgcolor_override`, `HudEd_` font copies | High | S on P2 | P2 |
| 9 | Own-health insides incl. hiding the scratch decals (`HealthbarTextureTop/Bottom`) | `localplayerpanel.res` | Med | S on P2 | P2 minus decals |
| 10 | Own-health panel background style (`LocalPlayer` `image`) | `localplayerdisplay.res` | Med | S | No (`panelBg` targets only `TeamPlayerN`) |
| 11 | **Weapon selection layout**: box sizes, gap, direction, icon/number/ammo offsets, colours, fonts | `hudlayout.res` `HudWeaponSelection` keys | High | M | No |
| 12 | **Weapon boxes restyle in normal mode** (repoint `rounded_background_glow`/`_noborder` to new names) | `scripts/mod_textures.txt` (new base file) | High | S-M | No |
| 13 | Use/revive bar style: fill/empty/border colours, thickness, bar size, label | `progressbar.res` | Med | S | No |
| 14 | **Target ID movable** via the two animation events; colours; font | `hudanimations.txt` `TargetIDNormal`, `TargetIDReviveProgress`; `targetid.res` | Med | S-M | No |
| 15 | Chat writes `basechat.res` too (position, size, `HudChatHistory` size) and keeps `DeathPanelOpen`'s offset instead of flattening all three events to one point | `basechat.res`, `hudanimations.txt` | Med (correctness) | S | No |
| 16 | Chat style: background, font size, colours | `basechat.res`, `chatscheme.res` | Med | S | No |
| 17 | Infected card fit to content (self block `ZombieTeamDisplayPlayer` 256x128) plus insides | `zombieteamdisplayplayer.res` | High (infected) | M | P2 insides only |
| 18 | SI health insides, and per-class files edited independently rather than only as Hunter deltas | five `*health.res` | Med | M | P2 (deltas only) |
| 19 | Remove `tankhealth.res` from the registry and find the Tank's real file | `elements.ts`, v2 spec | Med (correctness) | S + one in-game check | No |
| 20 | Ghost panel restyle: background colour/size, hide class art, fonts, `WhiteText`/`RedText` | `hudghostpanel.res`, `hudlayout.res` | High (infected: it covers mid-screen) | M | No |
| 21 | Ability ring and crosshair ability marker colours and sizes | `hudlayout.res` `CHudAbilityTimer`, `HudCrosshair`; `abilitytimerhud.res` | Med | S | No |
| 22 | Tank frustration layout (bar size, `east_aligned`, fonts) | `frustrationmeter.res` | Low-med | S | No |
| 23 | Dead-infected spawn countdown place and style | `spectatorinfected.res` (new base file) | Med | M | No |
| 24 | Voice list and own mic placement, row size, font | `hudlayout.res` `HudVoiceStatus`, `HudVoiceSelfStatus` | Med | S | No |
| 25 | Server menu (SourceMod) offset, fonts, colours | `hudlayout.res` `HudMenu`, animations | Med | S-M | No |
| 26 | Vote panel place and style | `hudlayout.res` `CHudVote`, `votehud.res` | Low-med | S (move) / M (insides) | No |
| 27 | Too-far / tank takeover panel, infected damage record, infected voice, peril notice, leaving-area warning, finale meter, close captions, damage indicator arcs, history list | see A | Low-med each | S each (move/hide) | No |
| 28 | Kill feed entry: remove or relabel (it does nothing) | `elements.ts` `killFeed` | Med (honesty) | S | No |
| 29 | Image tint on image children (`drawColor`, e.g. the infected card background, portraits) | image children | Med | S on P2 | No (P2 colour is labels only) |
| 30 | Added decoration: plain rectangles (`ImagePanel` + `fillcolor`) behind or between children, as Modern's `ModBg` | any panel `.res` | Med | M | No (only the fixed HealthNumber toggle) |
| 31 | Tab scoreboard and versus score panel: row style, widths, fonts, colours | `scoreboard*.res`, `versusmodescoreboard.res` | Low-med | L | No |
| 32 | Global font size and flags (shadow, outline, weight) per font entry | `clientscheme.res` `Fonts` | Med | M | No |
| 33 | Scheme colour theme (named colours used by code-driven labels, e.g. `SelectionTextFg`, `FgColor`, `Ability.Clock.*`) | `clientscheme.res` `Colors`, `BaseSettings` | Med | M | No |
| 34 | zpos / layer order per child and per element | `zpos` | Low | S | No |
| 35 | Item pickup fly-in path and speed, or disable | `hudanimations.txt` `StartItemPickup1..3` | Low | S | No |

## C. Hard limits (say so in the UI)

1. **Different contents per teammate.** One `TeammatePanel.res` is loaded for every card (a single
   path in the dll). Per-slot position, clip size and background image are possible (item 3),
   different children are not. Which teammate lands in which slot is code's choice (**inferred**).
2. **Vertical or stacked infected row.** `CHudZombieTeamDisplay` reads only `HorizPanelSpacing`;
   `VertPanelSpacing` is absent from the dll. A "column" of infected is impossible.
3. **Kill feed.** L4D1 has no death-notice HUD class. There is nothing to move or restyle, and the
   editor should stop offering it.
4. **New information.** HUD labels can show only the dialog variables their own panel sets (A.0):
   no teammate temp-health number, ammo, distance, boss percent, round score or timers on the
   HUD. Those need a server plugin; they are not a HUD-file problem.
5. **Temporary health as a number.** Only `%HealthNumber%`. The bar's temp segment is code-drawn
   (`healthbar_white`, `cl_temp_health_*` cvars).
6. **Portrait art per player.** Portraits are chosen by character in code
   (`../vgui/s_panel_<char>`, `_incap`, `s_panel_dead`); changing them means overwriting the
   stock textures (Advanced mount), and the change applies to every player with that character.
7. **Health bar fill colours.** Code draws the fill; the file can move, size and hide the bar.
   The per-state green/orange/red textures are probably unused (A.4); a flat colour per state may
   not be achievable at all. Verify once in game before promising it.
8. **When children appear.** Incapacitated, Dead, Voice, DuckingIcon, SkullIconPlacement, the
   teammate splatter, ghost/too-far/tank panels: code decides. Files decide only where and how.
9. **Colours code rewrites.** The own health number's colour tracks health in game regardless of
   the file (owner's screenshot); `fgcolor_override "White"` (named colour) draws nothing in some
   panels, raw `r g b a` works.
10. **Weapon slot contents.** Slot order, count and which weapon shows are code. Icons are glyphs
    of the ToolBox font named in `scripts/weapon_*.txt`; those are gameplay scripts, so an icon
    pack through them is out (and would risk the server's file consistency list if it ever grew
    to cover `scripts/`).
11. **Overhead names and glows.** 3D, code-placed; height and glow colours are cvars
    (`hud_targetid_name_height*`, `cl_glow_*`), not files.
12. **Stock crosshair look.** `cl_crosshair_*` cvars. The HUD can host an image crosshair
    (`xHair`) and perhaps hide the engine one (`never_draw`, inferred). `vgui/hud/altcrosshair`
    is not in `pak01`, so an `xHair` with no crosshair addon points at a missing texture.
13. **Per-aspect or per-resolution layouts.** No such conditional exists; layouts adapt only
    through `r`/`c` anchors (and possibly `_minmode` variants toggled by a cvar).
14. **No automatic child scaling.** VGUI never scales children; every scale is written out.
15. **Engine plumbing.** VPK v1 and VTF 7.2 only; a game restart to see changes; an addon's
    `scripts/hudlayout.res` loses to a crosshair addon listed above it in `addonlist.txt`;
    textures in `pak01` can be replaced only from a `gameinfo.txt` mount.
16. **Fonts.** Trade Gothic (the stock face) cannot ship; any bundled TTF can. Scheme fonts are
    global names, so a per-element size needs a cloned entry (already how the editor works).

## D. Cross-cutting capabilities worth adding

- **Card fit-to-content**, one button per card-type panel (survivor card, infected card, own
  health, SI health): compute the steady-state child bounding box, crop the card to it, shift the
  children, and resize state art (incap, dead, splatter) to the new card as Modern does. The single
  biggest win for the owner's feedback.
- **Gap-based spacing**: store the gap between cards, not the pitch; pitch = card size + gap.
  Removes the stock column's 104-unit air and makes spacing survive a card resize.
- **Per-slot team layout**: Row, Column and Free (each `TeamPlayerN` dragged on its own).
- **Per-child style controls** on every label (colour, size, alignment, shadow via a font clone)
  and every image (tint via `drawColor`, fill via `fillcolor`): one control set, many panels.
- **Global theme**: an accent and text colour pair applied to every label the editor knows and to
  the scheme colours code uses; a global text-size multiplier (clone every HUD font entry with
  `tall * k`); a shadow/outline toggle for HUD fonts.
- **State preview**: switch the preview between healthy, hurt, incapacitated, dead, ghost and
  tank, so code-driven children (and the fit policy) can be seen and placed.
- **Sibling anchoring** through `pin_to_sibling` (engine supports it, dll): "keep the health
  number right of the name" survives later edits.
- **Explicit anchors**: let a player pin an element to left/centre/right per axis instead of the
  derived thirds, and show which anchor each element uses.
- **Alignment tools**: align and distribute selected elements, equal gaps, nudge grid.
- **Decoration children**: add a plain rectangle behind a group (the `ModBg` pattern) in any panel
  that has insides. Static only; the UI says it shows no data.
- **Presets as data**: keep stock and modern, add a "compact competitive" preset built with the
  editor itself, and "start from my current HUD" by importing an addon VPK (parse its `.res`).
- **Honest registry**: drop dead entries (kill feed, `tankhealth.res`), and add a test that every
  registry key and hudlayout block the editor writes is named in a committed `client.dll` strings
  list, so a dead key can never be offered again.
- **Cvar companion text**: for what only cvars do (`hud_targetid_health`, `cl_drawprogressbar`,
  `hud_zombieteam_showself`, `cl_crosshair_*`), show a copy-paste snippet for `autoexec.cfg`.
  Never ship a `.cfg` in the VPK: an addon file would shadow the player's own.
- **Animation tweaks**: a few named switches (target ID offset, item pickup fly-in off, chat
  positions during death and intro), written into `hudanimations.txt`, rather than a raw editor.
- **Alternate layout via `cl_hud_minmode`** (inferred): if `_minmode` keys work in L4D1, one
  download can carry a second layout the player toggles from the console. Needs one in-game test.

## E. Recommended phases, most valuable first

1. **Teammate cards done right** (answers all three pieces of feedback). Fix the spacing model
   (gap, not pitch; item 2), card fit-to-content with a state-art policy (1, 4), per-slot Free
   layout (3), and Plan 2's child editing for `teamColumn` extended with `Items` and `Status` (5,
   6, 7, 8) plus a healthy/incap/dead preview toggle. Also the two correctness fixes that cost
   nothing: drop the kill feed and `tankhealth.res` from the registry (19, 28).
2. **Plan 2 for the other three panels plus styling**: own health (9, 10), infected card with fit
   (17), SI health (18) after one in-game check of which file the Tank uses; image tint and
   decoration rectangles (29, 30). In-game check of the bar fill textures (C.7) before the
   Advanced bar slots are promised again.
3. **Weapons and bars**: weapon selection keys (11), `mod_textures.txt` weapon boxes in normal
   mode (12), use/revive bar style (13), chat through `basechat.res` and its style (15, 16).
4. **Infected quality of life**: ghost panel restyle (20), ability ring and crosshair marker
   colours (21), dead-infected countdown (23), tank meter (22), damage record, too-far panel.
5. **The rest of the screen**: target ID via animations (14), voice list and own mic (24),
   server menu (25), vote panel (26), peril notice, captions, damage arcs (27).
6. **Themes and tools**: global colour theme and text-size multiplier (32, 33), alignment tools,
   explicit anchors, sibling anchoring, presets and addon import, cvar companion.
7. **Tab screens and extras**: scoreboard and versus panel (31), spectator and round-end screens,
   animation tweaks (35), the `_minmode` alternate layout after its in-game test.

In-game checks this audit asks the owner for (one addon, one session): which SI file the Tank
reads; whether `healthbar_green/orange/red` overrides change the bar; whether `never_draw` hides
the stock crosshair; whether `_minmode` keys switch with `cl_hud_minmode 1`; whether the chat
follows `hudlayout.res` or `basechat.res` when they disagree.

## In-game probe results, 2026-09-22

The owner ran `hud/probe-2026-09-22` (addon VPK plus a `gameinfo.txt` mount) on a local versus
listen server. Results:

| Test | Result |
|---|---|
| T1 Tank's health file | The Tank reads **`hunterhealth.res`** (showed `FILE hunterhealth` at 6000 health), the same file as the Hunter. Smoker reads `smokerhealth.res`, Boomer `boomerhealth.res`. `tankhealth.res` is dead, as the audit said. `zombiehealthleft_small/large` were not seen for any class |
| T2 `never_draw` on `HudCrosshair` | **Works**: the engine crosshair is gone for survivors and infected |
| T3 `_minmode` | **Impossible**: `cl_hud_minmode` is an unknown command in L4D1 |
| T4 chat | The chat window you type into, and its history, sit where **`basechat.res`** puts them, in `basechat.res`'s background colour. `hudlayout.res`'s `HudChat` draws a separate background panel at the animation file's position all the time, so the editor must never give it a colour and must write chat position to `basechat.res` |
| T5 per-teammate positions | **Works**: `TeamPlayer1..3` each landed where their own block said |
| T6 fit card to content | **Works**: a 121x36 card with every child shifted shows portrait, items, bar and name uncut. **The card's own `image` is never painted** (the magenta background did not show), which is also why stock `s_panel_background` is invisible: the editor's `panelBg` slot, which repoints `TeamPlayerN` `image`, does nothing in game. Incap and dead art resized to the card do show inside it; the incap art squashed to 121x36 reads as a thin strip, so a fitted card needs a shape policy for it. The damage splatter shrunk to the card is faintly visible at full health (so it is drawn, faintly, not hidden) |
| T7 teammate health number | **Works**: `%HealthNumber%` on the teammate card shows each teammate's health and updates; incapacitated it shows the incap health (299) in red. **Code recolours it by health** (green, orange, red) and ignores `fgcolor_override`. Half-width bar and moved Items: work |
| T8 bar textures | `path` confirmed the mount loaded first, yet bars stayed green/orange and temp health drew white stripes: **health bar fills are code-drawn and cannot be recoloured through `healthbar_*` textures**. The Advanced bar slots should be removed |

Also seen: game messages such as "Bill killed Mal" and "Mal incapacitated Louis" print into the chat
history, not a separate kill feed, which confirms the kill feed element should go.
