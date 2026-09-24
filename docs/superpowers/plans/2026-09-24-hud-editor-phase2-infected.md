# HUD Editor Phase 2, slices 2.2, 2.3 and 2.4: the infected panels, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Hand an implementer one or two tasks at a time, in order.

> **Runs AFTER** the plumbing plan (`2026-09-24-hud-editor-phase2-plumbing-own-health.md`, Tasks 0 to 17) and the fixes plan (`2026-09-24-hud-editor-phase2-fixes.md`, at least X1 hard hide for every element, X3 art export, X7 ability timer drawn from its file, X9 and X10 health bar and panel colour). Check with `git log --oneline | grep -i -E "hard-hide every|ability timer from its file|whole health panel"`. Every line number in this plan is from 32a975c1 and will have moved: find code by the names given, never by line.

**Goal:** Every piece of the three infected panels a HUD file can move, size, hide or recolour becomes editable, and the preview draws what the game draws: your special infected health (slice 2.2, one edit applied to the Hunter, Smoker, Tank and, in proportion, the Boomer file), the ability timer and the crosshair ability marker (slice 2.3), and the infected teammate cards (slice 2.4). Where game code decides, the editor says so.

**Architecture:** Three new `PanelChildren` entries in `children.ts` (`SI_PANEL`, `ABILITY_PANEL`, `ZCARD_PANEL`), each on the per-panel machinery slice 2.0 built (registry, `childPass`, `panelWork`, `panelChild`, `panelBoxes`, `FIT_RULES`, `PreviewState`, `hiddenInState`, typed `keys`, hard hide). `childPass` gains the `linked` rule the registry already types. Two new fit rules (`siHealth`, `infectedRow`). One new element, `abilityMarker`, carrying the `HudCrosshair` ability keys. The painters in `mock.ts` for `siHealth`, `abilityRing`, `infectedRow` and the new `abilityMarker` draw from `buildTrees` only.

**Tech Stack:** TypeScript, Preact, Vite, vitest (project `web`, happy-dom; `// @vitest-environment node` where a test reads files), canvas 2D. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-hud-editor-phase2-design.md`, sections 1.2, 3.2, 3.3, 3.4 and 4 (B9, B10, B11). **Probe answers (read first, they override the spec where they differ):** `/home/volence/l4d/hud/probe-phase2-infected/RESULTS.md`, with every shot and crop it cites. Earlier answers: `/home/volence/l4d/hud/probe-phase2/RESULTS.md` (B3: `visible 0` hides no infected element). Project memory: `/home/volence/.claude/projects/-home-volence-l4d/memory/pug-hud-editor.md`.

---

## What the probes answered (no gate needed)

Each row is settled evidence; the tasks below build on it directly. "RESULTS" is `/home/volence/l4d/hud/probe-phase2-infected/RESULTS.md`.

| Q | Answer | What it means here |
|---|---|---|
| Q11 | `HudZombieHealth` clips its children (B10) | the SI fit may shrink the container (Task 3) |
| Q12 | SI `BackgroundImage` honours `drawColor` and `image` (B9, a white test image drew solid green) | the frame takes a tint (Task 1); the stock frame art is black, so the note says a tint shows only on light art |
| B11 | the Tank reads `hunterhealth.res` including its `image` | Tank = the Hunter file, sample 6000 (Task 4) |
| Q13 | SI `HealthNumber` keeps `fgcolor_override` | the number takes a colour, ungated (Task 1) |
| Q14 | code sets the ring backdrop's art (`PZ_charge_bg`) over the file's `image` | `BackgroundImage` of the ring: move, size, hide only; note "The game picks this picture" (Task 6) |
| Q15 | the three ring state colours tint **all three** pieces: icon, backdrop, meter | the element's three colour keys are ungated; the preview tints all three (Tasks 6, 7) |
| Q15 geometry | the meter is lit from 12 o'clock **counter-clockwise** for the fraction p | preview arc (Task 7) |
| Q15 states | Hunter standing = charging, crouched = ready; Smoker, Boomer, Tank ready on spawn | the preview's Ready/Charging tabs; a note on the Hunter (Task 7) |
| Q16a | `HudCrosshair`'s `ability_size` and colours drive the marker; **`ability_size` is screen pixels** (dll type `int`), the marker box is 2 x size; the marker draws only with the `crosshair` cvar on | Tasks 8, 9 |
| Q16b | `never_draw` on `HudCrosshair` removes the marker too | the "hide the game's crosshair" switch must warn (Task 8) |
| S-ring | `Progress` follows a square resize | the ring pieces take square sizes (Task 6) |
| Q17 | the card's self block clips its children | the card fit (Task 11) |
| Q18 | the card backdrop honours `drawColor`, `NameLabel` honours `fgcolor_override` | both colours ungated (Task 10) |
| Q19 | `Dead` shows only when given a height (code toggles its visibility, never its size; stock 0 tall); the skull draws at `SkullIconPlacement`; `HealthPanel` and `PlayerImage` hide when dead | the dead preview (Tasks 10, 12) |
| Q20 | ghost card: the `GhostTeamImage_<class>` icon tinted `206 219 225` (dll), bar shown, no spawn time, no `AbilityProgress` | the ghost preview (Task 12) |
| card ring | `AbilityProgress` shows alive, not ghost, not a Hunter (dll `0x10248700`, seen on Smoker and Tank) | a state rule (Task 10) |
| cards | bots never get a card (dll: `IsFakePlayer` skip); exactly 3 card panels; card i at `x = i * HorizPanelSpacing`, `y 0`; `HorizPanelSpacing` is `proportional_int`, default 140 | Tasks 11 to 13, and an honest note in the UI |
| extra | the SI health bar is **green** at full health (not red, as spec 3.2 says) | Task 4 |
| extra | code hides the SI panel and the ring while you pin someone or throw a rock | a note only (Task 5) |
| earlier | `visible 0` hides no infected element (B3); the fixes plan's X1 already hard-hides elements | every new registry piece's hide goes through `hardHide` |

## What remains unknown, and its gate

| Probe | Question | Gate in `probes.ts` | Tasks that read it | On pass | On fail |
|---|---|---|---|---|---|
| **Q24** | `monochrome_color` on the SI `Health` and the card's `HealthPanel`: the fill takes the colour (the `HealthPanel` class proved it in Q1), but does it also recolour the SI number or the card's name and icon, as it recolours the whole own panel? | `Q24` | 1, 10 (key `gate`), 4, 12 (preview) | Task F1 | leave off; record in the spec |

`inset` is not gated: it is read by the `HealthPanel` class (Q3 passed on that class), the same class the SI panel and the card use.

**Unanswerable in the harness (no gate, the UI says so):** a teammate card's `SpawnTimeLabel` countdown and `Voice` icon (need a second human client; bots never get cards), the multi-card spacing (known from the dll instead), the marker's attack colours and the suppressed colour (never produced). These keys and pieces ship ungated, because the dll proves the class reads them, with notes that say when the game shows them. Recorded as decisions 6 and 7.

---

## Global Constraints

- FIRST RULE: never run `git stash` in any form. Never checkout, switch, reset or rebase, never move HEAD. Commit only your own files, by explicit path (`git add <path>`, never `-A` or `.`). If `.git/index.lock` blocks you, wait a few seconds and retry: other agents commit in this worktree.
- Work only in `/home/volence/l4d/pug/.claude/worktrees/hud-editor` (branch `worktree-hud-editor`). No push, no deploy, no ssh, no rcon.
- Commands run from the worktree root. Tests: `npx vitest run --project web <paths>`. Types: `npm run typecheck`. Build: `npm run build`.
- Never use em dashes (or en dashes) anywhere: code, comments, UI copy, test names, commit messages.
- Match the surrounding comment style: block comments that say why, citing the probe shot (path under `/home/volence/l4d/hud/probe-phase2-infected/`) for every game fact.
- Preview equals file: the canvas draws and hit-tests only from the generator's own trees (`buildTrees`, `panelChild`, `childRects`, `elementRect`, `panelBoxes`).
- **Byte promise:** a saved design with no edits to the three infected panels builds the same bytes as before. `download.golden.test.ts` stays green through every task except where a task names a golden change on purpose (none does).
- Valve's stock art (`web/src/hud/art/`) stays preview-only (`art.test.ts`). `children.ts` and `probes.ts` import nothing but types.
- TDD: write the test, run it and capture the RED output in the task report, implement, GREEN, then the whole suite with the count.
- Small plain-English commits, at least one per task.
- In-game runs (Task 14 only): always `flock /home/volence/l4d/hud/ingame-harness/.lock ./run.sh ...`, one VPK per launch, check "restore verified" in the output, never leave the game running. The owner's config has `crosshair "0"`: a steps file that looks at the marker sends `cmd crosshair 1` after the map.
- The local test server `/home/volence/l4d1-ds` and the owner's game are shared: never kill a process you did not start.

## Decisions this plan locks in (made overnight, for owner review)

1. **Fit keeps the art that already shows (the own-panel rule, plumbing decision 1).** The spec's SI fit (content 134x33) and card fit (124x44) would cut the SI splatter frame and the card's rounded backdrop, the most visible art of both panels, so "fit alone changes nothing on screen" would break. `BackgroundImage` on both panels, and `DuckingIcon` on the SI panel, are `fitPlace: 'keep'`, cut to the file's own frame rect first. Stock SI fits to **(250,0) 150x100** (the Hunter and Boomer files together); stock card fits to **(0,10) 133x64**. Hiding the backdrop shrinks the fit to the spec's content box.
2. **The SI container moves, the Tank does not need its own file.** Fit writes `HudZombieHealth` `wide/tall` = box x scale and adds the box offset x scale to its position (on stock `r387` becomes `r137`); every child in the three live files shifts by the box's top-left. The two `zombiehealthleft_*` files are not child-edited (spec decision 5) and are not shifted; they keep today's scale-only treatment.
3. **Stored SI numbers are in the Hunter's frame** (spec 3.2). Smoker `same`; Boomer `delta`: `x' = x - hunterBase.x + boomerBase.x`, `w' = round(w * boomerBase.w / hunterBase.w)`, same for y/h. Drags and the X/Y/W/H inputs on the Boomer preview convert back through the inverse, so what the player sees on the Boomer is what the Boomer file gets.
4. **The card fit shifts the container, not the cards.** Code places card i at `(i * HorizPanelSpacing, 0)`, so the fitted offset cannot be written per card: `CHudZombieTeamDisplay` `ypos` gains `box.y * k` and `xpos` gains `box.x * k` (stock: 10 units down), exactly the element-position rule the SI fit uses.
5. **`infectedRow` moves from `spacing` to `gap`** (spec decision 7), with `teamFields`' migration, and writes `HorizPanelSpacing = (card.w + gap) * k`. Row only; the UI says why.
6. **Keys proven read by the dll but never seen drawn ship ungated, with a note:** `ability_surpressed_color` (ring and marker), `ability_attack_color` and `ability_attack_color_colorblind` (marker), the card's `SpawnTimeLabel` colour and font. The note says when the game shows them.
7. **The preview draws sample teammates the game can never show you with bots**, three cards (Smoker, Boomer, Hunter), with a line under the canvas on the infected side: "The game shows only human teammates here, at most 3 cards; bots never get one." The own card is not drawn unless "Show yourself" is ticked, a companion note for `hud_zombieteam_showself 1`, not a file key.
8. **The marker is its own non-movable element `abilityMarker`** (spec decision 6), side infected, key `HudCrosshair`. Its size control is labelled in pixels at the game's resolution, and the preview draws it at 1920x1080 with the note "Sized in screen pixels: smaller on a bigger screen."
9. **The ring gets `resize: 'scale'`** and `children: ['resource/ui/hud/abilitytimerhud.res']` so a scale reaches its pieces; its 80x70 hudlayout box keeps clipping the 80x80 backdrop's bottom 10 units, as the game does (fixes X7 matched that).
10. **Preview state rules for the infected side** come from the registry, as for survivors: `StateArt` gains `'ability'` (alive, not ghost, not a Hunter) and `ChildDef` gains `hideInInfected?: ('ghost' | 'dead')[]`.

## File Structure

```
web/src/hud/probes.ts               Q24
web/src/hud/children.ts             SI_PANEL, ABILITY_PANEL, ZCARD_PANEL; StateArt 'ability'; ChildDef.hideInInfected; linkedValue()
web/src/hud/children.test.ts        names in both presets, links, notes
web/src/hud/elements.ts             abilityRing scale + children + keys; abilityMarker; infectedRow gap
web/src/hud/design.ts               infectedRow gap migration, siHealth/infectedRow fit, marker keys
web/src/hud/build.ts                linked childPass, FIT_RULES siHealth and infectedRow, element keys, marker merge with never_draw
web/src/hud/render.ts               PANEL_FILE by class, hiddenInState for infected, ring tint and arc, ghost tint
web/src/hud/mock.ts                 paintSiHealth, paintAbilityRing, paintAbilityMarker, paintInfectedRow
web/src/hud/selection.ts, edit.ts   class-aware SI pieces, card level for infectedRow
web/src/hud/art.ts, scripts/export-hud-art.py, web/src/hud/art/*   crouch_infected, pz_charge_crosshair, pz_crosshair_open, zombieteamimage_*, icon_skull cell
web/src/routes/hud/Toolbar.tsx      class picker, Alive / Ghost / Dead, Ready / Charging, Show yourself
web/src/routes/hud/ContextPanel.tsx notes, marker group
web/src/routes/hud/LayersPanel.tsx  the three panels' pieces
web/src/hud/download.golden.test.ts infected cases
```

---

# Slice 2.2: your special infected health

### Task 0: Preconditions and infected golden cases

**Files:** Modify `web/src/hud/download.golden.test.ts`.

- [ ] **Step 1:** Confirm the plans named in the header are on the branch. Run `npx vitest run` and record the baseline counts. Red suite: stop and report.
- [ ] **Step 2:** Append pinned cases (as `validateDesign` returns them) for: `siHealth` scale 1.5 and moved; `infectedRow` scale 2 with a stored `spacing` 200 (the pre-gap form); `abilityRing` moved; `hideGameCrosshair: true`; Modern with each of the same. Compute the hashes from the current code, paste them, run GREEN. These pin today's output so Tasks 1 to 14 cannot change a saved design by accident. Commit: "Pin the downloads of saved infected designs before the infected panels change".

### Task 1: The Q24 gate and the SI health registry

**Files:** Modify `web/src/hud/probes.ts`, `probes.test.ts`, `web/src/hud/children.ts`, `children.test.ts`.

- [ ] **Step 1: Tests (RED).** `probes.test.ts`: `PROBES.Q24` exists, `passed: false`, batch `B14`. `children.test.ts`:
  - `panelChildren('siHealth')` has file `resource/ui/hud/hunterhealth.res`, `repeat: 'single'`, `frame: 'hudlayout'`, `linked` = smoker `same`, boomer `delta`;
  - every registered name exists in the stock and Modern copies of all three files (read the base files the way the existing name tests do; Modern's `ModBg` stays unregistered, as on the own panel);
  - `Health` carries keys `monochrome_color` (gate `Q24`) and `inset` (int 0..8, no gate); `BackgroundImage` is `decor`, `colour: true`, `fitPlace: 'keep'`; `HealthNumber` is a label with `colour: true` and no `colourGate`; `DuckingIcon` is `state`, `stateArt: 'crouched'`, `fitPlace: 'keep'`, `colour: true` (Q8 proved the same class keeps a tint);
  - `dllstrings.test.ts` stays green (every key is in the dll run).
- [ ] **Step 2: Implement.** Add `'Q24'` to `ProbeId` and `PROBES` (question: "monochrome_color on the SI Health and the card HealthPanel: what else it recolours"). Add `SI_PANEL` to `children.ts` and to `PANEL_CHILDREN`:

```ts
/**
 * Your special infected health: hunterhealth.res, which the Hunter and the
 * Tank read (probe T1, B9 b9-l), with smokerhealth.res (the same geometry)
 * and boomerhealth.res (a smaller bar) following every edit through
 * `linked`. Probe answers, /home/volence/l4d/hud/probe-phase2-infected/RESULTS.md:
 * Q11 the container clips; Q12 the frame takes a tint and an image; Q13 the
 * number keeps its colour.
 */
export const SI_PANEL: PanelChildren = {
  panelId: 'siHealth', file: 'resource/ui/hud/hunterhealth.res', repeat: 'single', frame: 'hudlayout',
  linked: [{ file: 'resource/ui/hud/smokerhealth.res', rule: 'same' }, { file: 'resource/ui/hud/boomerhealth.res', rule: 'delta' }],
  children: [
    { name: 'BackgroundImage', label: 'Frame', kind: 'image', role: 'decor', box: 'wh', move: true, font: false, colour: true, fitPlace: 'keep',
      note: 'A tint shows only on light art: the stock frame is black.' },
    { name: 'Health', label: 'Health bar', kind: 'bar', role: 'content', box: 'wh', move: true, font: false, colour: false,
      keys: [
        { key: 'monochrome_color', label: 'Bar colour', type: 'colour', gate: 'Q24', evidence: 'client.dll HealthPanel run: m_monochromeColor|monochrome_color' },
        { key: 'inset', label: 'Inset', type: 'int', range: [0, 8], evidence: 'client.dll HealthPanel run: m_inset|inset; probe B1 Q3 on the same class' },
      ],
      note: 'The game fills the bar by health.' },
    { name: 'HealthNumber', label: 'Health number', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true },
    { name: 'DuckingIcon', label: 'Crouch icon', kind: 'image', role: 'state', box: 'square', move: true, font: false, colour: true,
      stateArt: 'crouched', fitPlace: 'keep', note: 'The game shows this while you crouch.' },
  ],
};
```

  Adjust field names to what the plumbing plan actually shipped (read `OWN_PANEL` first). GREEN, full suite. Commit: "Register the pieces of your infected health, with the bar colour gated on Q24".

### Task 2: Linked files: one edit, three special infected

**Files:** Modify `web/src/hud/children.ts` (a pure `linkedValue` helper), `web/src/hud/build.ts` (`childPass`, `hidePass`), `build.test.ts`, `children.test.ts`.

- [ ] **Step 1: Tests (RED).**
  - `children.test.ts`, `linkedValue(rule, key, stored, hunterBase, boomerBase)`: `same` returns stored; `delta` on x: stored 262, hunter 252, boomer 322 gives 332; on w: stored 112, hunter 132, boomer 64 gives 54 (`Math.round(112 * 64 / 132)`); `visible`, colours, fonts and keys pass through for both rules. Its inverse `unlinkedValue` round-trips every case within 1 unit.
  - `build.test.ts`: a design with `children.siHealth.Health = { w: 112, y: 60 }` writes Hunter `wide 112, ypos 60`, Smoker the same, Boomer `wide 54, ypos 60`; `HealthNumber` colour `0 0 255 255` lands in all three as `fgcolor_override`; `BackgroundImage` hidden hard-hides it in all three; a Hunter `[$WINDOWS]` `tall` line is replaced, never doubled (`pcSet`); `zombiehealthleft_small.res` is byte-identical to the design without the edit.
- [ ] **Step 2: Implement.** In `childPass`, after `applyChild` on the panel's own file, for each `linked` entry parse that file's block of the same name and apply the override mapped through `linkedValue` (bases read from `baseTree(baseOf(design), file)`, never from the already-edited tree). Same in `hidePass` for hidden pieces. An imported HUD missing a linked file or block: skip that file, as `childPass` skips a missing block on imports. GREEN, full suite (goldens unchanged). Commit: "Apply every infected health edit to the Hunter, Smoker and Boomer files, the Boomer's in proportion".

### Task 3: Fit your infected health

**Files:** Modify `web/src/hud/build.ts` (`FIT_RULES.siHealth`), `web/src/hud/design.ts` (keep `fit` on `siHealth`), `build.test.ts`, `design.test.ts`.

- [ ] **Step 1: Tests (RED).**
  - stock, `siHealth.fit = true`: the content box across the three live files is x 250..400, y 0..100 (Hunter frame 250,0 200x100 cut to the 400x100 container, Boomer frame 320,0 100x100, bars and numbers inside, crouch icon 320,42 inside), so the box is (250,0) 150x100;
  - every child in hunter/smoker/boomer shifts by (-250, 0); `HudZombieHealth` becomes `wide 150`, `tall 100`, `xpos r137`, at scale 1; at scale 1.5 `wide 225`, `tall 150` and the xpos offset is `250 * 1.5`, written through the same anchor helper `layoutPass` uses;
  - fit alone leaves every child's screen rect unchanged at scale 1 and 1.5 (compare `panelChild` screen rects with fit off and on, within 1 unit);
  - frame hidden: the box is (252,42) 134x40 (the bars and numbers, plus the kept crouch icon at 320,42); frame and crouch icon hidden: (252,49) 134x33, the spec's box;
  - `validateDesign` keeps `fit` on `siHealth` and drops it anywhere it is not a registered fit.
- [ ] **Step 2: Implement** on the `fitOwn` pattern: `siContent(work, design)` unions the fitted boxes of the three files (each file's `fitBox` with `SI_PANEL`, keep pieces cut to the base container 400x100), `fitSi` shifts the three files and records the offset for `layoutPass`, which reads it through `panelWork` (never recomputed). No background slot for this panel (`bg: null`; widen `FitRule.bg` to optional if needed, and keep `stylePass` reading only rules that have one). Default on for new designs? **No:** unlike the own panel, fit changes the container anchor players already placed; keep it opt-in (absent means off) and offer the checkbox. GREEN. Commit: "Fit your infected health to what it shows, moving nothing on screen".

### Task 4: The SI preview, by class

**Files:** Modify `web/src/hud/render.ts` (`PANEL_FILE` becomes `panelFile(panelId, state)`), `web/src/hud/mock.ts` (`paintSiHealth`), `web/src/hud/build.ts` (`panelChild` takes an optional file), `render.test.ts`, `mock.test.ts`; `art.ts`, `scripts/export-hud-art.py` (`vgui/hud/crouch_infected`).

- [ ] **Step 1: Tests (RED).**
  - `panelFile('siHealth', { siClass: 'boomer' })` is `boomerhealth.res`; smoker `smokerhealth.res`; hunter and tank `hunterhealth.res`;
  - drawing the infected side at `siClass: 'boomer'` draws the bar at the Boomer file's rect (322,69 64x13 on stock, relative to the element), the number text `50`; hunter `250`, smoker `250`, tank `6000`;
  - the bar at full health is drawn with the green health colour (`healthRgb(250, 250, false)`), not red: comment cites `b9/shots/b9/b9-b.png` and `probe-phase2/b13/b13-stock/infected/hunter.png`;
  - `crouched: true` draws `vgui/hud/crouch_infected` at the `DuckingIcon` rect; not crouched draws nothing there;
  - the frame's tint multiplies its art (the existing `tinted` path), and a hidden frame draws nothing;
  - with Q24 closed, a stored `monochrome_color` is not drawn (validateDesign drops it);
  - the drawing is clipped to the container (a child moved past `wide` is cut), cite `b10/shots/crops/br-bce.png`.
- [ ] **Step 2: Implement.** Export `crouch_infected` (the script's rules; read the PNG back). `paintSiHealth` draws `panelFile('siHealth', state)` through `drawPanel`, with the class's sample health. Selection and hit tests read the same file: `panelChild(design, 'siHealth', name, file?)`. GREEN, full suite, typecheck. Commit: "Preview your infected health as the class you pick, green at full health".

### Task 5: The page: class picker, notes, Layers

**Files:** Modify `web/src/routes/hud/Toolbar.tsx`, `ContextPanel.tsx`, `LayersPanel.tsx`, `web/src/routes/Hud.tsx`, `web/src/hud/edit.ts` (drags on a linked piece), `Hud.test.tsx`, `edit.test.ts`.

- [ ] **Step 1: Tests (RED).**
  - the infected side's Toolbar shows a class picker (Hunter, Smoker, Boomer, Tank), Alive / Ghost / Dead tabs and a Crouched toggle; the survivor side shows none of them;
  - Layers lists "Your infected health": Frame, Health bar, Health number, Crouch icon;
  - dragging the Boomer's bar 10 units right with `siClass: 'boomer'` stores Hunter-frame `x + 10`; widening it on the Boomer by 10 stores `round(10 * 132 / 64)` more on the Hunter (the inverse `unlinkedValue`);
  - the siHealth note replaces today's "Shown as the Hunter" line: "Shown as the <class>. Edits apply to every special infected; the Boomer's smaller bar moves the same and sizes in proportion. The game hides this panel while you pin a survivor or throw a rock." (cite `b9-d`, `b9-h`, `b9-m`);
  - the Fit checkbox shows on `siHealth`.
- [ ] **Step 2: Implement.** GREEN, full suite. Commit: "Pick the special infected to preview, and edit its pieces in its own frame".

# Slice 2.3: the ability timer and the crosshair marker

### Task 6: The ring's pieces, scale and state colours

**Files:** Modify `web/src/hud/elements.ts`, `web/src/hud/children.ts`, `web/src/hud/build.ts` (element keys, already typed in 2.0), `elements.test.ts`, `children.test.ts`, `build.test.ts`.

- [ ] **Step 1: Tests (RED).**
  - `abilityRing` has `resize: 'scale'`, `children: ['resource/ui/hud/abilitytimerhud.res']`, and `keys` `ability_ready_color`, `ability_charging_color`, `ability_surpressed_color` (the game's spelling), all `colour`, no gate;
  - `ABILITY_PANEL` (`abilityRing`, file `abilitytimerhud.res`, single, frame `'hudlayout'`): `BackgroundImage` (image, decor, square, `colour: false`, note "The game picks this picture; you can move, size or hide it."), `AbilityImage` (image, content, square, note "The game picks the icon by class."), `Progress` (other, content, square, note "The game fills this as your ability recharges."); names in stock and Modern;
  - scale 1.5 writes every piece's rect times 1.5 and the element block 120x105;
  - element colour keys land in `hudlayout.res` `CHudAbilityTimer`, replacing the stock lines, not doubling them;
  - hiding `BackgroundImage` hard-hides it (Modern's own 0x0 stays as it is when untouched).
- [ ] **Step 2: Implement.** A state colour's `KeyDef.evidence` cites the dll run and `b10/shots/crops/ring-all.png`. GREEN. Commit: "Edit the ability timer's pieces, its scale and its three state colours".

### Task 7: The ring's preview, tinted and filled as the game does

Builds on fixes Task X7 (the ring drawn from its file).

**Files:** Modify `web/src/hud/mock.ts` (`paintAbilityRing`), `web/src/hud/render.ts` (a small `arcClip` helper if X7 did not add one), `mock.test.ts`.

- [ ] **Step 1: Tests (RED).**
  - `ability: 'ready'` tints the icon, the backdrop and the meter by `ability_ready_color`; `'charging'` by `ability_charging_color` (a spy on the tint path sees three tints of the same colour); cite `b10/shots/crops/ring-all.png` (meter R 203 ready vs R 101 charging with the stock 127 grey) and `b9/shots/crops/br-bcd.png` (magenta and cyan);
  - charging draws the meter as a counter-clockwise arc from 12 o'clock over the fraction 0.4 (the canvas clip path starts at angle `-PI/2` and runs anticlockwise to `-PI/2 - 0.4 * 2 * PI`); ready draws it whole; cite `b10/shots/crops/progress-f-zoom.png`;
  - the icon is `pz_charge_lunge|smoker|boomer|tank` by `siClass`;
  - ghost or dead (`infected !== 'alive'`): the ring is not drawn (the game shows it only on a spawned infected, `b9-a`, `b9-e`).
- [ ] **Step 2: Implement.** In the ContextPanel note for the ring: "Hunter: charging while standing, ready while crouched." GREEN, full suite. Commit: "Tint the whole ability timer by its state and fill it the way the game does".

### Task 8: The crosshair marker element

**Files:** Modify `web/src/hud/elements.ts`, `web/src/hud/design.ts`, `web/src/hud/build.ts`, `web/src/routes/hud/CrosshairControls.tsx`, `ContextPanel.tsx`, tests for each.

- [ ] **Step 1: Tests (RED).**
  - `abilityMarker`: side `infected`, key `HudCrosshair`, `move: false`, `resize: 'none'`, `mockPos: { x: 'c', y: 'c' }`, keys `ability_size` (int 4..64, label "Size (pixels)"), `ability_ready_color`, `ability_charging_color`, `ability_surpressed_color`, `ability_attack_color`, `ability_attack_color_colorblind`, all ungated;
  - a design with marker keys and `hideGameCrosshair` writes one `HudCrosshair` block carrying both the keys and `never_draw 1`;
  - hiding `abilityMarker` writes `ability_size 0` and alpha 0 on its colours instead of a hard hide on `HudCrosshair` (a hard hide there would remove the game's crosshair too); its note says so. Checked in game in Task 14;
  - the crosshair switch "Hide the game's crosshair" shows, when on, "This also removes the ability marker on the infected side." (cite `b10/shots/crops/centre-bcef.png`);
  - the marker's context panel says: "Shown only with the game's crosshair on (crosshair 1). Sized in screen pixels: smaller on a bigger screen. The attack colours show when a survivor is in reach."
- [ ] **Step 2: Implement.** GREEN, full suite, goldens unchanged. Commit: "Add the ability marker around the infected crosshair: size and colours".

### Task 9: The marker preview

**Files:** Modify `web/src/hud/mock.ts` (`paintAbilityMarker`), `art.ts`, `scripts/export-hud-art.py` (`vgui/hud/pz_charge_crosshair`, `vgui/hud/pz_crosshair_open`), `mock.test.ts`, `art.test.ts`.

- [ ] **Step 1: Tests (RED).** On the infected side, alive, ready, not a Hunter standing: `pz_charge_crosshair` is drawn centred on the screen centre in `ability_ready_color`, in a box of `2 * ability_size` screen pixels at 1080p (`2 * 40 * 480 / 1080` units, about 35.6; the game's ring measured 72x72 px, `b9/shots-v2/crops/centre-af.png`); `pz_crosshair_open` is drawn at the centre unless `hideGameCrosshair`; charging with a Hunter (standing): no marker; ghost or dead: none; `hideGameCrosshair`: neither.
- [ ] **Step 2: Implement.** Export both textures (read them back, keep the 1 MB cap). GREEN. Commit: "Preview the ability marker at its pixel size".

# Slice 2.4: the infected teammate cards

### Task 10: The card registry and its state rules

**Files:** Modify `web/src/hud/children.ts`, `web/src/hud/render.ts` (`hiddenInState`), `children.test.ts`, `render.test.ts`.

- [ ] **Step 1: Tests (RED).**
  - `ZCARD_PANEL` (`infectedRow`, file `zombieteamdisplayplayer.res`, `repeat: 'cards'`, frame `{ file: same, block: 'ZombieTeamDisplayPlayer' }`): `BackgroundImage` (image, decor, wh, `colour: true`, `fitPlace: 'keep'`, `art: 'splatter'`), `PlayerImage` (image, content, square, `hideInInfected: ['dead']`, note "The game picks the icon by class; a ghost's is faint."), `HealthPanel` (bar, content, wh, keys `monochrome_color` gate `Q24` and `inset`, `hideInInfected: ['dead']`), `NameLabel` (label, content, wh, font, colour), `SpawnTimeLabel` (label, state, `stateArt: 'dead'`, font, colour, note "Your teammates' respawn countdown. Your own card never shows it."), `AbilityProgress` (other, state, `stateArt: 'ability'`, square, note "Shown on a spawned Smoker, Boomer or Tank; never on a Hunter or a ghost."), `Dead` (image, state, `stateArt: 'dead'`, wh, note "The stock file gives this no height, so the game never shows it; give it a height to see it."), `SkullIconPlacement` (other, state, `stateArt: 'dead'`, square), `Voice` (other, state, `stateArt: 'talking'`, square); names in stock and Modern;
  - `hiddenInState('infectedRow', …)`: alive shows PlayerImage, HealthPanel, NameLabel, AbilityProgress unless `siClass` is hunter; ghost hides AbilityProgress, SpawnTimeLabel, Dead, Skull; dead hides PlayerImage, HealthPanel, AbilityProgress and shows SpawnTimeLabel, Dead, Skull. Cite `b9/shots/crops/bl-abeg.png` and the dll offsets in RESULTS.
- [ ] **Step 2: Implement** `StateArt 'ability'` and `hideInInfected`. For a card, the class of the sample card decides (Task 13 passes it in `DrawOpts`); for the own-card case `siClass`. GREEN. Commit: "Register the infected card's pieces and when the game shows each".

### Task 11: Fit the card, and gap spacing

**Files:** Modify `web/src/hud/build.ts` (`FIT_RULES.infectedRow`, `teamLayout` and `teamPass` for `infectedRow`), `web/src/hud/design.ts` (`teamFields` for `infectedRow`), `elements.ts` (`team.spacingKey` stays), tests.

- [ ] **Step 1: Tests (RED).**
  - stock, `infectedRow.fit = true`: box (0,10) 133x64 (backdrop 0,10 128x64 kept; name to x 133); children shift by (0,-10); self block `ZombieTeamDisplayPlayer` `wide 133`, `tall 64`; `CHudZombieTeamDisplay` `ypos` moves 10 units down times scale; fit alone leaves every piece's screen rect unchanged;
  - backdrop hidden: the box is the content union of PlayerImage (9,23 24x24), HealthPanel (38,41 86x12) and NameLabel (13,55 120x12), (9,23) 124x44, the spec's box (state art such as AbilityProgress never counts);
  - `Dead` is not squared: it spreads over the fitted card (x 0, y 0, the card size) only when its stored height is above 0; at the stock 0 it stays 0 (the game would not show it anyway, Q19);
  - a saved `spacing: 200` at scale 2 becomes `gap = 200 / 2 - cardWidth` clamped at 0 (the `teamFields` rule), and the build writes `HorizPanelSpacing = round((card.w + gap) * k)`; untouched designs keep the stock `HorizPanelSpacing 140` and bytes (goldens green);
  - `dir` other than `row` is dropped by `validateDesign` for `infectedRow`.
- [ ] **Step 2: Implement.** GREEN, full suite. Commit: "Fit the infected card and space infected cards by the gap between them".

### Task 12: The row preview as the game lays it out

**Files:** Modify `web/src/hud/mock.ts` (`paintInfectedRow`), `web/src/hud/render.ts` (the card icon, ghost tint, skull), `art.ts`, `scripts/export-hud-art.py` (`vgui/hud/zombieteamimage_hunter|smoker|boomer|tank` at 64x64, the `icon_skull` cell of `vgui/hud/iconsheet` through the EQUIP cutter), tests.

- [ ] **Step 1: Tests (RED).**
  - three cards drawn at `x = i * HorizPanelSpacing` (the written value, read through `teamLayout`), `y = 0` inside the container, clipped to it; never four; the sample team is Smoker, Boomer, Hunter;
  - alive: icon `zombieteamimage_<class>` untinted white, bar in the health colour, name; the Smoker and Boomer cards draw `AbilityProgress` (`pz_charge_meter`, full), the Hunter card does not;
  - ghost: the icon at the ghost art (the same texture, faint: alpha 0.16, spec 0.1.3) tinted `206 219 225`, bar drawn, no spawn time, no ring;
  - dead: the skull cell at `SkullIconPlacement`, `SpawnTimeLabel` "12" in its font and colour, no bar, no icon, `Dead` art only if its height is above 0;
  - with "Show yourself" on, a fourth candidate (you, as `siClass`) takes the first slot and the Hunter sample drops, so there are still 3;
  - the backdrop's tint multiplies `infected_healthbar_bg_1` (stock `64 64 64`).
- [ ] **Step 2: Implement.** GREEN, full suite, typecheck. Commit: "Draw the infected cards where the game puts them, alive, ghost or dead".

### Task 13: The page: card selection, Layers and the honest note

**Files:** Modify `web/src/hud/selection.ts`, `web/src/routes/hud/LayersPanel.tsx`, `ContextPanel.tsx`, `Toolbar.tsx`, `web/src/routes/Hud.tsx`, tests.

- [ ] **Step 1: Tests (RED).**
  - cards are a selection level as survivor cards are; dragging a card moves the row (there is no Free);
  - Layers lists "Infected teammates": Card 1..3, then the pieces;
  - the infected row's context panel shows Gap, Fit, and the lines: "The game lays infected cards in a row; a column is impossible." and "The game shows only human teammates here, at most 3 cards; bots never get one.";
  - a "Show yourself" toggle on the infected Toolbar, labelled as a preview of `hud_zombieteam_showself 1` (a console setting, not part of the HUD file).
- [ ] **Step 2: Implement.** GREEN, full suite. Commit: "Select, list and explain the infected cards".

# Verification and the remaining probe

### Task 14: Probe B14 (Q24) and in-game checks of the new writes

**Files:** Create `/home/volence/l4d/hud/probe-phase2-infected/b14/` (follow `build.mts` and `validate.py` in that folder: add a `b14` batch there, do not fork a new script).

- [ ] **Step 1: Build B14** from a design made with this branch's editor (so the new writes are what is tested): `siHealth` fitted and scaled 1.25 with the bar 20 units shorter, `infectedRow` fitted with gap 10, `abilityRing` scale 1.5 with ready `255 0 255 255`, marker size 30, ready `0 255 0 255`, `abilityMarker` not hidden; plus hand edits `hunterhealth.res` `Health` `monochrome_color 255 0 255 255`, `smokerhealth.res` the same, `boomerhealth.res` the same, and `zombieteamdisplayplayer.res` `HealthPanel` `monochrome_color 0 255 255 255` (Q24). Validate.
- [ ] **Step 2: Run** with a steps file on `b9/b9v2.steps`'s route (with `cmd crosshair 1`): ghost, Hunter standing and crouched, Smoker, Boomer, Tank, death. `flock` the lock, check the restore line, the game closed.
- [ ] **Step 3: Record** in `RESULTS.md` (a B14 section): Q24 (does the number, the name or the icon change colour, or only the fills), whether each fitted and scaled panel sits where the preview draws it (open this branch's preview headless at 1920x1080 via `canvas.toDataURL()`, never a CDP capture, and crop both), the Boomer's bar length (the delta rule), card spacing (only the own card shows: note it). Any mismatch becomes a fix task appended to this plan with the shot path.

### Task F1: Q24 passed (bar colour on the infected panels)

Only if Task 14 says the fill takes the colour. Set `PROBES.Q24.passed = true`; update the tests that pin the key as hidden; the preview draws the bar (and whatever else B14 showed recolouring) in that colour. If the number or name also changed, the label becomes "Panel colour" and the note says what it recolours, as the own panel's does. If it failed, leave the gate closed and record it in the spec's section 1.2 table.

### Task 15: Slice verification

- [ ] Full suite, typecheck, build. Report counts against Task 0's baseline.
- [ ] `sample.vpkcheck.test.ts` / `scripts/check-hud-vpk.sh`: add a sample design touching all three panels and the marker, and check it with the independent VPK reader.
- [ ] Headless preview shots (stock, 1920x1080) for Hunter ready, Hunter charging, Boomer, Tank, ghost and dead, next to `b9/shots` and `b14` game shots, in `/home/volence/l4d/hud/probe-phase2-infected/parity/`, each row "matches" or what differs with pixel positions.

### Fix tasks from probe B14 (appended 2026-09-24)

B14 (`/home/volence/l4d/hud/probe-phase2-infected/RESULTS.md`, section B14; side-by-side sheets in `/home/volence/l4d/hud/probe-phase2-infected/parity/b14-*.png`) found four mismatches. Two are fixed on this branch: your infected health is drawn only while spawned (the game shows none as a ghost or dead, `b14/shots/b14/b14-a.png`, `b14-g.png`), and a label with no colour of its own draws in the scheme's `Label.TextColor` (Gray 192: the SI number measured 193, `b14-c.png`). Two remain:

#### Task X-B14a: the dead card's skull colour

The game draws the skull at `SkullIconPlacement` flat grey, peaking at 98 98 98 (`parity/b14-dead-skull-game.png`); the preview draws `icon_skull` white (`parity/b14-dead-skull-prev.png`). Find the colour or alpha client.dll gives it (the dead branch near `0x10248606`, which sets up the skull), or, failing the dll, a second launch with the skull over a flat backdrop to tell a tint from an alpha; then draw it so, with a test citing the shot. Do not guess a factor from one shot over a textured floor.

#### Task X-B14b: the infected card backdrop in linear light

The stock backdrop's disc is black at alpha 224. In game it lets the floor through as 53 46 33 (`b14-g`, disc centre at 20,975), which the preview's gamma-space blend cannot give (it goes near black); the linear-light blend slice 2.F found for the weapon boxes and used for the dead survivor art (`render.ts` `paintLinearOver`, `linearOverArt`) predicts it. Draw the card backdrop through the same path, and check whether the SI frame and the ring splat need it too, against `b14-b` and `b14-c` (their black art over the Hunter's arm) before changing them.

## Task list

| # | Task | Slice | Depends on |
|---|---|---|---|
| 0 | Preconditions, infected golden cases | all | plumbing, fixes plans |
| 1 | Q24 gate, SI registry | 2.2 | 0 |
| 2 | Linked files (same / delta) | 2.2 | 1 |
| 3 | Fit your infected health | 2.2 | 2 |
| 4 | SI preview by class, green bar, crouch icon | 2.2 | 3 |
| 5 | Page: class picker, notes, linked drags | 2.2 | 4 |
| 6 | Ring pieces, scale, state colours | 2.3 | 0 |
| 7 | Ring preview: tint all three, CCW arc | 2.3 | 6, fixes X7 |
| 8 | Marker element, never_draw warning | 2.3 | 0 |
| 9 | Marker preview at pixel size | 2.3 | 8 |
| 10 | Card registry and state rules | 2.4 | 0 |
| 11 | Card fit, gap spacing | 2.4 | 10 |
| 12 | Row preview, 3 cards, alive/ghost/dead | 2.4 | 11 |
| 13 | Page: card level, Layers, honest note | 2.4 | 12 |
| 14 | Probe B14 (Q24 and the new writes in game) | all | 5, 9, 13 |
| F1 | Q24 flip | 2.2, 2.4 | 14 |
| 15 | Verification | all | 14 |
| X-B14a | Dead card skull colour | 2.4 | 14 |
| X-B14b | Card backdrop in linear light | 2.4 | 14 |

Suggested implementer runs: (0, 1), (2), (3), (4, 5), (6, 7), (8, 9), (10), (11), (12, 13), (14, F1), (15).
