# HUD Editor Phase 2, slices 2.5 to 2.8 and the leftovers, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Hand an implementer one or two tasks at a time, in order.

> **Runs AFTER** the infected plan (`2026-09-24-hud-editor-phase2-infected.md`, through Task 15) and the fixes plan. Every line number in this plan is from `b401ec55` and will have moved: find code by the names given, never by line. This plan absorbs the infected plan's open fix tasks X-B14a and X-B14b (as L2 and L3 here); do not also run them from there.

**Goal:** Finish Phase 2: the controls the built elements still lack (weapon icon pack and box images, teammate extras, kill notice style, chat font), the use bar's insides, the ghost panel and the too-far / Tank takeover / frustration panels, the minor elements (mic, vote, holdout timer, voice lists, finale, peril, leaving area, spawn countdown, pickup fly-in), and four leftovers (the dead infected skull, the infected card backdrop blend, scaled panels running off screen, handles off the canvas). Every control is one the game was seen to honour, or ships behind a gate named below.

**Architecture:** The Phase 2 machinery already on the branch: the per-panel registry (`children.ts` `PanelChildren`, `PANEL_CHILDREN`), typed `KeyDef` keys on elements and children, `childPass`/`panelChild`, `hardHide`, `PreviewState`, `probes.ts` gates. New panels are registry entries plus a painter in `mock.ts` that draws from `buildTrees`. Uploads reuse the splatter path: an `images[id]` PNG in the design, decoded to RGBA in `BuildAssets.images`, written as a VTF under `materials/vgui/hud/hudeditor/`, and pointed at by `scripts/mod_textures.txt` (weaponsPass's repoint).

**Tech Stack:** TypeScript, Preact, Vite, vitest (project `web`, happy-dom; `// @vitest-environment node` where a test reads files), canvas 2D. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-hud-editor-phase2-design.md`, sections 1.4, 3.5 to 3.8. **Probe answers (read first; they override the spec where they differ):** `/home/volence/l4d/hud/probe-phase2-rest/RESULTS.md` (launches R1 to R6, 2026-09-24), with every shot it cites. Earlier: `/home/volence/l4d/hud/probe-phase2/RESULTS.md` (B1: S-items, S-head, Q22; B2: `visible 0` hides nothing), `/home/volence/l4d/hud/probe-2f/RESULTS.md` (hard hide, box alpha), `/home/volence/l4d/hud/probe-phase2-infected/RESULTS.md` (B14, the two mismatches). Project memory: `/home/volence/.claude/projects/-home-volence-l4d/memory/pug-hud-editor.md`.

---

## What the probes answered (no gate needed)

"R" is `/home/volence/l4d/hud/probe-phase2-rest/RESULTS.md`.

| Q | Answer | Used by |
|---|---|---|
| W1 | an `icon_equip_*` entry repointed to an upload with its own cell rect draws the upload in full colour | W2, W3 |
| W1 names | **`icon_equip_machinegun` is the M16, `icon_equip_rifle` the hunting rifle** (the `WEAPON_ICONS` comment in `build.ts` says the reverse) | L1 |
| W1 geometry | primary icon: `PrimaryWeaponTall` high, as wide as the upload's aspect; pistol icon: a square as tall as its box whatever the upload's shape; item icons: `IconSize` squares | W3 |
| W2 | uploads keep their colours; an item the player lacks is multiplied by `InactiveItemColor` | W3 |
| W3 | a box upload (repointed `rounded_background_*`, 128x128 rect) is nine-sliced with 16-texel corners, as the stock art | W4 |
| W4 | the weapons panel's `wide`/`tall` right-aligns the column to its right edge and clips numbers and icons (not boxes) | W5 |
| V1, V2 | a font-glyph entry (`voice_self`) repointed to a texture cell draws it; `HudVoiceSelfStatus` moves and sizes | T3, M1 |
| K1 | `label_textalign` on `HudPZDamageRecord` is honoured | K1 |
| K2 | only `recordlabel0` is ever used; its `fgcolor_override` is honoured | K1 |
| K4 | `label4background`'s `image` is honoured (code moves it to row 0) | K2 |
| C1 | `HudChatHistory`'s `font` key is ignored; `ChatFont` itself in `chatscheme.res` sets the size | C1 |
| C3 | the chat does not jump on the player's death (weak) | decision 6 |
| S-items, S-head (B1) | teammate `Items` take `fgcolor_override`, `Head` takes `drawColor` | T1, T2 |
| P1 to P3, Q22 | `BarLabel` colour and font, `AwardIcon` move and size, all `Bar` keys honoured | U1, U2 |
| G1 to G4, Q21 | `WhiteText`/`RedText` colour the ghost panel's lines; a line's own `fgcolor_override` is ignored; line move and font, `ClassImage` move/size, `Background` colour honoured | G1, G2 |
| Z1, Z2, Z4 | `HudZombiePanel` moves; the too-far title colour and background colour are honoured (seen with a spawned infected culled far from the survivors) | Z1, Z2 |
| F1 | the addon's `hudanimations.txt` is read: `StartItemPickup1..3` can be rewritten | M3 |
| VO | `CHudVote` moves, `VoteActive` `bgcolor_override` honoured | M1 |
| H1 | `HudHoldoutTimer` moves (survival) | M1 |
| X-B14a | the dead infected skull draws opaque, multiplied by 98 98 98 | L2 |
| X-B14a extra | `icon_skull` can be repointed | decision 9 |
| B2, B3 (earlier) | `visible 0` hides no element: every new element hides with `hardHide` | all new elements |

## What remains unknown, and its gate

Gates are `probes.ts` entries (`passed: false`); a closed gate hides its control, drops stored values in `validateDesign`, keeps the build from writing the key, and the preview draws the stock look.

| Gate | Question | Tasks that read it | Why unanswered |
|---|---|---|---|
| **K5** | `recordlabel0`'s `font` sets the kill notice's font | K1 (font size control) | R4's notice never fired (killing an infected makes none) |
| **C2** | `basechat.res` `HudChat` `bgcolor_override` colours the open chat | C1 (background control) | `messagemode` over netcon does not open the chat |
| **Z3** | the `TankTakeover` title/text keys are honoured | Z2 (takeover controls) | no Tank offer reached the harness player in three tries |
| **T1** | `frustrationmeter.res` keys (`east_aligned`, label colours and fonts, moves) are honoured | Z3 | the meter never drew in four Tank runs |

**Unobservable with one client (no gate; the UI says when the game shows them):** the voice list, the infected voice panel, the use bar's `Subtext`, the peril notice, the leaving-area warning, the finale meter (not reached). Their controls are move and hide only, which every hudlayout panel tested honours, plus plain Label keys proven on other panels (decision 3).

---

## Global Constraints

- FIRST RULE: never run `git stash` in any form. Never checkout, switch, reset or rebase, never move HEAD. Commit only your own files, by explicit path (`git add <path>`, never `-A` or `.`). If `.git/index.lock` blocks you, wait a few seconds and retry: other agents commit in this worktree.
- Work only in `/home/volence/l4d/pug/.claude/worktrees/hud-editor` (branch `worktree-hud-editor`). No push, no deploy, no ssh, no rcon.
- Commands run from the worktree root. Tests: `npx vitest run --project web <paths>`. Types: `npm run typecheck`. Build: `npm run build`.
- Never use em dashes (or en dashes) anywhere: code, comments, UI copy, test names, commit messages.
- Block comments say why and cite the probe shot (path under `/home/volence/l4d/hud/probe-phase2-rest/`) for every game fact.
- Preview equals file: the canvas draws and hit-tests only from the generator's own trees (`buildTrees`, `panelChild`, `elementRect`, `panelBoxes`).
- **Byte promise:** a saved design that uses none of this plan's new fields builds the same bytes. `download.golden.test.ts` stays green through every task except where a task names a golden change (only L1 may, if a label string reaches a file; it should not).
- Valve's stock art stays preview-only (`art.test.ts`). `children.ts` and `probes.ts` import nothing but types.
- TDD: write the test, run it and capture the RED output in the task report, implement, GREEN, then the whole suite with the count.
- Small plain-English commits, at least one per task.
- In-game runs (task V1 only): `flock /home/volence/l4d/hud/ingame-harness/.lock ./run.sh ...`, one VPK per launch, check "restore verified", never leave the game running. `messagemode` does not work over netcon; chat lines 0.4 s apart are flood-dropped (space them 1.2 s).
- The local test server `/home/volence/l4d1-ds` and the owner's game are shared: never kill a process you did not start.

## Decisions this plan locks in (made overnight, for owner review)

1. **No free width for the weapons panel.** W4 showed `wide`/`tall` only move the column (right-aligned) and cut numbers and icons. Instead the build sizes `HudWeaponSelection`'s `wide`/`tall` to the column it draws (right edge kept), so bigger boxes or fonts are never clipped (task W5). The spec's "weapons panel width (resize free horizontally)" is dropped.
2. **One kill notice colour, not five.** Only `recordlabel0` is ever used (K2); the control writes the same colour to all five rows (harmless, and safe if a server plugin ever fills more). Row spacing is dropped (rows 1 to 4 never show).
3. **Panels never seen with one client ship move and hide only, ungated,** with a note saying when the game shows them: voice list, infected voice, peril notice (ypos only, as the block has no xpos), leaving area, finale meter. Move and hard hide are proven on every hudlayout panel tried; nothing else is offered on them.
4. **The pistol icon upload is drawn square** (W1 geometry), and the upload dialog says so; the primary icon keeps the upload's aspect, capped at 4:1 so a 1-pixel-tall upload cannot make a screen-wide icon.
5. **Uploads are resized in the browser to fixed texel sizes** before they reach the design: gun icons 256x64 max keeping aspect (height 64), pistol and item icons 64x64, boxes 128x128 (so the 16-texel nine-slice corners mean what they mean in the stock art), mic and voice glyphs 64x64. Each under `limits.ts`'s cap, reusing the crosshair image-to-VTF path.
6. **The chat keeps one position for all three chat animation events** (today's `layoutPass`), since R1 saw no death jump; the spec's "keep DeathPanelOpen's own offset" is dropped.
7. **Ghost panel lines have no colour control of their own** (G2): the element's `WhiteText` and `RedText` keys are the colours, labelled "Text colour" and "Warning colour".
8. **Scaling keeps a panel on screen by moving it, not by limiting the scale** (L4): after any scale change (handle or slider), if the element's frame runs past the right or bottom edge it is placed back inside with `placeElement`'s own clamp widened to the whole frame; a panel already on screen does not move, so one on its file anchor keeps it.
9. **A custom dead skull is not offered in this plan** (possible, R3 `r3-l`: `icon_skull` repoints), recorded for Phase 3.
10. **Frustration and Tank takeover insides ship behind gates T1 and Z3**; their move and hide (existing `tankPanel`, new `zombiePanel`) ship now.

## File Structure

```
web/src/hud/probes.ts                 K5, C2, Z3, T1
web/src/hud/elements.ts               kill notice keys, chat keys, ghost keys, zombiePanel, ownMic, vote, holdoutTimer, voiceList,
                                      infectedVoice, finaleMeter, perilNotice, leavingArea, spawnCountdown
web/src/hud/children.ts               TEAM_PANEL Items colour, Head tint; PROGRESS_PANEL; GHOST_PANEL; ZPANEL_PANEL; FRUST_PANEL
web/src/hud/design.ts                 weapons.icons / box 'image', killNotices style, chat font size, pickupFlyIn
web/src/hud/build.ts                  WEAPON_ICONS comment, icon and box uploads, weapons auto-size, notice/chat/anim passes
web/src/hud/weapons.ts                upload geometry in the preview
web/src/hud/render.ts, mock.ts        skull tint, backdrop blend, painters for the new panels
web/src/hud/edit.ts                   keep-on-screen after a scale
web/src/routes/hud/*.tsx              controls, upload dialogs, handles inside the canvas
web/src/hud/base/stock/resource/ui/spectatorinfected.res (+ modern)   new base file, byte-identical to the game's
web/src/hud/download.golden.test.ts   new pinned cases
```

---

# Leftovers first (small, visible, correctness)

### Task L0: Preconditions

- [ ] Confirm the infected plan's Task 15 is on the branch (`git log --oneline | grep -i "independent VPK reader"`). Run `npx vitest run` and record the counts. Red suite: stop and report.
- [ ] Append golden cases (hashes from current code) for: a design with `weapons.boxActive` flat, `killNotices` moved, `chat` moved and resized, `progressBar` moved, `ghostPanel` moved, `tankPanel` hidden. Commit: "Pin the downloads of saved designs before the rest of Phase 2".

### Task L1: Name the gun icons right

**Files:** `web/src/hud/build.ts` (the comment above `WEAPON_ICONS`), `web/src/hud/weapons.ts`, any label map naming icon entries; tests beside them.

- [ ] Test (RED): a new `WEAPON_ICON_LABELS` (exported from `build.ts`, next to `WEAPON_ICONS`) maps `icon_equip_machinegun` to "M16 (assault rifle)" and `icon_equip_rifle` to "Hunting rifle", with the other five (`pumpshotgun` "Pump shotgun", `autoshotgun` "Auto shotgun", `uzi` "Uzi", `pistol` "Pistol", `dualpistols` "Dual pistols"); every `WEAPON_ICONS` entry has a label.
- [ ] Implement; fix the comment: cite R1 `r1/shots/crops/weap-a.png` (rifle entry repointed, M16 unchanged) and R4 `r4/shots/crops/weap-abc.png`. No output bytes change (the golden stays green). Commit: "Name the M16 and hunting rifle icons the way the game uses them".

### Task L2: The dead infected skull, as dark as the game draws it (X-B14a)

**Files:** `web/src/hud/render.ts` (`drawCardArt`), `render.test.ts`.

- [ ] Test (RED): drawing a dead infected card, the skull's opaque texels come out 98 98 98 (a test canvas through `drawCardArt` with the white skull art mocked as the other art tests do; read the pixel); its alpha is untouched.
- [ ] Implement: `SKULL_TINT = [98, 98, 98]`, drawn through `tinted(img, material, ...SKULL_TINT)`; comment cites `r3/shots/r3/r3-l.png` (quadrants 98 / 98 0 0 / 0 98 0 / 70 for alpha 128) and `probe-phase2-infected/b14/shots/b14/b14-g.png` (flat 98 over a 53 46 33 floor: a tint, not an alpha), and client.dll `0x10247fb0` (the draw's own colour is white; the 98 is applied further down, not found). Commit: "Draw the dead infected skull at the grey the game draws".

### Task L3: The infected card backdrop in linear light (X-B14b)

**Files:** `web/src/hud/render.ts` (the infected card `BackgroundImage` draw, `paintLinearOver`, `linearOverArt`), `render.test.ts`.

- [ ] Step 1, measure (no code): from `probe-phase2-infected/b14/shots/b14/b14-g.png` (disc centre 20,975 reads 53 46 33) and `parity/stock-*.png`, and for the SI frame and the ring splat from `b14-b` and `b14-c` (their black art over the Hunter's arm) against the preview shots in `b14/preview/`, write down in the task report which of the three need the linear blend (the disc surely; the other two only if the game lets more through than the preview by more than 10 levels).
- [ ] Test (RED): over a mid-grey backdrop, the stock infected card disc (black at alpha 224) comes out at the linear-light value (for backdrop 128: about 46, not 16), via the same helper the dead survivor art uses.
- [ ] Implement for the disc, and for the SI frame / ring splat only if Step 1 said so. Commit: "Blend the infected card backdrop in linear light, as the game does".

### Task L4: A scaled panel stays on screen

**Files:** `web/src/hud/edit.ts` (`scaleElement`, a new `keepOnScreen`), `web/src/routes/hud/ContextPanel.tsx` (the Scale slider), `edit.test.ts`.

- [ ] Test (RED): `ownHealth` at its stock place scaled to 2 by the slider path (a new exported `setScale(design, id, scale)`) ends with its `elementFrame` inside 0..screenW and 0..480; the same at scale 1.2, where it still fits, leaves `x`/`y` absent (the file anchor kept); a bottom-right handle drag to 2 on `siHealth` also ends inside; a left or top handle keeps today's behaviour.
- [ ] Implement `keepOnScreen(design, id)`: read `elementFrame`; if it runs past an edge, `placeElement` to the nearest in-screen spot (the frame, not just 8 units); `scaleElement` and `setScale` call it; the slider calls `setScale`. Commit: "Keep a scaled panel on screen by moving it back inside".

### Task L5: Handles never leave the canvas

**Files:** the selection overlay drawing (find where `CORNERS` handles are drawn under `web/src/routes/hud/`), its test.

- [ ] Test (RED): for a frame that runs past the canvas's right edge (a Free teammate card or an imported HUD's panel, which L4 does not move), each handle's drawn and hit-tested square lies inside the canvas, pinned to the edge.
- [ ] Implement: clamp each handle's centre into `[h/2, W - h/2]`; hit-testing uses the same clamped squares. Commit: "Keep selection handles inside the canvas".

# Slice 2.5: what the built elements still lack

### Task W1: Weapon uploads in the design

**Files:** `web/src/hud/design.ts` (`WeaponsOverride`, `weaponsOf`), `design.test.ts`.

- [ ] Test (RED): `weapons.icons` is a map from a `WEAPON_ICONS`/`ITEM_ICONS` entry to an image id present in `design.images`; unknown entries and ids with no image are dropped; `WeaponBoxStyle.kind` gains `'image'` (its picture in `images['weaponBoxActive']` / `['weaponBoxInactive']`), dropped back to absent when the image is missing; `weaponIcons: false` still wins over a per-icon upload (the hide).
- [ ] Implement. Commit: "Store per-weapon icon and box uploads in the design".

### Task W2: Build the uploads

**Files:** `web/src/hud/build.ts` (`weaponsPass`, `BuildAssets.images`), `build.test.ts`, `sample.vpkcheck.test.ts`.

- [ ] Test (RED): with an icon upload for `icon_equip_machinegun` (a 192x64 image), the download holds `materials/vgui/hud/hudeditor/icon_equip_machinegun.vtf/.vmt` and `mod_textures.txt`'s entry is exactly `file vgui/hud/hudeditor/icon_equip_machinegun`, `x 0`, `y 0`, `width 192`, `height 64` (the upload's own rect: R4 `weap-abc.png`); a box upload writes a 128x128 VTF and keeps `0 0 128 128`; an entry that was a font glyph gains `file`/`x`/`y`/`width`/`height` and loses `font`/`character` (V1 proves this form).
- [ ] Implement through `weaponsPass`'s `repoint`, rewriting the rect as well as `file` for uploads. Add the case to `sample.vpkcheck.test.ts`. Commit: "Ship uploaded weapon icons and box art through mod_textures.txt".

### Task W3: Draw uploads in the preview, where and how the game does

**Files:** `web/src/hud/weapons.ts` (`weaponSlots`, `textureFiles`, the icon draw), `weapons.test.ts`.

- [ ] Test (RED): the primary slot with a 3:1 upload has `icon.w = 3 * icon.h` and a square upload `icon.w = icon.h` (height `PrimaryWeaponTall`, right-aligned, R4 `r4-a`, `r4-b`); the pistol slot's icon stays `box.h` square whatever the upload (R4 `r4-c`); an item upload the sample player lacks carries `tint = InactiveItemColor` (R1 `weap-a.png`); a box `image` style draws the upload nine-sliced with 16-texel corners through the same `DrawSelfScalableCorners` helper the stock box art uses (R1 `weap-d.png`).
- [ ] Implement: the preview reads the upload's own size for the aspect (the design's `images[id]`), so the primary icon uses the upload's aspect, not the pump shotgun cell's. Commit: "Preview weapon uploads at the size and tint the game gives them".

### Task W4: The upload controls

**Files:** `web/src/routes/hud/ContextPanel.tsx` (weapons section), the image upload helper the splatter uses, a page test.

- [ ] Test (RED): the weapons panel lists every gun and item by `WEAPON_ICON_LABELS` with Upload / Reset; an upload is resized per decision 5 before it is stored; the pistol rows say "Drawn square"; the Box style picker gains "Image" with an upload.
- [ ] Implement. Commit: "Upload your own weapon and item icons and box art".

### Task W5: The weapons panel sized to its column

**Files:** `web/src/hud/build.ts` (`weaponsPass`), `weapons.ts` (the column's extent), `build.test.ts`.

- [ ] Test (RED): with `PrimaryWeaponBoxWide` 120 (wider than stock's 100 - 10 indent), the built `HudWeaponSelection` has `wide` at least the column's width plus the grown active box, and `xpos` moved left by the growth so the right edge stays (R2 `r2/shots/crops/weap-ab.png`: the panel clips numbers and icons); a stock design writes nothing (golden green); `tall` covers the lowest item slot.
- [ ] Implement: compute the column's extent from `weaponSlots` (all three held states, taking the largest), grow `wide`/`tall` only when the column is bigger than the file's. Commit: "Grow the weapons panel to fit its column, so the game never cuts a number or icon".

### Task K1: Kill notice alignment and colour

**Files:** `web/src/hud/elements.ts` (`killNotices` keys), `web/src/hud/probes.ts` (K5), build (a pass writing `pzdamagerecordpanel.res`), `mock.ts` `paintKillNotices`, tests.

- [ ] Test (RED): `killNotices` takes `label_textalign` (`west` / `center` / `east`, an enum key; `KeyDef` gains `type: 'enum'` with `options`), written to `HudPZDamageRecord`; a design colour writes `fgcolor_override` on all five `recordlabelN` (decision 2); `PROBES.K5` exists closed and a font size (a `HudEd_` copy of `Default` at the size) is dropped while it is closed; the preview draws the sample notice right-aligned at the panel's right edge for `east` (R1 `notices-ijkl.png`) in the colour.
- [ ] Implement. Commit: "Align and colour the kill notices".

### Task K2: Kill notice background

**Files:** `web/src/hud/slots.ts` or the style machinery, build, `mock.ts`, tests.

- [ ] Test (RED): a `noticeBg` style (stock / flat colour / none) points `label4background`'s `image` at a generated 32x32 texture (`../vgui/hud/hudeditor/noticebg`) or hard-hides it; the preview draws the notice box in that colour behind row 0 (R1: code moves it to row 0).
- [ ] Implement. Commit: "Restyle or remove the kill notice box".

### Task C1: Chat text size (and the gated background)

**Files:** `web/src/hud/elements.ts` or design (`chat` font size), build (`chatscheme.res`), `probes.ts` (C2), `mock.ts` `paintChat`, tests.

- [ ] Test (RED): a chat text size writes `tall` on every size range of `ChatFont` in `chatscheme.res`, scaled from the stock `yres 480 599` value as the other font copies scale (R4 `chat-d.png`: `ChatFont` itself sets it; R1 `chat-h.png`: `HudChatHistory`'s `font` key is ignored, so no copy is pointed at); the preview's chat lines use the size; `PROBES.C2` closed, a background colour dropped while closed.
- [ ] Implement. Commit: "Set the chat's text size through ChatFont".

### Task T1: Teammate item colour and portrait tint

**Files:** `web/src/hud/children.ts` (`TEAM_PANEL` `Items` `colour: true`, `Head` tint), `render.ts`, tests.

- [ ] Test (RED): the registry offers a colour on `Items` (written `fgcolor_override`) and a tint on `Head` (`drawColor`), both citing `/home/volence/l4d/hud/probe-phase2/b1/shots/crops/card1-a.png`; the preview tints the item icons and the portrait by them (it already tints items: pin it).
- [ ] Implement. Commit: "Colour teammate item icons and tint their portraits".

### Task T2: The voice icons

**Files:** design (two glyph uploads), build (`mod_textures.txt` `voice_player`, `voice_self`), `render.ts`, UI, tests.

- [ ] Test (RED): an upload for `voice_self` (own mic) or `voice_player` (teammate card) replaces the entry's `font`/`character` with a 64x64 cell of `vgui/hud/hudeditor/voice_self` (R1 `voice-g.png`); the teammate card's Voice note says "Shown when a teammate talks; not seen in our tests (needs a second player)".
- [ ] Implement. Commit: "Upload your own microphone and teammate voice icons".

# Slice 2.6: the use / revive bar

### Task U1: Register the bar's pieces

**Files:** `web/src/hud/children.ts` (`PROGRESS_PANEL`), `elements.ts` (`progressBar` `resize: 'scale'`, `children: ['resource/ui/hud/progressbar.res']`), `design.ts`, tests.

- [ ] Test (RED): `panelChildren('progressBar')`: `BarLabel` (label: move, size, font, colour), `Bar` (other: move, size; keys `fill_color`, `empty_color`, `border_color`, `shadow_color` colours and `gap`, `border_thickness`, `shadow_thickness` ints clamped by `progress.ts` `clampBarKeys`), `AwardIcon` (square: move, size; note "The game picks healing or reviving"), `Subtext` (label: move, size, font, colour; note "Shows a name when someone heals or revives you; not seen in our tests"); names exist in stock and Modern; `validateDesign` keeps them; scale reaches the children.
- [ ] Implement. Commit: "Edit the use bar's label, bar, icon and subtext".

### Task U2: The bar's preview from its edited file

**Files:** `mock.ts` `paintProgressBar`, `progress.ts`, tests.

- [ ] Test (RED): with `BarLabel` coloured and `AwardIcon` at 232,0 40x40, the preview draws the label in that colour and the icon at that rect (R1 `bar-e.png`, `bar-e-icon.png`); the bar keys already drawn stay drawn; a scaled bar scales every piece.
- [ ] Implement (the painter already reads `buildTrees`; make sure `childPass` edits land in the trees it reads). Commit: "Preview the edited use bar".

# Slice 2.7: ghost panel, too far and Tank takeover, frustration

### Task G1: Ghost panel pieces and its two text colours

**Files:** `elements.ts` (`ghostPanel` keys `WhiteText`, `RedText` labelled "Text colour", "Warning colour"; `resize: 'scale'`, `children: ['resource/ui/hudghostpanel.res']`), `children.ts` (`GHOST_PANEL`), tests.

- [ ] Test (RED): registry: `Background` (other: size; key `bgcolor_override` colour), `ClassImage` (square), `ClassName`, `SelectSpawn`, `Ready`, `Info`, `SpawnLabel` (labels: move, size, font, **no colour**, note "Coloured by the panel's Text and Warning colours", R3 `r3-a`), `SpawnBind` (other: move only). Names in stock and Modern.
- [ ] Implement. Commit: "Edit the spawn panel's pieces and its two text colours".

### Task G2: The ghost panel drawn from its file

**Files:** `mock.ts` (`paintGhostPanel` replaced), `art.ts` + `scripts/export-hud-art.py` (`tip_hunter` cell of `vgui/tipgraphic`), tests.

- [ ] Test (RED): the preview draws `Background` in its colour with rounded corners (`PaintBackgroundType 2`), the class art at `ClassImage`, "HUNTER" in `WhiteText`, "Choose Spawn Location" in `WhiteText`, "Can't spawn here" in `RedText`, fonts from the file; matches `r3-a`'s layout within 2 px at 1920x1080 (compare headless via `canvas.toDataURL()`).
- [ ] Implement. Commit: "Draw the spawn panel the way the game does".

### Task Z1: The too-far / Tank takeover element

**Files:** `elements.ts` (`zombiePanel`: key `HudZombiePanel`, side infected, move, hide, `mockSize` 320x155), `mock.ts`, tests.

- [ ] Test (RED): moving writes `HudZombiePanel` `xpos`/`ypos` (R6 `toofar-a.png`); hiding hard-hides; the preview draws the too-far box from `zombiepanel.res` (`Background` colour, `SurvivorsImage`, "TOO FAR FROM THE SURVIVORS", the text line).
- [ ] Implement. Commit: "Move or hide the too-far and Tank takeover panel".

### Task Z2: Too-far insides, and the gated takeover insides

**Files:** `children.ts` (`ZPANEL_PANEL`, nested blocks `TooFarFromSurvivors/*`, `TankTakeover/*`), `probes.ts` (Z3), tests.

- [ ] Test (RED): `TooFarTitle`, `TooFarText` (labels with colour and font, R6), `Background` (colour), `SurvivorsImage` (square); `TankTakeover`'s `Title`, `Text`, `TankImage` carry `gate: 'Z3'` and are hidden from the page while closed. The registry's nested-block paths work with `panelChild` (add the support if it only handles top-level blocks, with its own test).
- [ ] Implement. Commit: "Edit the too-far panel's text and box".

### Task Z3: Frustration meter insides (gated T1)

**Files:** `children.ts` (`FRUST_PANEL`), `probes.ts` (T1), `mock.ts` `paintTankPanel` from its file, tests.

- [ ] Test (RED): `Countdown`, `Warning`, `Warning2`, `FrustrationLabel` (labels), `FrustrationBar` (key `east_aligned` bool) all `gate: 'T1'`; the preview draws the stock file ("ATTACK THE SURVIVORS", the bar half full from the east, "CONTROL") whatever the gate, since it only reads the file.
- [ ] Implement. Commit: "Draw the Tank frustration meter from its file, its edits behind a probe".

# Slice 2.8: the minor elements

### Task M1: Mic, vote, holdout timer

**Files:** `elements.ts`, `mock.ts`, tests.

- [ ] Test (RED): `ownMic` (`HudVoiceSelfStatus`, both sides, move, `resize: 'free'` square, R1 `voice-g.png`), `vote` (`CHudVote`, both, move; key `bgcolor_override` on `votehud.res` `VoteActive` as a child colour, R4 `r4-e`), `holdoutTimer` (`HudHoldoutTimer`, survivor, move, note "Survival only", R2 `r2-g`); each hides with `hardHide`; each has a painter (mic glyph square, the vote box with its header, the timer box).
- [ ] Implement. Commit: "Move, size or hide the microphone, the vote panel and the survival timer".

### Task M2: The panels seen only with other players

**Files:** `elements.ts`, `mock.ts`, tests.

- [ ] Test (RED): `voiceList` (`HudVoiceStatus`, keys `item_tall`, `item_wide`, `item_spacing` ints), `infectedVoice` (`HudInfectedVOIP`), `finaleMeter` (`HudFinaleMeter`), `perilNotice` (`CHudTeamMateInPerilNotice`, y only: the element moves vertically), `leavingArea` (`HudLeavingAreaWarning`); each note says when the game shows it and "not seen in our tests" (decision 3); hard hide; a plain labelled frame painter each.
- [ ] Implement. Commit: "Move or hide the voice lists, finale meter, peril and leaving-area notices".

### Task M3: Item pickup fly-in off

**Files:** design (`pickupFlyIn?: false`), build (`hudanimations.txt`), tests.

- [ ] Test (RED): `pickupFlyIn: false` rewrites the bodies of `StartItemPickup1..3` to `Animate imageN Alpha 0 Linear 0.0 0.001` only (R1 `r1-b`: the addon's `hudanimations.txt` is read); absent writes nothing; the chat's position rewrite (`layoutPass`) still applies to the same file.
- [ ] Implement, with a checkbox "Item pickup animation". Commit: "Switch off the item pickup fly-in".

### Task M4: Dead infected spawn countdown

**Files:** `web/src/hud/base/stock/resource/ui/spectatorinfected.res` (and Modern's copy if Modern ships none, the stock file), the base byte-identical test, `elements.ts` (`spawnCountdown`: move the `InfectedState` and countdown labels as one element, colour and text size on `InfectedState`), tests.

- [ ] Test (RED): the new base file equals the game's loose `left4dead/resource/ui/spectatorinfected.res` byte for byte (the existing base test pattern); moving the element offsets `SpawnModeLabel` and `InfectedState` together; colour writes `fgcolor_override` on `InfectedState` (Q23, `probe-phase2-infected/RESULTS.md`).
- [ ] Implement. Commit: "Move and colour the dead infected countdown".

# Verification

### Task V1: In-game check of the new writes (one survivor launch, one infected launch)

**Files:** create `/home/volence/l4d/hud/probe-phase2-rest/v1/` following `../build.mts` (add batches there; do not fork).

- [x] Build from this branch's editor: a design with an M16 and a pills icon upload, an image active box, weapons boxes 120 wide (W5), kill notices east in cyan with a flat box, chat text 20, teammate items yellow, use bar label magenta and icon moved, mic moved with an uploaded glyph, vote moved, pickup fly-in off; and an infected design with the ghost panel's colours and a moved `ClassName`, the zombie panel moved.
- [x] Run survivor steps on R1/R4's routes (one full-health Hunter for a notice; `callvote ChangeDifficulty Normal`; `give pain_pills` then a shot at 0.7 s to prove no fly-in) and infected steps on R3/R6's routes (spawned Smoker culled far away). Also try once more for the gated panels: a director Tank by lottery (`director_force_tank 1` with specials allowed, you as a ghost) for Z3 and T1, and `ent_fire trigger_finale` alternatives for the finale meter; record what shows.
- [x] Record in `probe-phase2-rest/RESULTS.md` (a V1 section) with preview parity crops (headless `canvas.toDataURL()` at 1920x1080). Any mismatch becomes a fix task appended here.

**Done 2026-09-24** (`probe-phase2-rest/RESULTS.md`, V1; six launches, all restores verified). Found and fixed: the frustration bar's preview look (outline and white fill, `8e5afd61`).

### Task V2: Gate flips

One task per gate V1 or a later run answers (K5, C2, Z3, T1): set `passed`, update the tests that pin the control hidden, cite the shot. A NO retires the control and its gate.

**Done 2026-09-24** (`6349ac10`): K5, Z3, T1 passed; C2 stays closed (no key press can reach the game from the harness).

### Task V3: Slice verification

- [x] Full suite, typecheck, build; counts against L0.
- [x] `sample.vpkcheck.test.ts` / `scripts/check-hud-vpk.sh` over a design touching every new field.
- [x] Update the spec's section 2 gap table (items 13, 16, 20 to 27, 35) to "Done" or the gate that holds them.

**Done 2026-09-24**: sample r (`3d78d014`) and all samples read back; final Stock and Modern parity launches in `/home/volence/l4d/hud/probe-phase2-rest/v-verify/RESULTS.md`.

## Task list

| # | Task | Slice | Depends on | Gate |
|---|---|---|---|---|
| L0 | Preconditions, goldens | all | infected plan | |
| L1 | Gun icon names | 2.5 | L0 | |
| L2 | Dead skull grey 98 | leftover | L0 | |
| L3 | Infected backdrop linear blend | leftover | L0 | |
| L4 | Scaled panel stays on screen | leftover | L0 | |
| L5 | Handles inside the canvas | leftover | L4 | |
| W1 | Weapon uploads in the design | 2.5 | L1 | |
| W2 | Build the uploads | 2.5 | W1 | |
| W3 | Preview the uploads | 2.5 | W2 | |
| W4 | Upload controls | 2.5 | W3 | |
| W5 | Weapons panel sized to its column | 2.5 | L0 | |
| K1 | Notice alignment, colour (font gated) | 2.5 | L0 | K5 |
| K2 | Notice background | 2.5 | K1 | |
| C1 | Chat text size (background gated) | 2.5 | L0 | C2 |
| T1 | Teammate item colour, portrait tint | 2.5 | L0 | |
| T2 | Voice icon uploads | 2.5 | W2 | |
| U1 | Use bar registry | 2.6 | L0 | |
| U2 | Use bar preview | 2.6 | U1 | |
| G1 | Ghost panel registry, text colours | 2.7 | L0 | |
| G2 | Ghost panel preview from file | 2.7 | G1 | |
| Z1 | Zombie panel element | 2.7 | L0 | |
| Z2 | Too-far insides, takeover gated | 2.7 | Z1 | Z3 |
| Z3 | Frustration insides gated | 2.7 | L0 | T1 |
| M1 | Mic, vote, holdout timer | 2.8 | L0 | |
| M2 | Voice lists, finale, peril, leaving area | 2.8 | M1 | |
| M3 | Pickup fly-in off | 2.8 | L0 | |
| M4 | Spawn countdown | 2.8 | L0 | |
| V1 | In-game check | all | all above | |
| V2 | Gate flips | all | V1 | |
| V3 | Verification | all | V2 | |

Suggested implementer runs (ordered by player value; each run 1 or 2 tasks, a reviewer after each range):
(L0, L1), (L2, L3), (L4, L5), (W1, W2), (W3, W4), (W5, T1), (K1, K2), (C1, M3), (U1, U2), (G1, G2), (Z1, Z2), (Z3, M4), (M1, M2), (T2), (V1), (V2, V3).
