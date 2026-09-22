# HUD Editor Phase 1: Teammate Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The survivor teammate card becomes fully editable within what L4D1 honours: Row, Column or Free layout with a real gap, a card fitted to its content, every child inside the card movable and sizable with square art kept square, a card background the game actually draws, a Healthy / Down / Dead preview, and four cleanups the in-game probe exposed (kill feed, `tankhealth.res`, the Advanced bar slots, the splatter), plus a "hide the game's crosshair" option.

**Architecture:** `HudDesign` stays `v: 1` and gains team fields on `ElementOverride` (`gap`, `fit`, `slots`, `dir: 'free'`), the v2 spec's sparse `children` map (teammate card only) and `hideGameCrosshair`. A new data-only registry (`children.ts`) names the card's children; the generator gains `childPass` (inside edits) and `fitPass` (shrink the card to its content, square the state art, inject the drawn card background), and `teamLayout`/`teamPass` move from pitch to gap and learn Free. The preview keeps drawing only from the generated trees: the renderer gains the Down and Dead states, and the page gains two-level selection (panel, then child), per-card dragging in Free, and the side-panel controls.

**Tech Stack:** TypeScript, Preact, Vite, vitest (happy-dom project `web`, plus `// @vitest-environment node` where a test needs CompressionStream), canvas 2D. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-22-hud-editor-teammate-cards-design.md` (binding). It builds on `docs/superpowers/specs/2026-09-22-hud-editor-panel-internals-design.md` (the v2 spec: its "The data model", "The child registry", "The child pass" and "The page" sections, applied here to `teamColumn` only) and on the "In-game probe results" section of `docs/superpowers/specs/2026-09-22-hud-editor-capability-audit.md`, which is the ground truth for every engine claim.

## Global Constraints

- Work only in the worktree `/home/volence/l4d/pug/.claude/worktrees/hud-editor` (branch `worktree-hud-editor`). Never touch the main checkout or `master`. Do not push. Nothing is deployed.
- No server code, no database, no plugin, no new npm dependencies. Everything is under `web/` plus `docs/`.
- Never use em dashes anywhere: code, comments, UI copy, test names, commit messages. Use commas, colons, parentheses or separate sentences.
- Match the surrounding explanatory comment style: block comments that say why, as in `web/src/hud/build.ts`.
- Commit after every task with a plain-English message. All commands run from the worktree root.
- Tests: `npx vitest run --project web <path>`. Types: `npm run typecheck`. Build: `npm run build`.
- Preview equals file: every position the canvas draws or hit-tests comes from the generator's own trees (`buildTrees`, `teamCardRects`, `childRects`, `elementRect`). No module under `web/src/hud/` or the page computes a child or card position on its own.
- Saved designs render unchanged when `fit` is absent: `validateDesign` never adds `fit`, and only `DEFAULT_DESIGN` (new designs and "Reset") carries `teamColumn: { fit: true }`.
- Square game art stays square: `Head`, `Incapacitated`, `Dead`, `Voice` always get `w == h` from the design and from `fitPass`.
- `ChildOverride` numbers are unscaled and stored in the card file's own unfitted frame (the frame of the base `teammatepanel.res`). `fitPass` shifts them and `scalePass` multiplies them afterwards.
- Pass order in `buildHud`: `layoutPass`, `childPass`, `fitPass`, `teamPass`, `scalePass`, `fontPass`, `stylePass`. `buildTrees` runs the same minus `fontPass`.
- One `teammatepanel.res` drives every teammate card: an inside edit applies to all of them, and the preview outlines a selected child in all three cards.
- The preview's exported Valve art stays preview-only: nothing the generator imports may import `hud/art` (`art.test.ts` enforces it; `children.ts` joins that list).

## File Structure

```
web/src/hud/children.ts          NEW. The child registry for the teammate card: names, labels, kinds, roles, size and colour rules, the HealthNumber template
web/src/hud/children.test.ts     NEW. Registry pinned to both presets' teammatepanel.res and schemes
web/src/hud/design.ts            ElementOverride team fields, ChildOverride, children, hideGameCrosshair, baseTeam, clampChild, migration spacing -> gap, drops removed elements and slots
web/src/hud/design.test.ts       migration, fit default, slots, children validation, dropped fields
web/src/hud/elements.ts          killFeed removed, tankhealth.res removed from siHealth
web/src/hud/elements.test.ts     twelve elements, five SI files, the injected card-background target exempted
web/src/hud/slots.ts             bar slots removed; panelBg now targets the injected HudEdCardBg child
web/src/hud/build.ts             never_draw, childPass, useFontCopy, fitPass (fit, state art, card background), teamLayout on gap with Free, teamPass, cardFit, cardChild, baseHasChild, teamCardRects, isFreeTeam
web/src/hud/build.test.ts        childPass, fit, card background, gap, Free, cleanups, parity extended to children, fit and every layout
web/src/hud/render.ts            splatter at 0.35, no bar-slot branch, CardState, hiddenInState, Down and Dead art, item stand-ins
web/src/hud/render.test.ts       states, splatter, item stand-ins, card background drawn, parity extended
web/src/hud/mock.ts              no kill feed painter, team cards read from the tree, HudView (state, child, card), Free hit testing, childAt, childCornerAt, outlines
web/src/hud/mock.test.ts         Free hit testing, state pass-through, child hit testing and outlines
web/src/hud/art.test.ts          children.ts added to the generator-module boundary list
web/src/hud/sample.vpkcheck.test.ts  sample (a) fitted with inside edits; sample (c) restyles the incap panel instead of a bar
web/src/routes/Hud.tsx           team controls (Layout with Free, Gap, Fit, card list), SI note, crosshair checkbox, state toggle, Free card drag, children list, child controls, child select and drag
web/src/routes/Hud.test.tsx      page tests for all of the above
```

`web/src/styles/app.css` is not changed: every new control reuses `hud__row`, `hud__row2`, `hud__field`, `hud__check`, `hud__list`, `hud__pill`, `hud__stylerow`, `hud__note` and `hud__reset`.

## Decisions this plan makes where the spec leaves a detail open

- **Migration arithmetic.** A saved teammate `spacing` is first clamped through its old range (0..400, what the old validator stored), then `gap = spacing / scale - unfitted card extent along the direction` (direction = the design's `dir`, else the preset's own), then clamped to 0..200. A design whose saved pitch was below the card size (overlapping cards) therefore moves apart by at most the overlap; the spec's "clamped at 0" makes that unavoidable.
- **Derived default gap is not clamped.** With no stored `gap`, `teamLayout` uses `base pitch - card extent` exactly, which is -10 for an unfitted stock card, so an untouched or old design keeps its exact pitch (140). The Gap slider shows `max(0, gap)`.
- **Base pitch is read along the preset's own direction** (stock row 140, Modern column 34) and applied along whichever direction the design uses.
- **Free needs its four slots.** `validateDesign` keeps `dir: 'free'` only with four valid `slots`; `teamLayout` reads a Free without four slots as the preset's own direction. Switching into Free fills `slots` only when none are stored.
- **Fit rule details.** `Voice` is placed at `x = card width - side`, `y = 0`. The splatter goes to `x 0, y 0, wide = card width, tall = round(card width / 2)`. State art with an override keeps the override field by field (`x`, `y`, side from `w`), the rest from the rule. `fitPass` does not write `TeamPlayerN` sizes: `teamPass` already owns them and now writes the fitted size, scaled (same file result as the spec's wording).
- **Items size.** The Items "Icon size" writes `fontSize` (a `HudEd_<font>_t<n>` copy) and also sets the Items label's `tall` to the same number, so the icons are not cut off and the fitted card grows with them.
- **States.** Down hides `Head`; Dead hides `Head`, `Health`, `HealthNumber` and `Items` and draws the name at half opacity; the splatter draws at 0.35 in every state; the Down number is drawn in the scheme's `HealthHurtRed` (`192 28 0 255`). `Voice` is never drawn.
- **Card background.** Flat writes `fillcolor` and ships no texture; Rounded and Image write `image hud/hudeditor/panelbg` and the texture. An Image style with no stored upload injects nothing.
- **Addable child that is off.** Edits to `HealthNumber` on stock without `on: true` are ignored by `childPass` rather than failing, so switching presets never needs to prune child overrides.
- **Child drag frame.** Child X/Y are stored (and shown) in the unfitted frame; `cardChild` reports state art where the fit rule put it, shifted back into that frame, so a drag starts where the preview draws the child. Child resize by dragging the outline's corner handle; a square child keeps its ratio (side grows by the larger of the two deltas).
- **Where controls live.** The crosshair checkbox sits in the "Custom crosshair" element panel. The fit-empty warning shows as a line in the status area of the Save panel. A selected Free card is named "Teammate card N" in the side panel.
- **tankhealth.res.** Removed from the SI list, so no stock build writes it. The Modern preset ships its own copy of that file as part of the preset (it already did); the game ignores it either way.
- **Pass order.** The spec lists `stylePass` before `fontPass`; the code runs `fontPass` first. They touch disjoint keys (image keys versus font names), so the existing order stays.

---

### Task 1: Remove the kill feed and `tankhealth.res`

**Files:**
- Modify: `web/src/hud/elements.ts`, `web/src/hud/mock.ts`, `web/src/hud/design.ts`, `web/src/routes/Hud.tsx`
- Test: `web/src/hud/elements.test.ts`, `web/src/hud/build.test.ts`, `web/src/hud/design.test.ts`, `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: `ELEMENTS`, `elementById` (`elements.ts`); `validateDesign` (`design.ts`).
- Produces: `ELEMENTS` without `killFeed`; `siHealth.children` of five files (no `tankhealth.res`); `validateDesign` drops element overrides whose id `elementById` does not know.

- [ ] **Step 1: Write the failing tests**

In `web/src/hud/elements.test.ts`, replace the first test and the "cannot move the two full-screen containers" test:

```ts
  it('has unique ids and the twelve elements', () => {
    const ids = ELEMENTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['abilityRing', 'chat', 'ghostPanel', 'infectedRow', 'ownHealth',
      'progressBar', 'siHealth', 'tankPanel', 'targetId', 'teamColumn', 'weaponSelection', 'xhair'].sort());
  });
```

```ts
  it('cannot move the full-screen target name container', () => {
    expect(elementById('targetId')!.move).toBe(false);
  });

  // Probe T1: the Tank reads hunterhealth.res, and tankhealth.res is never
  // loaded. Writing it shipped a file the game ignores.
  it('lists the five infected health files the game reads, and never tankhealth.res', () => {
    const files = elementById('siHealth')!.children;
    expect(files).toHaveLength(5);
    expect(files).not.toContain('resource/ui/hud/tankhealth.res');
  });
```

In `web/src/hud/build.test.ts`, replace "hides an element" and "scales all six infected health files together":

```ts
  it('hides an element', () => {
    const got = layoutOf(buildHud(design({ elements: { targetId: { visible: false } } })));
    expect(kvGet(kvFind(got, ['TargetID'])!, 'visible')).toBe('0');
  });
```

```ts
  it('scales the five infected health files the game reads, and never writes tankhealth.res', () => {
    const paths = buildHud(design({ elements: { siHealth: { scale: 1.2 } } })).map((f) => f.path);
    for (const n of ['boomerhealth', 'hunterhealth', 'smokerhealth', 'zombiehealthleft_large', 'zombiehealthleft_small']) {
      expect(paths).toContain(`resource/ui/hud/${n}.res`);
    }
    expect(paths).not.toContain('resource/ui/hud/tankhealth.res');
  });
```

In `web/src/hud/design.test.ts`, add inside `describe('validateDesign', ...)`:

```ts
  it('drops overrides for elements the editor no longer has', () => {
    const d = validateDesign({ v: 1, elements: { killFeed: { visible: false }, chat: { x: 5 } } });
    expect(d.elements).toEqual({ chat: { x: 5 } });
  });
```

In `web/src/routes/Hud.test.tsx`, change the nudge test that uses `killFeed`:

```ts
  it('does nothing to an element that cannot move', () => {
    expect(nudge(DEFAULT_DESIGN, 'targetId', 5, 5)).toBe(DEFAULT_DESIGN);
  });
```

and add inside `describe('Hud page', ...)`:

```ts
  it('says the infected health card is shown as the Hunter and that the Tank uses the same file', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Your infected health' }));
    expect(screen.getByText('Shown as the Hunter; the Tank uses the same file.')).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/elements.test.ts web/src/hud/build.test.ts web/src/hud/design.test.ts web/src/routes/Hud.test.tsx`
Expected: FAIL. The element list still has `killFeed`, `siHealth` has six files, `validateDesign` keeps `killFeed`, and the page has no SI note.

- [ ] **Step 3: Implement**

`web/src/hud/elements.ts`: delete the whole `killFeed` entry (the two lines starting `{ id: 'killFeed', ...`) and change `SI_HEALTH`:

```ts
/**
 * The special infected health files the game reads. The Tank reads
 * hunterhealth.res (probe T1), so tankhealth.res is never loaded and is not
 * listed: scaling it only shipped a file the game ignores.
 */
const SI_HEALTH = ['boomerhealth', 'hunterhealth', 'smokerhealth', 'zombiehealthleft_large', 'zombiehealthleft_small']
  .map((n) => `resource/ui/hud/${n}.res`);
```

`web/src/hud/mock.ts`: delete the function `paintKillFeed` and the `killFeed: paintKillFeed,` line in `PAINTERS`.

`web/src/hud/design.ts`: add `import { elementById } from './elements';` below the existing imports, and in `validateDesign` change

```ts
    if (!ID.test(id)) continue;
    const e = element(v);
```

to

```ts
    // An element the registry no longer has (the kill feed, say) has nothing to apply to.
    if (!ID.test(id) || !elementById(id)) continue;
    const e = element(v);
```

`web/src/routes/Hud.tsx`, in `ElementControls`, directly after the `{!el.move && (...)}` block, add:

```tsx
      {id === 'siHealth' && (
        <p class="muted hud__note">Shown as the Hunter; the Tank uses the same file.</p>
      )}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud web/src/routes/Hud.test.tsx && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/elements.ts web/src/hud/elements.test.ts web/src/hud/mock.ts web/src/hud/design.ts web/src/hud/design.test.ts web/src/hud/build.test.ts web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx
git commit -m "Remove the kill feed element and tankhealth.res, which the game never loads, and say so on the page"
```

---

### Task 2: Remove the Advanced bar slots and draw the splatter faintly

**Files:**
- Modify: `web/src/hud/slots.ts`, `web/src/hud/render.ts`, `web/src/hud/design.ts`, `web/src/hud/build.ts` (comment only), `web/src/routes/Hud.tsx`, `web/src/hud/sample.vpkcheck.test.ts`
- Test: `web/src/hud/render.test.ts`, `web/src/hud/build.test.ts`, `web/src/hud/design.test.ts`, `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: `SLOTS`, `drawPanel`, `validateDesign`.
- Produces: `SLOTS` without `barGreen`, `barOrange`, `barRed`, `barWhite`; `validateDesign` drops styles and images whose id is not a `SLOTS` id; `drawPanel` draws the stock teammate `BackgroundImage` at opacity `SPLATTER_ALPHA = 0.35`; the private `drawBar(ctx, r, opts)` no longer takes `design`.

- [ ] **Step 1: Write the failing tests**

In `web/src/hud/render.test.ts`, replace `recCtx` so it records alpha and honours save and restore:

```ts
/** A recording 2D context: every method the renderer calls logs its name, and save/restore keep a real alpha stack. */
function recCtx() {
  const calls: { m: string; a: unknown[]; font: string; fill: string; op: string; alpha: number }[] = [];
  const stack: number[] = [];
  // Each call snapshots ctx.font, ctx.fillStyle, the composite op and the alpha at the moment it was made, so a test can pin how a child was drawn.
  const noop = (m: string) => (...a: unknown[]) => {
    calls.push({ m, a, font: ctx.font, fill: ctx.fillStyle, op: ctx.globalCompositeOperation, alpha: ctx.globalAlpha });
  };
  const ctx = {
    canvas: { width: 853, height: 480 },
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1, lineWidth: 1,
    globalCompositeOperation: 'source-over',
    save: (...a: unknown[]) => { stack.push(ctx.globalAlpha); noop('save')(...a); },
    restore: (...a: unknown[]) => { ctx.globalAlpha = stack.pop() ?? 1; noop('restore')(...a); },
    beginPath: noop('beginPath'), rect: noop('rect'), clip: noop('clip'),
    fillRect: noop('fillRect'), strokeRect: noop('strokeRect'), fillText: noop('fillText'), drawImage: noop('drawImage'),
    setLineDash: noop('setLineDash'), moveTo: noop('moveTo'), lineTo: noop('lineTo'), stroke: noop('stroke'), fill: noop('fill'),
    arc: noop('arc'), closePath: noop('closePath'), measureText: () => ({ width: 10 }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}
```

Replace the test "draws an advanced-mode restyled bar in the design colour, as the overwritten healthbar_green does" with:

```ts
  it('draws the stock bar art whatever the styles say, since the game draws bar fills in code (probe T8)', () => {
    const green = artUrl('vgui/healthbar_green')!;
    // barGreen is a slot the editor no longer has; a raw design that still carries it changes nothing.
    const styles = { barGreen: { kind: 'flat' as const, color: '255 0 0 255' } };
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({ advanced: true, styles }), 'ownHealth', { x: 0, y: 0 }, 1);
    expect(calls.filter((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === green)).toHaveLength(1);
    expect(calls.some((c) => c.m === 'fillRect' && c.fill === 'rgba(255,0,0,1)')).toBe(false);
  });
```

Replace the test "does not draw the teammate card splatter background at full health, and leaves Modern alone" with:

```ts
  it('draws the stock teammate splatter faintly, as the game does at full health, and leaves Modern alone', () => {
    // Probe T6: the splatter shrunk to the card was faintly visible at full health. It is drawn, not hidden.
    const bg = artUrl('vgui/hud/healthbar_bg_1')!;
    const stock = recCtx();
    drawPanel(stock.ctx, design({}), 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 });
    const splatter = stock.calls.filter((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === bg);
    expect(splatter).toHaveLength(1);
    expect(splatter[0].alpha).toBeCloseTo(0.35);
    // Nothing drawn after it inherits the reduced opacity.
    expect(stock.calls.find((c) => c.m === 'fillText' && c.a[0] === 'Francis')!.alpha).toBe(1);

    const modern = recCtx();
    drawPanel(modern.ctx, design({ preset: 'modern' }), 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 });
    // Modern's ModBg paints its fillcolor background; its BackgroundImage ships visible 0.
    expect(modern.calls.some((c) => c.m === 'fillRect')).toBe(true);
  });
```

In `web/src/hud/build.test.ts`, replace "writes stock names in advanced mode":

```ts
  it('writes stock names in advanced mode', () => {
    const files = buildHud(design({ advanced: true, styles: { incapPanel: { kind: 'flat', color: '95 22 22 205' } } }));
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(
      ['materials/vgui/s_panel_biker_incap.vtf', 'materials/vgui/s_panel_biker_incap.vmt']));
  });

  it('never writes a health bar texture, since the game draws bar fills in code (probe T8)', () => {
    const files = buildHud(design({ advanced: true, styles: { barGreen: { kind: 'flat', color: '0 255 0 255' } } }));
    expect(files.some((f) => f.path.includes('healthbar_'))).toBe(false);
  });
```

and in the `buildTrees` parity test change `barGreen: { kind: 'flat', color: '255 0 0 255' }` to `incapPanel: { kind: 'flat', color: '255 0 0 255' }`.

In `web/src/hud/design.test.ts`, replace "drops oversize images" and add a slot test:

```ts
  it('drops oversize images', () => {
    const d = validateDesign({ v: 1, images: {
      panelBg: { w: 64, h: 64, png: 'AAAA' },
      incapPanel: { w: 4096, h: 64, png: 'AAAA' },
      deadPanel: { w: 64, h: 64, png: 'A'.repeat(1_500_000) },
    } });
    expect(Object.keys(d.images)).toEqual(['panelBg']);
  });

  it('drops styles and images for slots the editor no longer has', () => {
    const d = validateDesign({ v: 1,
      styles: { barGreen: { kind: 'flat' }, barWhite: { kind: 'flat' }, panelBg: { kind: 'flat' } },
      images: { barRed: { w: 8, h: 8, png: 'AAAA' } } });
    expect(Object.keys(d.styles)).toEqual(['panelBg']);
    expect(d.images).toEqual({});
  });
```

In `web/src/routes/Hud.test.tsx`, in "reveals the advanced-only style rows and switches the download button to a zip", change both `'Health bar: healthy'` references:

```ts
    expect(screen.queryByText('Incapacitated panel')).toBeNull();
```

```ts
    expect(screen.getByText('Incapacitated panel')).toBeTruthy();
    expect(screen.queryByText('Health bar: healthy')).toBeNull();
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/render.test.ts web/src/hud/build.test.ts web/src/hud/design.test.ts web/src/routes/Hud.test.tsx`
Expected: FAIL. The splatter is skipped (no drawImage), `healthbar_green.vtf` is still written for `barGreen`, the bar slot styles survive validation, and the page still lists "Health bar: healthy".

- [ ] **Step 3: Implement**

`web/src/hud/slots.ts`: delete the four entries `barGreen`, `barOrange`, `barRed`, `barWhite`, and change the header sentence

```
 * normal-mode route at all, so it must be advancedOnly.
```

so the paragraph reads:

```ts
/**
 * Style slots: one texture the player can restyle, and everywhere it has to be wired in.
 *
 * In normal mode a texture gets a new name and the .res `image` keys in
 * `targets` are pointed at it, because an addon cannot replace a texture that
 * ships in pak01. `stockNames` are the pak01 names themselves; they are only
 * written in advanced mode, where the VPK mounts ahead of pak01. A slot with
 * no targets (the weapon boxes and the incapacitated and dead panels, which
 * game code names directly) has no normal-mode route at all, so it must be
 * advancedOnly. There are no health bar slots: the game draws bar fills in
 * code and never reads the healthbar_* textures (probe T8).
 */
```

`web/src/hud/build.ts`: in the comment above `stylePass`, change "nothing needs repointing for a slot with no `targets` (the health bar fills, which the game code names directly)." to "nothing needs repointing for a slot with no `targets` (the weapon boxes and the state panels, which game code names directly)."

`web/src/hud/design.ts`: add `import { SLOTS } from './slots';` and in `validateDesign` change the two loop guards

```ts
  if (isObj(raw.styles)) for (const [id, v] of Object.entries(raw.styles)) {
    if (!ID.test(id) || !isObj(v)) continue;
```

```ts
  if (isObj(raw.images)) for (const [id, v] of Object.entries(raw.images)) {
    if (!ID.test(id) || !isObj(v)) continue;
```

to

```ts
  // A slot the editor no longer has (the removed health bar slots) has nothing to restyle.
  const isSlot = (id: string) => SLOTS.some((s) => s.id === id);
  if (isObj(raw.styles)) for (const [id, v] of Object.entries(raw.styles)) {
    if (!ID.test(id) || !isSlot(id) || !isObj(v)) continue;
```

```ts
  if (isObj(raw.images)) for (const [id, v] of Object.entries(raw.images)) {
    if (!ID.test(id) || !isSlot(id) || !isObj(v)) continue;
```

`web/src/hud/render.ts`:

1. Replace the header's last paragraph (from "The owner's in-game screenshot of the stock HUD at full health caught two" to the end of the header) with:

```ts
 * The owner's in-game screenshot of the stock HUD at full health and the
 * probe caught two things game code decides that the .res files alone do not
 * say: the teammate card's splatter background is drawn only faintly at full
 * health (isTeamColumnHealthbarBg, drawn at SPLATTER_ALPHA), and the
 * own-health panel's scratch overlays are tinted with the health colour, not
 * drawn raw (the drawColor branch in drawImageChild, below).
 */
```

2. Replace the comment above `isTeamColumnHealthbarBg` with:

```ts
/**
 * The stock teammate card's BackgroundImage is a black splatter texture
 * (hud/healthbar_bg_N, one file per team colour) sitting at zpos -1 behind
 * the whole card. Probe T6 showed it faintly at full health, so it is drawn
 * at SPLATTER_ALPHA rather than hidden. Scoped to the teamColumn panel and to
 * images actually named healthbar_bg_*, so it never touches the infected
 * card's own infected_healthbar_bg_1 background, the Hunter card's
 * pz_healthbar frame, or the Modern preset (whose teammate card paints its
 * backgrounds with fillcolor and ships BackgroundImage as visible 0).
 */
const SPLATTER_ALPHA = 0.35;
```

3. Replace `drawBar` and its comment with:

```ts
/**
 * The health bar at 100 health: the whole rect, stock green. The game draws
 * bar fills in code and never reads the healthbar_* textures (probe T8), so
 * there is nothing a design can restyle here.
 */
function drawBar(ctx: CanvasRenderingContext2D, r: ChildRect, opts: DrawOpts) {
  const img = artImage('vgui/healthbar_green', opts.onAsset);
  if (img) ctx.drawImage(img, r.x, r.y, r.w, r.h);
  else { ctx.fillStyle = 'rgba(76,217,100,0.9)'; ctx.fillRect(r.x, r.y, r.w, r.h); }
}
```

4. Replace `drawPanel` with:

```ts
export function drawPanel(ctx: CanvasRenderingContext2D, design: HudDesign, panelId: string, origin: PanelBox, k: number, opts: DrawOpts = {}): void {
  const nodes = orderedChildren(buildTrees(design)(PANEL_FILE[panelId]));
  const rects = childRects(design, panelId, origin, k);
  for (const [i, n] of nodes.entries()) {
    const r = rects[i];
    if (!r.visible || STATE_CHILDREN.has(n.key.toLowerCase())) continue;
    const alpha = isTeamColumnHealthbarBg(panelId, n) ? SPLATTER_ALPHA : 1;
    if (alpha !== 1) { ctx.save(); ctx.globalAlpha *= alpha; }
    switch (r.kind) {
      case 'image': drawImageChild(ctx, design, n, r, k, opts); break;
      case 'label': drawLabel(ctx, design, n, r, k, opts); break;
      case 'bar': drawBar(ctx, r, opts); break;
      default: break;                                                // Panel, CircularProgressBar: nothing to show
    }
    if (alpha !== 1) ctx.restore();
  }
}
```

`web/src/routes/Hud.tsx`: change the advanced note text to:

```tsx
        <p class="muted hud__note">
          Advanced mode also restyles the incapacitated and dead panels and the weapon boxes. The game only allows
          that from a folder you add to gameinfo.txt, so the download becomes a zip with instructions.
        </p>
```

`web/src/hud/sample.vpkcheck.test.ts`: change the header line "c: sample (a) again, but in advanced mode with a recoloured health bar," to "c: sample (a) again, but in advanced mode with a recoloured incapacitated panel," and in the `sample === 'c'` branch change `barGreen: { kind: 'flat', color: '120 60 200 255' }` to `incapPanel: { kind: 'flat', color: '120 60 200 255' }`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud web/src/routes/Hud.test.tsx && npm run typecheck`
Expected: PASS. `grep -rn "barGreen\|bargreen" web/src --include='*.ts' --include='*.tsx'` prints only the two test lines that pass a stale `barGreen` on purpose.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/slots.ts web/src/hud/render.ts web/src/hud/render.test.ts web/src/hud/design.ts web/src/hud/design.test.ts web/src/hud/build.ts web/src/hud/build.test.ts web/src/hud/sample.vpkcheck.test.ts web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx
git commit -m "Remove the health bar slots the game ignores and draw the teammate splatter faintly, as it shows in game"
```

---

### Task 3: Write `never_draw` to hide the game's crosshair

**Files:**
- Modify: `web/src/hud/design.ts`, `web/src/hud/build.ts`
- Test: `web/src/hud/design.test.ts`, `web/src/hud/build.test.ts`

**Interfaces:**
- Consumes: `layoutPass` (module-private in `build.ts`), `Work.panel`.
- Produces: `HudDesign.hideGameCrosshair?: boolean`, kept by `validateDesign` only when `true`; `layoutPass` writes `"never_draw" "1"` on `HudCrosshair` when it is true.

- [ ] **Step 1: Write the failing tests**

`web/src/hud/design.test.ts`, inside `describe('validateDesign', ...)`:

```ts
  it('keeps hideGameCrosshair only when it is true', () => {
    expect(validateDesign({ v: 1, hideGameCrosshair: true }).hideGameCrosshair).toBe(true);
    expect('hideGameCrosshair' in validateDesign({ v: 1, hideGameCrosshair: 'yes' })).toBe(false);
    expect('hideGameCrosshair' in validateDesign({ v: 1 })).toBe(false);
  });
```

`web/src/hud/build.test.ts`, inside `describe('buildHud, layout', ...)`:

```ts
  // Probe T2: never_draw on HudCrosshair hides the engine crosshair for both teams.
  it('writes never_draw on HudCrosshair only when the player hides the game crosshair', () => {
    const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };
    for (const preset of ['stock', 'modern'] as const) {
      const on = kvFind(layoutOf(buildHud(design({ preset, hideGameCrosshair: true }), { fonts })), ['HudCrosshair'])!;
      expect(kvGet(on, 'never_draw'), preset).toBe('1');
      const off = kvFind(layoutOf(buildHud(design({ preset }), { fonts })), ['HudCrosshair'])!;
      expect(kvGet(off, 'never_draw'), preset).toBeUndefined();
    }
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/design.test.ts web/src/hud/build.test.ts`
Expected: FAIL, `hideGameCrosshair` is not on `HudDesign` (a type error vitest reports as a failed expectation) and nothing writes `never_draw`.

- [ ] **Step 3: Implement**

`web/src/hud/design.ts`, in `interface HudDesign`, after `images: Record<string, UploadedImage>;`:

```ts
  /** Write never_draw on HudCrosshair so an image crosshair can replace the game's own (probe T2). */
  hideGameCrosshair?: boolean;
```

and in `validateDesign`, after `d.xhair = raw.xhair !== false;`:

```ts
  if (raw.hideGameCrosshair === true) d.hideGameCrosshair = true;
```

`web/src/hud/build.ts`, in `layoutPass`, after the two xHair lines (`if (!design.xhair && has) layout.splice(...)`):

```ts
  // Probe T2: the engine crosshair honours never_draw, so a player with an
  // image crosshair can hide the game's own one underneath it.
  if (design.hideGameCrosshair) kvSet(work.panel(LAYOUT, ['HudCrosshair']), 'never_draw', '1');
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/design.ts web/src/hud/design.test.ts web/src/hud/build.ts web/src/hud/build.test.ts
git commit -m "Add the option to hide the game's own crosshair with never_draw"
```

---

### Task 4: Teammate layout data: gap, fit, slots, Free, and the spacing migration

**Files:**
- Modify: `web/src/hud/design.ts`, `web/src/routes/Hud.tsx`
- Test: `web/src/hud/design.test.ts`, `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: `baseFile` (`base/index.ts`), `parseKv`, `kvFind`, `kvGet` (`kv.ts`), `elementById`.
- Produces (in `design.ts`):
  - `export type TeamDir = 'row' | 'column' | 'free'`
  - `export interface CardSlot { x: number; y: number }`
  - `ElementOverride` gains `dir?: TeamDir; gap?: number; fit?: boolean; slots?: CardSlot[]` (`spacing?` stays, for the infected row).
  - `RANGES.gap = [0, 200]`, so `clampOverride('gap', n)` works.
  - `export interface BaseTeam { dir: 'row' | 'column'; pitch: number; card: { w: number; h: number } }` and `export function baseTeam(preset: Preset): BaseTeam` (memoised per preset).
  - `DEFAULT_DESIGN.elements = { teamColumn: { fit: true } }`.
  - `validateDesign` builds `elements` only from the raw design, migrates teammate `spacing` to `gap`, keeps `fit` as a boolean, keeps `slots` only as four finite clamped entries, keeps `dir: 'free'` only with `slots`, and keeps `gap`/`fit`/`slots` only on `teamColumn`.
- Produces (in `Hud.tsx`): `export function elementsTouched(d: HudDesign): boolean`, `export function hasOverrides(d: HudDesign): boolean`, `export function resetElement(d: HudDesign, id: string): HudDesign`.

- [ ] **Step 1: Write the failing tests**

`web/src/hud/design.test.ts`: change the import to

```ts
import { DEFAULT_DESIGN, validateDesign, encodeShare, decodeShare, safeName, clampOverride, baseTeam } from './design';
```

replace "clamps numbers and drops unknown keys":

```ts
  it('clamps numbers and drops unknown keys', () => {
    const d = validateDesign({
      v: 1, preset: 'modern', evil: 1,
      elements: { teamColumn: { x: 99999, y: -99999, scale: 50, junk: true, dir: 'column', spacing: 9999 } },
    });
    expect(d.preset).toBe('modern');
    expect((d as unknown as Record<string, unknown>).evil).toBeUndefined();
    // spacing 9999 is first held to its old cap (400), then becomes the gap that keeps that pitch:
    // 400 / scale 2 - Modern's 34-unit column card = 166.
    expect(d.elements.teamColumn).toEqual({ x: 1000, y: -200, scale: 2, dir: 'column', gap: 166 });
  });
```

and add:

```ts
describe('baseTeam', () => {
  it('reads each preset card, direction and pitch from its own teamdisplayhud.res', () => {
    expect(baseTeam('stock')).toEqual({ dir: 'row', pitch: 140, card: { w: 150, h: 150 } });
    expect(baseTeam('modern')).toEqual({ dir: 'column', pitch: 34, card: { w: 120, h: 34 } });
  });
});

describe('validateDesign, the teammate layout', () => {
  const team = (preset: 'stock' | 'modern', o: Record<string, unknown>) =>
    validateDesign({ v: 1, preset, elements: { teamColumn: o } }).elements.teamColumn;

  it('migrates a saved spacing to the gap that keeps the same pitch', () => {
    // gap = spacing / scale - the unfitted card along the direction, clamped at 0.
    expect(team('stock', { dir: 'row', spacing: 140 })).toEqual({ dir: 'row', gap: 0 });   // 140 - 150, overlapping: clamped
    expect(team('stock', { dir: 'column', spacing: 180 })).toEqual({ dir: 'column', gap: 30 });
    expect(team('modern', { spacing: 40 })).toEqual({ gap: 6 });                            // Modern's own column, card 34 tall
    expect(team('modern', { dir: 'row', spacing: 130 })).toEqual({ dir: 'row', gap: 10 });  // card 120 wide
    expect(team('modern', { dir: 'column', spacing: 45, scale: 1.25 })).toEqual({ dir: 'column', scale: 1.25, gap: 2 });
  });

  it('keeps a stored gap over a stale spacing, and clamps it to 0..200', () => {
    expect(team('stock', { gap: 12, spacing: 400 })).toEqual({ gap: 12 });
    expect(team('stock', { gap: 500 })).toEqual({ gap: 200 });
    expect(team('stock', { gap: -5 })).toEqual({ gap: 0 });
  });

  it('keeps the infected row spacing as it is, and never gives it a gap, fit or slots', () => {
    const d = validateDesign({ v: 1, elements: { infectedRow: { spacing: 124, gap: 5, fit: true, slots: [] } } });
    expect(d.elements.infectedRow).toEqual({ spacing: 124 });
  });

  it('leaves fit off when a saved design has none, while a new design starts fitted', () => {
    expect(validateDesign({ v: 1 }).elements).toEqual({});
    expect(validateDesign({ v: 1, elements: { chat: { x: 5 } } }).elements.teamColumn).toBeUndefined();
    expect(DEFAULT_DESIGN.elements.teamColumn).toEqual({ fit: true });
    expect(validateDesign(null).elements.teamColumn).toEqual({ fit: true });
    expect(team('stock', { fit: false })).toEqual({ fit: false });
    expect(team('stock', { fit: 'yes' })).toBeUndefined();
  });

  it('clamps slots like element positions, and drops any set that is not four finite points', () => {
    const four = [{ x: 5000, y: -900 }, { x: 8, y: 100 }, { x: 8, y: 150 }, { x: 700, y: 100 }];
    expect(team('stock', { dir: 'free', slots: four })).toEqual({
      dir: 'free', slots: [{ x: 1000, y: -200 }, { x: 8, y: 100 }, { x: 8, y: 150 }, { x: 700, y: 100 }],
    });
    expect(team('stock', { dir: 'free', slots: four.slice(0, 3) })).toBeUndefined();
    expect(team('stock', { slots: [...four.slice(0, 3), { x: NaN, y: 1 }] })).toBeUndefined();
    // Row with slots stored keeps them, so switching back to Free restores the cards.
    expect(team('stock', { dir: 'row', slots: four })!.slots).toHaveLength(4);
  });

  it('keeps Free only on the survivor team', () => {
    expect(validateDesign({ v: 1, elements: { chat: { dir: 'free' } } }).elements.chat).toBeUndefined();
  });
});
```

`web/src/routes/Hud.test.tsx`: change the import to

```ts
import { snap, nudge, toUnits, hasOverrides, elementsTouched, resetElement } from './Hud';
```

and add:

```ts
describe('what counts as an edit', () => {
  // A fresh design already fits the teammate card, so "has elements" is not
  // "has edits": a share link must not ask to replace an untouched design.
  it('treats a fresh design as untouched and a moved element as an edit', () => {
    expect(elementsTouched(DEFAULT_DESIGN)).toBe(false);
    expect(hasOverrides(DEFAULT_DESIGN)).toBe(false);
    const moved = { ...DEFAULT_DESIGN, elements: { ...DEFAULT_DESIGN.elements, chat: { x: 5 } } };
    expect(elementsTouched(moved)).toBe(true);
    expect(hasOverrides({ ...DEFAULT_DESIGN, hideGameCrosshair: true })).toBe(true);
  });

  it('resets an element to what a fresh design has for it', () => {
    const d = { ...DEFAULT_DESIGN, elements: { teamColumn: { gap: 40 }, chat: { x: 5 } } };
    expect(resetElement(d, 'teamColumn').elements.teamColumn).toEqual({ fit: true });
    expect(resetElement(d, 'chat').elements.chat).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/design.test.ts web/src/routes/Hud.test.tsx`
Expected: FAIL, `baseTeam`, `elementsTouched`, `hasOverrides` and `resetElement` are not exported and the migration does not exist.

- [ ] **Step 3: Implement `design.ts`**

Replace the import block at the top with:

```ts
import { baseFile, type Preset } from './base';
import type { Aspect } from './units';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { elementById } from './elements';
import { SLOTS } from './slots';
```

Replace `interface ElementOverride` with:

```ts
export type TeamDir = 'row' | 'column' | 'free';
/** One Free teammate card's top-left corner on screen, in units, like an element's x/y. */
export interface CardSlot { x: number; y: number }

export interface ElementOverride {
  visible?: boolean;
  x?: number; y?: number;
  w?: number; h?: number;
  scale?: number;
  /** 'free' is the survivor team's only; validateDesign keeps it only with four `slots`. */
  dir?: TeamDir;
  /**
   * The infected row's HorizPanelSpacing, final units. The survivor team used
   * this too before `gap`; validateDesign migrates it and never keeps it there.
   */
  spacing?: number;
  /** Survivor team, Row and Column: units between two cards at scale 1. */
  gap?: number;
  /** Survivor team: shrink the card to its content. Absent means off, so a saved design renders as it was. */
  fit?: boolean;
  /** Survivor team, Free: the four cards' positions. Kept when leaving Free, so coming back restores them. */
  slots?: CardSlot[];
  /**
   * Validated and reserved, not live. The spec's own HudDesign declares these
   * three, so they are validated and clamped here and a design that carries
   * them survives a round trip, but no pass in build.ts reads any of them and
   * no registry entry in elements.ts lists them as a prop, so no control
   * writes them either.
   */
  color?: string; bg?: string;
  fontSize?: number;
}
```

Replace `DEFAULT_DESIGN` with:

```ts
/**
 * A new design, and what "Reset" returns an element to. The teammate card
 * starts fitted: a saved design without `fit` stays unfitted (validateDesign
 * never adds it), so only designs made from here on start with it.
 */
export const DEFAULT_DESIGN: HudDesign = {
  v: 1, name: 'my_hud', preset: 'stock', advanced: false, aspect: '16:9', font: 'preset',
  xhair: true, elements: { teamColumn: { fit: true } }, styles: {}, images: {},
};
```

Replace `RANGES` with:

```ts
const RANGES = {
  x: [-200, 1000], y: [-200, 680], w: [4, 853], h: [4, 480],
  scale: [0.5, 2], spacing: [0, 400], gap: [0, 200], fontSize: [6, 64],
} as const;
```

Add after `safeName`:

```ts
const TEAM_FILE = 'resource/ui/hud/teamdisplayhud.res';
export interface BaseTeam { dir: 'row' | 'column'; pitch: number; card: { w: number; h: number } }
const BASE_TEAMS = new Map<Preset, BaseTeam>();

/**
 * The survivor team as the preset's own teamdisplayhud.res lays it out: the
 * direction (a row when TeamPlayer1 and TeamPlayer2 share a ypos), the pitch
 * between their origins along it, and one card's size before any fit. Stock
 * is a row at pitch 140 of 150 x 150 cards, Modern a column at pitch 34 of
 * 120 x 34 cards. The spacing migration, the default gap and the child drag
 * clamp all start here, which is why it reads the real file, not constants.
 */
export function baseTeam(preset: Preset): BaseTeam {
  const hit = BASE_TEAMS.get(preset);
  if (hit) return hit;
  const tree = parseKv(baseFile(preset, TEAM_FILE))[0].value as KvNode[];
  const first = kvFind(tree, ['TeamPlayer1']);
  const second = kvFind(tree, ['TeamPlayer2']);
  const n = (p: KvNode | undefined, key: string, d: number) => {
    const v = parseFloat((p && kvGet(p, key)) ?? '');
    return Number.isFinite(v) ? v : d;
  };
  const dir: 'row' | 'column' = first && second && (kvGet(second, 'ypos') ?? '0') !== (kvGet(first, 'ypos') ?? '0') ? 'column' : 'row';
  const axis = dir === 'row' ? 'xpos' : 'ypos';
  const pitch = Math.abs(n(second, axis, dir === 'row' ? 140 : 45) - n(first, axis, 0));
  const out: BaseTeam = { dir, pitch, card: { w: n(first, 'wide', 150), h: n(first, 'tall', 150) } };
  BASE_TEAMS.set(preset, out);
  return out;
}

/** Four finite points, each clamped like an element's x/y, or nothing: a Free layout is all four cards or none. */
function cardSlots(v: unknown): CardSlot[] | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const out: CardSlot[] = [];
  for (const s of v) {
    if (!isObj(s) || typeof s.x !== 'number' || typeof s.y !== 'number' || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return undefined;
    out.push({ x: clampOverride('x', s.x), y: clampOverride('y', s.y) });
  }
  return out;
}

/**
 * The survivor team's own fields. `fit` is kept only as a real boolean, so a
 * design saved before fit existed stays unfitted. Free needs its four card
 * positions, so it survives only with them. A saved `spacing` (the old
 * origin-to-origin pitch, final units) becomes the `gap` that gives the same
 * pitch: held to its old 0..400 first, divided by the scale, minus the
 * unfitted card along the direction, clamped at 0. An old design therefore
 * loads where it was unless its cards overlapped.
 */
function teamFields(raw: Record<string, unknown>, out: ElementOverride, preset: Preset) {
  if (typeof raw.fit === 'boolean') out.fit = raw.fit;
  const slots = cardSlots(raw.slots);
  if (slots) out.slots = slots;
  if (raw.dir === 'free' && slots) out.dir = 'free';
  if (out.gap === undefined && typeof raw.spacing === 'number' && Number.isFinite(raw.spacing)) {
    const base = baseTeam(preset);
    const dir = out.dir === 'row' || out.dir === 'column' ? out.dir : base.dir;
    const extent = dir === 'row' ? base.card.w : base.card.h;
    out.gap = clampOverride('gap', clampOverride('spacing', raw.spacing) / (out.scale ?? 1) - extent);
  }
}
```

Replace `function element(raw: unknown)` with:

```ts
function element(id: string, raw: unknown, preset: Preset): ElementOverride {
  const out: ElementOverride = {};
  if (!isObj(raw)) return out;
  const team = id === 'teamColumn';
  if (typeof raw.visible === 'boolean') out.visible = raw.visible;
  for (const k of Object.keys(RANGES) as RangeKey[]) {
    // The survivor team's spacing is migrated to gap in teamFields; gap means nothing anywhere else.
    if ((team && k === 'spacing') || (!team && k === 'gap')) continue;
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = clampOverride(k, v);
  }
  if (raw.dir === 'row' || raw.dir === 'column') out.dir = raw.dir;
  if (team) teamFields(raw, out, preset);
  const c = colour(raw.color); if (c) out.color = c;
  const b = colour(raw.bg); if (b) out.bg = b;
  return out;
}
```

In `validateDesign`, directly after `const d: HudDesign = structuredClone(DEFAULT_DESIGN);` add

```ts
  // A stored design lists everything it changed. Starting from DEFAULT_DESIGN's
  // own elements would fit the teammate card of every design saved before fit
  // existed, and those must render exactly as they did.
  d.elements = {};
```

and change `const e = element(v);` to `const e = element(id, v, d.preset);`. (`d.preset` is set above the elements loop already, which the migration needs.)

- [ ] **Step 4: Implement the page helpers in `Hud.tsx`**

Replace the private `hasOverrides` function and its comment with:

```ts
/** Whether the elements differ from a fresh design's. Not the same as having
 *  none: a fresh design already fits the teammate card. */
export function elementsTouched(d: HudDesign): boolean {
  return JSON.stringify(d.elements) !== JSON.stringify(DEFAULT_DESIGN.elements);
}

/** Whether a design holds anything beyond the untouched defaults: decides
 *  whether loading a share link needs to ask first rather than silently
 *  overwriting whatever a reader already had going. */
export function hasOverrides(d: HudDesign): boolean {
  return elementsTouched(d)
    || Object.keys(d.styles).length > 0
    || Object.keys(d.images).length > 0
    || d.hideGameCrosshair === true
    || d.preset !== DEFAULT_DESIGN.preset
    || d.aspect !== DEFAULT_DESIGN.aspect
    || d.font !== DEFAULT_DESIGN.font
    || d.advanced !== DEFAULT_DESIGN.advanced;
}

/** "Reset this element": back to what a fresh design has for it, which for
 *  the teammates is a fitted card, not nothing. */
export function resetElement(d: HudDesign, id: string): HudDesign {
  const elements = { ...d.elements };
  const fresh = DEFAULT_DESIGN.elements[id];
  if (fresh) elements[id] = structuredClone(fresh); else delete elements[id];
  return { ...d, elements };
}
```

In `ElementControls`, replace

```ts
  const reset = () => setDesign((d) => {
    const elements = { ...d.elements };
    delete elements[id];
    return { ...d, elements };
  });
```

with

```ts
  const reset = () => setDesign((d) => resetElement(d, id));
```

In `changePreset`, replace

```ts
    if (Object.keys(design.elements).length > 0) {
```

with

```ts
    if (elementsTouched(design)) {
```

and replace

```ts
    setDesign((d) => ({ ...d, preset, ...(resetElements ? { elements: {} } : {}) }));
```

with

```ts
    setDesign((d) => ({ ...d, preset, ...(resetElements ? { elements: structuredClone(DEFAULT_DESIGN.elements) } : {}) }));
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project web web/src/hud web/src/routes && npm run typecheck`
Expected: PASS. Nothing reads `gap`, `fit` or `slots` yet, so every build and preview test is unchanged; the "names the font file" page test still passes because switching preset on a fresh design no longer asks.

- [ ] **Step 6: Commit**

```bash
git add web/src/hud/design.ts web/src/hud/design.test.ts web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx
git commit -m "Add gap, fit, Free slots and the spacing migration to the teammate layout data, and start new designs fitted"
```

---

### Task 5: The child registry and `ChildOverride` validation

**Files:**
- Create: `web/src/hud/children.ts`, `web/src/hud/children.test.ts`
- Modify: `web/src/hud/design.ts`, `web/src/hud/art.test.ts`
- Test: `web/src/hud/design.test.ts`

**Interfaces:**
- Consumes: `KvNode` (type), `baseFile`, `parseKv`, `kvFind`, `kvGet`.
- Produces (in `children.ts`):
  - `export type ChildKind = 'image' | 'label' | 'bar' | 'other'`
  - `export interface ChildDef { name: string; label: string; kind: ChildKind; role: 'content' | 'state' | 'decor'; box: 'wh' | 'square' | 'none'; move: boolean; font: boolean; colour: boolean; addable?: { template: KvNode; after: string }; note?: string }`
  - `export interface PanelChildren { panelId: string; file: string; children: ChildDef[] }`
  - `export const TEAM_PANEL: PanelChildren`, `export const PANEL_CHILDREN: PanelChildren[]`, `export function panelChildren(panelId: string): PanelChildren | undefined`, `export function teamChild(name: string): ChildDef | undefined`, `export const CONTENT_CHILDREN: string[]`, `export const FIT_SQUARED: readonly string[]`.
- Produces (in `design.ts`): `export interface ChildOverride { visible?: boolean; x?: number; y?: number; w?: number; h?: number; fontSize?: number; color?: string; on?: boolean }`; `HudDesign.children: Record<string, Record<string, ChildOverride>>` (required, `{}` in `DEFAULT_DESIGN`); `export type ChildRangeKey = 'x' | 'y' | 'w' | 'h' | 'fontSize'`; `export function clampChild(key: ChildRangeKey, value: number): number` (x, y -64..512; w, h 1..512; fontSize 6..64).

- [ ] **Step 1: Write the failing tests**

Create `web/src/hud/children.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TEAM_PANEL, PANEL_CHILDREN, CONTENT_CHILDREN, FIT_SQUARED } from './children';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { baseFile } from './base';

const card = (preset: 'stock' | 'modern') => parseKv(baseFile(preset, TEAM_PANEL.file))[0].value as KvNode[];
const scheme = (preset: 'stock' | 'modern') => parseKv(baseFile(preset, 'resource/clientscheme.res'))[0].value as KvNode[];
const CONTROL: Record<string, string> = { image: 'imagepanel', label: 'label', bar: 'healthpanel' };

/**
 * The registry names blocks in a real file, and a typo would land in a
 * player's game, so every entry is pinned to both presets' teammatepanel.res
 * the way elements.test.ts pins element keys to hudlayout.res.
 */
describe('the teammate card registry', () => {
  it('covers only the teammate card in this phase', () => {
    expect(PANEL_CHILDREN.map((p) => p.panelId)).toEqual(['teamColumn']);
    expect(TEAM_PANEL.file).toBe('resource/ui/hud/teammatepanel.res');
  });

  for (const preset of ['stock', 'modern'] as const) {
    it(`finds every child in the ${preset} card file, or the sibling an addable one goes after`, () => {
      for (const def of TEAM_PANEL.children) {
        if (def.addable) {
          expect(kvFind(card(preset), [def.addable.after]), `${preset} ${def.name} after ${def.addable.after}`).toBeDefined();
          continue;
        }
        expect(kvFind(card(preset), [def.name]), `${preset} ${def.name}`).toBeDefined();
      }
    });

    it(`matches each child's kind to its ControlName in ${preset}`, () => {
      for (const def of TEAM_PANEL.children) {
        const block = kvFind(card(preset), [def.name]) ?? def.addable!.template;
        const control = (kvGet(block, 'ControlName') ?? '').toLowerCase();
        if (def.kind === 'other') expect(Object.values(CONTROL), `${preset} ${def.name}`).not.toContain(control);
        else expect(control, `${preset} ${def.name}`).toBe(CONTROL[def.kind]);
      }
    });

    it(`gives every label child a font the ${preset} scheme defines`, () => {
      for (const def of TEAM_PANEL.children.filter((c) => c.kind === 'label')) {
        const block = kvFind(card(preset), [def.name]) ?? def.addable!.template;
        const font = kvGet(block, 'font');
        expect(font, `${preset} ${def.name}`).toBeDefined();
        expect(kvFind(scheme(preset), ['Fonts', font!]), `${preset} ${def.name} ${font}`).toBeDefined();
      }
    });

    it(`keeps every aspect-locked child square in ${preset}, or leaves it to the fit rule`, () => {
      for (const def of TEAM_PANEL.children.filter((c) => c.box === 'square')) {
        const block = kvFind(card(preset), [def.name])!;
        const square = kvGet(block, 'wide') === kvGet(block, 'tall');
        expect(square || FIT_SQUARED.includes(def.name), `${preset} ${def.name}`).toBe(true);
      }
    });
  }

  it('has the health number block only on Modern, which is why it is addable', () => {
    expect(kvFind(card('stock'), ['HealthNumber'])).toBeUndefined();
    expect(kvFind(card('modern'), ['HealthNumber'])).toBeDefined();
  });

  it('builds the fit box from exactly the steady-state children', () => {
    expect(CONTENT_CHILDREN).toEqual(['Head', 'Health', 'Name', 'HealthNumber', 'Items', 'Status']);
  });

  it('aspect-locks exactly the square game art', () => {
    expect(TEAM_PANEL.children.filter((c) => c.box === 'square').map((c) => c.name)).toEqual(['Head', 'Incapacitated', 'Dead', 'Voice']);
  });

  it('offers colour only on labels, and never on the health number, which the game colours by health', () => {
    for (const def of TEAM_PANEL.children) if (def.colour) expect(def.kind, def.name).toBe('label');
    expect(TEAM_PANEL.children.find((c) => c.name === 'HealthNumber')!.colour).toBe(false);
  });
});
```

`web/src/hud/design.test.ts`: change the import to

```ts
import { DEFAULT_DESIGN, validateDesign, encodeShare, decodeShare, safeName, clampOverride, clampChild, baseTeam } from './design';
```

and add:

```ts
describe('validateDesign, the teammate card children', () => {
  const kids = (raw: unknown) => validateDesign({ v: 1, children: raw }).children;

  it('keeps only the teammate card, only registry children, and clamps their numbers', () => {
    expect(kids({ ownHealth: { Head: { x: 1 } } })).toEqual({});
    expect(kids({ teamColumn: { Nope: { x: 1 }, Head: { x: 9999, y: -9999, junk: 1 } } }))
      .toEqual({ teamColumn: { Head: { x: 512, y: -64 } } });
  });

  it('drops each field the child does not offer', () => {
    const got = kids({ teamColumn: {
      Name: { color: '10 20 30 255', fontSize: 99, on: true },
      HealthNumber: { color: '10 20 30 255', on: true, fontSize: 14 },
      Head: { fontSize: 20, color: '1 2 3 4' },
      Items: { w: 90, h: 9, fontSize: 22, y: 20 },
      BackgroundImage: { x: 5, visible: false },
    } }).teamColumn;
    expect(got).toEqual({
      Name: { color: '10 20 30 255', fontSize: 64 },
      HealthNumber: { on: true, fontSize: 14 },
      Items: { fontSize: 22, y: 20 },
      BackgroundImage: { visible: false },
    });
  });

  it('stores square art with both sides equal, the smaller winning', () => {
    expect(kids({ teamColumn: { Head: { w: 30, h: 20 } } }).teamColumn!.Head).toEqual({ w: 20, h: 20 });
    expect(kids({ teamColumn: { Dead: { w: 30 } } }).teamColumn!.Dead).toEqual({ w: 30, h: 30 });
    expect(kids({ teamColumn: { Health: { w: 30, h: 5 } } }).teamColumn!.Health).toEqual({ w: 30, h: 5 });
  });

  it('starts a new design with no children', () => {
    expect(DEFAULT_DESIGN.children).toEqual({});
    expect(validateDesign({ v: 1 }).children).toEqual({});
  });
});

describe('clampChild', () => {
  it('clamps child numbers to their own ranges', () => {
    expect(clampChild('x', 9999)).toBe(512);
    expect(clampChild('y', -100)).toBe(-64);
    expect(clampChild('w', 0)).toBe(1);
    expect(clampChild('fontSize', 99)).toBe(64);
  });
});
```

and extend the share link round trip:

```ts
  it('carries the teammate card children through a share link', async () => {
    const d = validateDesign({ v: 1, children: { teamColumn: { HealthNumber: { on: true }, Items: { y: 20 } } } });
    expect((await decodeShare(await encodeShare(d)))!.children).toEqual(d.children);
  });
```

`web/src/hud/art.test.ts`: in the `generatorModules` array add `'children.ts'` after `'elements.ts'`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/children.test.ts web/src/hud/design.test.ts web/src/hud/art.test.ts`
Expected: FAIL, `./children` cannot be resolved and `clampChild` is not exported.

- [ ] **Step 3: Create `web/src/hud/children.ts`**

```ts
/**
 * The child registry: which blocks inside a card file the editor lets a
 * player touch, and how.
 *
 * Phase 1 covers the survivor teammate card (teammatepanel.res). One file is
 * loaded for every teammate card, so an edit here edits all of them, and game
 * code decides which teammate lands in which card (audit C.1). Every name is
 * the real block name, pinned to both presets by children.test.ts, because a
 * typo here lands in a player's game.
 *
 * Data only: design.ts validates against it, build.ts writes with it, the
 * renderer and the page read it. It imports nothing but a type.
 */
import type { KvNode } from './kv';

export type ChildKind = 'image' | 'label' | 'bar' | 'other';

export interface ChildDef {
  /** The block name in the file. */
  name: string;
  /** What the side panel calls it. */
  label: string;
  kind: ChildKind;
  /**
   * content: counts toward the fitted card. state: shown only when game code
   * says (down, dead, talking), never counted, squared by the fit rule.
   * decor: background, never counted, never a hit target on the canvas.
   */
  role: 'content' | 'state' | 'decor';
  /** Size controls: W and H, one Size for square art (aspect-locked), or none. */
  box: 'wh' | 'square' | 'none';
  /** X, Y and dragging. */
  move: boolean;
  /** Labels: a text size, written as a HudEd_<font>_t<size> copy of the label's font. */
  font: boolean;
  /** Labels: a raw colour, written as fgcolor_override. */
  colour: boolean;
  /** A child some preset's file lacks: cloned from this template after `after` when turned on. */
  addable?: { template: KvNode; after: string };
  /** Shown under the child's controls. */
  note?: string;
}

export interface PanelChildren { panelId: string; file: string; children: ChildDef[] }

const block = (key: string, pairs: [string, string][]): KvNode => ({ key, value: pairs.map(([k, v]) => ({ key: k, value: v })) });

/**
 * The Modern card's HealthNumber, placed right of the stock card's Name (x 13,
 * y 60, 120 wide), with a raw colour because a named scheme colour draws
 * nothing in some panels. The game recolours it by health anyway (probe T7).
 */
const HEALTH_NUMBER = block('HealthNumber', [
  ['ControlName', 'Label'], ['fieldName', 'HealthNumber'], ['xpos', '103'], ['ypos', '60'], ['wide', '30'], ['tall', '12'],
  ['visible', '1'], ['enabled', '1'], ['labelText', '%HealthNumber%'], ['textAlignment', 'east'],
  ['font', 'PlayerDisplayName'], ['zpos', '3'], ['fgcolor_override', '255 255 255 255'],
]);

const STATE_NOTE = 'The game decides when this one shows. Pick Down or Dead above the canvas to see it.';

export const TEAM_PANEL: PanelChildren = {
  panelId: 'teamColumn',
  file: 'resource/ui/hud/teammatepanel.res',
  children: [
    { name: 'Head', label: 'Portrait', kind: 'image', role: 'content', box: 'square', move: true, font: false, colour: false },
    { name: 'Health', label: 'Health bar', kind: 'bar', role: 'content', box: 'wh', move: true, font: false, colour: false },
    { name: 'Name', label: 'Name', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true },
    { name: 'HealthNumber', label: 'Health number', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: false,
      addable: { template: HEALTH_NUMBER, after: 'Name' }, note: 'The game colours this by health.' },
    { name: 'Items', label: 'Item icons', kind: 'label', role: 'content', box: 'none', move: true, font: true, colour: false,
      note: "The preview draws stand-in icons; the real ones are the game's." },
    { name: 'Status', label: 'Status text', kind: 'label', role: 'content', box: 'wh', move: true, font: true, colour: true },
    { name: 'BackgroundImage', label: 'Damage splatter', kind: 'image', role: 'decor', box: 'none', move: false, font: false, colour: false },
    { name: 'Incapacitated', label: 'Down picture', kind: 'image', role: 'state', box: 'square', move: true, font: false, colour: false, note: STATE_NOTE },
    { name: 'Dead', label: 'Dead picture', kind: 'image', role: 'state', box: 'square', move: true, font: false, colour: false, note: STATE_NOTE },
    { name: 'Voice', label: 'Voice icon', kind: 'other', role: 'state', box: 'square', move: true, font: false, colour: false, note: STATE_NOTE },
  ],
};

export const PANEL_CHILDREN: PanelChildren[] = [TEAM_PANEL];
export const panelChildren = (panelId: string): PanelChildren | undefined => PANEL_CHILDREN.find((p) => p.panelId === panelId);
export const teamChild = (name: string): ChildDef | undefined => TEAM_PANEL.children.find((c) => c.name === name);

/** The children whose union is the fitted card. */
export const CONTENT_CHILDREN: string[] = TEAM_PANEL.children.filter((c) => c.role === 'content').map((c) => c.name);

/**
 * Square art whose base block is not square in some preset (Modern's
 * Incapacitated is 88 x 31, its Dead 120 x 31): fitPass squares these, so
 * the registry test accepts them as covered by the fit rule.
 */
export const FIT_SQUARED: readonly string[] = ['Incapacitated', 'Dead', 'Voice'];
```

- [ ] **Step 4: Implement the design side**

`web/src/hud/design.ts`: add `import { TEAM_PANEL, type ChildDef } from './children';` to the imports. After `interface ElementOverride` add:

```ts
/**
 * One child of a card file (v2 spec, "The data model"). Numbers are unscaled,
 * in the card file's own unfitted frame: fitPass shifts them and the element's
 * scale multiplies them afterwards. Phase 1 accepts the teammate card only.
 */
export interface ChildOverride {
  visible?: boolean;
  x?: number; y?: number;
  w?: number; h?: number;
  /** Labels: the tall of a HudEd_<font>_t<size> copy of the label's font. */
  fontSize?: number;
  /** Labels: raw "r g b a", written as fgcolor_override. */
  color?: string;
  /** Addable children: present in the file or not. Absent means as the preset's file has it. */
  on?: boolean;
}
```

In `interface HudDesign`, after `images: Record<string, UploadedImage>;` add:

```ts
  /** panelId -> child name -> override. Only teamColumn in this phase. */
  children: Record<string, Record<string, ChildOverride>>;
```

In `DEFAULT_DESIGN`, change `styles: {}, images: {},` to `styles: {}, images: {}, children: {},`.

After `clampOverride` add:

```ts
const CHILD_RANGES = { x: [-64, 512], y: [-64, 512], w: [1, 512], h: [1, 512], fontSize: [6, 64] } as const;
export type ChildRangeKey = keyof typeof CHILD_RANGES;

/** clampOverride's twin for a child's numbers, shared by validateDesign and the child number boxes for the same reason. */
export function clampChild(key: ChildRangeKey, value: number): number {
  const [lo, hi] = CHILD_RANGES[key];
  return Math.min(hi, Math.max(lo, value));
}

/**
 * One child override, rebuilt field by field from what its registry entry
 * offers: a colour on the health number, a size on the item icons or a move
 * on the splatter is dropped here, so the build only ever sees edits it can
 * write. Square art keeps both sides equal, the smaller winning when a
 * hand-edited design disagrees.
 */
function childOverride(def: ChildDef, raw: unknown): ChildOverride {
  const out: ChildOverride = {};
  if (!isObj(raw)) return out;
  const n = (k: ChildRangeKey) => {
    const v = raw[k];
    return typeof v === 'number' && Number.isFinite(v) ? clampChild(k, v) : undefined;
  };
  if (typeof raw.visible === 'boolean') out.visible = raw.visible;
  if (def.move) {
    const x = n('x'), y = n('y');
    if (x !== undefined) out.x = x;
    if (y !== undefined) out.y = y;
  }
  if (def.box === 'wh') {
    const w = n('w'), h = n('h');
    if (w !== undefined) out.w = w;
    if (h !== undefined) out.h = h;
  }
  if (def.box === 'square') {
    const w = n('w'), h = n('h');
    const side = w !== undefined && h !== undefined ? Math.min(w, h) : w ?? h;
    if (side !== undefined) { out.w = side; out.h = side; }
  }
  if (def.font) { const f = n('fontSize'); if (f !== undefined) out.fontSize = f; }
  if (def.colour) { const c = colour(raw.color); if (c) out.color = c; }
  if (def.addable && typeof raw.on === 'boolean') out.on = raw.on;
  return out;
}
```

In `validateDesign`, before `return d;` add:

```ts
  const team = isObj(raw.children) ? raw.children[TEAM_PANEL.panelId] : undefined;
  if (isObj(team)) {
    const kids: Record<string, ChildOverride> = {};
    for (const [name, v] of Object.entries(team)) {
      const def = TEAM_PANEL.children.find((c) => c.name === name);
      if (!def) continue;
      const o = childOverride(def, v);
      if (Object.keys(o).length) kids[name] = o;
    }
    if (Object.keys(kids).length) d.children[TEAM_PANEL.panelId] = kids;
  }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project web web/src/hud && npm run typecheck`
Expected: PASS. If `npm run typecheck` flags an object literal typed `HudDesign` that lacks `children`, add `children: {}` to it (the test helpers spread `DEFAULT_DESIGN`, which now has it).

- [ ] **Step 6: Commit**

```bash
git add web/src/hud/children.ts web/src/hud/children.test.ts web/src/hud/design.ts web/src/hud/design.test.ts web/src/hud/art.test.ts
git commit -m "Add the teammate card child registry and validate inside edits against it"
```

---

### Task 6: `childPass`, with the font copy shared with `scalePass`

**Files:**
- Modify: `web/src/hud/build.ts`
- Test: `web/src/hud/build.test.ts`

**Interfaces:**
- Consumes: `panelChildren`, `ChildDef` (`children.ts`); `ChildOverride` (`design.ts`); `Work`, `scalePass`, `buildHud`, `buildTrees`.
- Produces: module-private `childPass(work: Work, design: HudDesign): void`, `applyChild(work, file, def, block, o)`, `useFontCopy(work: Work, leaf: KvNode, tag: string, tall: (t: number) => number): void`; `Work` gains `readonly fonts: Map<string, string | null>`; `buildHud` and `buildTrees` run `childPass` right after `layoutPass`.

- [ ] **Step 1: Write the failing tests**

In `web/src/hud/build.test.ts`, change the kv import to `import { parseKv, kvFind, kvGet, kvSet, type KvNode } from './kv';` and add after the `design` helper:

```ts
const CARD_FILE = 'resource/ui/hud/teammatepanel.res';
const TEAM_FILE = 'resource/ui/hud/teamdisplayhud.res';
const SCHEME_FILE = 'resource/clientscheme.res';
/** A file's root children as the build wrote it, or the base file when the build left it alone (as the game would read it). */
const tree = (files: { path: string; data: Uint8Array }[], path: string, preset: 'stock' | 'modern' = 'stock') =>
  parseKv(text(files, path) ?? baseFile(preset, path))[0].value as KvNode[];
const cardAt = (nodes: KvNode[], name: string) => ['xpos', 'ypos', 'wide', 'tall'].map((k) => kvGet(kvFind(nodes, [name])!, k));
```

and a new block:

```ts
describe('buildHud, childPass', () => {
  const kids = (c: Record<string, unknown>) => ({ teamColumn: c }) as HudDesign['children'];

  it('writes only the overridden keys', () => {
    const got = tree(buildHud(design({ children: kids({ Name: { x: 20 } }) })), CARD_FILE);
    const expected = parseKv(baseFile('stock', CARD_FILE))[0].value as KvNode[];
    kvSet(kvFind(expected, ['Name'])!, 'xpos', '20');
    expect(got).toEqual(expected);
  });

  it('hides a child', () => {
    const got = tree(buildHud(design({ children: kids({ Head: { visible: false } }) })), CARD_FILE);
    expect(kvGet(kvFind(got, ['Head'])!, 'visible')).toBe('0');
  });

  it('adds the health number after Name on stock, and removes it on Modern', () => {
    const stock = tree(buildHud(design({ children: kids({ HealthNumber: { on: true } }) })), CARD_FILE);
    const at = stock.findIndex((n) => n.key === 'HealthNumber');
    expect(stock[at - 1].key).toBe('Name');
    expect(cardAt(stock, 'HealthNumber')).toEqual(['103', '60', '30', '12']);
    expect(kvGet(stock[at], 'labelText')).toBe('%HealthNumber%');

    const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };
    const modern = tree(buildHud(design({ preset: 'modern', children: kids({ HealthNumber: { on: false } }) }), { fonts }), CARD_FILE, 'modern');
    expect(kvFind(modern, ['HealthNumber'])).toBeUndefined();
  });

  it('ignores edits to an addable child that is off in this preset', () => {
    const files = buildHud(design({ children: kids({ HealthNumber: { x: 5 } }) }));
    expect(kvFind(tree(files, CARD_FILE), ['HealthNumber'])).toBeUndefined();
  });

  it('writes a label colour raw', () => {
    const got = tree(buildHud(design({ children: kids({ Name: { color: '10 20 30 255' } }) })), CARD_FILE);
    expect(kvGet(kvFind(got, ['Name'])!, 'fgcolor_override')).toBe('10 20 30 255');
  });

  it('points a sized label at a HudEd_<font>_t<size> copy of its font', () => {
    const files = buildHud(design({ children: kids({ Name: { fontSize: 14 } }) }));
    expect(kvGet(kvFind(tree(files, CARD_FILE), ['Name'])!, 'font')).toBe('HudEd_PlayerDisplayName_t14');
    const copy = kvFind(tree(files, SCHEME_FILE), ['Fonts', 'HudEd_PlayerDisplayName_t14', '1'])!;
    expect(kvGet(copy, 'tall')).toBe('14');
    // Other labels on the same font keep the original.
    expect(kvGet(kvFind(tree(files, CARD_FILE), ['Status'])!, 'font')).toBe('PlayerDisplayName');
  });

  it('sizes the item icons by their font and grows the label with them', () => {
    const files = buildHud(design({ children: kids({ Items: { fontSize: 22 } }) }));
    const items = kvFind(tree(files, CARD_FILE), ['Items'])!;
    expect(kvGet(items, 'font')).toBe('HudEd_L4D_Icons_medium_t22');
    expect(kvGet(items, 'tall')).toBe('22');
  });

  // childPass writes unscaled numbers before scalePass, which multiplies them with the rest of the file.
  it('lets the element scale multiply the edited values', () => {
    const files = buildHud(design({ elements: { teamColumn: { scale: 1.5 } }, children: kids({ Name: { x: 20, fontSize: 14 } }) }));
    const name = kvFind(tree(files, CARD_FILE), ['Name'])!;
    expect(kvGet(name, 'xpos')).toBe('30');
    // scalePass collects the t14 leaf like any other font and clones it again.
    expect(kvGet(name, 'font')).toBe('HudEd_HudEd_PlayerDisplayName_t14_150');
    const copy = kvFind(tree(files, SCHEME_FILE), ['Fonts', 'HudEd_HudEd_PlayerDisplayName_t14_150', '1'])!;
    expect(kvGet(copy, 'tall')).toBe(String(Math.round(14 * 1.5)));
  });

  // The `t` in the tag: without it a size-60 label and a 0.60 scale on the same font would share one key.
  it('keeps a size-60 label and a 0.60 scale on the same font apart', () => {
    const files = buildHud(design({ elements: { teamColumn: { scale: 0.6 } }, children: kids({ Name: { fontSize: 60 } }) }));
    const fonts = kvFind(tree(files, SCHEME_FILE), ['Fonts'])!.value as KvNode[];
    expect(kvGet(kvFind(fonts, ['HudEd_PlayerDisplayName_60', '1'])!, 'tall')).toBe(String(Math.round(12 * 0.6)));
    expect(kvGet(kvFind(fonts, ['HudEd_HudEd_PlayerDisplayName_t60_60', '1'])!, 'tall')).toBe('36');
  });

  // childPass and fontPass are order independent: fontPass renames every face in the scheme, copies included.
  it('gives a sized label the chosen font', () => {
    const files = buildHud(design({ font: 'roboto', children: kids({ Name: { fontSize: 14 } }) }),
      { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } });
    const copy = kvFind(tree(files, SCHEME_FILE), ['Fonts', 'HudEd_PlayerDisplayName_t14', '1'])!;
    expect(kvGet(copy, 'name')).toBe('Roboto Condensed');
  });

  it('fails naming the file and child for an edit the child cannot take', () => {
    // validateDesign strips these; this is the guard for a design that skipped it.
    expect(() => buildHud(design({ children: kids({ HealthNumber: { on: true, color: '1 2 3 255' } }) })))
      .toThrow(/teammatepanel\.res: HealthNumber takes no colour/);
    expect(() => buildHud(design({ children: kids({ Head: { fontSize: 20 } }) })))
      .toThrow(/teammatepanel\.res: Head takes no text size/);
    expect(() => buildHud(design({ children: kids({ Nope: { x: 1 } }) })))
      .toThrow(/teammatepanel\.res: Nope is not an editable child/);
  });
});
```

In the `buildTrees` parity test, add to the design: `children: { teamColumn: { Name: { x: 20, fontSize: 14 }, Head: { visible: false } } },`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/build.test.ts`
Expected: FAIL, no pass reads `design.children`.

- [ ] **Step 3: Implement**

In `web/src/hud/build.ts`, change the design import to `import type { HudDesign, ElementOverride, ChildOverride } from './design';` and add `import { panelChildren, type ChildDef } from './children';`.

In `class Work`, after `private texts = new Map<string, string>();` add:

```ts
  /**
   * HudEd_ font copies made so far, by the copy's own name: that name, or
   * null when the scheme does not define the font. One map for the whole
   * build, shared by scalePass and childPass, so two asks for the same copy
   * never push a duplicate key into a shipped scheme.
   */
  readonly fonts = new Map<string, string | null>();
```

Add before `scalePass`:

```ts
/**
 * Point a font leaf at a HudEd_<font>_<tag> copy of its scheme entry, every
 * size's `tall` rewritten by `tall`, creating the copy the first time any
 * pass asks for that name. scalePass tags by percent (`_150`), childPass by
 * size (`_t14`); the `t` is load bearing, or a size-60 label and a 0.60 scale
 * on the same font would collide on one key with two meanings. A font the
 * scheme does not define (an icon font defined elsewhere) is left exactly as
 * the base file had it, or the child would lose its font. The scheme is only
 * pulled into the build when a leaf actually asks.
 */
function useFontCopy(work: Work, leaf: KvNode, tag: string, tall: (t: number) => number) {
  const name = leaf.value as string;
  const newName = `HudEd_${name}_${tag}`;
  if (!work.fonts.has(newName)) {
    const schemeFonts = work.panel(SCHEME, ['Fonts']);
    const src = kvFind(schemeFonts.value as KvNode[], [name]);
    if (!src) {
      work.fonts.set(newName, null);
    } else {
      const copy = structuredClone(src);
      copy.key = newName;
      for (const size of copy.value as KvNode[]) {
        if (typeof size.value === 'string') continue;
        const t = kvGet(size, 'tall');
        if (t !== undefined) kvSet(size, 'tall', String(tall(parseFloat(t))));
      }
      (schemeFonts.value as KvNode[]).push(copy);
      work.fonts.set(newName, newName);
    }
  }
  if (work.fonts.get(newName)) leaf.value = newName;
}
```

Replace `scalePass` with:

```ts
function scalePass(work: Work, design: HudDesign) {
  for (const el of ELEMENTS) {
    const k = design.elements[el.id]?.scale;
    if (el.resize !== 'scale' || k === undefined || k === 1) continue;
    const tag = String(Math.round(k * 100));
    const fontLeaves: KvNode[] = [];
    // teamPass owns a team-file element's container size and the file that
    // holds its cards, and writes both already scaled. Scaling them here too
    // would square the factor.
    if (!el.team?.file) {
      const container = work.panel(LAYOUT, [el.key]);
      for (const key of ['wide', 'tall']) { const v = kvGet(container, key); if (v !== undefined) kvSet(container, key, scaleToken(v, k)); }
    }
    for (const file of el.children) scaleBlock(work.tree(file), k, fontLeaves);
    // The generator never writes a file the design did not change: an
    // element whose children reference no font at all leaves
    // clientscheme.res alone, since useFontCopy only opens it for a leaf.
    for (const leaf of fontLeaves) useFontCopy(work, leaf, tag, (t) => Math.round(t * k));
  }
}
```

Add after `layoutPass`:

```ts
/**
 * Write the player's edits inside a card file (the v2 spec's child pass,
 * teammate card only in this phase). Values are the stored unscaled numbers,
 * written before fitPass, which fits the card around what this pass left,
 * and before scalePass, which multiplies them with the rest of the file.
 *
 * An addable child (the stock card's health number) is cloned from its
 * template after its sibling when turned on and removed when turned off. An
 * addable child that is absent and not turned on has nothing to edit yet, so
 * its other fields wait: that is what lets a design switch presets without
 * pruning. Anything else missing, or an edit the child cannot take, fails the
 * build naming the file and child, before any of it is written.
 */
function childPass(work: Work, design: HudDesign) {
  for (const [panelId, kids] of Object.entries(design.children ?? {})) {
    const panel = panelChildren(panelId);
    if (!panel) throw new Error(`No inside-editable panel ${panelId}`);
    for (const [name, o] of Object.entries(kids)) {
      const def = panel.children.find((c) => c.name === name);
      if (!def) throw new Error(`${panel.file}: ${name} is not an editable child`);
      const nodes = work.tree(panel.file);
      let block = kvFind(nodes, [name]);
      if (def.addable) {
        if (o.on === false) { if (block) nodes.splice(nodes.indexOf(block), 1); continue; }
        if (o.on === true && !block) {
          const after = def.addable.after.toLowerCase();
          const at = nodes.findIndex((n) => n.key.toLowerCase() === after);
          if (at < 0) throw new Error(`${panel.file}: no ${def.addable.after} to add ${name} after`);
          block = structuredClone(def.addable.template);
          nodes.splice(at + 1, 0, block);
        }
        if (!block) continue;
      }
      if (!block) throw new Error(`${panel.file}: no child ${name}`);
      applyChild(work, panel.file, def, block, o);
    }
  }
}

function applyChild(work: Work, file: string, def: ChildDef, block: KvNode, o: ChildOverride) {
  if (o.color !== undefined && !def.colour) throw new Error(`${file}: ${def.name} takes no colour`);
  if (o.fontSize !== undefined && !def.font) throw new Error(`${file}: ${def.name} takes no text size`);
  if (o.visible !== undefined) kvSet(block, 'visible', o.visible ? '1' : '0');
  const set = (key: string, v: number | undefined) => { if (v !== undefined) kvSet(block, key, String(Math.round(v))); };
  set('xpos', o.x); set('ypos', o.y); set('wide', o.w); set('tall', o.h);
  if (o.color !== undefined) kvSet(block, 'fgcolor_override', o.color);
  if (o.fontSize !== undefined) {
    const leaf = typeof block.value === 'string' ? undefined
      : block.value.find((n) => n.key.toLowerCase() === 'font' && typeof n.value === 'string');
    if (!leaf) throw new Error(`${file}: ${def.name} has no font`);
    const size = Math.round(o.fontSize);
    useFontCopy(work, leaf, `t${size}`, () => size);
    // The item icons are glyphs in their font with no size of their own: the
    // label's tall follows the font so the icons are not cut off and the
    // fitted card grows with them.
    if (def.box === 'none') kvSet(block, 'tall', String(size));
  }
}
```

In `buildHud` and in `buildTrees`, add `childPass(work, design);` directly after `layoutPass(work, design);`.

Replace the first line and first bullet of the comment above `buildHud`:

```
 * The pass order is not load bearing anywhere here.
 *
```

with

```
 * Where the pass order matters, and where it does not.
 *
 * - `childPass` runs after `layoutPass` and before `scalePass`: it writes the
 *   stored unscaled numbers and scalePass multiplies them with the rest of
 *   the card file. A HudEd_<font>_t<size> copy it makes is a font leaf that
 *   scalePass then clones again as HudEd_HudEd_<font>_t<size>_<pct>.
 * - `childPass` and `fontPass` are order independent, for the same reason as
 *   scalePass below: both edit the one memoised scheme tree.
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud && npm run typecheck`
Expected: PASS, including the existing scale tests (`HudEd_PlayerDisplayName_150` is unchanged).

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/build.ts web/src/hud/build.test.ts
git commit -m "Write inside edits to the teammate card file, sharing scalePass's font copies"
```

---

### Task 7: `fitPass`: fit the card, keep the content where it was, square the state art

**Files:**
- Modify: `web/src/hud/build.ts`, `web/src/hud/mock.ts`
- Test: `web/src/hud/build.test.ts`, `web/src/hud/render.test.ts`, `web/src/hud/mock.test.ts`

**Interfaces:**
- Consumes: `childPass`, `baseTeam`, `CONTENT_CHILDREN`, `TEAM_PANEL`, `ChildOverride`.
- Produces (in `build.ts`):
  - `export interface Box { x: number; y: number; w: number; h: number }`
  - `export function contentBox(nodes: KvNode[]): Box | null` (the union of the visible content children, null when all are hidden)
  - `export function cardFit(design: HudDesign): Box | null` (memoised per design; the content box after the design's child edits)
  - `export interface CardChild { x: number; y: number; w: number; h: number; visible: boolean; fontTall?: number; color?: string }` and `export function cardChild(design: HudDesign, name: string): CardChild | null`
  - `export function baseHasChild(preset: Preset, name: string): boolean`
  - module-private `fitPass(work, design)` and `fitStateArt(nodes, edits, card)`; `buildHud` and `buildTrees` run `fitPass` after `childPass`.
  - `TeamLayout` gains `offset?: { x: number; y: number }` (present with `card`) and `fitEmpty?: boolean`; `teamWrites` is true for `fit: true`; `teamPass` adds `offset` to every card position.
- Produces (in `mock.ts`): `teamCards` adds `t.offset` to each card.

- [ ] **Step 1: Write the failing tests**

In `web/src/hud/build.test.ts`, change the design helper so an "empty" design has no element overrides at all (DEFAULT_DESIGN's own fitted card has its own tests below):

```ts
/** An untouched design: no element overrides, not even DEFAULT_DESIGN's fitted teammate card, which has its own tests. */
const design = (patch: Partial<HudDesign>): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), elements: {}, ...patch });
```

Change the build import to `import { buildHud, elementRect, teamLayout, packHud, buildTrees, cardChild, baseHasChild } from './build';`. In the "gives the owner sample (a) the same four cards on screen and in the file" test, change the expected object to

```ts
    expect(teamLayout(d, elementById('teamColumn')!)).toEqual({
      dir: 'column', spacing: 36, offset: { x: 0, y: 0 }, card: { w: 187.5, h: 187.5 }, container: { w: 187.5, h: 295.5 },
    });
```

and add:

```ts
describe('buildHud, fit', () => {
  const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };
  const fitted = (preset: 'stock' | 'modern' = 'stock', children: HudDesign['children'] = {}) =>
    design({ preset, elements: { teamColumn: { fit: true } }, children });

  it('fits the stock card to 121 x 36 and shifts its content by (13, 36)', () => {
    const files = buildHud(fitted());
    const card = tree(files, CARD_FILE);
    expect(cardAt(card, 'Head')).toEqual(['0', '2', '23', '23']);
    expect(cardAt(card, 'Health')).toEqual(['24', '16', '96', '7']);
    expect(cardAt(card, 'Name')).toEqual(['0', '24', '120', '12']);
    expect(cardAt(card, 'Status')).toEqual(['51', '2', '70', '12']);
    expect(cardAt(card, 'Items')).toEqual(['26', '0', '50', '14']);
    const team = tree(files, TEAM_FILE);
    for (let n = 1; n <= 4; n++) {
      expect([kvGet(kvFind(team, [`TeamPlayer${n}`])!, 'wide'), kvGet(kvFind(team, [`TeamPlayer${n}`])!, 'tall')]).toEqual(['121', '36']);
    }
  });

  it('fits the Modern card to 113 x 26 from (3, 2)', () => {
    const files = buildHud(fitted('modern'), { fonts });
    expect(cardAt(tree(files, CARD_FILE, 'modern'), 'Head')).toEqual(['0', '1', '25', '25']);
    expect(kvGet(kvFind(tree(files, TEAM_FILE, 'modern'), ['TeamPlayer1'])!, 'wide')).toBe('113');
    expect(kvGet(kvFind(tree(files, TEAM_FILE, 'modern'), ['TeamPlayer1'])!, 'tall')).toBe('26');
  });

  for (const preset of ['stock', 'modern'] as const) {
    it(`fitting alone moves nothing on screen: ${preset}`, () => {
      const dir = preset === 'stock' ? 'row' as const : 'column' as const;
      const onScreen = (d: HudDesign) => {
        const files = buildHud(d, { fonts });
        const team = tree(files, TEAM_FILE, preset);
        const card = tree(files, CARD_FILE, preset);
        const container = kvFind(layoutOf(files), ['CHudTeamDisplay'])!;
        const out: Record<string, number[]> = { container: [kvGet(container, 'xpos'), kvGet(container, 'ypos')].map((v) => parseFloat(v!.replace(/^r/, '-'))) };
        for (let n = 1; n <= 4; n++) {
          const p = kvFind(team, [`TeamPlayer${n}`])!;
          for (const name of ['Head', 'Health', 'Name', 'Items', 'Status', 'HealthNumber']) {
            const c = kvFind(card, [name]);
            if (!c) continue;
            out[`${n} ${name}`] = [parseFloat(kvGet(p, 'xpos')!) + parseFloat(kvGet(c, 'xpos')!),
              parseFloat(kvGet(p, 'ypos')!) + parseFloat(kvGet(c, 'ypos')!)];
          }
        }
        return out;
      };
      expect(onScreen(design({ preset, elements: { teamColumn: { dir, fit: true } } })))
        .toEqual(onScreen(design({ preset, elements: { teamColumn: { dir } } })));
    });
  }

  it('re-fits when the icons move above a shorter bar', () => {
    // Head 13..36, Health now 37..85, Name 13..133 at y 60..72, Status 64..134, Items 37..87 at y 40..54: box y 38..72.
    const files = buildHud(fitted('stock', { teamColumn: { Items: { x: 37, y: 40 }, Health: { w: 48 } } }));
    expect(kvGet(kvFind(tree(files, TEAM_FILE), ['TeamPlayer1'])!, 'tall')).toBe('34');
    expect(cardAt(tree(files, CARD_FILE), 'Items').slice(0, 2)).toEqual(['24', '2']);
  });

  it('re-fits when the health number is turned on and moved past the card', () => {
    const files = buildHud(fitted('stock', { teamColumn: { HealthNumber: { on: true, x: 140 } } }));
    expect(kvGet(kvFind(tree(files, TEAM_FILE), ['TeamPlayer1'])!, 'wide')).toBe('157');
    expect(cardAt(tree(files, CARD_FILE), 'HealthNumber').slice(0, 2)).toEqual(['127', '24']);
  });

  it('squares the state art at the card height and fits the splatter to the card width', () => {
    const stock = tree(buildHud(fitted()), CARD_FILE);
    expect(cardAt(stock, 'Incapacitated')).toEqual(['0', '0', '36', '36']);
    expect(cardAt(stock, 'Dead')).toEqual(['0', '0', '36', '36']);
    expect(cardAt(stock, 'Voice')).toEqual(['105', '0', '16', '16']);
    expect(cardAt(stock, 'BackgroundImage')).toEqual(['0', '0', '121', '61']);
    const modern = tree(buildHud(fitted('modern'), { fonts }), CARD_FILE, 'modern');
    // Modern's own Incapacitated is 88 x 31 and Dead 120 x 31: the fit rule is what makes them square.
    expect(cardAt(modern, 'Incapacitated')).toEqual(['0', '0', '26', '26']);
    expect(cardAt(modern, 'Dead')).toEqual(['0', '0', '26', '26']);
    expect(cardAt(modern, 'Voice')).toEqual(['97', '0', '16', '16']);
    expect(cardAt(modern, 'BackgroundImage')).toEqual(['0', '0', '113', '57']);
    // Decoration the registry does not list is shifted like everything else; the card clips it.
    expect(cardAt(modern, 'ModBg')).toEqual(['-3', '-2', '120', '31']);
  });

  it('keeps a moved or sized state picture where the player put it, still square', () => {
    const files = buildHud(fitted('stock', { teamColumn: { Incapacitated: { x: 50, y: 40, w: 30, h: 30 } } }));
    expect(cardAt(tree(files, CARD_FILE), 'Incapacitated')).toEqual(['37', '4', '30', '30']);
  });

  it('keeps the full card and says so when every content child is hidden', () => {
    const hidden = Object.fromEntries(['Head', 'Health', 'Name', 'Items', 'Status'].map((n) => [n, { visible: false }]));
    const d = fitted('stock', { teamColumn: hidden });
    const files = buildHud(d);
    expect(kvGet(kvFind(tree(files, TEAM_FILE), ['TeamPlayer1'])!, 'wide')).toBe('150');
    expect(cardAt(tree(files, CARD_FILE), 'Head').slice(0, 2)).toEqual(['13', '38']);
    expect(teamLayout(d, elementById('teamColumn')!).fitEmpty).toBe(true);
  });

  it('leaves the card file alone when fit is off', () => {
    expect(text(buildHud(design({ elements: { teamColumn: { dir: 'row' } } })), CARD_FILE)).toBeUndefined();
  });

  it('fits DEFAULT_DESIGN, which every new design starts from', () => {
    expect(kvGet(kvFind(tree(buildHud(structuredClone(DEFAULT_DESIGN)), TEAM_FILE), ['TeamPlayer1'])!, 'wide')).toBe('121');
  });
});

describe('cardChild', () => {
  const fitted = (children: HudDesign['children'] = {}) => design({ elements: { teamColumn: { fit: true } }, children });

  it('reports a child in the unfitted frame its override is stored in', () => {
    expect(cardChild(fitted(), 'Head')).toMatchObject({ x: 13, y: 38, w: 23, h: 23, visible: true });
    expect(cardChild(design({}), 'Head')).toMatchObject({ x: 13, y: 38, w: 23, h: 23 });
  });

  it('reports the state art where the fit rule put it, so a drag starts where the preview draws it', () => {
    expect(cardChild(fitted(), 'Incapacitated')).toMatchObject({ x: 13, y: 36, w: 36, h: 36 });
    expect(cardChild(design({}), 'Incapacitated')).toMatchObject({ x: 10, y: 4, w: 96, h: 96 });
  });

  it('reports the font size, a raw colour, and nothing for an addable child that is off', () => {
    expect(cardChild(fitted(), 'HealthNumber')).toBeNull();
    expect(cardChild(fitted({ teamColumn: { HealthNumber: { on: true } } }), 'HealthNumber'))
      .toMatchObject({ x: 103, y: 60, w: 30, h: 12, fontTall: 12, color: '255 255 255 255' });
    expect(cardChild(fitted({ teamColumn: { Name: { fontSize: 14 } } }), 'Name')!.fontTall).toBe(14);
    expect(cardChild(fitted(), 'Name')!.color).toBeUndefined();                  // "White" is a scheme name, not raw
  });

  it('knows which children a preset file has', () => {
    expect(baseHasChild('stock', 'HealthNumber')).toBe(false);
    expect(baseHasChild('modern', 'HealthNumber')).toBe(true);
  });
});
```

In `web/src/hud/render.test.ts`, change the helper the same way:

```ts
/** An untouched design: no element overrides, not even DEFAULT_DESIGN's fitted teammate card. */
const design = (patch: Partial<HudDesign>): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), elements: {}, ...patch });
```

In `web/src/hud/mock.test.ts`, in "clips each panel to its real parent", replace everything from `const card = size(...)` to the end of the test with:

```ts
    const card = size('resource/ui/hud/teamdisplayhud.res', 'TeamPlayer1');
    expect(card).toEqual({ w: 121, h: 36 });                          // DEFAULT_DESIGN fits the stock card
    const team = elementRect(DEFAULT_DESIGN, 'teamColumn', DEFAULT_DESIGN.aspect);
    const cardClips = rects.filter((r) => r[2] === card.w * k && r[3] === card.h * k);
    expect(cardClips).toHaveLength(3);
    // Fitting keeps the content where it was, so the first card starts at the content's old top-left.
    expect(cardClips[0].slice(0, 2)).toEqual([(team.x + 13) * k, (team.y + 36) * k]);
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/build.test.ts web/src/hud/mock.test.ts`
Expected: FAIL, `cardChild` and `baseHasChild` are not exported and nothing fits.

- [ ] **Step 3: Implement the fit in `build.ts`**

Change the design import to `import { baseTeam, type HudDesign, type ElementOverride, type ChildOverride } from './design';` and the children import to `import { panelChildren, TEAM_PANEL, CONTENT_CHILDREN, type ChildDef } from './children';`. Add `const CARD = TEAM_PANEL.file;` next to the other path constants and:

```ts
const num = (v: string | undefined) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : 0; };
```

Add after `applyChild`:

```ts
export interface Box { x: number; y: number; w: number; h: number }

/**
 * The teammate card's content: the union of the visible steady-state
 * children (Head, Health, Name, Items, and HealthNumber and Status when
 * present). State art and decoration never count. Null when every one is
 * hidden, which fitPass treats as "keep the file's card" rather than write a
 * 0 x 0 card. On stock this is x 13..134, y 36..72: 121 x 36.
 */
export function contentBox(nodes: KvNode[]): Box | null {
  const content = new Set(CONTENT_CHILDREN.map((n) => n.toLowerCase()));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    if (typeof n.value === 'string' || !content.has(n.key.toLowerCase())) continue;
    if ((kvGet(n, 'visible') ?? '1') === '0') continue;
    const x = num(kvGet(n, 'xpos')), y = num(kvGet(n, 'ypos')), w = num(kvGet(n, 'wide')), h = num(kvGet(n, 'tall'));
    if (w <= 0 || h <= 0) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * Square the state art and fit the splatter, after the shift (the spec's
 * aspect rule). Incapacitated and Dead become squares of the card height at
 * the Head's x and y 0; Voice a square of min(height, 16) at the right edge;
 * the splatter keeps its 2:1 shape at the card width, clipped by the card.
 * A state picture the player moved or sized keeps those fields, which
 * childPass already wrote and the shift already moved into the fitted frame.
 */
function fitStateArt(nodes: KvNode[], edits: Record<string, ChildOverride>, card: { w: number; h: number }) {
  const at = (name: string) => kvFind(nodes, [name]);
  const head = at('Head');
  const headX = head ? num(kvGet(head, 'xpos')) : 0;
  const place = (name: string, side: number, x: number) => {
    const n = at(name);
    if (!n) return;
    const e = edits[name] ?? {};
    const s = String(Math.round(e.w ?? side));
    kvSet(n, 'wide', s); kvSet(n, 'tall', s);
    if (e.x === undefined) kvSet(n, 'xpos', String(x));
    if (e.y === undefined) kvSet(n, 'ypos', '0');
  };
  place('Incapacitated', card.h, headX);
  place('Dead', card.h, headX);
  const voice = Math.min(card.h, 16);
  place('Voice', voice, card.w - (edits.Voice?.w ?? voice));
  const splatter = at('BackgroundImage');
  if (splatter) {
    kvSet(splatter, 'xpos', '0'); kvSet(splatter, 'ypos', '0');
    kvSet(splatter, 'wide', String(card.w)); kvSet(splatter, 'tall', String(Math.round(card.w / 2)));
  }
}

/**
 * Shrink the teammate card to its content (probe T6: nothing is lost).
 * Every child is shifted so the content starts at the card's top-left, and
 * teamPass adds the same offset back to every card, so fitting alone moves
 * nothing on screen; only empty space goes. The card size itself is
 * teamPass's to write, from the same box through cardFit. Recomputed from
 * the tree on every build, so moving a child re-fits the card.
 */
function fitPass(work: Work, design: HudDesign) {
  if (!design.elements.teamColumn?.fit) return;
  const nodes = work.tree(CARD);
  const box = contentBox(nodes);
  if (!box) return;
  for (const n of nodes) {
    if (typeof n.value === 'string') continue;
    for (const [key, d] of [['xpos', box.x], ['ypos', box.y]] as const) {
      const v = parseFloat(kvGet(n, key) ?? '');
      if (Number.isFinite(v)) kvSet(n, key, String(v - d));
    }
  }
  fitStateArt(nodes, design.children?.teamColumn ?? {}, { w: box.w, h: box.h });
}

/**
 * childPass then fitPass on a scratch Work, once per design object, with the
 * content box taken between the two. teamLayout asks for the fitted size on
 * every repaint and the side panel for a child's numbers, and both must be
 * the build's own numbers.
 */
const CARD_WORK = new WeakMap<HudDesign, { work: Work; box: Box | null }>();
function cardWork(design: HudDesign) {
  let w = CARD_WORK.get(design);
  if (!w) {
    const work = new Work(design.preset);
    childPass(work, design);
    const box = contentBox(work.tree(CARD));
    fitPass(work, design);
    w = { work, box };
    CARD_WORK.set(design, w);
  }
  return w;
}

/** The teammate card's content box after the design's child edits, fit on or off. */
export function cardFit(design: HudDesign): Box | null {
  return cardWork(design).box;
}

export interface CardChild { x: number; y: number; w: number; h: number; visible: boolean; fontTall?: number; color?: string }

/**
 * One teammate-card child as the side panel shows it and a drag starts
 * from: after the player's edits and the fit rule, before scale, in the card
 * file's own unfitted frame, which is the frame a ChildOverride is stored
 * in. Fit only shifts content children, so for them this is the edited
 * block; for the state art it is where the fit rule put it, shifted back.
 * Null when the block is not in the file (an addable child that is off).
 */
export function cardChild(design: HudDesign, name: string): CardChild | null {
  const { work, box } = cardWork(design);
  const n = kvFind(work.tree(CARD), [name]);
  if (!n) return null;
  const shift = design.elements.teamColumn?.fit && box ? box : { x: 0, y: 0 };
  const font = kvGet(n, 'font');
  const size = font ? kvFind(work.tree(SCHEME), ['Fonts', font, '1']) : undefined;
  const tall = size ? parseFloat(kvGet(size, 'tall') ?? '') : NaN;
  const raw = kvGet(n, 'fgcolor_override');
  return {
    x: num(kvGet(n, 'xpos')) + shift.x, y: num(kvGet(n, 'ypos')) + shift.y,
    w: num(kvGet(n, 'wide')), h: num(kvGet(n, 'tall')),
    visible: (kvGet(n, 'visible') ?? '1') !== '0',
    ...(Number.isFinite(tall) ? { fontTall: tall } : {}),
    ...(raw && /^\d+ \d+ \d+ \d+$/.test(raw) ? { color: raw } : {}),
  };
}

/** Whether the preset's own card file has this child: an addable child it lacks shows as a checkbox. */
export function baseHasChild(preset: Preset, name: string): boolean {
  return kvFind(parseKv(baseFile(preset, CARD))[0].value as KvNode[], [name]) !== undefined;
}
```

In `buildHud` and `buildTrees`, add `fitPass(work, design);` directly after `childPass(work, design);`. Add to the pass-order comment above `buildHud`, after the childPass bullets:

```
 * - `fitPass` runs after `childPass` (it fits the card around what the edits
 *   left), before `teamPass` (which places and sizes the fitted card, reading
 *   the same box through cardFit) and before `scalePass` (which multiplies
 *   the shifted, still unscaled values).
```

- [ ] **Step 4: Make `teamLayout` and `teamPass` place the fitted card**

Replace `interface TeamLayout` with:

```ts
export interface TeamLayout {
  dir: 'row' | 'column';
  /**
   * Units between two neighbouring cards' origins, the element's own scale
   * already applied: the exact number `teamPass` steps each card by, and the
   * exact number the canvas steps each card by.
   */
  spacing: number;
  /**
   * Survivor team: where the first card sits inside the container, scaled.
   * Non-zero only when fitted: the fit box's top-left, so a fitted card's
   * content lands exactly where the unfitted card had it.
   */
  offset?: { x: number; y: number };
  /**
   * One teammate card, and the container that has to cover four of them, both
   * with the scale already applied. Present only when `teamWrites` is true,
   * because these are the values `teamPass` writes; an element whose team
   * geometry the generator is not rewriting has no such promise to keep, and
   * the preview falls back to the registry's `mockSize`. An element with no
   * per-player file (the infected row, whose cards the game places itself)
   * never has them.
   */
  card?: { w: number; h: number };
  container?: { w: number; h: number };
  /** Fit was asked for but every content child is hidden, so the card keeps its file size. */
  fitEmpty?: boolean;
}
```

In `teamWrites`, change the return to:

```ts
  return o.dir !== undefined || o.spacing !== undefined || o.fit === true || scaled;
```

and add to its comment: "Fitting the card does too: it changes the card's size and position."

Replace `teamLayout` with:

```ts
export function teamLayout(design: HudDesign, el: HudElement): TeamLayout {
  const o = design.elements[el.id];
  const k = el.resize === 'scale' ? o?.scale ?? 1 : 1;
  // Parsed on demand: the survivor team needs it only to size its container,
  // and this runs on every canvas repaint.
  const layoutPanel = () => kvFind(parseKv(baseFile(design.preset, LAYOUT))[0].value as KvNode[], [el.key]);
  let baseDir: 'row' | 'column' | undefined;
  let baseSpacing: number | undefined;
  let card: { w: number; h: number } | undefined;
  let offset = { x: 0, y: 0 };
  let fitEmpty = false;
  if (el.team?.file) {
    const base = baseTeam(design.preset);
    baseDir = base.dir;
    baseSpacing = base.pitch;
    // A fitted card is its content box and sits at the box's top-left, so
    // fitting alone moves nothing on screen.
    const box = o?.fit ? cardFit(design) : null;
    if (o?.fit && !box) fitEmpty = true;
    const size = box ?? base.card;
    card = { w: size.w * k, h: size.h * k };
    if (box) offset = { x: Math.round(box.x * k), y: Math.round(box.y * k) };
  } else if (el.team?.spacingKey) {
    baseDir = el.team.dirs[0];
    const panel = layoutPanel();
    const v = panel ? kvGet(panel, el.team.spacingKey) : undefined;
    if (v !== undefined) { const n = parseFloat(v); if (!Number.isNaN(n)) baseSpacing = n; }
  }
  const dir = o?.dir === 'row' || o?.dir === 'column' ? o.dir : baseDir ?? 'row';
  const spacing = Math.round(o?.spacing ?? (baseSpacing ?? (dir === 'row' ? 140 : 45)) * k);
  const out: TeamLayout = { dir, spacing };
  if (fitEmpty) out.fitEmpty = true;
  if (!card || !teamWrites(el, o)) return out;
  const panel = layoutPanel();
  if (!panel) return out;
  out.card = card;
  out.offset = offset;
  // The container clips its children, so along the direction it has to cover
  // the offset and all four cards. Across the direction it keeps its own
  // size, scaled; a fill token has no fixed size, and teamPass replaces it
  // with the offset plus one card rather than leave a column loose across
  // the whole screen.
  const tall = kvGet(panel, 'tall') ?? '0';
  out.container = dir === 'column'
    ? { w: fixedExtent(kvGet(panel, 'wide'), k) ?? offset.x + card.w, h: offset.y + spacing * 3 + card.h }
    : { w: offset.x + spacing * 3 + card.w, h: fixedExtent(tall, k) ?? parseSize(tall, SCREEN_H) };
  return out;
}
```

(The old header comment above `teamLayout` stays; `baseTeam` now supplies the base direction, pitch and card it describes.)

In `teamPass`, change

```ts
    if (!team.file || !t.card || !t.container) continue;
    for (let n = 1; n <= 4; n++) {
      const p = work.panel(team.file, [`TeamPlayer${n}`]);
      kvSet(p, 'xpos', String(t.dir === 'row' ? t.spacing * (n - 1) : 0));
      kvSet(p, 'ypos', String(t.dir === 'row' ? 0 : t.spacing * (n - 1)));
```

to

```ts
    if (!team.file || !t.card || !t.container || !t.offset) continue;
    for (let n = 1; n <= 4; n++) {
      const p = work.panel(team.file, [`TeamPlayer${n}`]);
      kvSet(p, 'xpos', String(t.offset.x + (t.dir === 'row' ? t.spacing * (n - 1) : 0)));
      kvSet(p, 'ypos', String(t.offset.y + (t.dir === 'row' ? 0 : t.spacing * (n - 1))));
```

- [ ] **Step 5: Offset the preview's cards in `mock.ts`**

In `teamCards`, change the returned map to:

```ts
  // A fitted card sits at the fit box's top-left inside the container.
  const off = t.offset ?? { x: 0, y: 0 };
  return Array.from({ length: TEAM_CARDS }, (_, i) => ({
    x: r.x + off.x * k + (t.dir === 'row' ? spacing * i : 0),
    y: r.y + off.y * k + (t.dir === 'column' ? spacing * i : 0),
    w, h,
  }));
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --project web web/src/hud web/src/routes && npm run typecheck`
Expected: PASS. The `buildTrees` parity test still compares every file, now including fitted designs through DEFAULT-free helpers; the `render.test.ts` parity test ("agrees with the downloaded file") passes because the preview reads the same fitted tree.

- [ ] **Step 7: Commit**

```bash
git add web/src/hud/build.ts web/src/hud/build.test.ts web/src/hud/render.test.ts web/src/hud/mock.ts web/src/hud/mock.test.ts
git commit -m "Fit the teammate card to its content without moving it, and square the down, dead and voice art"
```

---

### Task 8: The card background the game actually draws

**Files:**
- Modify: `web/src/hud/slots.ts`, `web/src/hud/build.ts`, `web/src/hud/mock.ts`, `web/src/hud/art.ts` (one comment)
- Test: `web/src/hud/build.test.ts`, `web/src/hud/elements.test.ts`, `web/src/hud/render.test.ts`, `web/src/hud/mock.test.ts`

**Interfaces:**
- Consumes: `fitPass`, `stylePass`, `SLOTS`, `contentBox`, `baseTeam`, `drawPanel`'s `hud/hudeditor/` and `fillcolor` branches.
- Produces: `panelBg.targets = [{ file: 'resource/ui/hud/teammatepanel.res', path: ['HudEdCardBg'], key: 'image' }]`; module-private `cardBackground(design): { fill: string } | { image: string } | null` and `cardBgBlock(bg, size): KvNode` in `build.ts`; `fitPass` injects `HudEdCardBg` first in the card file whenever `cardBackground` is not null (fit on or off); `stylePass` skips `panelBg` when the background is a fill or was not injected; `paintTeamColumn` no longer paints `panelbg` behind the card.

- [ ] **Step 1: Write the failing tests**

`web/src/hud/build.test.ts`, in `describe('buildHud, styles', ...)` replace the first three tests with:

```ts
  it('writes a new texture and points the card background at it', () => {
    const files = buildHud(design({ styles: { panelBg: { kind: 'rounded', color: '0 0 0 140' } } }));
    const paths = files.map((f) => f.path);
    expect(paths).toContain('materials/vgui/hud/hudeditor/panelbg.vtf');
    expect(paths).toContain('materials/vgui/hud/hudeditor/panelbg.vmt');
    expect(kvGet(tree(files, CARD_FILE)[0], 'image')).toBe('hud/hudeditor/panelbg');
  });

  it('uses an uploaded image when the slot asks for one', () => {
    const rgba = new Uint8ClampedArray(32 * 32 * 4).fill(7);
    const files = buildHud(design({ styles: { panelBg: { kind: 'image' } }, images: { panelBg: { w: 32, h: 32, png: 'AAAA' } } }),
      { images: { panelBg: rgba } });
    const vtf = files.find((f) => f.path.endsWith('panelbg.vtf'))!;
    expect(vtf.data.length).toBe(80 + 32 * 32 * 4);
    expect(vtf.data[80]).toBe(7);
  });

  it('never writes a stock texture name in normal mode', () => {
    const files = buildHud(design({ styles: { panelBg: { kind: 'rounded', color: '0 0 0 140' } } }));
    const materials = files.filter((f) => f.path.startsWith('materials/'));
    expect(materials.length).toBeGreaterThan(0);
    for (const f of materials) expect(f.path, f.path).toMatch(/^materials\/vgui\/hud\/hudeditor\//);
  });
```

and add a new block:

```ts
describe('buildHud, card background', () => {
  const rounded = { panelBg: { kind: 'rounded' as const, color: '0 0 0 150' } };

  it('injects HudEdCardBg first in the card file, at the fitted card size', () => {
    const card = tree(buildHud(design({ elements: { teamColumn: { fit: true } }, styles: rounded })), CARD_FILE);
    const bg = card[0];
    expect(bg.key).toBe('HudEdCardBg');
    expect(['ControlName', 'xpos', 'ypos', 'zpos', 'wide', 'tall', 'scaleImage', 'image'].map((k) => kvGet(bg, k)))
      .toEqual(['ImagePanel', '0', '0', '-2', '121', '36', '1', 'hud/hudeditor/panelbg']);
  });

  it('covers the whole file card when fit is off', () => {
    const bg = tree(buildHud(design({ styles: rounded })), CARD_FILE)[0];
    expect([kvGet(bg, 'wide'), kvGet(bg, 'tall')]).toEqual(['150', '150']);
  });

  it('draws a flat background with fillcolor and ships no texture for it', () => {
    const files = buildHud(design({ elements: { teamColumn: { fit: true } }, styles: { panelBg: { kind: 'flat' } } }));
    const bg = tree(files, CARD_FILE)[0];
    expect(kvGet(bg, 'fillcolor')).toBe('0 0 0 140');                   // the slot's default colour
    expect(kvGet(bg, 'image')).toBeUndefined();
    expect(files.some((f) => f.path.includes('panelbg'))).toBe(false);
  });

  it('scales with the card', () => {
    const files = buildHud(design({ elements: { teamColumn: { fit: true, scale: 1.5 } }, styles: rounded }));
    const bg = tree(files, CARD_FILE)[0];
    const card = kvFind(tree(files, TEAM_FILE), ['TeamPlayer1'])!;
    expect([kvGet(bg, 'wide'), kvGet(bg, 'tall')]).toEqual([kvGet(card, 'wide'), kvGet(card, 'tall')]);
  });

  // Probe T6: the card block's own image is never painted, which is why the old target did nothing.
  it('never writes the card block image', () => {
    const team = tree(buildHud(design({ elements: { teamColumn: { fit: true } }, styles: rounded })), TEAM_FILE);
    for (let n = 1; n <= 4; n++) expect(kvGet(kvFind(team, [`TeamPlayer${n}`])!, 'image')).toBe('../vgui/s_panel_background');
  });

  it('adds nothing for an Image style with no upload stored', () => {
    const files = buildHud(design({ styles: { panelBg: { kind: 'image' } } }));
    expect(text(files, CARD_FILE)).toBeUndefined();
  });
});
```

`web/src/hud/elements.test.ts`, in "points every target at a real image key in the stock file", add as the first line inside the double loop:

```ts
      // The card background is a child fitPass injects into the card file, so
      // it is in no base file; build.test.ts pins that it is written.
      if (t.path[0] === 'HudEdCardBg') continue;
```

`web/src/hud/render.test.ts`, replace "draws a restyled panel background from the design colour, not from the art" with:

```ts
  it('draws the injected card background at the card size, from the design colour', () => {
    const flat = design({ elements: { teamColumn: { fit: true } }, styles: { panelBg: { kind: 'flat', color: '255 0 0 255' } } });
    const bg = childRects(flat, 'teamColumn', { x: 5, y: 7 }, 2).find((c) => c.name === 'HudEdCardBg')!;
    expect([bg.x, bg.y, bg.w, bg.h]).toEqual([5, 7, 242, 72]);
    const a = recCtx();
    drawPanel(a.ctx, flat, 'teamColumn', { x: 5, y: 7 }, 2, { card: 0 });
    expect(a.calls.some((c) => c.m === 'fillRect' && c.fill === 'rgba(255,0,0,1)' && c.a.join() === [5, 7, 242, 72].join())).toBe(true);

    const rounded = design({ elements: { teamColumn: { fit: true } }, styles: { panelBg: { kind: 'rounded', color: '0 255 0 255' } } });
    const b = recCtx();
    drawPanel(b.ctx, rounded, 'teamColumn', { x: 5, y: 7 }, 2, { card: 0 });
    expect(b.calls.some((c) => c.m === 'fill' && c.fill === 'rgba(0,255,0,1)')).toBe(true);
  });
```

`web/src/hud/mock.test.ts`, in "draws a restyled survivor panel background behind each teammate card", replace its leading comment with:

```ts
    // The background is a child of the card file now (HudEdCardBg), so
    // drawPanel draws it from the tree, once per card, and nothing else does.
```

(its assertion of exactly three red fills stays).

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud`
Expected: FAIL in `build.test.ts` and `render.test.ts` (no `HudEdCardBg` is injected; the slot still targets `TeamPlayerN`). The mock test passes both before and after this task: before, mock.ts paints the three red fills itself; after, the card file does and mock.ts stops. If mock.ts kept painting, it would see six.

- [ ] **Step 3: Implement**

`web/src/hud/slots.ts`: replace the `team` helper and the `panelBg` entry with:

```ts
/**
 * The survivor card background. The card block's own `image`
 * (TeamPlayerN in teamdisplayhud.res) is never painted (probe T6), so the
 * slot targets a child fitPass injects into the card file instead:
 * HudEdCardBg, which exists only when this slot is restyled.
 */
const CARD_BG = { file: 'resource/ui/hud/teammatepanel.res', path: ['HudEdCardBg'], key: 'image' };
```

```ts
  { id: 'panelBg', label: 'Survivor panel background', advancedOnly: false, size: { w: 32, h: 32 },
    targets: [CARD_BG], stockNames: [], defaultColor: '0 0 0 140' },
```

`web/src/hud/build.ts`, add after `fitStateArt`:

```ts
const CARD_BG = 'HudEdCardBg';

/**
 * The panelBg style as the card background child carries it. Flat is a
 * plain fillcolor (the Modern ModBg pattern), so no texture ships; Rounded
 * and Image point at the generated texture. An Image style with no stored
 * upload has nothing to show and adds nothing. Stock adds nothing: the stock
 * s_panel_background was never painted either.
 */
function cardBackground(design: HudDesign): { fill: string } | { image: string } | null {
  const s = design.styles.panelBg;
  if (!s || s.kind === 'stock') return null;
  if (s.kind === 'image' && !design.images.panelBg) return null;
  if (s.kind === 'flat') return { fill: s.color ?? SLOTS.find((x) => x.id === 'panelBg')!.defaultColor };
  return { image: 'hud/hudeditor/panelbg' };
}

/** The background child, unscaled at the card's size: scalePass scales it with everything else in the card file. */
function cardBgBlock(bg: { fill: string } | { image: string }, size: { w: number; h: number }): KvNode {
  const pairs: [string, string][] = [
    ['ControlName', 'ImagePanel'], ['fieldName', CARD_BG], ['xpos', '0'], ['ypos', '0'], ['zpos', '-2'],
    ['wide', String(size.w)], ['tall', String(size.h)], ['visible', '1'], ['enabled', '1'],
    ...('fill' in bg ? [['fillcolor', bg.fill]] as [string, string][] : [['scaleImage', '1'], ['image', bg.image]] as [string, string][]),
  ];
  return { key: CARD_BG, value: pairs.map(([key, value]) => ({ key, value })) };
}
```

Replace `fitPass` with:

```ts
/**
 * Shrink the teammate card to its content (probe T6: nothing is lost).
 * Every child is shifted so the content starts at the card's top-left, and
 * teamPass adds the same offset back to every card, so fitting alone moves
 * nothing on screen; only empty space goes. The card size itself is
 * teamPass's to write, from the same box through cardFit. Recomputed from
 * the tree on every build, so moving a child re-fits the card.
 *
 * Then the card background: a child the card really draws, injected first
 * so it sits under everything, sized to the card after fit (or the file's
 * card when fit is off or finds nothing), visible in every state.
 */
function fitPass(work: Work, design: HudDesign) {
  const fit = design.elements.teamColumn?.fit === true;
  const bg = cardBackground(design);
  if (!fit && !bg) return;
  const nodes = work.tree(CARD);
  let size = baseTeam(design.preset).card;
  const box = fit ? contentBox(nodes) : null;
  if (box) {
    for (const n of nodes) {
      if (typeof n.value === 'string') continue;
      for (const [key, d] of [['xpos', box.x], ['ypos', box.y]] as const) {
        const v = parseFloat(kvGet(n, key) ?? '');
        if (Number.isFinite(v)) kvSet(n, key, String(v - d));
      }
    }
    size = { w: box.w, h: box.h };
    fitStateArt(nodes, design.children?.teamColumn ?? {}, size);
  }
  if (bg) nodes.unshift(cardBgBlock(bg, size));
}
```

In `stylePass`, after `if (slot.advancedOnly && !design.advanced) continue;` add:

```ts
    // The card background is a child fitPass injects: a flat one is a plain
    // fillcolor and needs no texture, and one fitPass did not inject (an
    // Image style with no upload) has nothing to point at.
    if (slot.id === 'panelBg') { const bg = cardBackground(design); if (!bg || 'fill' in bg) continue; }
```

`web/src/hud/mock.ts`, in `paintTeamColumn`, delete the three comment lines and the `drawSlotStyle(ctx, design, 'panelbg', ...)` call inside the card clip, and change the render import to `import { drawPanel } from './render';`.

`web/src/hud/art.ts`, in `NEEDED_MATERIALS`, put this comment on the line above `'vgui/s_panel_background',`:

```ts
  // Stock names this as the card block's image, which the game never paints (probe T6); kept so the index stays complete.
```

In `web/src/hud/render.test.ts`, the `drawSlotStyle` import is now unused by that file's tests: remove it from the import list.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud && npm run typecheck`
Expected: PASS. The "keeps every path lower case" test still passes with `panelBg: { kind: 'rounded' }`.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/slots.ts web/src/hud/build.ts web/src/hud/build.test.ts web/src/hud/elements.test.ts web/src/hud/render.test.ts web/src/hud/mock.ts web/src/hud/mock.test.ts
git commit -m "Draw the survivor card background as a child the card paints, since the card's own image never shows"
```

---

### Task 9: Row and Column by gap

**Files:**
- Modify: `web/src/hud/build.ts`, `web/src/routes/Hud.tsx`
- Test: `web/src/hud/build.test.ts`, `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: `baseTeam`, `cardFit`, `teamWrites`, `fixedExtent`.
- Produces: `TeamLayout` becomes `{ dir: TeamDir; spacing: number; gap?: number; offset?: { x: number; y: number }; card?: { w: number; h: number }; container?: { w: number; h: number }; cards?: { xpos: string; ypos: string }[]; fitEmpty?: boolean }`. For the survivor team `gap`, `offset`, `card` and `cards` are always present (the file's own values when nothing is written); `container` only when `teamWrites`. `spacing = round(card along the direction + gap * scale)`; `gap = o.gap ?? base pitch - card extent along the base direction`. `teamWrites` also fires on `gap`. `teamPass` writes `t.cards`. The page's teammate Spacing box becomes a Gap slider.

- [ ] **Step 1: Write the failing tests**

In `web/src/hud/build.test.ts`, replace the whole `describe('team geometry: the canvas and the file agree for any scale, dir and spacing', ...)` block with:

```ts
/**
 * The whole point of teamLayout: one function decides a team element's
 * direction, pitch, card, offset and container, the generator writes exactly
 * those numbers and elementRect reports exactly that container, so the
 * canvas cannot show a layout the downloaded file contradicts.
 */
describe('team geometry: the canvas and the file agree for any scale, dir, gap and fit', () => {
  const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };
  for (const preset of ['stock', 'modern'] as const) {
    for (const dir of ['row', 'column'] as const) {
      for (const gap of [undefined, 0, 20]) {
        for (const scale of [undefined, 0.75, 1.25]) {
          for (const fit of [false, true]) {
            const label = `${preset} ${dir} gap=${gap} scale=${scale} fit=${fit}`;
            it(label, () => {
              const o: ElementOverride = { dir };
              if (gap !== undefined) o.gap = gap;
              if (scale !== undefined) o.scale = scale;
              if (fit) o.fit = true;
              const d = design({ preset, elements: { teamColumn: o } });
              const files = buildHud(d, { fonts });
              const t = teamLayout(d, elementById('teamColumn')!);
              const rect = elementRect(d, 'teamColumn', d.aspect);
              // The pitch is one card plus the gap, both scaled.
              expect(t.spacing, label).toBe(Math.round((t.dir === 'row' ? t.card!.w : t.card!.h) + t.gap! * (scale ?? 1)));
              const team = tree(files, TEAM_FILE, preset);
              for (let n = 1; n <= 4; n++) {
                const p = kvFind(team, [`TeamPlayer${n}`])!;
                const along = t.spacing * (n - 1);
                expect(kvGet(p, 'xpos'), `${label} TeamPlayer${n} xpos`).toBe(String(t.offset!.x + (t.dir === 'row' ? along : 0)));
                expect(kvGet(p, 'ypos'), `${label} TeamPlayer${n} ypos`).toBe(String(t.offset!.y + (t.dir === 'row' ? 0 : along)));
                expect(t.cards![n - 1], `${label} TeamPlayer${n} tokens`).toEqual({ xpos: kvGet(p, 'xpos'), ypos: kvGet(p, 'ypos') });
                expect(kvGet(p, 'wide'), `${label} TeamPlayer${n} wide`).toBe(String(Math.round(t.card!.w)));
                expect(kvGet(p, 'tall'), `${label} TeamPlayer${n} tall`).toBe(String(Math.round(t.card!.h)));
              }
              // The container the preview draws is the container the file has.
              const c = kvFind(layoutOf(files), ['CHudTeamDisplay'])!;
              expect(kvGet(c, 'wide'), `${label} container wide`).toBe(String(Math.round(rect.w)));
              expect(kvGet(c, 'tall'), `${label} container tall`).toBe(String(Math.round(rect.h)));
              // And it covers all four cards, so nothing is clipped away that the canvas drew.
              if (t.dir === 'row') expect(rect.w, label).toBeGreaterThanOrEqual(t.offset!.x + t.spacing * 3 + t.card!.w);
              else expect(rect.h, label).toBeGreaterThanOrEqual(t.offset!.y + t.spacing * 3 + t.card!.h);
            });
          }
        }
      }
    }
  }

  it('lays out a fitted, scaled column as the sample does', () => {
    const d = design({ elements: { teamColumn: { scale: 1.25, dir: 'column', fit: true, gap: 4 } } });
    expect(teamLayout(d, elementById('teamColumn')!)).toEqual({
      dir: 'column', spacing: 50, gap: 4, offset: { x: 16, y: 45 }, card: { w: 151.25, h: 45 },
      container: { w: 167.25, h: 240 },
      cards: [{ xpos: '16', ypos: '45' }, { xpos: '16', ypos: '95' }, { xpos: '16', ypos: '145' }, { xpos: '16', ypos: '195' }],
    });
    const t = tree(buildHud(d), TEAM_FILE);
    expect(kvGet(kvFind(t, ['TeamPlayer1'])!, 'tall')).toBe('45');
    expect(kvGet(kvFind(t, ['TeamPlayer1'])!, 'wide')).toBe('151');
  });

  it('leaves the container at its mock size while the generator writes no team geometry', () => {
    expect(elementRect(design({}), 'teamColumn', '16:9')).toMatchObject({ w: 430, h: 75 });
    expect(teamLayout(design({}), elementById('teamColumn')!).container).toBeUndefined();
  });
});

describe('teamLayout, the gap', () => {
  const layout = (d: HudDesign) => teamLayout(d, elementById('teamColumn')!);

  it('derives the gap from the preset file when none is stored, so a new design looks like its preset', () => {
    // Stock row pitch 140: fitted card 121 leaves 19; the unfitted 150 overlaps by 10.
    expect(layout(design({ elements: { teamColumn: { fit: true } } }))).toMatchObject({ gap: 19, spacing: 140 });
    expect(layout(design({}))).toMatchObject({ gap: -10, spacing: 140 });
    // Modern column pitch 34: fitted card 26 tall leaves 8.
    expect(layout(design({ preset: 'modern', elements: { teamColumn: { fit: true } } }))).toMatchObject({ gap: 8, spacing: 34 });
  });

  it('steps a fitted stock column by the card plus the gap', () => {
    const files = buildHud(design({ elements: { teamColumn: { fit: true, dir: 'column', gap: 4 } } }));
    const team = tree(files, TEAM_FILE);
    expect([1, 2, 3, 4].map((n) => kvGet(kvFind(team, [`TeamPlayer${n}`])!, 'ypos'))).toEqual(['36', '76', '116', '156']);
    expect(kvGet(kvFind(team, ['TeamPlayer1'])!, 'xpos')).toBe('13');
    const c = kvFind(layoutOf(files), ['CHudTeamDisplay'])!;
    expect([kvGet(c, 'wide'), kvGet(c, 'tall')]).toEqual(['134', '192']);
  });

  it('gives a migrated design the pitch it had', () => {
    expect(layout(validateDesign({ v: 1, elements: { teamColumn: { dir: 'column', spacing: 180 } } })).spacing).toBe(180);
    expect(layout(validateDesign({ v: 1, preset: 'modern', elements: { teamColumn: { spacing: 45, scale: 1.25 } } })).spacing).toBe(45);
  });
});
```

Replace the two tests in `describe('teamLayout, real base-file defaults', ...)`:

```ts
  it('reads the modern preset real spacing when nothing is overridden', () => {
    const d = design({ preset: 'modern' });
    expect(teamLayout(d, elementById('teamColumn')!)).toMatchObject({ dir: 'column', spacing: 34, gap: 0 });
    expect(teamLayout(d, elementById('infectedRow')!)).toEqual({ dir: 'row', spacing: 124 });
  });

  it('reads the stock preset real spacing, not a hardcoded constant', () => {
    const teamFile = parseKv(baseFile('stock', 'resource/ui/hud/teamdisplayhud.res'))[0].value as KvNode[];
    const p1 = kvFind(teamFile, ['TeamPlayer1'])!, p2 = kvFind(teamFile, ['TeamPlayer2'])!;
    const rowGap = Math.abs(parseFloat(kvGet(p2, 'xpos')!) - parseFloat(kvGet(p1, 'xpos')!));
    const layout = parseKv(baseFile('stock', 'scripts/hudlayout.res'))[0].value as KvNode[];
    const zombieGap = parseFloat(kvGet(kvFind(layout, ['CHudZombieTeamDisplay'])!, 'HorizPanelSpacing')!);
    const d = design({});
    expect(teamLayout(d, elementById('teamColumn')!)).toMatchObject({ dir: 'row', spacing: rowGap, gap: rowGap - 150 });
    expect(teamLayout(d, elementById('infectedRow')!)).toEqual({ dir: 'row', spacing: zombieGap });
  });
```

In `describe('buildHud, team layout', ...)` replace the first three tests (they wrote `spacing` on the survivor team, which now means nothing there) with:

```ts
  it('stacks the survivor team as a column', () => {
    const t = team(buildHud(design({ elements: { teamColumn: { dir: 'column', gap: 0 } } })));
    expect([1, 2, 3, 4].map((n) => [kvGet(kvFind(t, [`TeamPlayer${n}`])!, 'xpos'), kvGet(kvFind(t, [`TeamPlayer${n}`])!, 'ypos')]))
      .toEqual([['0', '0'], ['0', '150'], ['0', '300'], ['0', '450']]);
  });

  it('lays it out as a row', () => {
    const t = team(buildHud(design({ elements: { teamColumn: { dir: 'row' } } })));
    expect(kvGet(kvFind(t, ['TeamPlayer3'])!, 'xpos')).toBe('280');
    expect(kvGet(kvFind(t, ['TeamPlayer3'])!, 'ypos')).toBe('0');
  });

  it('grows the container so a column is not clipped', () => {
    const got = layoutOf(buildHud(design({ elements: { teamColumn: { dir: 'column', gap: 10 } } })));
    expect(parseFloat(kvGet(kvFind(got, ['CHudTeamDisplay'])!, 'tall')!)).toBeGreaterThanOrEqual(3 * 160 + 150);
  });
```

In the `buildHud, bad numbers` test change `teamColumn: { scale: NaN, spacing: NaN, dir: 'column' }` to `teamColumn: { scale: NaN, gap: NaN, dir: 'column' }`. In the `buildTrees` parity test change `teamColumn: { scale: 1.5, dir: 'column', spacing: 40 }` to `teamColumn: { scale: 1.5, dir: 'column', gap: 6, fit: true }`. In the `render.test.ts` childRects test "reads every child of the teammate card from the generated file, scaled and offset" nothing changes.

`web/src/routes/Hud.test.tsx`: replace "snaps an out-of-range number box to the clamp used at download time" with:

```ts
  // design.ts's RANGES caps the infected row spacing at 400. Typing past the
  // cap must snap the design to it immediately, not just at download time:
  // otherwise the canvas would draw a value the packed file could never carry.
  it('snaps an out-of-range number box to the clamp used at download time', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Infected teammates' }));
    const spacing = screen.getByLabelText('Spacing') as HTMLInputElement;
    fireEvent.input(spacing, { target: { value: '500' } });
    expect(spacing.value).toBe('400');
  });

  it('offers a Gap slider for the teammates, starting at the gap the fitted stock row already has', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect(screen.queryByLabelText('Spacing')).toBeNull();
    const gap = screen.getByRole('slider', { name: /^Gap/ }) as HTMLInputElement;
    expect(gap.value).toBe('19');
    fireEvent.input(gap, { target: { value: '30' } });
    expect((screen.getByRole('slider', { name: /^Gap/ }) as HTMLInputElement).value).toBe('30');
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/build.test.ts web/src/routes/Hud.test.tsx`
Expected: FAIL, `teamLayout` has no `gap` or `cards` and the page still shows Spacing for the teammates.

- [ ] **Step 3: Implement `teamLayout` and `teamPass`**

In `build.ts` change the design import to `import { baseTeam, type HudDesign, type ElementOverride, type ChildOverride, type TeamDir } from './design';`.

Replace `interface TeamLayout` with:

```ts
export interface TeamLayout {
  dir: TeamDir;
  /**
   * Units from one card's origin to the next, the element's own scale
   * already applied: one card plus the gap for the survivor team, the
   * HorizPanelSpacing for the infected row, whose cards the game places.
   */
  spacing: number;
  /** Survivor team: the gap between cards at scale 1, as the Gap slider shows it. Derived values can be negative (an overlapping base file). */
  gap?: number;
  /** Survivor team: where the first card sits inside the container, scaled. Non-zero only when fitted. */
  offset?: { x: number; y: number };
  /** Survivor team: one card, scaled. */
  card?: { w: number; h: number };
  /**
   * The container that has to cover four cards, scaled. Present only when
   * `teamWrites` is true, because it is a value `teamPass` writes; otherwise
   * the preview falls back to the registry's `mockSize`.
   */
  container?: { w: number; h: number };
  /** Survivor team: the four TeamPlayerN positions as teamPass writes them. */
  cards?: { xpos: string; ypos: string }[];
  /** Fit was asked for but every content child is hidden, so the card keeps its file size. */
  fitEmpty?: boolean;
}
```

In `teamWrites`, change the return to:

```ts
  return o.dir !== undefined || o.spacing !== undefined || o.gap !== undefined || o.fit === true || scaled;
```

Replace `teamLayout` and the comment above it with:

```ts
/**
 * Everything about a team element's layout that both the generator and the
 * canvas need, in final HUD units with the element's scale already applied.
 * This is the single source of truth for team geometry: `teamPass` writes
 * exactly these numbers, `elementRect` reports exactly this container, and
 * the canvas reads the cards back from the file teamPass wrote.
 *
 * The survivor team is placed by gap, not pitch: card n sits at
 * (n - 1) * (card + gap * scale) along the direction, after the fit offset.
 * With no stored gap it is the preset file's own pitch minus its card
 * (fitted or not) along the file's own direction, so a new design looks
 * like its preset (stock fitted: 140 - 121 = 19) and an unfitted one keeps
 * its exact pitch (140 - 150 = -10, which is why this one is not clamped).
 *
 * The infected row has no per-player file: the game places its players
 * HorizPanelSpacing apart, so its spacing comes from that key on its
 * hudlayout.res panel, and a hardcoded constant is only a last resort.
 */
export function teamLayout(design: HudDesign, el: HudElement): TeamLayout {
  const o = design.elements[el.id];
  const k = el.resize === 'scale' ? o?.scale ?? 1 : 1;
  // Parsed on demand: it is needed only to size a container, and this runs on every canvas repaint.
  const layoutPanel = () => kvFind(parseKv(baseFile(design.preset, LAYOUT))[0].value as KvNode[], [el.key]);
  if (!el.team?.file) {
    const dir = el.team?.dirs[0] ?? 'row';
    let baseSpacing: number | undefined;
    if (el.team?.spacingKey) {
      const panel = layoutPanel();
      const v = panel ? kvGet(panel, el.team.spacingKey) : undefined;
      if (v !== undefined) { const n = parseFloat(v); if (!Number.isNaN(n)) baseSpacing = n; }
    }
    return { dir, spacing: Math.round(o?.spacing ?? (baseSpacing ?? (dir === 'row' ? 140 : 45)) * k) };
  }
  const base = baseTeam(design.preset);
  // A fitted card is its content box and sits at the box's top-left, so
  // fitting alone moves nothing on screen.
  const box = o?.fit ? cardFit(design) : null;
  const size = box ?? base.card;
  const card = { w: size.w * k, h: size.h * k };
  const offset = box ? { x: Math.round(box.x * k), y: Math.round(box.y * k) } : { x: 0, y: 0 };
  const dir: 'row' | 'column' = o?.dir === 'row' || o?.dir === 'column' ? o.dir : base.dir;
  const along = (d: 'row' | 'column', c: { w: number; h: number }) => (d === 'row' ? c.w : c.h);
  const gap = o?.gap ?? base.pitch - along(base.dir, size);
  const spacing = Math.round(along(dir, card) + gap * k);
  const cards = [0, 1, 2, 3].map((i) => ({
    xpos: String(offset.x + (dir === 'row' ? spacing * i : 0)),
    ypos: String(offset.y + (dir === 'column' ? spacing * i : 0)),
  }));
  const out: TeamLayout = { dir, spacing, gap, offset, card, cards };
  if (o?.fit && !box) out.fitEmpty = true;
  if (!teamWrites(el, o)) return out;
  const panel = layoutPanel();
  if (!panel) return out;
  // The container clips its children, so along the direction it has to cover
  // the offset and all four cards. Across the direction it keeps its own
  // size, scaled; a fill token has no fixed size, and teamPass replaces it
  // with the offset plus one card rather than leave a column loose across
  // the whole screen.
  const tall = kvGet(panel, 'tall') ?? '0';
  out.container = dir === 'column'
    ? { w: fixedExtent(kvGet(panel, 'wide'), k) ?? offset.x + card.w, h: offset.y + spacing * 3 + card.h }
    : { w: offset.x + spacing * 3 + card.w, h: fixedExtent(tall, k) ?? parseSize(tall, SCREEN_H) };
  return out;
}
```

In `teamPass`, replace

```ts
    if (!team.file || !t.card || !t.container || !t.offset) continue;
    for (let n = 1; n <= 4; n++) {
      const p = work.panel(team.file, [`TeamPlayer${n}`]);
      kvSet(p, 'xpos', String(t.offset.x + (t.dir === 'row' ? t.spacing * (n - 1) : 0)));
      kvSet(p, 'ypos', String(t.offset.y + (t.dir === 'row' ? 0 : t.spacing * (n - 1))));
```

with

```ts
    if (!team.file || !t.card || !t.container || !t.cards) continue;
    for (let n = 1; n <= 4; n++) {
      const p = work.panel(team.file, [`TeamPlayer${n}`]);
      kvSet(p, 'xpos', t.cards[n - 1].xpos);
      kvSet(p, 'ypos', t.cards[n - 1].ypos);
```

In `mock.ts`, `teamCards` needs no change: `t.card` is now always present for the survivor team, `t.offset` too, and the positions are the same numbers.

- [ ] **Step 4: Implement the page's Gap slider**

In `Hud.tsx`, replace `TeamControls` (and its comment) with:

```tsx
/**
 * Layout controls for a team element. The survivor team's cards step by the
 * Gap between them (0 to 200, units at scale 1); the infected row, whose
 * cards the game places itself, keeps its single spacing number. Column is
 * offered only when the registry says the element supports it.
 */
function TeamControls(
  { design, el, patch }: { design: HudDesign; el: HudElement; patch: Patch },
) {
  if (!el.team) return null;
  const t = teamLayout(design, el);
  return (
    <>
      <label class="hud__row">
        <span>Layout</span>
        <select
          value={t.dir}
          onChange={(e) => patch({ dir: (e.target as HTMLSelectElement).value as 'row' | 'column' })}
        >
          <option value="row">Row</option>
          {el.team.dirs.includes('column') && <option value="column">Column</option>}
        </select>
        <span />
      </label>
      {el.team.file ? (
        <Slider
          label="Gap" value={Math.max(0, Math.round(t.gap ?? 0))} min={0} max={200} step={1}
          onInput={(gap) => patch({ gap: clampOverride('gap', gap) })}
        />
      ) : (
        <label class="hud__row">
          <span>Spacing</span>
          <input
            type="number" value={t.spacing}
            onInput={(e) => patchNum(patch, e, 'spacing', (n) => ({ spacing: n }))}
          />
          <span />
        </label>
      )}
    </>
  );
}
```

and change its use in `ElementControls` to `<TeamControls design={design} el={el} patch={patch} />`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project web web/src/hud web/src/routes && npm run typecheck`
Expected: PASS (the geometry matrix is 72 cases).

- [ ] **Step 6: Commit**

```bash
git add web/src/hud/build.ts web/src/hud/build.test.ts web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx
git commit -m "Lay the teammate cards out by the gap between them instead of a pitch, with a Gap slider"
```

---

### Task 10: Free layout

**Files:**
- Modify: `web/src/hud/build.ts`
- Test: `web/src/hud/build.test.ts`

**Interfaces:**
- Consumes: `teamLayout`, `teamPass`, `elementRect`, `buildTrees`, `formatPos`, `parsePos`, `screenW`.
- Produces: `teamLayout` returns `dir: 'free'` when `o.dir === 'free'` and four `slots` exist, with `cards` = each slot formatted with `formatPos` (card size, `screenW(design.aspect)`, `SCREEN_H`), and `container = { w: screenW(design.aspect), h: SCREEN_H }`; `teamPass` in Free writes the container `xpos 0`, `ypos 0`, `wide f0`, `tall f0`; `elementRect` in Free returns `{ x: 0, y: 0, w: screenW(aspect), h: SCREEN_H, visible }`; `export function teamCardRects(design: HudDesign, aspect: Aspect): { x: number; y: number; w: number; h: number }[]` (four screen rects read from the generated `teamdisplayhud.res`); `export function isFreeTeam(design: HudDesign): boolean`.

- [ ] **Step 1: Write the failing tests**

In `web/src/hud/build.test.ts`, change the build import to add `teamCardRects, isFreeTeam`, and add:

```ts
const FOUR = [{ x: 8, y: 100 }, { x: 8, y: 150 }, { x: 700, y: 100 }, { x: 400, y: 440 }];

describe('buildHud, Free', () => {
  const free = (patch: Partial<ElementOverride> = {}) =>
    design({ elements: { teamColumn: { fit: true, dir: 'free', slots: FOUR, ...patch } } });

  it('writes the full-screen container and four anchored card positions', () => {
    const files = buildHud(free());
    const c = kvFind(layoutOf(files), ['CHudTeamDisplay'])!;
    expect(['xpos', 'ypos', 'wide', 'tall'].map((k) => kvGet(c, k))).toEqual(['0', '0', 'f0', 'f0']);
    const team = tree(files, TEAM_FILE);
    // Anchors follow each card's centre, like an element's: left third plain, middle third c, right third r.
    expect([1, 2, 3, 4].map((n) => [kvGet(kvFind(team, [`TeamPlayer${n}`])!, 'xpos'), kvGet(kvFind(team, [`TeamPlayer${n}`])!, 'ypos')]))
      .toEqual([['8', '100'], ['8', 'c-90'], ['r153', '100'], ['c-26', 'r40']]);
    expect(kvGet(kvFind(team, ['TeamPlayer1'])!, 'wide')).toBe('121');
  });

  it('reports the full screen as the container and each card where its slot is', () => {
    const d = free();
    expect(elementRect(d, 'teamColumn', '16:9')).toMatchObject({ x: 0, y: 0, w: 853, h: 480 });
    const cards = teamCardRects(d, '16:9');
    expect(cards.slice(0, 3)).toEqual([
      { x: 8, y: 100, w: 121, h: 36 }, { x: 8, y: 150, w: 121, h: 36 }, { x: 700, y: 100, w: 121, h: 36 },
    ]);
    expect(Math.abs(cards[3].x - 400)).toBeLessThanOrEqual(0.5);          // c-26 on an odd-width screen
    // A right-anchored card stays at the right edge on another aspect.
    expect(teamCardRects(d, '4:3')[2].x).toBe(640 - 153);
  });

  it('keeps the slots while in Row, so switching back to Free restores the cards', () => {
    const row = design({ elements: { teamColumn: { fit: true, dir: 'row', slots: FOUR } } });
    expect(kvGet(kvFind(tree(buildHud(row), TEAM_FILE), ['TeamPlayer1'])!, 'xpos')).toBe('13');
    expect(isFreeTeam(row)).toBe(false);
    const back = validateDesign({ v: 1, elements: { teamColumn: { ...row.elements.teamColumn, dir: 'free' } } });
    expect(isFreeTeam(back)).toBe(true);
    expect(kvGet(kvFind(tree(buildHud(back), TEAM_FILE), ['TeamPlayer1'])!, 'xpos')).toBe('8');
  });

  it('reads a Free without four slots as the preset direction', () => {
    const d = design({ elements: { teamColumn: { dir: 'free' } } });
    expect(teamLayout(d, elementById('teamColumn')!).dir).toBe('row');
  });

  it('reads the row cards from the file the same way', () => {
    expect(teamCardRects(design({ elements: { teamColumn: { fit: true } } }), '16:9')).toEqual([
      { x: 13, y: 441, w: 121, h: 36 }, { x: 153, y: 441, w: 121, h: 36 },
      { x: 293, y: 441, w: 121, h: 36 }, { x: 433, y: 441, w: 121, h: 36 },
    ]);
  });
});
```

In the `buildTrees` parity test, wrap the design in a loop over the three layouts: replace

```ts
      it(`returns every file the preview reads exactly as buildHud writes it: ${preset}${advanced ? ', advanced' : ''}`, () => {
        const d = design({ preset, advanced,
          elements: { ownHealth: { scale: 1.25 }, siHealth: { scale: 0.8 }, infectedRow: { scale: 1.3 },
            teamColumn: { scale: 1.5, dir: 'column', gap: 6, fit: true } },
```

with

```ts
      for (const dir of ['row', 'column', 'free'] as const) it(`returns every file the preview reads exactly as buildHud writes it: ${preset} ${dir}${advanced ? ', advanced' : ''}`, () => {
        const d = design({ preset, advanced,
          elements: { ownHealth: { scale: 1.25 }, siHealth: { scale: 0.8 }, infectedRow: { scale: 1.3 },
            teamColumn: { scale: 1.5, dir, gap: 6, fit: true, slots: FOUR } },
```

(the test body and its closing `});` are unchanged; `FOUR` is defined above this describe block).

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/build.test.ts`
Expected: FAIL, `teamCardRects` and `isFreeTeam` are not exported and `dir: 'free'` lays out as a row.

- [ ] **Step 3: Implement**

`build.ts` already imports `parsePos`, `formatPos`, `screenW`, `SCREEN_H` and `type Aspect` from `./units`, and `num` exists since Task 7. In `teamLayout`, replace

```ts
  const dir: 'row' | 'column' = o?.dir === 'row' || o?.dir === 'column' ? o.dir : base.dir;
  const along = (d: 'row' | 'column', c: { w: number; h: number }) => (d === 'row' ? c.w : c.h);
  const gap = o?.gap ?? base.pitch - along(base.dir, size);
  const spacing = Math.round(along(dir, card) + gap * k);
  const cards = [0, 1, 2, 3].map((i) => ({
    xpos: String(offset.x + (dir === 'row' ? spacing * i : 0)),
    ypos: String(offset.y + (dir === 'column' ? spacing * i : 0)),
  }));
```

with

```ts
  // Free needs its four card positions; without them it is the preset's own direction.
  const free = o?.dir === 'free' && o.slots?.length === 4;
  const flow: 'row' | 'column' = o?.dir === 'row' || o?.dir === 'column' ? o.dir : base.dir;
  const dir: TeamDir = free ? 'free' : flow;
  const along = (d: 'row' | 'column', c: { w: number; h: number }) => (d === 'row' ? c.w : c.h);
  const gap = o?.gap ?? base.pitch - along(base.dir, size);
  const spacing = Math.round(along(flow, card) + gap * k);
  // In Free each card carries its own position, written with the same anchor
  // tokens elements use, so a card placed at the right edge stays there on
  // another aspect ratio. The container covers the screen, so the tokens
  // resolve against the screen.
  const cards = free
    ? o!.slots!.map((s) => ({ xpos: formatPos(s.x, card.w, screenW(design.aspect)), ypos: formatPos(s.y, card.h, SCREEN_H) }))
    : [0, 1, 2, 3].map((i) => ({
      xpos: String(offset.x + (flow === 'row' ? spacing * i : 0)),
      ypos: String(offset.y + (flow === 'column' ? spacing * i : 0)),
    }));
```

and replace

```ts
  const tall = kvGet(panel, 'tall') ?? '0';
  out.container = dir === 'column'
```

with

```ts
  if (free) { out.container = { w: screenW(design.aspect), h: SCREEN_H }; return out; }
  const tall = kvGet(panel, 'tall') ?? '0';
  out.container = dir === 'column'
```

In `teamPass`, after the four-card loop and before `kvSet(container, 'wide', ...)`, add:

```ts
    if (t.dir === 'free') {
      // The probe's setting: the container covers the screen and each card
      // carries its own anchored position.
      kvSet(container, 'xpos', '0'); kvSet(container, 'ypos', '0');
      kvSet(container, 'wide', 'f0'); kvSet(container, 'tall', 'f0');
      continue;
    }
```

In `elementRect`, after the line `const visible = o.visible ?? (kvGet(panel, 'visible') ?? '1') !== '0';` add:

```ts
  // In Free the container covers the screen and each card places itself.
  if (el.team?.file && teamLayout(design, el).dir === 'free') return { x: 0, y: 0, w: screenW(aspect), h: SCREEN_H, visible };
```

Add after `elementRect`:

```ts
/**
 * The four teammate cards on screen, in HUD units at `aspect`, read from the
 * generated teamdisplayhud.res and the container elementRect reports: where
 * the canvas draws each card, what hit testing and a Free drag use, and
 * what switching into Free copies into `slots`. Reading the file, not
 * teamLayout, is what keeps the picture the file.
 */
export function teamCardRects(design: HudDesign, aspect: Aspect): { x: number; y: number; w: number; h: number }[] {
  const c = elementRect(design, 'teamColumn', aspect);
  const team = buildTrees(design)('resource/ui/hud/teamdisplayhud.res');
  return [1, 2, 3, 4].map((n) => {
    const p = kvFind(team, [`TeamPlayer${n}`]);
    if (!p) throw new Error(`resource/ui/hud/teamdisplayhud.res: no panel TeamPlayer${n}`);
    return {
      x: c.x + parsePos(kvGet(p, 'xpos') ?? '0', c.w), y: c.y + parsePos(kvGet(p, 'ypos') ?? '0', c.h),
      w: num(kvGet(p, 'wide')), h: num(kvGet(p, 'tall')),
    };
  });
}

/** Whether the survivor team is laid out Free: the element's own X, Y and drag give way to each card's. */
export function isFreeTeam(design: HudDesign): boolean {
  return teamLayout(design, elementById('teamColumn')!).dir === 'free';
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/build.ts web/src/hud/build.test.ts
git commit -m "Add the Free teammate layout: a full-screen container and four anchored cards"
```

---

### Task 11: The Healthy / Down / Dead preview and the item stand-ins

**Files:**
- Modify: `web/src/hud/render.ts`
- Test: `web/src/hud/render.test.ts`

**Interfaces:**
- Consumes: `drawPanel`, `drawImageChild`, `drawLabel`, `drawBar`, `artImage`, `colourOf`, `fontFace`.
- Produces: `export type CardState = 'healthy' | 'down' | 'dead'`; `DrawOpts` gains `state?: CardState`; `export function hiddenInState(panelId: string, name: string, state: CardState): boolean`; `drawPanel` hides per state, draws `Incapacitated` with the character's `_incap` art and `Dead` with `vgui/s_panel_dead`, draws the bar red and the number `299` in `HealthHurtRed` when down, dims the name when dead, and draws the item stand-ins.

- [ ] **Step 1: Write the failing tests**

In `web/src/hud/render.test.ts`, change the import to `import { childRects, drawPanel, PANEL_FILE, hiddenInState, _setImageFactory, _setCanvasFactory, _resetAssetCache } from './render';` and add:

```ts
describe('the teammate card states', () => {
  const fitted = (children: HudDesign['children'] = {}) => design({ elements: { teamColumn: { fit: true } }, children });
  const srcs = (calls: { m: string; a: unknown[] }[]) =>
    calls.filter((c) => c.m === 'drawImage').map((c) => (c.a[0] as HTMLImageElement).src);
  const imageAt = (calls: { m: string; a: unknown[] }[], url: string) =>
    calls.find((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === url);

  it('Healthy draws the portrait and never the down or dead art', () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, fitted(), 'teamColumn', { x: 0, y: 0 }, 1, { card: 1 });
    expect(srcs(calls)).toContain(artUrl('vgui/s_panel_manager'));
    expect(srcs(calls)).not.toContain(artUrl('vgui/s_panel_manager_incap'));
    expect(srcs(calls)).not.toContain(artUrl('vgui/s_panel_dead'));
  });

  it("Down draws the character's incap art square at the card height, a red bar and 299 in red, and no portrait", () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, fitted({ teamColumn: { HealthNumber: { on: true } } }), 'teamColumn', { x: 10, y: 20 }, 2, { card: 1, state: 'down' });
    // Stock fitted: a 36-unit square at the card's top-left (the Head's x, which fit moved to 0), at k = 2.
    expect(imageAt(calls, artUrl('vgui/s_panel_manager_incap')!)!.a.slice(1)).toEqual([10, 20, 72, 72]);
    expect(srcs(calls)).not.toContain(artUrl('vgui/s_panel_manager'));
    expect(srcs(calls)).toContain(artUrl('vgui/healthbar_red'));
    expect(srcs(calls)).not.toContain(artUrl('vgui/healthbar_green'));
    const number = calls.find((c) => c.m === 'fillText' && c.a[0] === '299')!;
    expect(number.fill).toBe('rgba(192,28,0,1)');                       // the scheme's HealthHurtRed
  });

  it('Dead draws the dead art square, dims the name, and draws no bar, number, portrait or icons', () => {
    const d = fitted({ teamColumn: { HealthNumber: { on: true } } });
    const items = childRects(d, 'teamColumn', { x: 10, y: 20 }, 2).find((c) => c.name === 'Items')!;
    const { ctx, calls } = recCtx();
    drawPanel(ctx, d, 'teamColumn', { x: 10, y: 20 }, 2, { card: 1, state: 'dead' });
    expect(imageAt(calls, artUrl('vgui/s_panel_dead')!)!.a.slice(1)).toEqual([10, 20, 72, 72]);
    expect(srcs(calls).some((s) => /healthbar_(green|red)/.test(s))).toBe(false);
    expect(srcs(calls)).not.toContain(artUrl('vgui/s_panel_manager'));
    expect(calls.some((c) => c.m === 'fillText' && (c.a[0] === '100' || c.a[0] === '299'))).toBe(false);
    expect(calls.find((c) => c.m === 'fillText' && c.a[0] === 'Louis')!.alpha).toBeCloseTo(0.5);
    expect(calls.some((c) => c.m === 'strokeRect' && c.a[0] === items.x)).toBe(false);
  });

  it('hides by state only on the teammate card', () => {
    expect(hiddenInState('teamColumn', 'Head', 'down')).toBe(true);
    expect(hiddenInState('teamColumn', 'Incapacitated', 'down')).toBe(false);
    expect(hiddenInState('ownHealth', 'Incapacitated', 'down')).toBe(true);
    expect(hiddenInState('teamColumn', 'Voice', 'healthy')).toBe(true);
  });

  it('draws stand-in item icons one font size tall where the Items label sits', () => {
    const d = design({});
    const r = childRects(d, 'teamColumn', { x: 0, y: 0 }, 1).find((c) => c.name === 'Items')!;
    const { ctx, calls } = recCtx();
    drawPanel(ctx, d, 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 });
    // L4D_Icons_medium is 18 tall in the stock scheme; the label box is 14, so the icons centre on it.
    expect(calls.filter((c) => c.m === 'strokeRect').map((c) => c.a)).toContainEqual([r.x, r.y + (r.h - 18) / 2, 18, 18]);
  });
});
```

and extend the preview-equals-file guarantee with a new test in `describe('childRects', ...)`:

```ts
  it('agrees with the downloaded file for the teammate card with fit, inside edits, a background and every layout', () => {
    const FOUR = [{ x: 8, y: 100 }, { x: 8, y: 150 }, { x: 700, y: 100 }, { x: 400, y: 440 }];
    for (const preset of ['stock', 'modern'] as const) {
      for (const dir of ['row', 'column', 'free'] as const) {
        const d = design({ preset,
          elements: { teamColumn: { fit: true, scale: 1.25, dir, gap: 6, slots: FOUR } },
          children: { teamColumn: { Head: { w: 30, h: 30 }, Items: { y: 20, fontSize: 22 }, HealthNumber: { on: true, x: 110 }, Incapacitated: { x: 40 } } },
          styles: { panelBg: { kind: 'rounded', color: '0 0 0 150' } } });
        const files = buildHud(d, { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } });
        const nodes = (parseKv(text(files, PANEL_FILE.teamColumn))[0].value as KvNode[]).filter((n) => typeof n.value !== 'string');
        const rects = childRects(d, 'teamColumn', { x: 0, y: 0 }, 1);
        expect(rects.length, `${preset} ${dir}`).toBe(nodes.length);
        for (const n of nodes) {
          const r = rects.find((c) => c.name === n.key)!;
          expect([r.x, r.y, r.w, r.h], `${preset} ${dir} ${n.key}`)
            .toEqual(['xpos', 'ypos', 'wide', 'tall'].map((key) => parseFloat(kvGet(n, key) ?? '0') || 0));
        }
      }
    }
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/render.test.ts`
Expected: FAIL, `hiddenInState` is not exported and no state is drawn. (The new childRects parity test passes on arrival: it pins what Tasks 6 to 10 built.)

- [ ] **Step 3: Implement in `render.ts`**

Replace `export interface DrawOpts ...` with:

```ts
/** The teammate card state the preview shows. Game code picks it at runtime; the page lets the player pick it. */
export type CardState = 'healthy' | 'down' | 'dead';
export interface DrawOpts { card?: number; onAsset?: () => void; state?: CardState }
```

After `STATE_CHILDREN` add:

```ts
/**
 * What the teammate card shows in each preview state, beyond what visible 0
 * hides. Game code decides this at runtime; these are a best reading of the
 * probe screenshots (a down teammate's portrait gives way to the
 * incapacitated art, a dead one keeps only the dead art and a dimmed name),
 * and the owner corrects them after seeing them. Voice shows only while
 * someone talks, so it is never drawn.
 */
const TEAM_HIDDEN: Record<CardState, ReadonlySet<string>> = {
  healthy: new Set(['incapacitated', 'dead', 'voice']),
  down: new Set(['head', 'dead', 'voice']),
  dead: new Set(['head', 'incapacitated', 'voice', 'health', 'healthnumber', 'items']),
};

/** Whether the preview leaves a child out in this state. Every panel but the teammate card shows the healthy, alive state. */
export function hiddenInState(panelId: string, name: string, state: CardState): boolean {
  const n = name.toLowerCase();
  return panelId === 'teamColumn' ? TEAM_HIDDEN[state].has(n) : STATE_CHILDREN.has(n);
}

/** A dead teammate's name stays on the card, dimmed. */
const DEAD_NAME_ALPHA = 0.5;
```

After `OWN_PORTRAIT` add:

```ts
const portraitFor = (opts: DrawOpts) => (opts.card === undefined ? OWN_PORTRAIT : CARD_PORTRAITS[opts.card % CARD_PORTRAITS.length]);
```

In `drawImageChild`, replace the `Head` branch's material line

```ts
    const material = opts.card === undefined ? OWN_PORTRAIT : CARD_PORTRAITS[opts.card % CARD_PORTRAITS.length];
```

with `const material = portraitFor(opts);`, and add directly after the `Head` branch:

```ts
  if (lname === 'incapacitated' || lname === 'dead') {
    // Game code picks this art too: the character's own _incap panel, or the
    // one dead panel. Drawn stretched to the rect, as scaleImage 1 has the
    // game draw it, which is why the fit rule keeps the rect square.
    const material = lname === 'dead' ? 'vgui/s_panel_dead' : `${portraitFor(opts)}_incap`;
    const img = artImage(material, opts.onAsset);
    if (!img) { if (missing.has(material)) hatch(ctx, r); return; }
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
    return;
  }
```

In `sampleText`, change `if (t === '%HealthNumber%') return '100';` to:

```ts
  if (t === '%HealthNumber%') return opts.state === 'down' ? '299' : '100';   // down, the number is the incap health (probe T7)
```

Add before `drawLabel`:

```ts
/**
 * The teammate's item icons are glyphs in a Valve icon font the page cannot
 * ship, so the preview draws two neutral outlines in their place, a medkit
 * and a pill bottle, each one icon tall at the label's font size: enough to
 * see where the row sits and how big it is.
 */
function drawItemStandIns(ctx: CanvasRenderingContext2D, design: HudDesign, n: KvNode, r: ChildRect, k: number) {
  const s = fontFace(design, kvGet(n, 'font') ?? '').tall * k;
  const y = r.y + (r.h - s) / 2;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = Math.max(1, s / 12);
  ctx.strokeRect(r.x, y, s, s);                                     // medkit
  ctx.beginPath();
  ctx.moveTo(r.x + s / 2, y + s * 0.25); ctx.lineTo(r.x + s / 2, y + s * 0.75);
  ctx.moveTo(r.x + s * 0.25, y + s / 2); ctx.lineTo(r.x + s * 0.75, y + s / 2);
  ctx.stroke();
  ctx.strokeRect(r.x + s * 1.25, y + s * 0.2, s * 0.5, s * 0.8);     // pill bottle
  ctx.restore();
}
```

In `drawLabel`, make the first lines:

```ts
function drawLabel(ctx: CanvasRenderingContext2D, design: HudDesign, n: KvNode, r: ChildRect, k: number, opts: DrawOpts) {
  if (n.key.toLowerCase() === 'items') { drawItemStandIns(ctx, design, n, r, k); return; }
  const s = sampleText(n, opts);
```

and replace `ctx.fillStyle = colourOf(design, kvGet(n, 'fgcolor_override'));` with:

```ts
  // Down, the game draws a teammate's number in red at the incap health (probe T7).
  const downNumber = opts.state === 'down' && n.key.toLowerCase() === 'healthnumber';
  ctx.fillStyle = colourOf(design, downNumber ? 'HealthHurtRed' : kvGet(n, 'fgcolor_override'));
```

Replace `drawBar` with:

```ts
/**
 * The health bar: the whole rect, stock green at 100 health, or red at the
 * incap sample when the preview shows a down teammate. The game draws bar
 * fills in code and never reads the healthbar_* textures (probe T8), so
 * there is nothing a design can restyle here.
 */
function drawBar(ctx: CanvasRenderingContext2D, r: ChildRect, opts: DrawOpts) {
  const down = opts.state === 'down';
  const img = artImage(down ? 'vgui/healthbar_red' : 'vgui/healthbar_green', opts.onAsset);
  if (img) ctx.drawImage(img, r.x, r.y, r.w, r.h);
  else { ctx.fillStyle = down ? 'rgba(192,28,0,0.9)' : 'rgba(76,217,100,0.9)'; ctx.fillRect(r.x, r.y, r.w, r.h); }
}
```

Replace `drawPanel` with:

```ts
export function drawPanel(ctx: CanvasRenderingContext2D, design: HudDesign, panelId: string, origin: PanelBox, k: number, opts: DrawOpts = {}): void {
  const state = opts.state ?? 'healthy';
  const nodes = orderedChildren(buildTrees(design)(PANEL_FILE[panelId]));
  const rects = childRects(design, panelId, origin, k);
  for (const [i, n] of nodes.entries()) {
    const r = rects[i];
    const lname = n.key.toLowerCase();
    if (!r.visible || hiddenInState(panelId, lname, state)) continue;
    let alpha = 1;
    if (isTeamColumnHealthbarBg(panelId, n)) alpha = SPLATTER_ALPHA;
    if (panelId === 'teamColumn' && state === 'dead' && lname === 'name') alpha = DEAD_NAME_ALPHA;
    if (alpha !== 1) { ctx.save(); ctx.globalAlpha *= alpha; }
    switch (r.kind) {
      case 'image': drawImageChild(ctx, design, n, r, k, opts); break;
      case 'label': drawLabel(ctx, design, n, r, k, opts); break;
      case 'bar': drawBar(ctx, r, opts); break;
      default: break;                                                // Panel, CircularProgressBar: nothing to show
    }
    if (alpha !== 1) ctx.restore();
  }
}
```

Add to the file header, after the paragraph starting "The preview shows the healthy, alive state":

```ts
 * The teammate card is the exception: the page can ask for the Down or Dead
 * state (DrawOpts.state), and each state draws what the game shows in it,
 * still from the same generated tree, so fitted, squared state art shows
 * exactly as the file will make the game draw it.
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud && npm run typecheck`
Expected: PASS, including the existing "never draws the state children the game controls" (healthy is the default).

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/render.ts web/src/hud/render.test.ts
git commit -m "Preview the teammate card healthy, down or dead, and draw stand-ins for the item icons"
```

---

### Task 12: Team cards from the tree, the preview state, and Free hit testing

**Files:**
- Modify: `web/src/hud/mock.ts`
- Test: `web/src/hud/mock.test.ts`

**Interfaces:**
- Consumes: `teamCardRects`, `isFreeTeam` (`build.ts`); `CardState` (`render.ts`).
- Produces: `export interface HudView { state?: CardState; child?: string | null; card?: number | null }`; `drawHud(ctx, pxW, pxH, design, side, selectedId, onAsset?, view: HudView = {})`; `paintTeamColumn` draws each card at `teamCardRects` and passes `view.state`; `hitTest` in Free hits only the three drawn cards (returning `'teamColumn'`); `export function freeCardAt(design: HudDesign, ux: number, uy: number): number | null`; the Free selection outlines each card, the selected one solid.

- [ ] **Step 1: Write the failing tests**

In `web/src/hud/mock.test.ts`, change the imports to

```ts
import { visibleElements, hitTest, drawHud, freeCardAt } from './mock';
import { buildTrees, elementRect, teamCardRects } from './build';
```

In "clips each panel to its real parent", replace everything from `const card = size(...)` to the end of the test with:

```ts
    // Each teammate card is clipped where the generated file puts it, at its own size.
    const cards = teamCardRects(DEFAULT_DESIGN, DEFAULT_DESIGN.aspect).slice(0, 3);
    expect(cards[0]).toEqual({ x: 13, y: 441, w: 121, h: 36 });       // DEFAULT_DESIGN fits the stock card
    for (const c of cards) expect(rects).toContainEqual([c.x * k, c.y * k, c.w * k, c.h * k]);
  });
```

and add:

```ts
const FREE: HudDesign = { ...DEFAULT_DESIGN, elements: { teamColumn: { fit: true, dir: 'free',
  slots: [{ x: 8, y: 100 }, { x: 8, y: 150 }, { x: 700, y: 100 }, { x: 400, y: 440 }] } } };

describe('Free teammate cards', () => {
  it('hits each drawn card as the teammates, and not the screen-sized container around them', () => {
    expect(hitTest(FREE, 'survivor', 68, 118)).toBe('teamColumn');
    expect(freeCardAt(FREE, 68, 118)).toBe(0);
    expect(freeCardAt(FREE, 68, 168)).toBe(1);
    expect(hitTest(FREE, 'survivor', 426, 100)).toBeNull();
    // Card 4 shows only while spectating a full team: not drawn, not a target.
    expect(hitTest(FREE, 'survivor', 460, 458)).toBeNull();
    expect(freeCardAt(FREE, 460, 458)).toBeNull();
    expect(freeCardAt(DEFAULT_DESIGN, 73, 459)).toBeNull();           // not Free
  });

  it('outlines each card instead of the whole screen, the selected one solid', () => {
    const strokes: number[][] = [];
    const dashes: number[][] = [];
    const ctx = fakeCtx(() => {});
    ctx.strokeRect = ((...a: number[]) => { strokes.push(a); }) as typeof ctx.strokeRect;
    ctx.setLineDash = ((d: number[]) => { dashes.push(d); }) as typeof ctx.setLineDash;
    drawHud(ctx, 853, 480, FREE, 'survivor', 'teamColumn', undefined, { card: 1 });
    for (const c of teamCardRects(FREE, FREE.aspect).slice(0, 3)) expect(strokes).toContainEqual([c.x, c.y, c.w, c.h]);
    expect(strokes).not.toContainEqual([0, 0, 853, 480]);
  });
});

describe('drawHud passes the preview state to the teammate cards', () => {
  it('draws every card down when asked', () => {
    _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement);
    const srcs: string[] = [];
    const ctx = fakeCtx(() => {});
    ctx.drawImage = ((img: HTMLImageElement) => { srcs.push(img.src); }) as unknown as typeof ctx.drawImage;
    drawHud(ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null, undefined, { state: 'down' });
    for (const c of ['biker', 'manager', 'teenangst']) expect(srcs).toContain(artUrl(`vgui/s_panel_${c}_incap`));
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/mock.test.ts`
Expected: FAIL, `freeCardAt` is not exported, `drawHud` takes no view, and in Free the full-screen container is the hit target.

- [ ] **Step 3: Implement in `mock.ts`**

Change the imports to

```ts
import { buildTrees, elementRect, teamLayout, teamCardRects, isFreeTeam } from './build';
import { drawPanel, type CardState } from './render';
```

After `interface Rect` add:

```ts
/** What the page asks the canvas to show beyond the design: the teammate card state, a selected child, a selected Free card. */
export interface HudView { state?: CardState; child?: string | null; card?: number | null }

const inside = (r: Rect, ux: number, uy: number) => ux >= r.x && ux <= r.x + r.w && uy >= r.y && uy <= r.y + r.h;
```

Replace `hitTest` with:

```ts
/** Smallest-area element under the point wins, so a small element sitting
 *  inside a larger container (the crosshair inside the whole screen, say)
 *  stays selectable. In Free the teammates' container covers the screen, so
 *  there the three drawn cards are the targets instead of the container. */
export function hitTest(design: HudDesign, side: Side, ux: number, uy: number): string | null {
  let best: { id: string; area: number } | null = null;
  for (const el of visibleElements(side)) {
    const r = rectFor(design, el.id);
    if (!r.visible) continue;
    const targets = el.id === 'teamColumn' && isFreeTeam(design) ? teamCardRects(design, design.aspect).slice(0, TEAM_CARDS) : [r];
    for (const t of targets) {
      if (!inside(t, ux, uy)) continue;
      const area = t.w * t.h;
      if (!best || area < best.area) best = { id: el.id, area };
    }
  }
  return best ? best.id : null;
}

/** Which of the three drawn Free teammate cards is under the point, or null (not Free, or no card there). */
export function freeCardAt(design: HudDesign, ux: number, uy: number): number | null {
  if (!isFreeTeam(design)) return null;
  const i = teamCardRects(design, design.aspect).slice(0, TEAM_CARDS).findIndex((c) => inside(c, ux, uy));
  return i < 0 ? null : i;
}
```

Move `const TEAM_CARDS = 3;` above `hitTest` (it is declared further down today; `const` must be initialised before first use at call time, which it is, but keeping it near the top is clearer).

Replace `paintTeamColumn` with:

```ts
/**
 * Each teammate card is drawn where the generated teamdisplayhud.res puts
 * it, at its own size, clipped to that card (VGUI clips a card's children to
 * the card) and to the container. All three draw from the one card file.
 */
function paintTeamColumn(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void, view: HudView = {}) {
  clipToRect(ctx, r, () => {
    for (const [i, c] of teamCardRects(design, design.aspect).slice(0, TEAM_CARDS).entries()) {
      const card = { x: c.x * k, y: c.y * k, w: c.w * k, h: c.h * k };
      clipToRect(ctx, card, () => drawPanel(ctx, design, 'teamColumn', { x: card.x, y: card.y }, k, { card: i, onAsset, state: view.state }));
    }
  });
}
```

Change the `PAINTERS` type to

```ts
const PAINTERS: Record<string, (ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void, view?: HudView) => void> = {
```

Add after `drawSelection`:

```ts
/** Free: the selection is the cards, not the screen-sized container. The picked card is solid, the others dashed. */
function drawCardSelection(ctx: CanvasRenderingContext2D, design: HudDesign, k: number, accent: string, card: number | null) {
  for (const [i, c] of teamCardRects(design, design.aspect).slice(0, TEAM_CARDS).entries()) {
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = i === card ? 2 : 1;
    ctx.setLineDash(i === card ? [] : [4, 3]);
    ctx.strokeRect(c.x * k, c.y * k, c.w * k, c.h * k);
    ctx.restore();
  }
}
```

Change `drawHud`'s signature and body:

```ts
export function drawHud(
  ctx: CanvasRenderingContext2D, pxW: number, pxH: number, design: HudDesign, side: Side, selectedId: string | null,
  onAsset?: () => void, view: HudView = {},
): void {
```

and inside the loop change both `paint(ctx, r, design, k, onAsset);` calls to `paint(ctx, r, design, k, onAsset, view);`, and replace `if (el.id === selectedId) drawSelection(ctx, r, el, accent);` with:

```ts
    if (el.id === selectedId) {
      if (el.id === 'teamColumn' && isFreeTeam(design)) drawCardSelection(ctx, design, k, accent, view.card ?? null);
      else drawSelection(ctx, r, el, accent);
    }
```

Add to `drawHud`'s comment: "`view` carries what the page shows beyond the design: the teammate card state and the selected Free card (and, from the child selection, the selected child)."

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud web/src/routes && npm run typecheck`
Expected: PASS. The page still calls `drawHud` with seven arguments, which the default `view` covers.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/mock.ts web/src/hud/mock.test.ts
git commit -m "Draw the teammate cards where the file puts them, pass the preview state through, and hit Free cards one by one"
```

---

### Task 13: Child hit testing and outlines

**Files:**
- Modify: `web/src/hud/mock.ts`
- Test: `web/src/hud/mock.test.ts`

**Interfaces:**
- Consumes: `childRects`, `hiddenInState` (`render.ts`); `teamChild` (`children.ts`); `teamCardRects`.
- Produces: `export function childAt(design: HudDesign, state: CardState, ux: number, uy: number): { name: string; card: number } | null`; `export function childCornerAt(design: HudDesign, state: CardState, name: string, ux: number, uy: number): boolean`; `drawHud` outlines `view.child` in every drawn card when `teamColumn` is selected, with a corner handle for a resizable child.

- [ ] **Step 1: Write the failing tests**

In `web/src/hud/mock.test.ts`, change the mock import to `import { visibleElements, hitTest, drawHud, freeCardAt, childAt, childCornerAt } from './mock';` and add `import { childRects } from './render';`, then:

```ts
describe('teammate card children on the canvas', () => {
  // DEFAULT_DESIGN: stock, fitted, card 2 at (153, 441); the fitted Head is (0, 2, 23, 23) inside it.
  const card2 = () => teamCardRects(DEFAULT_DESIGN, DEFAULT_DESIGN.aspect)[1];

  it('finds the child under the pointer in whichever card it is', () => {
    const c = card2();
    expect(childAt(DEFAULT_DESIGN, 'healthy', c.x + 11, c.y + 13)).toEqual({ name: 'Head', card: 1 });
  });

  it('finds what the state draws: the down picture where the portrait was', () => {
    const c = card2();
    expect(childAt(DEFAULT_DESIGN, 'down', c.x + 11, c.y + 13)).toEqual({ name: 'Incapacitated', card: 1 });
  });

  it('never picks decoration, a hidden child, or anything outside the cards', () => {
    const c = card2();
    // (120, 1) in the card is only the splatter: decoration, so the card itself stays the target.
    expect(childAt(DEFAULT_DESIGN, 'healthy', c.x + 120, c.y + 1)).toBeNull();
    const hidden = { ...DEFAULT_DESIGN, children: { teamColumn: { Head: { visible: false } } } };
    expect(childAt(hidden, 'healthy', c.x + 11, c.y + 13)).toBeNull();
    expect(childAt(DEFAULT_DESIGN, 'healthy', 426, 100)).toBeNull();
  });

  it("finds a resizable child's corner, and never one that has no size of its own", () => {
    const c = card2();
    const head = childRects(DEFAULT_DESIGN, 'teamColumn', { x: c.x, y: c.y }, 1).find((r) => r.name === 'Head')!;
    expect(childCornerAt(DEFAULT_DESIGN, 'healthy', 'Head', head.x + head.w, head.y + head.h)).toBe(true);
    expect(childCornerAt(DEFAULT_DESIGN, 'healthy', 'Head', head.x, head.y)).toBe(false);
    const items = childRects(DEFAULT_DESIGN, 'teamColumn', { x: c.x, y: c.y }, 1).find((r) => r.name === 'Items')!;
    expect(childCornerAt(DEFAULT_DESIGN, 'healthy', 'Items', items.x + items.w, items.y + items.h)).toBe(false);
  });

  it('outlines the selected child in every drawn card', () => {
    _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement);
    const strokes: number[][] = [];
    const ctx = fakeCtx(() => {});
    ctx.strokeRect = ((...a: number[]) => { strokes.push(a); }) as typeof ctx.strokeRect;
    drawHud(ctx, 853, 480, DEFAULT_DESIGN, 'survivor', 'teamColumn', undefined, { child: 'Head' });
    for (const c of teamCardRects(DEFAULT_DESIGN, DEFAULT_DESIGN.aspect).slice(0, 3)) {
      const head = childRects(DEFAULT_DESIGN, 'teamColumn', { x: c.x, y: c.y }, 1).find((r) => r.name === 'Head')!;
      expect(strokes).toContainEqual([head.x, head.y, head.w, head.h]);
    }
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/hud/mock.test.ts`
Expected: FAIL, `childAt` and `childCornerAt` are not exported.

- [ ] **Step 3: Implement in `mock.ts`**

Change the render import to `import { drawPanel, childRects, hiddenInState, type CardState } from './render';` and add `import { teamChild } from './children';`. Add after `freeCardAt`:

```ts
/**
 * The smallest teammate-card child under the point, in whichever of the
 * three drawn cards it falls, or null. A child counts only where the card
 * and the container both let it show (VGUI clips to both), only when the
 * preview draws it in `state`, and only when the registry lists it:
 * decoration (the splatter, the card background) is never a target, so a
 * click on a card's empty space still means the card. The rects come from
 * the generated tree through childRects, like everything the canvas draws.
 */
export function childAt(design: HudDesign, state: CardState, ux: number, uy: number): { name: string; card: number } | null {
  const container = rectFor(design, 'teamColumn');
  if (!container.visible || !inside(container, ux, uy)) return null;
  let best: { name: string; card: number; area: number } | null = null;
  for (const [i, c] of teamCardRects(design, design.aspect).slice(0, TEAM_CARDS).entries()) {
    if (!inside(c, ux, uy)) continue;
    for (const r of childRects(design, 'teamColumn', { x: c.x, y: c.y }, 1)) {
      const def = teamChild(r.name);
      if (!def || def.role === 'decor' || !r.visible || hiddenInState('teamColumn', r.name, state) || !inside(r, ux, uy)) continue;
      const area = r.w * r.h;
      if (!best || area < best.area) best = { name: r.name, card: i, area };
    }
  }
  return best && { name: best.name, card: best.card };
}

/** Whether the point is on the selected child's bottom-right resize handle in any drawn card (4 units of slack). */
export function childCornerAt(design: HudDesign, state: CardState, name: string, ux: number, uy: number): boolean {
  const def = teamChild(name);
  if (!def || def.box === 'none' || hiddenInState('teamColumn', name, state)) return false;
  return teamCardRects(design, design.aspect).slice(0, TEAM_CARDS).some((c) => {
    const r = childRects(design, 'teamColumn', { x: c.x, y: c.y }, 1).find((x) => x.name === name);
    return !!r && r.visible && Math.hypot(ux - (r.x + r.w), uy - (r.y + r.h)) <= 4;
  });
}

/** One card file drives every teammate card, so the selected child is outlined in all three. */
function drawChildSelection(ctx: CanvasRenderingContext2D, design: HudDesign, k: number, accent: string, name: string) {
  const def = teamChild(name);
  for (const c of teamCardRects(design, design.aspect).slice(0, TEAM_CARDS)) {
    const r = childRects(design, 'teamColumn', { x: c.x * k, y: c.y * k }, k).find((x) => x.name === name);
    if (!r) continue;
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    if (def && def.box !== 'none') {
      const s = 6;
      ctx.fillStyle = accent;
      ctx.fillRect(r.x + r.w - s / 2, r.y + r.h - s / 2, s, s);
    }
    ctx.restore();
  }
}
```

In `drawHud`, inside the `if (el.id === selectedId) { ... }` block, after the if/else, add:

```ts
      if (el.id === 'teamColumn' && view.child) drawChildSelection(ctx, design, k, accent, view.child);
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/hud && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/hud/mock.ts web/src/hud/mock.test.ts
git commit -m "Hit-test and outline the teammate card's children on the canvas, in every card at once"
```

---

### Task 14: Page: Row, Column and Free, the Fit checkbox and the card list

**Files:**
- Modify: `web/src/routes/Hud.tsx`
- Test: `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: `teamLayout`, `teamCardRects`, `isFreeTeam` (`build.ts`); `TeamDir`, `CardSlot`, `clampOverride` (`design.ts`).
- Produces (exported from `Hud.tsx`): `withTeamDir(d: HudDesign, dir: TeamDir): HudDesign` (fills `slots` from `teamCardRects` only on the first switch into Free); `placeCard(design: HudDesign, card: number, x: number, y: number): HudDesign` (writes one slot, clamped through `clampOverride`). Page state `selectedCard: number | null` and `selectEl(id: string | null)` (clears the card). `TeamControls` gains `setDesign`, `o`, `selectedCard`, `onPickCard` props. The fit-empty line in the Save panel.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/Hud.test.tsx`, change the import to

```ts
import { snap, nudge, toUnits, hasOverrides, elementsTouched, resetElement, withTeamDir, placeCard } from './Hud';
```

and add:

```ts
describe('the teammate layout helpers', () => {
  it('fills the four Free positions from where the cards sit, only the first time', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(free.elements.teamColumn).toEqual({ fit: true, dir: 'free',
      slots: [{ x: 13, y: 441 }, { x: 153, y: 441 }, { x: 293, y: 441 }, { x: 433, y: 441 }] });
    const moved = placeCard(free, 0, 50, 60);
    expect(withTeamDir(withTeamDir(moved, 'row'), 'free').elements.teamColumn!.slots![0]).toEqual({ x: 50, y: 60 });
  });

  it('clamps a placed card like an element position', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(placeCard(free, 2, 5000, -900).elements.teamColumn!.slots![2]).toEqual({ x: 1000, y: -200 });
    expect(placeCard(DEFAULT_DESIGN, 0, 5, 5)).toBe(DEFAULT_DESIGN);           // not Free: nothing to place
  });
});
```

and inside `describe('Hud page', ...)`:

```ts
  it('offers Row, Column and Free for the teammates, and Free lists the four cards where they sit', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect(screen.getByLabelText('X')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    expect(screen.getByText(/Drag each card/)).toBeTruthy();
    expect((screen.getByLabelText('Card 1 X') as HTMLInputElement).value).toBe('13');
    expect((screen.getByLabelText('Card 1 Y') as HTMLInputElement).value).toBe('441');
    expect((screen.getByLabelText('Card 4 X') as HTMLInputElement).value).toBe('433');
    // The element's own X and Y give way to the cards'.
    expect(screen.queryByLabelText('X')).toBeNull();
    expect(screen.queryByRole('slider', { name: /^Gap/ })).toBeNull();
  });

  it('keeps the card positions when switching out of Free and back', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    const layout = () => screen.getByRole('combobox', { name: /^Layout/ });
    fireEvent.change(layout(), { target: { value: 'free' } });
    fireEvent.input(screen.getByLabelText('Card 1 X'), { target: { value: '50' } });
    fireEvent.change(layout(), { target: { value: 'column' } });
    expect(screen.queryByLabelText('Card 1 X')).toBeNull();
    fireEvent.change(layout(), { target: { value: 'free' } });
    expect((screen.getByLabelText('Card 1 X') as HTMLInputElement).value).toBe('50');
  });

  it('starts a new design fitted and lets the player untick it', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    const fit = () => screen.getByLabelText('Fit the card to its contents') as HTMLInputElement;
    expect(fit().checked).toBe(true);
    fireEvent.click(fit());
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    expect(fit().checked).toBe(false);
  });

  it('says on the status line when fit finds nothing to fit', () => {
    const hidden = Object.fromEntries(['Head', 'Health', 'Name', 'Items', 'Status'].map((n) => [n, { visible: false }]));
    localStorage.setItem('hud', JSON.stringify({ v: 1, elements: { teamColumn: { fit: true } }, children: { teamColumn: hidden } }));
    render(<Hud />);
    expect(screen.getByText(/keeps its full size/)).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/routes/Hud.test.tsx`
Expected: FAIL, `withTeamDir` and `placeCard` are not exported and there is no Free option.

- [ ] **Step 3: Implement**

Change the imports in `Hud.tsx`:

```ts
import {
  loadDesign, saveDesign, validateDesign, safeName, encodeShare, decodeShare, clampOverride, DEFAULT_DESIGN,
  type HudDesign, type ElementOverride, type StyleOverride, type RangeKey, type TeamDir,
} from '../hud/design';
```

```ts
import { elementRect, teamLayout, teamCardRects, packHud, type BuildAssets } from '../hud/build';
```

Add after `resetElement`:

```ts
/**
 * Switch the survivor team's layout. Going into Free for the first time
 * copies where each card sits now into `slots`, read from the generated file
 * like everything the canvas draws, so nothing jumps; leaving Free keeps
 * them, so coming back restores the cards where the player left them.
 */
export function withTeamDir(d: HudDesign, dir: TeamDir): HudDesign {
  const cur = d.elements.teamColumn ?? {};
  const next: ElementOverride = { ...cur, dir };
  if (dir === 'free' && !cur.slots) {
    next.slots = teamCardRects(d, d.aspect).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y) }));
  }
  return { ...d, elements: { ...d.elements, teamColumn: next } };
}

/** Put one Free card's top-left at (x, y), clamped through the same table as an element's position. */
export function placeCard(design: HudDesign, card: number, x: number, y: number): HudDesign {
  const o = design.elements.teamColumn;
  if (!o?.slots || !o.slots[card]) return design;
  const slots = o.slots.map((s, i) => (i === card ? { x: clampOverride('x', x), y: clampOverride('y', y) } : s));
  return { ...design, elements: { ...design.elements, teamColumn: { ...o, slots } } };
}
```

Replace `TeamControls` with:

```tsx
/**
 * Layout controls for a team element. The survivor team gets Row, Column or
 * Free, the Gap between cards (Row and Column), Fit, and in Free one X and
 * Y per card, card 4 included, since it shows only while spectating a full
 * team and is otherwise unreachable. The infected row, whose cards the game
 * places itself, keeps its single spacing number.
 */
function TeamControls(
  { design, setDesign, el, o, patch, selectedCard, onPickCard }: {
    design: HudDesign; setDesign: (fn: (d: HudDesign) => HudDesign) => void; el: HudElement; o: ElementOverride;
    patch: Patch; selectedCard: number | null; onPickCard: (card: number | null) => void;
  },
) {
  if (!el.team) return null;
  const t = teamLayout(design, el);
  if (!el.team.file) {
    return (
      <>
        <label class="hud__row">
          <span>Layout</span>
          <select value={t.dir} onChange={(e) => patch({ dir: (e.target as HTMLSelectElement).value as 'row' | 'column' })}>
            <option value="row">Row</option>
            {el.team.dirs.includes('column') && <option value="column">Column</option>}
          </select>
          <span />
        </label>
        <label class="hud__row">
          <span>Spacing</span>
          <input type="number" value={t.spacing} onInput={(e) => patchNum(patch, e, 'spacing', (n) => ({ spacing: n }))} />
          <span />
        </label>
      </>
    );
  }
  const setSlot = (i: number, key: 'x' | 'y', e: Event) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(n)) return;
    setDesign((d) => {
      const cur = d.elements.teamColumn?.slots?.[i];
      return cur ? placeCard(d, i, key === 'x' ? n : cur.x, key === 'y' ? n : cur.y) : d;
    });
  };
  return (
    <>
      <label class="hud__row">
        <span>Layout</span>
        <select
          value={t.dir}
          onChange={(e) => { onPickCard(null); const dir = (e.target as HTMLSelectElement).value as TeamDir; setDesign((d) => withTeamDir(d, dir)); }}
        >
          <option value="row">Row</option>
          <option value="column">Column</option>
          <option value="free">Free</option>
        </select>
        <span />
      </label>
      {t.dir !== 'free' && (
        <Slider
          label="Gap" value={Math.max(0, Math.round(t.gap ?? 0))} min={0} max={200} step={1}
          onInput={(gap) => patch({ gap: clampOverride('gap', gap) })}
        />
      )}
      <label class="hud__check">
        <input type="checkbox" checked={o.fit === true} onChange={(e) => patch({ fit: (e.target as HTMLInputElement).checked })} />
        <span>Fit the card to its contents</span>
      </label>
      {t.dir === 'free' && o.slots && (
        <>
          <p class="muted hud__note">Drag each card on the canvas, or type its position. Card 4 shows only while you spectate a full team.</p>
          {selectedCard !== null && <p class="hud__note">{`Teammate card ${selectedCard + 1}`}</p>}
          {o.slots.map((s, i) => (
            <div class="hud__row2" key={i}>
              <label class="hud__field">
                <span>{`Card ${i + 1} X`}</span>
                <input type="number" value={Math.round(s.x)} onFocus={() => onPickCard(i)} onInput={(e) => setSlot(i, 'x', e)} />
              </label>
              <label class="hud__field">
                <span>{`Card ${i + 1} Y`}</span>
                <input type="number" value={Math.round(s.y)} onFocus={() => onPickCard(i)} onInput={(e) => setSlot(i, 'y', e)} />
              </label>
            </div>
          ))}
        </>
      )}
    </>
  );
}
```

Change `ElementControls`' props and body:

```tsx
function ElementControls(
  { design, setDesign, id, selectedCard, onPickCard }: {
    design: HudDesign; setDesign: (fn: (d: HudDesign) => HudDesign) => void; id: string;
    selectedCard: number | null; onPickCard: (card: number | null) => void;
  },
) {
  const el = elementById(id);
  if (!el) return null;
  const o = design.elements[id] ?? {};
  const rect = elementRect(design, id, design.aspect);
  // In Free each card places itself, so the element's own X and Y would move nothing.
  const free = !!el.team?.file && teamLayout(design, el).dir === 'free';
```

change `{el.move && (` (the X/Y block) to `{el.move && !free && (`, and change the TeamControls use to:

```tsx
      <TeamControls design={design} setDesign={setDesign} el={el} o={o} patch={patch} selectedCard={selectedCard} onPickCard={onPickCard} />
```

In `Hud()`, after `const [selected, setSelected] = useState<string | null>(null);` add:

```ts
  // In Free, the teammate card the canvas or the card list picked.
  const [selectedCard, setSelectedCard] = useState<number | null>(null);
  // Selecting an element (or nothing) always drops a picked card.
  const selectEl = (id: string | null) => { setSelected(id); setSelectedCard(null); };
```

Replace every other `setSelected(` call in the `Hud()` body with `selectEl(` (in `onPointerDown`, `onKeyDown`, the side `Tabs` `onSelect`, and the element pill `onClick`).

Change the side panel's `ElementControls` use to:

```tsx
            ? <ElementControls design={design} setDesign={setDesign} id={selected} selectedCard={selectedCard} onPickCard={setSelectedCard} />
```

In the Save panel, after `{status && <p class="muted hud__status">{status}</p>}` add:

```tsx
        {teamLayout(design, elementById('teamColumn')!).fitEmpty && (
          <p class="muted hud__status">Every part of the teammate card is hidden, so it keeps its full size instead of fitting.</p>
        )}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/routes web/src/hud && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx
git commit -m "Offer Row, Column and Free, a Fit checkbox and a per-card position list for the teammates"
```

---

### Task 15: Page: drag Free cards, the state toggle, and the crosshair checkbox

**Files:**
- Modify: `web/src/routes/Hud.tsx`
- Test: `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: `freeCardAt`, `HudView` (`mock.ts`); `isFreeTeam`, `teamCardRects` (`build.ts`); `CardState` (`render.ts`); `placeCard`, `selectEl`, `selectedCard` (Task 14).
- Produces: `export function nudgeCard(design: HudDesign, card: number, dx: number, dy: number): HudDesign`; `nudge` returns the design unchanged for the Free teammates; page state `cardState: CardState`; a Healthy / Down / Dead `Tabs` shown on the survivor side; the canvas drags a Free card; arrows nudge a picked Free card; `drawHud` receives `{ state: cardState, card: selectedCard }`; the "Hide the game's crosshair" checkbox in the Custom crosshair panel.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/Hud.test.tsx`, add `nudgeCard` to the `./Hud` import, and add:

```ts
describe('nudgeCard', () => {
  it('moves a Free card from its slot and keeps 8 units of it on screen, like a drag', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(nudgeCard(free, 0, 5, 0).elements.teamColumn!.slots![0]).toEqual({ x: 18, y: 441 });
    let d = free;
    for (let i = 0; i < 200; i++) d = nudgeCard(d, 0, -10, 0);
    expect(d.elements.teamColumn!.slots![0].x).toBe(8 - 121);
  });

  it('leaves the element position alone in Free, where it moves nothing', () => {
    const free = withTeamDir(DEFAULT_DESIGN, 'free');
    expect(nudge(free, 'teamColumn', 5, 5)).toBe(free);
  });
});
```

and inside `describe('Hud page', ...)`:

```ts
  it('drags a Free teammate card on the canvas', () => {
    const { container } = render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.change(screen.getByRole('combobox', { name: /^Layout/ }), { target: { value: 'free' } });
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    // happy-dom lays nothing out: give the canvas a 1:1 box so client pixels are HUD units.
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 853, height: 480, right: 853, bottom: 480, x: 0, y: 0, toJSON() {} }) as DOMRect;
    // Card 1 sits at (13, 441), 121 x 36. (133, 442) is on the card but on no
    // child (only the splatter, which is decoration), so even with the
    // teammates already selected this grabs the card, not a child.
    fireEvent.pointerDown(canvas, { clientX: 133, clientY: 442, pointerId: 1 });
    expect(screen.getByText('Teammate card 1')).toBeTruthy();
    fireEvent.pointerMove(canvas, { clientX: 233, clientY: 242, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 233, clientY: 242, pointerId: 1 });
    expect((screen.getByLabelText('Card 1 X') as HTMLInputElement).value).toBe('113');
    expect((screen.getByLabelText('Card 1 Y') as HTMLInputElement).value).toBe('241');
  });

  it('offers the Healthy, Down and Dead preview on the survivor side only', () => {
    render(<Hud />);
    expect(screen.getByRole('tab', { name: 'Healthy' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Down' }));
    expect(screen.getByRole('tab', { name: 'Down' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Infected' }));
    expect(screen.queryByRole('tab', { name: 'Down' })).toBeNull();
  });

  it("hides the game's crosshair from the Custom crosshair panel", () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom crosshair' }));
    const box = () => screen.getByLabelText("Hide the game's crosshair") as HTMLInputElement;
    expect(box().checked).toBe(false);
    expect(screen.getByText(/so an image crosshair can replace it/)).toBeTruthy();
    fireEvent.click(box());
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom crosshair' }));
    expect(box().checked).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/routes/Hud.test.tsx`
Expected: FAIL, `nudgeCard` is not exported, the canvas drags the whole element, and there is no state toggle or crosshair checkbox.

- [ ] **Step 3: Implement**

Imports in `Hud.tsx`:

```ts
import { elementRect, teamLayout, teamCardRects, isFreeTeam, packHud, type BuildAssets } from '../hud/build';
import { drawHud, hitTest, freeCardAt, visibleElements, type Side } from '../hud/mock';
import type { CardState } from '../hud/render';
```

In `nudge`, change `if (!el || !el.move) return design;` to:

```ts
  // In Free each card places itself: the element's own position would move nothing.
  if (!el || !el.move || (id === 'teamColumn' && isFreeTeam(design))) return design;
```

Add after `placeCard`:

```ts
/**
 * Nudge a Free card by (dx, dy) from its slot, through the same clampSpan
 * and 8-unit floor a drag uses, so repeated arrow presses cannot walk it off
 * screen. Its size comes from the generated file.
 */
export function nudgeCard(design: HudDesign, card: number, dx: number, dy: number): HudDesign {
  const s = design.elements.teamColumn?.slots?.[card];
  if (!s) return design;
  const r = teamCardRects(design, design.aspect)[card];
  const extentW = screenW(design.aspect);
  return placeCard(design, card, clampSpan(s.x + dx, r.w, extentW, 8), clampSpan(s.y + dy, r.h, SCREEN_H, 8));
}
```

Add at module level, above `export default function Hud()`:

```ts
type Rect4 = { x: number; y: number; w: number; h: number };
/** What a pointer-down grabbed: an element (moved or resized) or one Free teammate card. */
type Drag =
  | { kind: 'element'; id: string; mode: 'move' | 'resize'; startUx: number; startUy: number; startRect: Rect4 }
  | { kind: 'card'; card: number; startUx: number; startUy: number; startRect: Rect4 };

const CARD_STATES: { key: CardState; label: string }[] = [
  { key: 'healthy', label: 'Healthy' }, { key: 'down', label: 'Down' }, { key: 'dead', label: 'Dead' },
];
```

In `Hud()`, after the `selectEl` line add:

```ts
  // Which state the teammate cards are previewed in. Game code picks it in
  // game; this only changes the picture, never the design or the file.
  const [cardState, setCardState] = useState<CardState>('healthy');
```

Replace the `drag` ref declaration (and its comment's first line stays) with `const drag = useRef<Drag | null>(null);`.

In the draw effect change the `drawHud` call and the dependency list:

```ts
    drawHud(ctx, w, h, design, side, selected, () => setImgTick((t) => t + 1), { state: cardState, card: selectedCard });
  }, [design, side, selected, backdrop, imgTick, cardState, selectedCard]);
```

Replace `onPointerDown` and `onPointerMove` with:

```ts
  const onPointerDown = (e: PointerEvent) => {
    const c = canvas.current;
    if (!c) return;
    c.setPointerCapture(e.pointerId);
    const { ux, uy } = pointerUnits(e);
    const hit = hitTest(design, side, ux, uy);
    if (!hit) {
      selectEl(null);
      drag.current = null;
      return;
    }
    selectEl(hit);
    if (hit === 'teamColumn' && isFreeTeam(design)) {
      // In Free each card is its own target, and dragging it moves only that card.
      const card = freeCardAt(design, ux, uy);
      setSelectedCard(card);
      drag.current = card === null ? null
        : { kind: 'card', card, startUx: ux, startUy: uy, startRect: teamCardRects(design, design.aspect)[card] };
      return;
    }
    const el = elementById(hit)!;
    const rect = elementRect(design, hit, design.aspect);
    const nearCorner = Math.hypot(ux - (rect.x + rect.w), uy - (rect.y + rect.h)) <= 6;
    if (el.resize === 'free' && nearCorner) {
      drag.current = { kind: 'element', id: hit, mode: 'resize', startUx: ux, startUy: uy, startRect: rect };
    } else if (el.move) {
      drag.current = { kind: 'element', id: hit, mode: 'move', startUx: ux, startUy: uy, startRect: rect };
    } else {
      drag.current = null;
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { ux, uy } = pointerUnits(e);
    const dux = ux - d.startUx;
    const duy = uy - d.startUy;
    const extentW = screenW(design.aspect);

    if (d.kind === 'card') {
      const r = d.startRect;
      setDesign((cur) => placeCard(cur, d.card,
        clampSpan(snap(r.x + dux, r.w, extentW), r.w, extentW, 8),
        clampSpan(snap(r.y + duy, r.h, SCREEN_H), r.h, SCREEN_H, 8)));
      return;
    }
    setDesign((cur) => {
      const old = cur.elements[d.id] ?? {};
      if (d.mode === 'resize') {
        const w = Math.max(20, d.startRect.w + dux);
        const h = Math.max(20, d.startRect.h + duy);
        return { ...cur, elements: { ...cur.elements, [d.id]: { ...old, w, h } } };
      }
      const x = clampSpan(snap(d.startRect.x + dux, d.startRect.w, extentW), d.startRect.w, extentW, 8);
      const y = clampSpan(snap(d.startRect.y + duy, d.startRect.h, SCREEN_H), d.startRect.h, SCREEN_H, 8);
      return { ...cur, elements: { ...cur.elements, [d.id]: { ...old, x, y } } };
    });
  };
```

In `onKeyDown`, replace `if (e.key === 'Escape') { selectEl(null); return; }` with:

```ts
    // Escape steps up one level: a picked card to the teammates, the teammates to nothing.
    if (e.key === 'Escape') { if (selectedCard !== null) setSelectedCard(null); else selectEl(null); return; }
```

and replace `if (selected) setDesign((d) => nudge(d, selected, delta[0], delta[1]));` with:

```ts
    if (selected === 'teamColumn' && selectedCard !== null && isFreeTeam(design)) {
      const card = selectedCard;
      setDesign((d) => nudgeCard(d, card, delta[0], delta[1]));
    } else if (selected) setDesign((d) => nudge(d, selected, delta[0], delta[1]));
```

In the toolbar, directly after the side `<Tabs ... />`, add:

```tsx
            {side === 'survivor' && (
              <Tabs
                tabs={CARD_STATES.map((s) => ({ key: s.key, label: s.label }))}
                active={cardState}
                onSelect={(k) => setCardState(k as CardState)}
              />
            )}
```

In `ElementControls`, after the `{!el.move && (...)}` note, add:

```tsx
      {id === 'xhair' && (
        <>
          <label class="hud__check">
            <input
              type="checkbox" checked={design.hideGameCrosshair === true}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                setDesign((d) => {
                  const next = { ...d };
                  if (on) next.hideGameCrosshair = true; else delete next.hideGameCrosshair;
                  return next;
                });
              }}
            />
            <span>Hide the game's crosshair</span>
          </label>
          <p class="muted hud__note">Hides the game's own crosshair so an image crosshair can replace it.</p>
        </>
      )}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/routes web/src/hud && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx
git commit -m "Drag and nudge Free teammate cards, preview the cards down or dead, and offer hiding the game's crosshair"
```

---

### Task 16: Page: the children list and the child controls

**Files:**
- Modify: `web/src/routes/Hud.tsx`
- Test: `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: `TEAM_PANEL`, `teamChild` (`children.ts`); `cardChild`, `baseHasChild` (`build.ts`); `clampChild`, `ChildOverride`, `ChildRangeKey` (`design.ts`); `hexOf`, `withHex`, `alphaPct`, `withAlphaPct`, `Field`, `selectEl`.
- Produces: `export function patchChild(design: HudDesign, name: string, p: Partial<ChildOverride>): HudDesign`; `resetElement` also drops `children[id]`; `hasOverrides` and `changePreset` count child edits (preset reset also clears `children`, copy "moves and inside edits"); page state `selectedChild: string | null` (cleared by `selectEl`); components `ChildList` and `ChildControls`; `drawHud` also receives `child: selectedChild`.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/Hud.test.tsx`, add `patchChild` to the `./Hud` import, and add:

```ts
describe('patchChild', () => {
  it('merges into one child of the teammate card and leaves the rest alone', () => {
    const a = patchChild(DEFAULT_DESIGN, 'Head', { w: 30, h: 30 });
    const b = patchChild(a, 'Head', { x: 5 });
    expect(b.children.teamColumn).toEqual({ Head: { w: 30, h: 30, x: 5 } });
    expect(resetElement(b, 'teamColumn').children.teamColumn).toBeUndefined();
    expect(hasOverrides(b)).toBe(true);
  });
});
```

and inside `describe('Hud page', ...)`:

```ts
  it('lists the teammate card children and adds the health number on stock', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    for (const label of ['Portrait', 'Health bar', 'Name', 'Item icons', 'Status text', 'Damage splatter', 'Down picture', 'Dead picture', 'Voice icon']) {
      expect(screen.getByRole('button', { name: label }), label).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: 'Health number' })).toBeNull();
    const add = screen.getByLabelText('Health number') as HTMLInputElement;
    expect(add.checked).toBe(false);
    fireEvent.click(add);
    expect(screen.getByRole('button', { name: 'Health number' })).toBeTruthy();
    expect(screen.getByText("Edits inside a card apply to every teammate's card.")).toBeTruthy();
  });

  it('shows one Size box for the portrait and writes both sides', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Portrait' }));
    expect(screen.queryByLabelText('W')).toBeNull();
    fireEvent.input(screen.getByLabelText('Size'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    fireEvent.click(screen.getByRole('button', { name: 'Portrait' }));
    expect((screen.getByLabelText('Size') as HTMLInputElement).value).toBe('30');
  });

  it('offers no colour for the health number and says why, and a colour for the name', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.click(screen.getByLabelText('Health number'));
    fireEvent.click(screen.getByRole('button', { name: 'Health number' }));
    expect(screen.getByText('The game colours this by health.')).toBeTruthy();
    expect(screen.queryByLabelText('Health number colour')).toBeNull();
    expect(screen.getByLabelText('Text size')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(screen.getByLabelText('Name colour')).toBeTruthy();
  });

  it("snaps a child's X box to its cap, and goes back to the teammates", () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    fireEvent.input(screen.getByLabelText('X'), { target: { value: '9999' } });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('512');
    fireEvent.click(screen.getByRole('button', { name: 'Back to Teammates' }));
    expect(screen.getByText('Reset this element')).toBeTruthy();
  });

  it('gives the item icons an Icon size and no W or H', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Item icons' }));
    expect((screen.getByLabelText('Icon size') as HTMLInputElement).value).toBe('18');
    expect(screen.queryByLabelText('W')).toBeNull();
    expect(screen.getByText(/stand-in icons/)).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/routes/Hud.test.tsx`
Expected: FAIL, `patchChild` is not exported and the side panel has no children.

- [ ] **Step 3: Implement**

Imports in `Hud.tsx`:

```ts
import {
  loadDesign, saveDesign, validateDesign, safeName, encodeShare, decodeShare, clampOverride, clampChild, DEFAULT_DESIGN,
  type HudDesign, type ElementOverride, type StyleOverride, type RangeKey, type TeamDir, type ChildOverride, type ChildRangeKey,
} from '../hud/design';
import { elementRect, teamLayout, teamCardRects, isFreeTeam, cardChild, baseHasChild, packHud, type BuildAssets } from '../hud/build';
import { TEAM_PANEL, teamChild } from '../hud/children';
```

In `hasOverrides`, add `|| Object.keys(d.children).length > 0` after `elementsTouched(d)`. Replace `resetElement` with:

```ts
/** "Reset this element": back to what a fresh design has for it, which for
 *  the teammates is a fitted card with no inside edits, not nothing. */
export function resetElement(d: HudDesign, id: string): HudDesign {
  const elements = { ...d.elements };
  const fresh = DEFAULT_DESIGN.elements[id];
  if (fresh) elements[id] = structuredClone(fresh); else delete elements[id];
  const children = { ...d.children };
  delete children[id];
  return { ...d, elements, children };
}
```

Add after `nudgeCard`:

```ts
/** Merge into one teammate-card child's override. */
export function patchChild(design: HudDesign, name: string, p: Partial<ChildOverride>): HudDesign {
  const kids = design.children.teamColumn ?? {};
  return { ...design, children: { ...design.children, teamColumn: { ...kids, [name]: { ...(kids[name] ?? {}), ...p } } } };
}
```

Add after `StyleRow`:

```tsx
/**
 * The teammate card's insides: one pill per registry child, struck through
 * when hidden, and the only way to reach a hidden or tiny one, as the
 * element list is for elements. A child the preset's file lacks (the stock
 * health number) is a checkbox that adds it; once added it gets a pill too.
 */
function ChildList(
  { design, setDesign, selectedChild, onPick }: {
    design: HudDesign; setDesign: (fn: (d: HudDesign) => HudDesign) => void;
    selectedChild: string | null; onPick: (name: string) => void;
  },
) {
  return (
    <Field legend="Inside the card">
      <div class="hud__list">
        {TEAM_PANEL.children.map((def) => {
          const info = cardChild(design, def.name);
          if (!info) return null;                              // an addable child that is off: its checkbox is below
          return (
            <button
              key={def.name} type="button"
              class={`hud__pill${def.name === selectedChild ? ' is-active' : ''}${info.visible ? '' : ' hud__pill--hidden'}`}
              onClick={() => onPick(def.name)}
            >
              {def.label}
            </button>
          );
        })}
      </div>
      {TEAM_PANEL.children.filter((def) => def.addable && !baseHasChild(design.preset, def.name)).map((def) => (
        <label key={def.name} class="hud__check">
          <input
            type="checkbox" checked={design.children.teamColumn?.[def.name]?.on === true}
            onChange={(e) => { const on = (e.target as HTMLInputElement).checked; setDesign((d) => patchChild(d, def.name, { on })); }}
          />
          <span>{def.label}</span>
        </label>
      ))}
      <p class="muted hud__note">Edits inside a card apply to every teammate's card.</p>
    </Field>
  );
}

/**
 * The controls for one child of the teammate card, built only from its
 * registry entry. Numbers are unscaled units in the card file's own frame
 * (what a ChildOverride stores), read back through cardChild so a child
 * with no edits shows real numbers. Square art gets one Size; labels a text
 * size and, where the game honours it, a colour.
 */
function ChildControls(
  { design, setDesign, name, onBack }: {
    design: HudDesign; setDesign: (fn: (d: HudDesign) => HudDesign) => void; name: string; onBack: () => void;
  },
) {
  const def = teamChild(name);
  const info = cardChild(design, name);
  if (!def || !info) return null;
  const o = design.children.teamColumn?.[name] ?? {};
  const patch = (p: Partial<ChildOverride>) => setDesign((d) => patchChild(d, name, p));
  // The same guard and clamp as patchNum, through the child table.
  const num = (e: Event, key: ChildRangeKey, to: (n: number) => Partial<ChildOverride>) => {
    const n = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isFinite(n)) patch(to(clampChild(key, n)));
  };
  const colour = o.color ?? info.color ?? '255 255 255 255';
  const reset = () => setDesign((d) => {
    const kids = { ...(d.children.teamColumn ?? {}) };
    const on = kids[name]?.on;
    delete kids[name];
    // Resetting an added child keeps it added: the checkbox, not this button, takes it away.
    if (def.addable && on !== undefined) kids[name] = { on };
    const children = { ...d.children, teamColumn: kids };
    if (Object.keys(kids).length === 0) delete children.teamColumn;
    return { ...d, children };
  });

  return (
    <Field legend={def.label}>
      <label class="hud__check">
        <input type="checkbox" checked={o.visible ?? info.visible} onChange={(e) => patch({ visible: (e.target as HTMLInputElement).checked })} />
        <span>Visible</span>
      </label>
      {def.move && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>X</span>
            <input type="number" value={Math.round(info.x)} onInput={(e) => num(e, 'x', (x) => ({ x }))} />
          </label>
          <label class="hud__field">
            <span>Y</span>
            <input type="number" value={Math.round(info.y)} onInput={(e) => num(e, 'y', (y) => ({ y }))} />
          </label>
        </div>
      )}
      {def.box === 'wh' && (
        <div class="hud__row2">
          <label class="hud__field">
            <span>W</span>
            <input type="number" value={Math.round(info.w)} onInput={(e) => num(e, 'w', (w) => ({ w }))} />
          </label>
          <label class="hud__field">
            <span>H</span>
            <input type="number" value={Math.round(info.h)} onInput={(e) => num(e, 'h', (h) => ({ h }))} />
          </label>
        </div>
      )}
      {def.box === 'square' && (
        <label class="hud__row">
          <span>Size</span>
          <input type="number" value={Math.round(info.w)} onInput={(e) => num(e, 'w', (s) => ({ w: s, h: s }))} />
          <span />
        </label>
      )}
      {def.font && (
        <label class="hud__row">
          <span>{def.box === 'none' ? 'Icon size' : 'Text size'}</span>
          <input type="number" min={6} max={64} value={o.fontSize ?? info.fontTall ?? 12} onInput={(e) => num(e, 'fontSize', (fontSize) => ({ fontSize }))} />
          <span />
        </label>
      )}
      {def.colour && (
        <div class="hud__stylerow">
          <span class="hud__stylerow-label">Colour</span>
          <input
            type="color" aria-label={`${def.label} colour`} value={hexOf(colour)}
            onInput={(e) => patch({ color: withHex(colour, (e.target as HTMLInputElement).value) })}
          />
          <input
            type="range" min={0} max={100} step={1} aria-label={`${def.label} opacity`} value={alphaPct(colour)}
            onInput={(e) => patch({ color: withAlphaPct(colour, parseFloat((e.target as HTMLInputElement).value)) })}
          />
        </div>
      )}
      {def.note && <p class="muted hud__note">{def.note}</p>}
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={reset}>Reset this child</button>
      <button type="button" class="btn btn--ghost btn--sm hud__reset" onClick={onBack}>Back to Teammates</button>
    </Field>
  );
}
```

In `Hud()`, after the `selectedCard` state add:

```ts
  // The teammate card child picked in the list or on the canvas: the second selection level.
  const [selectedChild, setSelectedChild] = useState<string | null>(null);
```

and change `selectEl` to:

```ts
  // Selecting an element (or nothing) always drops a picked card and child.
  const selectEl = (id: string | null) => { setSelected(id); setSelectedCard(null); setSelectedChild(null); };
```

Change the draw call and dependencies:

```ts
    drawHud(ctx, w, h, design, side, selected, () => setImgTick((t) => t + 1), { state: cardState, card: selectedCard, child: selectedChild });
  }, [design, side, selected, backdrop, imgTick, cardState, selectedCard, selectedChild]);
```

In `changePreset`, replace the condition, the confirm title and the reset:

```ts
    if (elementsTouched(design) || Object.keys(design.children).length > 0) {
      resetElements = await confirm({
        title: 'Switching preset keeps your moves and inside edits, but they were placed for the other layout. Reset them as well?',
        confirmLabel: 'Reset', cancelLabel: 'Keep',
      });
    }
    setDesign((d) => ({ ...d, preset, ...(resetElements ? { elements: structuredClone(DEFAULT_DESIGN.elements), children: {} } : {}) }));
```

Replace the side panel body with:

```tsx
        <Panel class="hud__side">
          {selected === 'teamColumn' && selectedChild
            ? <ChildControls design={design} setDesign={setDesign} name={selectedChild} onBack={() => setSelectedChild(null)} />
            : selected
              ? <ElementControls design={design} setDesign={setDesign} id={selected} selectedCard={selectedCard} onPickCard={setSelectedCard} />
              : <p class="muted">Select an element on the canvas or in the list below it.</p>}
          {selected === 'teamColumn' && (
            <ChildList design={design} setDesign={setDesign} selectedChild={selectedChild} onPick={setSelectedChild} />
          )}
        </Panel>
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/routes web/src/hud && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx
git commit -m "List the teammate card's children and give each the controls its registry entry allows"
```

---

### Task 17: Page: select and drag a child on the canvas

**Files:**
- Modify: `web/src/routes/Hud.tsx`
- Test: `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: `childAt`, `childCornerAt` (`mock.ts`); `cardChild`; `baseTeam`, `clampChild`; `teamChild`; `patchChild`; `snap`; `selectedChild`, `cardState`.
- Produces: `export function placeChild(design: HudDesign, name: string, x: number, y: number): HudDesign` (rounded, clamped inside the unfitted card); `export function nudgeChild(design: HudDesign, name: string, dx: number, dy: number): HudDesign`; `export function resizeChild(design: HudDesign, name: string, start: { x: number; y: number; w: number; h: number }, dw: number, dh: number): HudDesign` (square keeps its ratio); the `Drag` union gains `{ kind: 'child'; name: string; mode: 'move' | 'resize'; startUx: number; startUy: number; start: Rect4 }`; clicking inside the selected teammates picks the child under the pointer and drags it; its corner resizes it; arrows nudge it; Escape steps child, card, panel.

- [ ] **Step 1: Write the failing tests**

In `web/src/routes/Hud.test.tsx`, add `placeChild, nudgeChild, resizeChild` to the `./Hud` import, and add:

```ts
describe('moving a teammate card child', () => {
  it('clamps a placed child inside the unfitted card, not the fitted one, or nothing could grow', () => {
    // Stock unfitted card 150 x 150; Head is 23 square.
    expect(placeChild(DEFAULT_DESIGN, 'Head', 500, -20).children.teamColumn!.Head).toEqual({ x: 127, y: 0 });
    expect(placeChild(DEFAULT_DESIGN, 'Head', 40.4, 50.6).children.teamColumn!.Head).toEqual({ x: 40, y: 51 });
  });

  it('nudges from where the child is now', () => {
    expect(nudgeChild(DEFAULT_DESIGN, 'Head', 1, 0).children.teamColumn!.Head).toEqual({ x: 14, y: 38 });
    // The down picture starts where the fit rule drew it: (13, 36) in the unfitted frame.
    expect(nudgeChild(DEFAULT_DESIGN, 'Incapacitated', 0, 1).children.teamColumn!.Incapacitated).toEqual({ x: 13, y: 37 });
  });

  it('resizes square art keeping it square, and anything else freely, inside the card', () => {
    expect(resizeChild(DEFAULT_DESIGN, 'Head', { x: 13, y: 38, w: 23, h: 23 }, 5, 2).children.teamColumn!.Head).toEqual({ w: 28, h: 28 });
    expect(resizeChild(DEFAULT_DESIGN, 'Head', { x: 13, y: 38, w: 23, h: 23 }, 500, 0).children.teamColumn!.Head).toEqual({ w: 112, h: 112 });
    expect(resizeChild(DEFAULT_DESIGN, 'Health', { x: 37, y: 52, w: 96, h: 7 }, -48, 0).children.teamColumn!.Health).toEqual({ w: 48, h: 7 });
    expect(resizeChild(DEFAULT_DESIGN, 'Items', { x: 39, y: 36, w: 50, h: 14 }, 5, 5)).toBe(DEFAULT_DESIGN);
  });
});
```

and inside `describe('Hud page', ...)`:

```ts
  it('picks a child inside the selected teammates on the canvas, drags it, and steps back up with Escape', () => {
    const { container } = render(<Hud />);
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 853, height: 480, right: 853, bottom: 480, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.click(screen.getByRole('button', { name: 'Teammates' }));
    // Card 1 at (13, 441); the fitted Head is (0, 2, 23, 23) inside it, so its centre is (24.5, 454.5).
    fireEvent.pointerDown(canvas, { clientX: 24, clientY: 454, pointerId: 1 });
    expect(screen.getByText('Portrait', { selector: 'legend' })).toBeTruthy();
    fireEvent.pointerMove(canvas, { clientX: 34, clientY: 454, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 34, clientY: 454, pointerId: 1 });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('23');
    expect((screen.getByLabelText('Y') as HTMLInputElement).value).toBe('38');
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('24');
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(screen.getByText('Reset this element')).toBeTruthy();
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(screen.getByText(/select an element/i)).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project web web/src/routes/Hud.test.tsx`
Expected: FAIL, `placeChild`, `nudgeChild` and `resizeChild` are not exported and the canvas selects only elements.

- [ ] **Step 3: Implement**

Imports in `Hud.tsx`: add `baseTeam` to the `../hud/design` import, and change the mock import to

```ts
import { drawHud, hitTest, freeCardAt, childAt, childCornerAt, visibleElements, type Side } from '../hud/mock';
```

Add after `patchChild`:

```ts
/**
 * Place a teammate-card child at (x, y): unscaled units in the card file's
 * own unfitted frame, rounded, clamped inside the unfitted card (150 x 150
 * on stock). The clamp is the unfitted card, not the fitted one, or a child
 * could never move past the card it currently makes and nothing could grow.
 */
export function placeChild(design: HudDesign, name: string, x: number, y: number): HudDesign {
  const r = cardChild(design, name);
  if (!r || !teamChild(name)?.move) return design;
  const p = baseTeam(design.preset).card;
  const cx = Math.round(Math.min(Math.max(0, p.w - r.w), Math.max(0, x)));
  const cy = Math.round(Math.min(Math.max(0, p.h - r.h), Math.max(0, y)));
  return patchChild(design, name, { x: clampChild('x', cx), y: clampChild('y', cy) });
}

/** Nudge a child from where it is now, through the same clamp as a drag. */
export function nudgeChild(design: HudDesign, name: string, dx: number, dy: number): HudDesign {
  const r = cardChild(design, name);
  return r ? placeChild(design, name, r.x + dx, r.y + dy) : design;
}

/**
 * Resize a child from `start` by (dw, dh), unscaled, inside the unfitted
 * card. Square art keeps its ratio: the side grows by the larger of the two
 * deltas. A child with no size of its own (the item icons) is unchanged.
 */
export function resizeChild(
  design: HudDesign, name: string, start: { x: number; y: number; w: number; h: number }, dw: number, dh: number,
): HudDesign {
  const def = teamChild(name);
  if (!def || def.box === 'none') return design;
  const p = baseTeam(design.preset).card;
  const fit = (v: number, room: number, key: 'w' | 'h') => clampChild(key, Math.round(Math.min(Math.max(1, room), Math.max(1, v))));
  if (def.box === 'square') {
    const side = fit(start.w + Math.max(dw, dh), Math.min(p.w - start.x, p.h - start.y), 'w');
    return patchChild(design, name, { w: side, h: side });
  }
  return patchChild(design, name, { w: fit(start.w + dw, p.w - start.x, 'w'), h: fit(start.h + dh, p.h - start.y, 'h') });
}
```

Replace the `Drag` type with:

```ts
/** What a pointer-down grabbed: an element (moved or resized), one Free teammate card, or a teammate card child. */
type Drag =
  | { kind: 'element'; id: string; mode: 'move' | 'resize'; startUx: number; startUy: number; startRect: Rect4 }
  | { kind: 'card'; card: number; startUx: number; startUy: number; startRect: Rect4 }
  | { kind: 'child'; name: string; mode: 'move' | 'resize'; startUx: number; startUy: number; start: Rect4 };
```

In `onPointerDown`, directly after `const { ux, uy } = pointerUnits(e);` insert:

```ts
    // Second level: inside the selected teammates, a child under the pointer
    // is picked before the panel, and the picked child's corner resizes it.
    if (selected === 'teamColumn') {
      if (selectedChild && childCornerAt(design, cardState, selectedChild, ux, uy)) {
        const start = cardChild(design, selectedChild);
        if (start) { drag.current = { kind: 'child', name: selectedChild, mode: 'resize', startUx: ux, startUy: uy, start }; return; }
      }
      const child = childAt(design, cardState, ux, uy);
      if (child) {
        setSelectedChild(child.name);
        const start = cardChild(design, child.name);
        drag.current = start && teamChild(child.name)?.move
          ? { kind: 'child', name: child.name, mode: 'move', startUx: ux, startUy: uy, start } : null;
        return;
      }
    }
```

In `onPointerMove`, directly after `const extentW = screenW(design.aspect);` insert:

```ts
    if (d.kind === 'child') {
      // Pointer units are screen units; the stored numbers are unscaled.
      const scale = design.elements.teamColumn?.scale ?? 1;
      const parent = baseTeam(design.preset).card;
      const s = d.start;
      setDesign((cur) => (d.mode === 'resize'
        ? resizeChild(cur, d.name, s, dux / scale, duy / scale)
        : placeChild(cur, d.name, snap(s.x + dux / scale, s.w, parent.w), snap(s.y + duy / scale, s.h, parent.h))));
      return;
    }
```

In `onKeyDown`, replace the Escape line with:

```ts
    // Escape steps up one level: a child or a picked card to the teammates, the teammates to nothing.
    if (e.key === 'Escape') {
      if (selectedChild) setSelectedChild(null);
      else if (selectedCard !== null) setSelectedCard(null);
      else selectEl(null);
      return;
    }
```

and replace the arrow dispatch with:

```ts
    if (selected === 'teamColumn' && selectedChild) {
      const name = selectedChild;
      setDesign((d) => nudgeChild(d, name, delta[0], delta[1]));
    } else if (selected === 'teamColumn' && selectedCard !== null && isFreeTeam(design)) {
      const card = selectedCard;
      setDesign((d) => nudgeCard(d, card, delta[0], delta[1]));
    } else if (selected) setDesign((d) => nudge(d, selected, delta[0], delta[1]));
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web web/src/routes web/src/hud && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx
git commit -m "Pick, drag, resize and nudge a teammate card child on the canvas, with Escape stepping back up"
```

---

### Task 18: Sample VPK, full verification and hand-off

**Files:**
- Modify: `web/src/hud/sample.vpkcheck.test.ts`

**Interfaces:**
- Consumes: everything above; `scripts/check-hud-vpk.sh` (unchanged).
- Produces: sample (a) now carries fit, gap, a scaled column, the health number toggle and two child edits, so the Python VPK reader checks a real Phase 1 build.

- [ ] **Step 1: Update sample (a)**

In `web/src/hud/sample.vpkcheck.test.ts`, change the header line for (a) to

```
//   a: stock preset, health panel bottom-left, team as a fitted column at
//      scale 1.25 with a 4-unit gap, the health number on, the item icons
//      above a half-width bar, chat moved, rounded card backgrounds, normal VPK.
```

and replace `SAMPLE_A` with:

```ts
const SAMPLE_A = { v: 1, preset: 'stock', elements: {
  ownHealth: { x: 8, y: 400 },
  teamColumn: { scale: 1.25, dir: 'column', gap: 4, fit: true },
  chat: { x: 8, y: 8 },
}, children: { teamColumn: { HealthNumber: { on: true }, Items: { x: 37, y: 40 }, Health: { w: 48 } } },
  styles: { panelBg: { kind: 'rounded', color: '0 0 0 150' } } };
```

- [ ] **Step 2: Full suite, types, build, the VPK check**

Run: `npm test && npm run typecheck && npm run build && bash scripts/check-hud-vpk.sh && HUD_SAMPLE=b bash scripts/check-hud-vpk.sh`
Expected: every suite passes (the known pre-existing ECONNREFUSED noise on port 3000 from the replay viewer tests is not this plan's), typecheck and build are clean, and both VPK checks print `N files ok`. Report the real output, including the `Hud-*.js` chunk size from the build.

- [ ] **Step 3: No em dashes**

Run: `git diff master --name-only | xargs grep -lP '\x{2014}' || echo none`
Expected: `none` for this branch's files (one pre-existing hit in `tests/discordPresenter.test.ts` is a required test literal and is not this branch's).

- [ ] **Step 4: Commit**

```bash
git add web/src/hud/sample.vpkcheck.test.ts
git commit -m "Build the owner's sample HUD with a fitted column, the health number and moved card insides"
```

- [ ] **Step 5: Write the controller's browser checklist into the report, then stop**

Do not start a dev server; the controller drives the browser. List exactly this for the controller to look at on `/hud`:

1. A fresh design (clear the `hud` localStorage key): stock teammate cards look exactly as before (same content positions, splatter faint behind each card), and selecting Teammates shows Layout Row, Gap 19, Fit ticked.
2. Layout Column with Gap 4: three compact cards stacked, no longer filling the side of the screen. Untick Fit: the cards spread to the old 150-unit pitch.
3. Layout Free: the cards do not jump; drag card 2 to the top right; the "Card 1..4" boxes follow; switch to Row and back to Free and card 2 is still at the top right. Change the aspect to 4:3 and the right-anchored card stays at the right edge.
4. Children: tick "Health number" (a `100` appears right of each name); click inside a selected card on a portrait and drag it; the outline follows in all three cards and the card re-fits. Drag "Item icons" above a half-width "Health bar" (W 48) and the cards get shorter.
5. Portrait Size 30 keeps the portrait square; the corner handle resize also keeps it square.
6. Healthy / Down / Dead: Down shows each character's down art as a square the card's height, a red bar and a red `299`; Dead shows the dead art as a square, a dimmed name, no bar.
7. Survivor panel background Flat red and Rounded red: the background covers exactly each (fitted) card, not a large box.
8. Modern preset: the fitted card is 113 x 26 from the Modern layout; the down art is square, not the old 88 x 31 strip.
9. Custom crosshair panel: "Hide the game's crosshair" ticks and survives reselecting.
10. The Infected side is unchanged, and "Your infected health" says "Shown as the Hunter; the Tank uses the same file."

Then the in-game check the owner runs (spec, Testing): a fitted Column with gap 4, a Free layout, icons above a half bar with the health number on, and the Down and Dead states on bots, compared with the preview.

Stop here. Do not merge, push or deploy.
