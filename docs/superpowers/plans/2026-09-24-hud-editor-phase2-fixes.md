# HUD Editor Phase 2, slice 2.F: correctness fixes from probe batches B1, B2, B3 and B13, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Hand an implementer one task at a time, in the order of the "Run order" table below.

> **Runs AFTER plumbing Task 9.** `docs/superpowers/plans/2026-09-24-hud-editor-phase2-plumbing-own-health.md` (the "plumbing plan") is being implemented in this same worktree. Do not start Task X0 until its Task 9 (slice 2.0 verification) is reported done. From then on this plan's tasks interleave with plumbing Tasks 10 to 17 in the exact order of the "Run order" table: several tasks here depend on a plumbing task (the own panel registry, the exported outline, the Hurt preview), and several plumbing tasks' tests are rewritten here on purpose. **This plan's gate tasks G1 to G5 replace the plumbing plan's F1 to F5**: do not run F1 to F5. Every line number is stale by the time you read it: find code by the names given.

**Goal:** Fix what the first probe batches proved wrong in what is already built. (1) `visible 0` hides nothing in game, so every element hide becomes a hard hide, with a probe VPK to prove it. (2) The preview disagrees with the game on kill notices, chat, the health bars, the use/heal bar and the ability timer, and on the weapon box alpha. (3) Probe answers Q1, Q2, Q3, Q5 and Q8 flip (or retire) the plumbing plan's gates, and Q1's answer changes what the control means. (4) S4, Q4 and S-hurt change preview details.

**Architecture:** One new download-only pass in `build.ts` (`elementHidePass`) hard-hides every hidden element after `teamPass` and `scalePass`, so nothing can write a size back over it. The preview fixes stay in `mock.ts` (element painters), `render.ts` (panel children: the health bar and the health colour) and `weapons.ts`, each drawing from the generated trees (`buildTrees`) as the rest of the preview does. A new data-free leaf `progress.ts` holds the use/heal bar geometry, including the Q22 rule that border plus gap must leave room for the fill. The gate flips edit `probes.ts`, `children.ts` and the tests that pin each gate.

**Tech Stack:** TypeScript, Preact, Vite, vitest (project `web`, happy-dom; `// @vitest-environment node` where a test reads files), canvas 2D. Python (`/home/volence/l4d/hud/.venv/bin/python`) for the art export. No new npm dependencies.

**Evidence:** `/home/volence/l4d/hud/probe-phase2/RESULTS.md` and the shots and crops it names. Read it whole before any task. Spec: `docs/superpowers/specs/2026-09-24-hud-editor-phase2-design.md` sections 1.4, 3.0F, 3.6 and 4. Memory: `/home/volence/.claude/projects/-home-volence-l4d/memory/pug-hud-editor.md`.

---

## What the probes proved, and what this plan does with it

| Probe | Answer (RESULTS.md) | Consequence | Task |
|---|---|---|---|
| S1 (B2, B3) | `visible 0` in `hudlayout.res` hides **no** element on either side | every element hide becomes the hard hide; a probe VPK proves it | X1, X2 |
| Q1 | YES, and **whole panel**: `monochrome_color` recolours the own bar fill, its outline, the HealthNumber, the HealthIcon cross and the scratches, in every health state; it **tints** the shaded bar texture (FE00FE top to B600B6 bottom), it does not paint flat. On teammate cards: bar and number, down card included | the control is "Panel colour", not "Bar colour"; the preview tints every one of those pieces; teammate cards get the key too | X10, G1 |
| Q2 | image **never painted** (no teal in two launches); the panel **clips** its children | the plumbing gate passes as its question is worded; fit is safe; `ownBg` (plumbing Task 14) is the only way to paint behind the own panel | G2 |
| Q3 | YES: the outline stays at the rect, the fill moves inside it (stock default about 2 units: 4 px; `inset 3`: 6 px) | the outline and the default inset are drawn **always** (they are stock), not only under the gate; the key sets the inset | X9, G3 |
| Q4 | top scratch: file `drawColor` ignored, code tints it by health (or by `monochrome_color`); bottom: `visible 0` held | the preview keeps ignoring the file tint and follows the panel colour | X10 |
| Q5 | **NO**: `fgcolor_override` on HealthIcon is ignored; the cross always takes the panel's health colour (or `monochrome_color`) | the cross colour is never offered; gate Q5 is retired | G4 |
| Q8 | YES: `drawColor` kept, icon shown only while crouched | flip | G5 |
| S-hurt | (B1 c, b1v3 hurt) the empty part of a hurt bar is **drawn**, a dark shaded grey; the outline takes the health colour | the plumbing plan's decision 12 ("nothing drawn in the rest") is wrong | X9 |
| S4 | the active weapon box's flat colour draws at its own alpha (about 0.55 for 128), there is no 180/255 multiplier | the preview stops multiplying a generated active box by `BOX_ALPHA`; the inactive box and the stock art are measured in launch P | X8, X2 |
| weapon box colour | game about 255,30,10 for a 255,0,0,128 box | **investigated for this plan:** the packed `b1.vpk` `weaponboxactive.vtf` is BGRA8888, 128x128, one mip, every texel exactly 255,0,0,128, and the .vmt is `vmtFor`'s (`$vertexcolor 1`, `$vertexalpha 1`). The texture is right. 30 and 10 come from the background estimate (b1-e's pixel is not the same background as b1-a's). Launch P draws the boxes at alpha 255, where the pixel is the colour with no background maths | X2 (launch P), X8 |
| Q22 | border and gap are drawn as written; `border 3` + `gap 3` on the stock 8-unit bar left **no** fill and no empty part | the geometry and the clamp `2 * (border + gap) < tall` live in `progress.ts` now; slice 2.6's controls must use it | X6 |
| B13 kill notices | game: at the element's left (x 30 px), `label_textalign west` from `hudlayout.res` beats the rows' `east`, the row in a dark rounded box | preview draws them that way | X4 |
| B13 chat | game: closed chat shows only text lines, no box | preview draws only the lines | X5 |
| B13 health bars | game: outline frame, fill inset, shaded fill; preview: flat rect (the `healthbar_green` texture is one flat colour, 28,151,24; `healthbar_white` runs 255 to 183 top to bottom, exactly the game's shading) | the fill is `healthbar_white` tinted by the health colour, the empty part `healthbar_grey`, the outline `s_healthbar_outline` tinted | X9 |
| B13 use/heal bar | game: `icon_healing`, "HEALING YOURSELF" in `MenuTitle_DropShadow`, a thin white-bordered bar; preview: a flat yellow and grey slab | drawn from `progressbar.res` | X6 |
| B13 owner heal bar | RESULTS called it unexplained. **Found for this plan:** it is drawn, at the bottom left, in `b13-owner/heal/mid-heal.png` (icon x 5 to 57, "HEALING YOURSELF" at y about 1030 to 1055, bar x 63 to 510, y about 1060 to 1075). The owner's `hudlayout.res` puts `HudProgressBar` at `xpos 0`, `ypos r24`, `wide 300`, `tall 45`, and ships no `progressbar.res`, so the stock one (228 units of content) draws inside a 300-wide element. The preview's slab is 300 wide because an import has no `mockSize` and the element rect is the file's | position already matches; drawing the children (X6) makes the width match too | X6 |
| B13 ability timer | game: Hunter icon in the red `pz_charge_bg` ring, centred about (1847, 905); preview: a white arc, no icon, about 17 px higher (it centres on the 80x70 element, the game on the 80x80 `BackgroundImage`) | drawn from `AbilityTimerHud.res` | X7 |
| S6 (not answered) | the teammate splatter's 0.35 factor was **not** measured by S4 (S4 is the weapon box) | measure it from the B13 stock shots before touching `SPLATTER_ALPHA` | X11 |
| splatter run A (dead card) | the custom splatter shows on incap and dead cards in game; on the dead card a cyan stripe is 0,168,168 in game, 0,99 to 119 in the preview | find the preview layer that over-darkens, fix it, pin the splatter in Down and Dead | X13 |

Unanswered and not in this plan: S8 (Status text), Q9 (own Down), HudZombiePanel, HudInfectedVOIP, HudVoiceStatus, HudFinaleMeter, the Tank panel (needs B11).

---

## Global Constraints

- FIRST RULE: never run `git stash` in any form. Never checkout, switch, reset or rebase, never move HEAD. Commit only your own files, by explicit path (`git add <path>`, never `-A` or `.`). If `.git/index.lock` blocks you, wait a few seconds and retry: another agent may be committing in the same worktree.
- Work only in `/home/volence/l4d/pug/.claude/worktrees/hud-editor` (branch `worktree-hud-editor`). No push, no deploy, no ssh, no rcon.
- One implementer at a time in this worktree. The "Files" matrix below says which tasks could share a moment; the default is strictly the run order.
- Commands run from the worktree root. Tests: `npx vitest run --project web <paths>`. Types: `npm run typecheck`. Build: `npm run build`.
- Never use em dashes or en dashes anywhere: code, comments, UI copy, test names, commit messages.
- Comments say why, in the style of `web/src/hud/build.ts`. Every preview fix names the probe shot that proves it (path under `/home/volence/l4d/hud/probe-phase2/`) in its comment and in its test's comment.
- Preview equals file: the canvas draws only from `buildTrees`, `panelChild`, `childRects`, `elementRect`, `panelBoxes`. The one exception this plan adds is deliberate and documented: `elementHidePass` is download-only (Task X1, decision 2).
- **Byte promise:** the plumbing plan's golden (`download.golden.test.ts`) keeps every hash through every task here, except where a task names the change. Only X1 may touch the "hidden chat and notices" case, and it must not: that case is the proof that moving the chat and notice hard hides into the new pass changed no byte.
- Valve's art stays preview-only (`art.test.ts`); `children.ts`, `probes.ts` and `progress.ts` import nothing but types.
- TDD: write the test, run it and capture the RED output in the task report, implement, then GREEN. Then the whole suite; report the count against the previous task's.
- Small plain-English commits, at least one per task.
- Never launch the game yourself. The in-game launches (X2, X12) run through `/home/volence/l4d/hud/ingame-harness/run.sh` only when the controller says the game is free: the owner's game and `/home/volence/l4d1-ds` are shared. Never kill a process you did not start.

## Decisions this plan locks in (for owner review)

1. **The element hard hide is the piece hard hide, plus the element's frame blocks.** `hardHide` on the `hudlayout.res` block (visible 0, `wide 0`, `tall 0` on every PC entry, `drawColor` alpha 0 when the block is an `ImagePanel`), and the same on each "frame" block that holds the element's content inside its own file: `localplayerdisplay.res` `LocalPlayer` for `ownHealth`, `teamdisplayhud.res` `TeamPlayer1` to `TeamPlayer4` for `teamColumn`, `basechat.res` `HudChat` and `HudChatHistory` for `chat` (today's rule, unchanged). Q2 proved a panel clips its children, so a 0x0 container alone should be enough; the frame blocks are the second line for an element whose code sizes its container itself. Every other element (weapons, progress bar, kill notices, the infected panels) gets only its `hudlayout.res` block. Launches S and I (Task X2) decide whether that is enough; if an element still shows, a follow-up adds its content blocks to `HIDE_FRAMES`, with the shot as evidence.
2. **`elementHidePass` is download-only**, like `fontPass`. `drawHud` still paints a hidden element dimmed while it is selected (so the player sees what they edit), from `buildTrees`, and a 0x0 `LocalPlayer` there would paint nothing. The pass runs in `buildHud` after `scalePass` (so `teamPass`'s container size and `scalePass`'s multiply can never undo it) and is not called by `buildTrees`. A test pins that `buildTrees` and the download differ only in the blocks the pass names.
3. **The label and bar types need nothing more than size 0.** No stock or Modern child uses `auto_wide_tocontents`, `auto_tall_tocontents` or `autoResize` (checked: none in any registered file), so a 0x0 `Label` or `HealthPanel` has nowhere to draw. If an imported HUD's block has one of those keys at a non-zero value, `hardHide` sets it to 0 (only when present, so no existing byte moves).
4. **The health bar is drawn the game's way in every state:** `s_healthbar_outline` at the rect, tinted by the health colour; the fill `healthbar_white` tinted by the health colour, inset by the inset (default 2 units, B1 Q3 and B13: 4 px at 1080p); the empty part `healthbar_grey` inset the same. At 100 health the empty part is zero wide. Down draws the fill in the incap colour. This replaces both the flat green texture and plumbing decision 12. The exact health colours stay `healthRgb`'s; Task X9 checks them against the game's pixels.
5. **`monochrome_color` is one colour for the whole health panel.** In the preview, when a panel's `Health` block carries it (and gate Q1 is open), it replaces the health colour everywhere the health colour is used: the fill, the outline, `HealthNumber`, `HealthIcon` and the scratches on the own panel; the bar and `HealthNumber` on a teammate card. Every state, down included (b1v3 `cards-hurt.png`: the down card's 279 is cyan). The key stays on the `Health` child (that is where the file carries it), labelled "Panel colour", with the note "Recolours the whole panel: bar, number, cross and scratches, in every health state." On the teammate card the note says "Recolours the bar and the number on every card."
6. **The teammate `Health` child gets `monochrome_color` (Q1) and `inset` (Q3).** Q1 was proven on cards. Q3 was proven on the own bar only, but both blocks are `ControlName HealthPanel` (one class, one `m_inset` read, the dll run in `dll-hud-strings.txt`), and B13 shows the same default frame and inset on cards. The KeyDef's `evidence` says so.
7. **Kill notices preview one sample row**, the one B2 showed: "Hunter incapacitated Francis" in `recordlabel0`'s colour, in its dark box. Two rows were a guess about which row the game fills next and how the boxes stack; B12 (two notices) settles that later.
8. **The chat preview shows the closed chat**: two history lines, no box. The open chat (typing) is a different state no probe has shot yet.
9. **Q5 is retired, not flipped.** The `HealthIcon` colour control is never offered, its `colourGate` goes, `PROBES` loses `Q5`. Recording a failed probe by deleting its gate keeps `probes.ts` a list of open questions.
10. **Q22's clamp lives in `progress.ts` now, and is used by the preview now;** the controls that write `border_thickness` and `gap` arrive in slice 2.6, and the spec's 3.6 gets a line saying they must call it.

## Files

```
web/src/hud/build.ts                  elementHidePass, HIDE_FRAMES; chat and notice hard hides move into it; hardHide auto-size keys
web/src/hud/build.test.ts
web/src/hud/progress.ts               NEW  progress bar geometry and the Q22 clamp (leaf)
web/src/hud/progress.test.ts          NEW
web/src/hud/mock.ts                   paintKillNotices, paintChat, paintProgressBar, paintAbilityRing
web/src/hud/mock.test.ts
web/src/hud/render.ts                 drawBar (outline, inset, white fill, grey empty), panelColour (monochrome), sampleHealthRgb, SPLATTER_ALPHA (X11), the dead card (X13)
web/src/hud/render.test.ts
web/src/hud/weapons.ts                box alpha per S4
web/src/hud/weapons.test.ts
web/src/hud/children.ts               teammate Health keys (X10); HealthIcon colour off (G4); notes (G1)
web/src/hud/children.test.ts
web/src/hud/probes.ts, probes.test.ts gate flips (G1 to G5)
web/src/hud/design.test.ts, web/src/routes/Hud.test.tsx   gate pins (G tasks)
web/src/hud/art.ts, scripts/export-hud-art.py, web/src/hud/art/*   parity art (X3)
docs/superpowers/specs/2026-09-24-hud-editor-phase2-design.md      answers into section 4, a 3.6 line (X6, G tasks)
/home/volence/l4d/hud/probe-2f/       NEW  probe VPK build, steps, README, RESULTS (X2, X12); outside the repo
```

## Run order, and which files each task touches

| Step | Task | Files | Needs |
|---|---|---|---|
| 1 | X0 preconditions | none | plumbing Task 9 reported done |
| 2 | X1 element hard hide | `build.ts`, `build.test.ts` | X0 |
| 3 | X2 hide probe VPKs, launches S, I, P | `/home/volence/l4d/hud/probe-2f/` only | X1; the game free for the launches (build the VPKs now, launch whenever the controller says) |
| 4 | X8 weapon box alpha | `weapons.ts`, `weapons.test.ts` | X0 (launch P's answer refines it later) |
| 5 | plumbing Task 10 | `children.ts`, `children.test.ts`, `render.test.ts`, `design.test.ts` | |
| 6 | plumbing Task 11 | export script, `art.ts`, `art/` | |
| 7 | X3 parity art | export script, `art.ts`, `art/` | plumbing 11 (same files: never together) |
| 8 | X4 kill notices | `mock.ts`, `mock.test.ts` | X3 |
| 9 | X5 chat | `mock.ts`, `mock.test.ts` | X0 |
| 10 | X6 use/heal bar and Q22 | `progress.ts` (new), `mock.ts`, `mock.test.ts`, spec 3.6 | X3 |
| 11 | X7 ability timer | `mock.ts`, `mock.test.ts` | X3 |
| 12 | plumbing Tasks 12, 13, 14 | `design.ts`, `edit.ts`, `build.ts`, `mock.ts`, `selection.ts`, `slots.ts` and tests | |
| 13 | plumbing Task 15 | `render.ts`, `render.test.ts`, `mock.ts`, `mock.test.ts` | |
| 14 | X9 health bar look | `render.ts`, `render.test.ts` | plumbing 11 and 15; rewrites three of Task 15's tests on purpose |
| 15 | X10 whole-panel colour, teammate keys | `render.ts`, `render.test.ts`, `children.ts`, `children.test.ts` | X9, plumbing 10 |
| 16 | X11 teammate splatter factor | `render.ts`, `render.test.ts` | X9 |
| 16b | X13 Down and Dead cards over a custom splatter | `render.ts`, `render.test.ts` | X11 |
| 17 | plumbing Task 16 | `Hud.tsx`, `Toolbar.tsx`, `ContextPanel.tsx`, `Hud.test.tsx` | |
| 18 | G4, G5, G1, G3 | `probes.ts`, `children.ts`, tests, spec section 4 | plumbing 16, X10 (G1), X9 (G3) |
| 19 | plumbing Task 17 | sample VPK check | |
| 20 | G2 | `probes.ts`, `design.ts` (`DEFAULT_DESIGN`), golden | plumbing 17 |
| 21 | X12 verification | none, or fix commits | everything above; launch R when the game is free |

Tasks X1, X8 and X5 touch no file any plumbing task 10 to 17 touches except `build.ts` (X1, before Task 12) and `mock.ts` (X5, before Task 13): run them where the table puts them and nothing collides. X9, X10 and X11 must come after plumbing Task 15, because Task 15 rewrites `drawBar` and `sampleHealthRgb` first.

---

### Task X0: Preconditions

**Files:** none.

- [ ] **Step 1:** Confirm plumbing Task 9 is reported done and its commits are on the branch (`git log --oneline | head -20`: look for "Drive Layers, the child controls and piece drags by panel"). Check `git status --short` and report anything uncommitted that is not yours.
- [ ] **Step 2:** `npx vitest run` and `npm run typecheck`. Record the counts as this plan's **baseline**. If anything fails, stop and report.
- [ ] **Step 3:** Read `/home/volence/l4d/hud/probe-phase2/RESULTS.md` whole, and open the crops this plan names for your first task. No commit.

---

### Task X1: Hard-hide every element

**Files:**
- Modify: `web/src/hud/build.ts`, `web/src/hud/build.test.ts`

**Interfaces produced (build.ts):**

```ts
/** Blocks, besides the element's own hudlayout.res block, that hold its content inside another file: hidden with it. */
export const HIDE_FRAMES: Readonly<Record<string, readonly { file: string; blocks: readonly string[] }[]>>;
// ownHealth:  [{ file: 'resource/ui/hud/localplayerdisplay.res', blocks: ['LocalPlayer'] }]
// teamColumn: [{ file: 'resource/ui/hud/teamdisplayhud.res', blocks: ['TeamPlayer1', 'TeamPlayer2', 'TeamPlayer3', 'TeamPlayer4'] }]
// chat:       [{ file: 'resource/ui/basechat.res', blocks: ['HudChat', 'HudChatHistory'] }]
```

- [ ] **Step 1: Write the failing tests.** Append to `web/src/hud/build.test.ts` (reuse `design`, `layoutOf`, `tree`):

```ts
describe('hiding an element hides it in game (probe B2 and B3: visible 0 alone hid nothing)', () => {
  // /home/volence/l4d/hud/probe-phase2/RESULTS.md, B2 and B3: every element tested came back with visible 0 only.
  const size = (n: KvNode) => [kvGet(n, 'visible'), kvGet(n, 'wide'), kvGet(n, 'tall')];
  const hideable = ELEMENTS.filter((e) => e.id !== 'xhair' && e.props.includes('visible'));

  for (const preset of ['stock', 'modern'] as const) {
    for (const el of hideable) {
      it(`${preset}: ${el.id} is visible 0 and 0 x 0 in hudlayout.res`, () => {
        const got = layoutOf(buildHud(design({ preset, elements: { [el.id]: { visible: false } } })));
        expect(size(kvFind(got, [el.key])!)).toEqual(['0', '0', '0']);
      });
    }
  }

  it('also zeroes the blocks that hold the content in another file', () => {
    for (const [id, frames] of Object.entries(HIDE_FRAMES)) {
      const files = buildHud(design({ elements: { [id]: { visible: false } } }));
      for (const f of frames) for (const b of f.blocks) expect(size(kvFind(tree(files, f.file), [b])!), `${id} ${b}`).toEqual(['0', '0', '0']);
    }
  });

  it('keeps the hide over a fitted, scaled team and a scaled own panel', () => {
    // teamPass writes the container and card sizes and scalePass multiplies: both run before the hide.
    const files = buildHud(design({ elements: { teamColumn: { visible: false, fit: true, scale: 1.5 }, ownHealth: { visible: false, scale: 2 } } }));
    expect(size(kvFind(layoutOf(files), ['CHudTeamDisplay'])!)).toEqual(['0', '0', '0']);
    expect(size(kvFind(tree(files, 'resource/ui/hud/teamdisplayhud.res'), ['TeamPlayer1'])!)).toEqual(['0', '0', '0']);
    expect(size(kvFind(tree(files, 'resource/ui/hud/localplayerdisplay.res'), ['LocalPlayer'])!)).toEqual(['0', '0', '0']);
  });

  it('is download-only: the preview trees keep a hidden element whole, so a selected hidden element still draws dimmed', () => {
    const d = design({ elements: { ownHealth: { visible: false } } });
    const local = kvFind(buildTrees(d)('resource/ui/hud/localplayerdisplay.res'), ['LocalPlayer'])!;
    expect([kvGet(local, 'wide'), kvGet(local, 'tall')]).toEqual(['130', '85']);
    expect(kvGet(kvFind(buildTrees(d)(LAYOUT_PATH), ['CHudLocalPlayerDisplay'])!, 'visible')).toBe('0');
  });

  it('writes nothing for an element that is not hidden', () => {
    expect(buildHud(design({ elements: { ownHealth: { visible: true } } })).map((f) => f.path))
      .toEqual(buildHud(design({})).map((f) => f.path));
  });
});
```

(`LAYOUT_PATH` is `'scripts/hudlayout.res'`; use the file's own constant if it has one. Import `ELEMENTS` from `./elements` and `HIDE_FRAMES` from `./build`, merged into the existing imports.)

Change the existing test "hides an element" (progress bar) to also expect `wide` and `tall` `'0'`: that is **the one deliberate change to an existing test** in this task; say so in the commit. Keep "hard-hides HudPZDamageRecord" and the chat hide tests exactly as they are: they must stay GREEN.

- [ ] **Step 2: Run** `npx vitest run --project web web/src/hud/build.test.ts`: RED (every element except chat and notices fails the first loop; the frames and the preview tests fail).
- [ ] **Step 3: Implement.**
  - `elementHidePass(work, design)`: for each element with `design.elements[id]?.visible === false`, skipping `xhair` and elements `baseHasElement` says the base lacks, `hardHide(work.panel(LAYOUT, [el.key]))`, then `hardHide` each block of `HIDE_FRAMES[id]` found with `work.optional(file, [block])` (an imported HUD may lack one). Doc comment: the B2 and B3 answer and shot paths, why it runs after `teamPass` and `scalePass` (they write sizes), why it is download-only (decision 2), and that `HIDE_FRAMES` is the second line on top of the container clip Q2 proved (`b1/shots/crops/own-a.png`).
  - Move the chat and kill-notice `hardHide` calls out of `layoutPass` into this pass (chat's basechat blocks become its `HIDE_FRAMES` entry). `layoutPass` keeps writing `visible` as now.
  - `buildHud`: call `elementHidePass(work, design)` right after `scalePass`. `buildTrees`: do not. Update the pass-order doc comment above `buildHud` with a bullet for the new pass.
  - `hardHide`: after the size writes, for each of `auto_wide_tocontents`, `auto_tall_tocontents`, `autoResize` present with a value other than `0`, `pcSet` it to `0` (decision 3). Add a unit test for that through a hand-made block with `autoResize 1` (the stock files have none, which is why no golden moves).
  - Update the comment on `hardHide` ("The chat window gets it too (layoutPass)") to name the new pass and say that B2 and B3 showed every element needs it.
- [ ] **Step 4: GREEN**, then `npx vitest run --project web web/src/hud/download.golden.test.ts`: every hash unchanged, in particular "hidden chat and notices, the game crosshair hidden, weapons edited". Full suite, typecheck. Commit `build.ts`, `build.test.ts`: "Hard-hide every hidden element, since probes B2 and B3 showed visible 0 hides none".

---

### Task X2: The hide probe VPKs (launches S, I and P)

**Files:**
- Create: `/home/volence/l4d/hud/probe-2f/build.mts`, `/home/volence/l4d/hud/probe-2f/validate.py`, `/home/volence/l4d/hud/probe-2f/README.md`, `s/s.steps`, `i/i.steps`, `p/p.steps` (outside the repo: nothing to commit)

Copy the loader pattern of `/home/volence/l4d/hud/probe-phase2/build.mts` (Vite SSR `buildHud`/`packHud`/`validateDesign` from this worktree, the golden sanity check updated to the current golden hashes from `download.golden.test.ts`) and of `probe-phase2/validate.py` (read every VPK back with the `vpk` module, check CRCs, that the harness counts it as a HUD addon, and every expected edit). Each VPK is the editor's own download, **no hand edits** except the load marker below: this probe tests the editor's output, not a theory.

**Launch S (survivor, `s/s.vpk`):** a stock design built through `validateDesign`, every survivor and both-side element hidden: `ownHealth`, `teamColumn`, `weaponSelection`, `chat`, `progressBar`, `killNotices` all `{ visible: false }`, `crosshair: 'none'`, `hideGameCrosshair: true` (the load marker: with everything hidden, a failed load and "all re-shown" would otherwise look alike, the B2 lesson). Steps: `probe-phase2/b2/b2.steps` shots (a) to (e), then the kill notice part of `b2/b2-killnotice.steps` (1-health Hunter, shot f). Name shots `s-a` to `s-f`.

**Launch I (infected, `i/i.vpk`):** stock, every infected and both-side element hidden: `infectedRow`, `siHealth`, `abilityRing`, `ghostPanel`, `tankPanel`, `chat`, `progressBar`, `killNotices`, the same load marker. Steps: `probe-phase2/b3/b3-rerun.steps` (the fixed order: `director_no_specials 1` only after the ghost shot), shots `i-a` to `i-e`, plus one `say probe` shot as a ghost for the chat.

**Launch P (pieces and boxes, `p/p.vpk`):** stock, every element visible, and inside them every registered piece hidden: `children.ownHealth` (once plumbing Task 10 has registered it; until then leave it out and say so in the README) and `children.teamColumn` each piece `{ visible: false }`; weapons `boxActive: { kind: 'flat', color: '255 0 0 255' }`, `boxInactive: { kind: 'flat', color: '0 0 255 255' }`. Steps: `probe-phase2/b1/b1.steps` shots (a) full health slot 1, (b) crouched, (c) hurt, then (e) pills held. Look: no own-health piece and no card piece anywhere (only the card background if `panelBg` is set: leave it unset); the active box pixel is exactly 255,0,0 and an inactive box exactly 0,0,255 if the game uses each box's file alpha as is; any blend with the scene means a multiplier (compute it from a pixel just outside the box in the same shot).

- [ ] **Step 1:** Write `build.mts` and the three steps files; build; run `validate.py`: every hidden element's `hudlayout.res` block is `visible 0`, `wide 0`, `tall 0`, every `HIDE_FRAMES` block the same, and the load marker is in.
- [ ] **Step 2:** `README.md`: the run list (3 launches, which steps file for each), what each shot must show for a pass, what a fail means and what to add to `HIDE_FRAMES` then.
- [ ] **Step 3:** Report that the VPKs are ready. **Do not launch.** When the controller says the game is free, the run is `ingame-harness/run.sh` with each VPK and its steps (one VPK per launch; the harness installs it as the only HUD addon and verifies the restore). After the run, write `probe-2f/RESULTS.md` in the probe-phase2 format: per element PRESENT or GONE with the shot path, the box pixels, and the harness's "restore verified" line per launch.
- [ ] **Step 4 (after the run):** For every element still PRESENT, a fix task: add its content blocks to `HIDE_FRAMES` (read its `.res` for the blocks), a test, rebuild, re-run that launch. For the box pixels, go to Task X8 Step 5.

---

### Task X8: Weapon box alpha (S4)

**Files:**
- Modify: `web/src/hud/weapons.ts`, `web/src/hud/weapons.test.ts`

- [ ] **Step 1: Write the failing test.** In `weapons.test.ts`, beside "draws every icon over its box":

```ts
it('draws a generated active box at its own alpha, as the game does (probe S4)', () => {
  // /home/volence/l4d/hud/probe-phase2/b1/shots/b1/b1-a.png vs b1-e.png, RESULTS.md S4:
  // a 255 0 0 128 box drew at about 0.55, with no 180/255 multiplier.
  const d = design({ weapons: { boxActive: { kind: 'flat', color: '255 0 0 128' } } });
  const fills = drawn(d).filter((c) => c.m === 'fillRect' && c.fill === 'rgba(255,0,0,0.502)');
  expect(fills).toHaveLength(1);
  near(fills[0].alpha, 1);
});
```

(Match the fill string to what `colourOf` returns for alpha 128; read the neighbouring tests for the exact format.)
- [ ] **Step 2: Run**: RED (alpha is `BOX_ALPHA`).
- [ ] **Step 3: Implement.** In `drawWeapons`, a generated fill on the **active** slot draws at `ctx.globalAlpha` unchanged; the inactive fill, an imported box and the stock art keep `BOX_ALPHA` until launch P measures them. Comment: the S4 shot and pixels, and that launch P (`/home/volence/l4d/hud/probe-2f/`) decides the rest. Update the `BOX_ALPHA` doc comment ("both slot kinds") to say which draws still use it and why. The existing "draws every icon over its box" test (inactive fills at `BOX_ALPHA`) stays GREEN unchanged.
- [ ] **Step 4: GREEN**, full suite. Commit: "Draw a generated active weapon box at its own alpha, as probe S4 showed".
- [ ] **Step 5 (after launch P):** If the inactive box pixel is exactly its colour, drop `BOX_ALPHA` for the inactive fill too (the "draws every icon over its box" test changes on purpose: say so). If the stock art also draws at full alpha (compare `probe-phase2/b13/compare/stock-weapons.png`, the glow box's rim pixel, against the preview), drop it there too; otherwise keep it and write the measured factor in the comment. One commit per change, each naming its shot.

---

### Task X3: Export the parity art

**Runs after plumbing Task 11** (same three files).

**Files:**
- Modify: `scripts/export-hud-art.py`, `web/src/hud/art.ts`, `web/src/hud/art/` (generated), `web/src/hud/art.test.ts` only if it pins a count

- [ ] **Step 1:** Add to `MATERIALS` (and `NEEDED_MATERIALS` in `art.ts`), each with a comment naming who draws it:
  - `vgui/hud/scalablepanel_bgblack_outlinegrey`: the kill notice box, named by `pzdamagerecordpanel.res` `label4background`.
  - `vgui/hud/pz_charge_bg`: the ability timer's red ring, set by code on `AbilityTimerHud.res` `BackgroundImage` (B3 shot `b3/shots-rerun/b3-rerun/b3-b.png`).
  - `vgui/hud/pz_charge_meter`: the ring's `fg_image` (`HUD/PZ_charge_meter`).
  - `vgui/hud/pz_charge_pounce`, `vgui/hud/pz_charge_lunge`, `vgui/hud/pz_charge_smoker`, `vgui/hud/pz_charge_boomer`, `vgui/hud/pz_charge_tank`: the class icons code sets on `AbilityImage`.
  - Add `'icon/healing': 'icon_healing'` to `EQUIP` (the `mod_textures.txt` cell, `vgui/hud/iconsheet` x 64 y 256, 64x64), the use/heal bar's `AwardIcon`.
- [ ] **Step 2:** `npx vitest run --project web web/src/hud/art.test.ts`: RED.
- [ ] **Step 3:** Run `/home/volence/l4d/hud/.venv/bin/python scripts/export-hud-art.py`. The 1 MB cap must hold; if a texture is large, the script's own downscale rules apply (read how it treats the existing ones). Read every new PNG back (Read tool) and say which of `pz_charge_pounce` and `pz_charge_lunge` is the leaping Hunter in `probe-phase2/b13/compare/stock-infected-bottom.png`; X7 uses that one and drops the other from the list (re-export).
- [ ] **Step 4: GREEN**, full suite. Commit the script, `art.ts` and the generated files by path: "Export the kill notice box, the ability timer ring and icons, and the healing icon for the preview".

---

### Task X4: Kill notices where the game draws them

**Files:**
- Modify: `web/src/hud/mock.ts` (`paintKillNotices` only), `web/src/hud/mock.test.ts`

**What the game does** (`probe-phase2/b2/shots-kill/b2-killnotice/b2-f.png`, stock `HudPZDamageRecord` at `xpos 10`, `ypos 170`, `label_textalign west`): one notice, red, "Hunter incapacitated Francis", its text starting at x about 45 px (20 units: the element's 10 plus the row's `xpos 10`), in a dark rounded box from x 30 to 333 px and y 383 to 415 px (row 0's 15 units tall at the element's top). The rows' own `textAlignment east` is overridden: `label_textalign` wins.

- [ ] **Step 1: Measure.** Crop `b2-f.png` (x 0 to 400, y 370 to 430) and find the first and last columns of red text and of the box's grey outline. Write the pad (box edge to text edge, in HUD units: pixels / 2.25) left and right, and the box's top and bottom against the row. These numbers go in the test comment and in `mock.ts` as named constants with the shot path.
- [ ] **Step 2: Write the failing test.** Replace the existing test "draws the kill/incap sample lines right-aligned, clipped to the element, first row red" with (this is **the deliberate change** in this task; say so in the commit):

```ts
it('draws one notice at the left, in the row\'s colour, in the notice box, as the game does (probe B2 f)', () => {
  // /home/volence/l4d/hud/probe-phase2/b2/shots-kill/b2-killnotice/b2-f.png: text from x 45 px,
  // box x 30 to 333 px, y 383 to 415 px; label_textalign west in hudlayout.res beats the rows' east.
  const { ctx, calls } = recordingCanvas();              // the file's existing recorder
  drawHud(ctx, 1920, 1080, DEFAULT_DESIGN, 'survivor', null);
  const text = calls.find((c) => c.m === 'fillText' && c.a[0] === 'Hunter incapacitated Francis')!;
  expect(text.align).toBe('left');
  expect(text.a[1]).toBeCloseTo(20 * 2.25, 0);          // element x 10 + row xpos 10
  expect(text.fill).toBe('rgba(246,5,5,1)');
  const box = artUrl('vgui/hud/scalablepanel_bgblack_outlinegrey')!;
  expect(calls.filter((c) => c.m === 'drawImage' && c.a[0].src === box)).toHaveLength(9);   // nine-sliced
  expect(calls.some((c) => c.m === 'fillText' && c.a[0] === 'Bill killed a Hunter')).toBe(false);
});
it('follows label_textalign east and center when a HUD sets them', () => { /* an imported sampleHud with label_textalign east: textAlign right at the row's right edge */ });
```

Use the helpers `mock.test.ts` already has for recording draws (read its kill notice test first and reuse its setup; the snippet names are placeholders for those).
- [ ] **Step 3: Run**: RED.
- [ ] **Step 4: Implement.** `paintKillNotices`: read `label_textalign` from the generated `hudlayout.res` `HudPZDamageRecord` (`buildTrees`), default `west`; it replaces every row's `textAlignment`. Draw one row, `recordlabel0`, text "Hunter incapacitated Francis", in its font and `fgcolor_override`. Behind it, the `label4background` art nine-sliced with its own `src_corner_width/height` (texels) and `draw_corner_width/height` (units), sized to the text's measured width plus the Step 1 pads, the row's height; drawn before the text. Reuse `weapons.ts`'s nine-slice routine (export it as `drawNineSlice` from `weapons.ts`, or move it to `render.ts` if the import would be circular). Comment: decision 7, the shot, and that B12 settles how several notices stack.
- [ ] **Step 5: GREEN**, full suite, typecheck. Commit: "Draw kill notices at the left in their box, as the game does".

---

### Task X5: The closed chat

**Files:**
- Modify: `web/src/hud/mock.ts` (`paintChat` only), `web/src/hud/mock.test.ts`

**What the game does** (`probe-phase2/b2/shots/b2/b2-e.png`): closed chat, no box, the line "Mal : probe" at x 52 px, y 670 px: the top-left of `basechat.res` `HudChatHistory` (stock `HudChat` at `xpos 10`, `ypos r205`; history at `10`, `17` inside it: x 20 units, y 292 units = 45 px, 657 px) plus the RichText's own inset. The font is `chatscheme.res` `ChatFont` (Tahoma 12, drop shadow).

- [ ] **Step 1: Write the failing test** in `mock.test.ts`:

```ts
it('draws the closed chat: history lines only, no box (probe B2 e)', () => {
  // /home/volence/l4d/hud/probe-phase2/b2/shots/b2/b2-e.png: "Mal : probe" at x 52, y 670 px, nothing behind it.
  // paintChat used to fill the whole element: that is the open chat, which no probe has shot.
  const calls = drawnChat(DEFAULT_DESIGN);          // record drawHud on the survivor side, keep only the chat element's calls
  expect(calls.filter((c) => c.m === 'fillRect')).toEqual([]);
  const lines = calls.filter((c) => c.m === 'fillText').map((c) => c.a[0]);
  expect(lines).toEqual(['Zoey : watch the closet', 'Francis : got it']);
  const first = calls.find((c) => c.m === 'fillText')!;
  expect(first.a[1]).toBeGreaterThanOrEqual(45); expect(first.a[1]).toBeLessThanOrEqual(54);   // history left plus the RichText inset
});
it('puts the lines at the top of the moved and resized history', () => { /* chat { x: 500, y: 20, w: 300, h: 150 }: first line at the generated HudChatHistory's top-left */ });
```
- [ ] **Step 2: Run**: RED.
- [ ] **Step 3: Implement.** `paintChat(ctx, r, design, k, onAsset)`: read `HudChat` and `HudChatHistory` from the generated `basechat.res` (`buildTrees`; `chatWindow` already writes both for a moved or resized chat), place the history at `r` plus its `xpos/ypos` (the history is a child of basechat's `HudChat`, whose own place is what `elementRect` reports), and draw the two sample lines from its top in `ChatFont` through `setFont`/`fillFontText` (so the size comes from the scheme), white with a one-pixel dark shadow, "Name : text" as the game formats it. Measure the RichText inset from the crop (the 7 px between 45 and 52) and name it. Clip to `r`. No fill. Update the painter table's signature entry. Comment: decision 8 and the shot.
- [ ] **Step 4: GREEN**, full suite, typecheck. Commit: "Draw the chat closed, as the game shows it: lines, no box".

---

### Task X6: The use/heal bar from its file, and the Q22 rule

**Files:**
- Create: `web/src/hud/progress.ts`, `web/src/hud/progress.test.ts`
- Modify: `web/src/hud/mock.ts` (`paintProgressBar` only), `web/src/hud/mock.test.ts`, `docs/superpowers/specs/2026-09-24-hud-editor-phase2-design.md` (section 3.6, one paragraph)

**Interfaces produced (progress.ts, imports nothing but types):**

```ts
export interface BarKeys { border: number; gap: number; shadow: number }
/** The largest border and gap that still leave one unit of fill: 2 * (border + gap) < tall (probe Q22). Gap gives way first. */
export function clampBarKeys(keys: BarKeys, tall: number): BarKeys;
/** The rects the game draws for a CTerrorProgressBar-style bar of `r` at fraction `f`: border ring, fill, empty, shadow. */
export function barGeometry(r: { x: number; y: number; w: number; h: number }, keys: BarKeys, f: number): {
  border: { x: number; y: number; w: number; h: number } | null;
  fill: { x: number; y: number; w: number; h: number } | null;
  empty: { x: number; y: number; w: number; h: number } | null;
  shadow: { x: number; y: number; w: number; h: number } | null;
};
```

**What the game does** (`probe-phase2/b13/compare/stock-heal.png`, `b1v2/shots/crops/bar-d.png`, `b1/shots/crops/bar-d.png`): `AwardIcon` `icon_healing` at `2,0` 24x24; `BarLabel` "HEALING YOURSELF" (`#L4D_progress_heal`) in `MenuTitle_DropShadow`, white; `Bar` at `28,15` 200x8: a `border_thickness` ring in `border_color`, a `gap`, the fill in `fill_color` from the left, the rest in `empty_color`, a `shadow_thickness` line in `shadow_color` under the bar. b1v2 (tall 20, border 3, gap 3): 6 px border, 6 px gap, fill, 2 px shadow. B1 (tall 8, border 3, gap 3): border only.

- [ ] **Step 1: Write the failing tests.** `progress.test.ts`:

```ts
describe('the use/heal bar geometry (probe Q22)', () => {
  const r = { x: 0, y: 0, w: 200, h: 20 };
  it('draws a border ring, a gap, then fill and empty inside it', () => {
    const g = barGeometry(r, { border: 3, gap: 3, shadow: 1 }, 0.5);
    expect(g.fill).toEqual({ x: 6, y: 6, w: 94, h: 8 });
    expect(g.empty).toEqual({ x: 100, y: 6, w: 94, h: 8 });
    expect(g.shadow).toEqual({ x: 0, y: 20, w: 200, h: 1 });
  });
  it('draws no fill and no empty part when border and gap eat the bar, as B1 showed', () => {
    const g = barGeometry({ ...r, h: 8 }, { border: 3, gap: 3, shadow: 1 }, 0.5);
    expect([g.fill, g.empty]).toEqual([null, null]);
    expect(g.border).not.toBeNull();
  });
  it('clamps so one unit of fill always remains, the gap giving way first', () => {
    expect(clampBarKeys({ border: 3, gap: 3, shadow: 1 }, 8)).toEqual({ border: 3, gap: 0, shadow: 1 });
    expect(clampBarKeys({ border: 5, gap: 2, shadow: 1 }, 8)).toEqual({ border: 3, gap: 0, shadow: 1 });
    expect(clampBarKeys({ border: 1, gap: 1, shadow: 1 }, 8)).toEqual({ border: 1, gap: 1, shadow: 1 });
  });
});
```

(Check the b1v2 crop to confirm the shadow sits below the bar rather than inside it, and fix the expectation if not, citing the pixels.)

`mock.test.ts`: on stock, drawing `progressBar` at `DEFAULT_PREVIEW` draws the `icon_healing` art at the element's origin plus `(2, 0)` 24x24 units, `fillText` "HEALING YOURSELF", and the bar rects from `barGeometry` of `Bar`'s rect and keys; no `fillRect` wider than 200 units. On the owner-like import (`sampleHud()` with `HudProgressBar` `xpos 0`, `ypos r24`, `wide 300`, `tall 45` and no `progressbar.res`), the drawn bar still ends at x 228 units: the content is the file's, not the element's 300.
- [ ] **Step 2: Run**: RED.
- [ ] **Step 3: Implement.** `progress.ts` as tested (units in, units out; the painter scales). `paintProgressBar(ctx, r, design, k, onAsset)`: clip to `r`; read the four children from `buildTrees(design)('resource/ui/hud/progressbar.res')`; draw `AwardIcon` (the `icon/healing` art), `BarLabel` via `setFont`/`fillFontText` with the text "HEALING YOURSELF" (comment: the label is filled by code with `#L4D_progress_heal` from `resource/left4dead_english.txt`; the preview shows the self-heal the B13 shots show), `Bar` through `barGeometry` at fraction 0.3 (the mid-heal shot's fill) with `clampBarKeys` applied first (the preview draws what the editor would let the file say; an imported HUD whose keys break the rule draws border only, like the game: pass the raw keys when the clamp would change them and the design is imported, and say why), `Subtext` empty. Comment block: the B13 shots, the owner-HUD finding from this plan's table, and Q22.
- [ ] **Step 4:** Spec section 3.6: add "The Bar's `border_thickness` and `gap` controls go through `progress.ts` `clampBarKeys` against the Bar's `tall`, in `validateDesign` and in the control's max, and a Bar resize that would break `2 * (border + gap) < tall` clamps the gap first (probe Q22, `probe-phase2/b1/shots/crops/bar-d.png`)."
- [ ] **Step 5: GREEN**, full suite, typecheck. Commit `progress.ts`, `progress.test.ts`, `mock.ts`, `mock.test.ts`, the spec: "Draw the use/heal bar from progressbar.res, and keep its border and gap from eating the bar".

---

### Task X7: The ability timer from its file

**Files:**
- Modify: `web/src/hud/mock.ts` (`paintAbilityRing` only), `web/src/hud/mock.test.ts`

**What the game does** (`probe-phase2/b3/shots-rerun/b3-rerun/b3-b.png`, `b13/b13-stock/infected/hunter.png`, `b13/compare/stock-infected-bottom.png`): `AbilityTimerHud.res` `BackgroundImage` (0,0 80x80) with `pz_charge_bg`, `AbilityImage` (10,10 60x60) with the class icon, `Progress` (10,10 60x60) with `pz_charge_meter`, inside the `CHudAbilityTimer` element (`r72`, `r120`, 80x70). Centred about (1847, 905) px on the 80x80 background, not on the 80x70 element.

- [ ] **Step 1: Write the failing test** (`mock.test.ts`): drawing the infected side at `DEFAULT_PREVIEW` (Hunter, ready) draws `vgui/hud/pz_charge_bg` at the element origin 80x80 units (times k), the Hunter icon chosen in X3 at +10,+10 60x60, and the meter at +10,+10 60x60; with `siClass: 'smoker'` the icon is `pz_charge_smoker`; the centre of the drawn background is within 3 px of (1847, 905) at 1920x1080 on stock. No `arc` call.
- [ ] **Step 2: Run**: RED.
- [ ] **Step 3: Implement.** `paintAbilityRing(ctx, r, design, k, onAsset, view)`: children from `buildTrees(design)('resource/ui/hud/abilitytimerhud.res')` in `zpos` order, each at `r` plus its rect, the background and icon chosen by code as the game does (a small `ABILITY_ICON` map by `PreviewState.siClass`, with a comment naming the export), the meter drawn full for `ready` and at 0.6 of its sweep (a canvas arc clip over the meter art) for `charging`. If the stock `hunter.png` shows the meter art at ready differently (for example not drawn at all), follow the shot and say so. Modern hides `BackgroundImage` (0x0, visible 0): its preview then has no red ring, as its file says. Clip to the element rect, as VGUI does (the bottom 10 units of the 80x80 background fall outside the 70-tall element: check the shot shows the ring's bottom cut or not, and match it; if the game does not cut it, the element does not clip here, and the comment says so).
- [ ] **Step 4: GREEN**, full suite, typecheck. Commit: "Draw the ability timer from its file: the ring, the class icon and the meter".

---

### Task X9: The health bar the game's way

**Runs after plumbing Task 15.** It rewrites three of Task 15's tests on purpose: "Hurt bar" (2), "Gated bar" (6) and "Gated inset" (7). Say so in the commit.

**Files:**
- Modify: `web/src/hud/render.ts` (`drawBar`, and the call in `drawPanel`), `web/src/hud/render.test.ts`

**What the game does:** `probe-phase2/b13/compare/stock-own.png` and `stock-card1.png` (full health: an outline frame, the fill inset about 4 px, shaded top to bottom), `b1v3/shots/crops/own-hurt.png` (20 health: orange outline, orange shaded fill at the left, the rest a dark shaded grey), `b1v2` (inset 3: 6 px). `healthbar_white` runs 255 to 183 top to bottom and `healthbar_grey` 49 to 33, both 256x16; the dll's `HealthPanel` string run names exactly `vgui/hud/s_healthbar_outline`, `vgui/healthbar_grey`, `vgui/healthbar_white` (`dll-hud-strings.txt`, lines after `HealthPanel`).

- [ ] **Step 1: Check the colours before writing the test.** Sample the game's fill column (top and bottom rows) at x 1800 in `b13/b13-stock/survivor-full/full-1.png` and at the orange fill in `b1v3/.../own-hurt.png`; compute `healthbar_white`'s top and bottom rows times `healthRgb(100, 100, false)` and times the hurt colour. They must agree within 10 per channel. If they do not, the health colour table is off: report the numbers and stop (a colour table fix is its own task).
- [ ] **Step 2: Write the failing tests** (`render.test.ts`, with `recCtx` and `instantImage`), on the own panel and on a teammate card:
  1. Healthy: `drawImage` of `vgui/hud/s_healthbar_outline` at the `Health` rect, tinted by the health colour (the tint cache key or the multiply fill the file's tint tests already check); `vgui/healthbar_white` tinted the same, at the rect inset by 2 units times k on every side, full width; no `healthbar_grey` (nothing is empty).
  2. Hurt (40): the fill 0.4 of the inset width, tinted orange; `healthbar_grey` over the other 0.6 (untinted); the outline orange.
  3. Down: the fill full width in the incap colour.
  4. Stock default inset is 2; `inset 3` in the block (gate Q3 forced open) insets by 3; with the gate closed a stored `inset` never reaches the tree (validateDesign) and the draw uses 2.
  5. No draw anywhere of `vgui/healthbar_green`, `_orange` or `_red` any more.
- [ ] **Step 3: Run**: RED.
- [ ] **Step 4: Implement.** `drawBar(ctx, design, n, r, k, view, panelColour)` as tested: the outline stretched to the rect; the inset `m = (Q3 open && kvGet(n, 'inset') !== undefined ? int : 2) * k`; fill and empty from the inset rect, split at the health fraction (1, 0.4 hurt, 1 down); the tint through `tinted` (the same cache the scratches use). Doc comment: decision 4, each shot path, the dll string run, and that the old claim "never reads the healthbar_* textures (probe T8)" was about addon overrides of pak01 textures, which cannot work anyway (the splatter spec, "What the game does"), not about what code draws. Delete that claim.
- [ ] **Step 5: GREEN**, full suite, typecheck. Commit: "Draw health bars as the game does: outline, inset, shaded fill and the dark empty part".

---

### Task X10: One colour for the whole health panel (Q1's real answer), and the teammate keys

**Runs after X9 and plumbing Task 10.**

**Files:**
- Modify: `web/src/hud/render.ts`, `web/src/hud/render.test.ts`, `web/src/hud/children.ts`, `web/src/hud/children.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `render.test.ts`, with `_setProbe('Q1', true)` and a design whose own `Health` has `keys: { monochrome_color: '255 0 255 255' }` (build directly or through `validateDesign` with the gate open):
    1. At Healthy **and** Hurt **and** Down, the own panel's fill, outline, `HealthNumber` text, `HealthIcon` text and both scratches are all drawn in 255,0,255 (the fill and outline as tints of their textures, the labels as `rgba(255,0,255,1)`); nothing is green or orange. (`b1/shots/crops/own-a.png`, `own-c.png`.)
    2. The number still reads "40" when hurt: the colour changes, the value does not.
    3. A teammate card with `children.teamColumn.Health.keys.monochrome_color '0 255 255 255'`: bar and `HealthNumber` (turned on) cyan, the name untouched; the down card's number cyan too (`b1v3/shots/crops/cards-hurt.png`).
    4. Gate closed: the stored key is dropped on load and the preview is the health colour.
    5. **Q4:** a file `drawColor "255 255 0 255"` on `HealthbarTextureTop` changes nothing in the preview's tint, with or without a panel colour (`b1v2/shots/crops/ownbig-a.png`, `ownbig-c.png`).
  - `children.test.ts`: the teammate `Health` child declares `monochrome_color` (gate Q1) and `inset` (gate Q3, `range [0, 8]`); the own `Health`'s `monochrome_color` KeyDef is labelled "Panel colour"; the notes are decision 5's texts. The dll test (`dllstrings.test.ts`) passes unchanged.
  - Replace the plumbing Task 15 test 6 ("a flat `rgba(255,0,255,1)` fill of the bar rect") with test 1 above: **deliberate**, say so in the commit.
- [ ] **Step 2: Run**: RED.
- [ ] **Step 3: Implement.**
  - `render.ts`: `panelColour(design, panelId, nodes)`: the `monochrome_color` of the panel's `Health` block in the generated tree, parsed, when `probe('Q1')`; else undefined. `sampleHealthRgb(view, panelColour)` returns it when set, before any state rule. Every user of the health colour on a panel (the bar, `HealthNumber`, `HealthIcon`, the scratches through `HEALTH_TINT_CHILDREN`) reads that one function, so no piece can disagree. Doc comment: Q1's answer as RESULTS.md words it, decision 5.
  - `children.ts`: the teammate `Health` gains `keys` with the two KeyDefs (`evidence` per decision 6); the own `Health`'s `monochrome_color` label becomes "Panel colour" and both notes are decision 5's; the scratch notes gain "or the panel colour".
- [ ] **Step 4: GREEN**, golden unchanged (no saved design has these keys), full suite, typecheck. Commit: "Make the panel colour tint the whole health panel, as probe Q1 showed, and offer it on teammate cards".

---

### Task X11: The teammate splatter's strength (S6), measured

**Files:**
- Modify: `web/src/hud/render.ts` (`SPLATTER_ALPHA` only), `web/src/hud/render.test.ts`

S4 answered the weapon box, not the splatter: `SPLATTER_ALPHA` (0.35) is still T6's guess. Measure before changing it.

- [ ] **Step 1: Measure.** In `probe-phase2/b13/b13-stock/survivor-full/full-1.png`, take three pixels inside a card's `healthbar_bg_N` splatter where the texture is solid (look at `web/src/hud/art/vgui-hud-healthbar_bg_1.png` for where its alpha is highest) and the same three pixels in a shot where that card is gone or moved (none exists: use pixels just outside the splatter's edge on the same wall, and say so). Solve `observed = a * texel + (1 - a) * background` per channel, knowing the texel RGB and its own alpha. Report `a / texelAlpha` as the factor.
- [ ] **Step 2:** If the factor is within 0.05 of 0.35, change nothing but the comment (cite the pixels) and commit that. Otherwise write a test pinning the new factor (the existing splatter alpha test, updated on purpose), set `SPLATTER_ALPHA`, GREEN, commit: "Draw the stock teammate splatter at the strength the B13 shot shows". If the measurement is too noisy to decide (the three pixels disagree by more than 0.1), change nothing and write that B7 must answer it.

---

### Task X13: Down and Dead cards over a custom splatter

**Runs after X11** (same file, `render.ts`).

**Files:**
- Modify: `web/src/hud/render.ts`, `web/src/hud/render.test.ts`

**What the game does** (`/home/volence/l4d/hud/test-splatter-2026-09-24/runs/A/crop-dead-incap-game-vs-preview.png`, top row game, bottom row preview; the full shots are `runs/A/survivor-hurt/hurt-settled.png` and `A-image-preview-dead.png` / `-down.png`, same 1920x1080 frame; the run's README maps the dead card to `-dead` and the incap card to `-down`): the custom teammate splatter (the `HudEdSplatter` stand-in) **shows on the incap and the dead card in game**, and on the dead card a cyan stripe measures **0,168,168** in game but **0,99 to 119** in the preview. The preview darkens the dead card far more than the game does. The stock `s_panel_dead` art is black at a low alpha (mean 41 of 255, up to 165) with the skull, and its `.vmt` has `$vertexcolor 1` but **no** `$vertexalpha` (pak01 `materials/vgui/s_panel_dead.vmt`); the fit rule draws it squared at the card width (120) where the file says 96x96 at 12,9.

- [ ] **Step 1: Measure and find the layer.** Pick three cyan and three magenta stripe pixels on the dead card, and the same on the incap and the 35-health card, in both the game shot and the preview shot. Tabulate game against preview. Then find which preview layer causes the extra darkening: redraw `A-image-preview-dead.png`'s design headless (`/home/volence/l4d/hud/test-splatter-2026-09-24/build-through-page.mjs` shows how the page was driven) with, in turn, the `Dead` art skipped, `DEAD_NAME_ALPHA` at 1, and the dead art drawn at the file's 96x96 instead of the fitted square, and see which one brings the stripe to 168. Also decode `s_panel_dead.vtf` from pak01 with `srctools` and compare its alpha at those texels with `web/src/hud/art/vgui-s_panel_dead.png`: an export that got the alpha wrong is a possible cause too. Report the table and the cause before changing code.
- [ ] **Step 2: Write the failing tests** (`render.test.ts`), for a design with an Image teammate splatter (the file's splatter tests show how to store one without pixels):
  1. The stand-in (`HudEdSplatter`) is drawn in the `down` and `dead` states, at the same rect and alpha as in `healthy` (the regression guard for "the splatter shows on incap and dead cards in game").
  2. The cause Step 1 found, pinned: for example, if the dead art must be drawn at a lower strength, the `Dead` art's `drawImage` runs at that `globalAlpha`; if its export was wrong, the art test checks the PNG's alpha at a named texel against the VTF's. Each test cites the pixel table.
- [ ] **Step 3: Run**: RED.
- [ ] **Step 4: Implement** the fix Step 1 identified, with a comment naming the shot, the pixels and the cause. A fix that is a factor (not a cause) must say so and name the probe that would explain it (B7).
- [ ] **Step 5: GREEN**, full suite, typecheck; redraw the dead card headless and confirm the stripe is within 10 of 0,168,168. Commit: "Darken a dead teammate card only as much as the game does, over a custom splatter too".

---

## Gate tasks (replace the plumbing plan's F1 to F5)

Each gate task first writes the answer and its shot paths into the spec's section 4 under its question (B1 table), then edits `probes.ts` and the tests that pin the gate. `probes.test.ts`'s "none passed yet" test becomes "each gate is passed or open as section 4 records it", listing the expected value per id.

### Task G4: Q5 failed, retire the cross colour (after plumbing Task 16)

- [ ] **Step 1: Tests first.** `children.test.ts`: own `HealthIcon` has `colour: false` and no `colourGate`, note "The game colours this with the panel's health colour, or the Panel colour when one is set."; `design.test.ts`: a stored `children.ownHealth.HealthIcon.color` is dropped on load (it already is for `colour: false`: the test pins it); `Hud.test.tsx`: "Health cross" shows no Colour control with any gate forced; `probes.test.ts`: `Q5` is not a gate. Remove the plumbing Task 16 test 5's "with Q5 on, a Colour control" half: deliberate.
- [ ] **Step 2: RED, implement, GREEN.** Remove `Q5` from `ProbeId` and `PROBES`, the `colourGate` from `HealthIcon`, and any `'Q5'` reference (`grep -rn "'Q5'" web/src`). Full suite, typecheck. Commit: "Drop the health cross colour: probe Q5 showed the game ignores it".

### Task G5: Q8 passed, the crouch icon tint (after plumbing Task 16)

- [ ] As the plumbing plan's F5: `PROBES.Q8.passed = true`, the tests that pinned the colour control as hidden now pin it shown (keep a `_setProbe('Q8', false)` variant as the closed path). `stateArt: 'crouched'` is confirmed (`b1v2/shots/crops/ownbig-b.png` shown, `ownbig-a.png` absent): no preview change. Commit: "Offer the crouch icon tint: probe Q8 showed the game keeps it".

### Task G1: Q1 passed, the Panel colour (after X10 and plumbing Task 16)

- [ ] `PROBES.Q1.passed = true`, and its `question` reworded to "monochrome_color on a HealthPanel recolours the whole panel (fill, outline, number, cross, scratches) in every state". Tests pinning the own and teammate `monochrome_color` control hidden now pin it shown, labelled "Panel colour", with decision 5's note; the page test sets it and the preview's `HealthNumber` draws in that colour (read through the canvas stub as plumbing Task 16's tests do). Keep the closed-gate variants. No "Healthy-only" branch: Q1 held at 40 health. Commit: "Offer the panel colour for your health and your teammates: probe Q1 showed it recolours the whole panel".

### Task G3: Q3 passed, the inset (after X9 and plumbing Task 16)

- [ ] `PROBES.Q3.passed = true`. Tests pinning `inset` hidden now pin it shown on the own and the teammate `Health`. Compare `b1v2` (inset 3) with the preview at 1920x1080 over a flat background: the gap between outline and fill must be 6 to 7 px, and the stock one 4 to 5 px; if not, fix `drawBar` with a test. Commit: "Offer the health bar inset: probe Q3 showed it works".

### Task G2: Q2 passed, fit the own panel by default (after plumbing Task 17)

- [ ] Exactly the plumbing plan's F2 (its text stands: the answer is "clips, image never painted", which is the pass condition as the gate is worded). Also record in the spec that Q2's "image painted" branch is closed and `ownBg` is the only own-panel background. Commit as F2 says.

---

### Task X12: Verification

**Files:** none (report only), unless a check fails.

- [ ] **Step 1: The whole chain**, real output in the report: the plumbing plan's Task 17 chain (`npm test && npm run typecheck && npm run build` and every `check-hud-vpk.sh` sample, including `o`). Golden: `git diff <plumbing Task 0 commit> -- web/src/hud/download.golden.test.ts` shows only G2's deliberate hash changes.
- [ ] **Step 2: Headless parity shots.** Vite on `:5199` from this worktree (as plumbing Task 9 Step 3 describes; `canvas.toDataURL()`, never a CDP screenshot). Stock, Modern and the owner's HUD (`/home/volence/l4d/hud/probe-phase2/b13/b13-owner.vpk`, imported through the page's file input), survivor Healthy, Hurt, Down, the heal bar showing, and stock infected Hunter. Crop the same regions as `probe-phase2/b13/compare/*.png` and put game and preview side by side in `/home/volence/l4d/hud/probe-2f/parity/`. For each row of this plan's first table that has a B13 shot, say "matches" or what still differs, with pixel positions.
- [ ] **Step 3: Launch R (optional, when the game is free):** re-run B13's three launches with today's downloads (`probe-phase2/b13/heal.steps` and the harness scenarios), so the next slices have a fresh baseline. Add the results to `probe-2f/RESULTS.md`.
- [ ] **Step 4:** Report: counts against the X0 baseline, the chain output, the parity table, the state of launches S, I, P (and R), and every probe still open (S8, Q9, S6 if X11 could not decide, the inactive and stock weapon box factor if launch P has not run).

---

## Task list (summary)

| Task | One line | Probe |
|---|---|---|
| X0 | Preconditions and baseline, after plumbing Task 9 | none |
| X1 | Hard-hide every hidden element in a download-only pass after scaling, frames included | S1 (B2, B3) |
| X2 | Probe VPKs: S (survivor all hidden), I (infected all hidden), P (all pieces hidden, pure boxes) | verifies X1, S4 |
| X8 | Active generated weapon box at its own alpha; the rest after launch P | S4 |
| X3 | Export the notice box, ability ring, class icons and healing icon | B13 |
| X4 | Kill notices at the left, west, one row in its box | B2 f, B13 |
| X5 | Closed chat: history lines only | B2 e, B13 |
| X6 | Use/heal bar from `progressbar.res`; `progress.ts` geometry and the Q22 clamp | B13, Q22 |
| X7 | Ability timer from `AbilityTimerHud.res`: ring, class icon, meter, right centre | B3, B13 |
| X9 | Health bars: tinted outline, inset, `healthbar_white` fill, `healthbar_grey` empty | B13, Q3, S-hurt |
| X10 | `monochrome_color` tints the whole panel in the preview; teammate `Health` keys | Q1, Q4 |
| X11 | Measure the teammate splatter factor before changing it | S6 |
| X13 | Dead card darkened as the game does (stripe 0,168,168, not 0,99 to 119); splatter pinned on Down and Dead | splatter run A |
| G4 | Retire Q5: no cross colour | Q5 |
| G5 | Flip Q8 | Q8 |
| G1 | Flip Q1 as "Panel colour" | Q1 |
| G3 | Flip Q3 | Q3 |
| G2 | Flip Q2 and fit by default (plumbing F2) | Q2 |
| X12 | Chain, headless parity against B13, optional launch R | all |
