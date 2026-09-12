# Replay Viewer v2: readable maps and legible survivors

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make the viewer readable. v1 draws a correct picture that is hard to look at: the map occupies about a tenth of the canvas and the four survivors are four identical dots.

**Spec:** `docs/superpowers/specs/2026-09-12-replay-viewer-design.md` (v1), plus `/home/volence/l4d/overviews/MAP_OVERVIEWS.md` for the capture data.

## Why

Two things were measured on the finished v1, not guessed:

- Sampling a rendered canvas gives about **10 percent non-black pixels**. The captures frame each map inside a 2048x1271 image and the map itself occupies roughly a third of it, often a tall narrow ribbon. The viewer spends most of its area on void, and the map draws far smaller than the canvas could show it.
- Survivors are drawn as four dots in one colour, with health only in the panel strip below. At 5 to 8 world units per pixel a survivor is 4 to 6 pixels, so the spec's own advice is to draw players as icons. v1 draws them as dots and stops there.

## Global Constraints

- Branch is `feat/skill-stats-5`. Do not create a new branch.
- **No em dashes** anywhere: code, comments, commit messages.
- **Never weaken an existing test.** Where a behaviour deliberately changes, update the assertion to the new behaviour and say so.
- `src/replayFormat.ts`, `src/mapTransform.ts` and `src/mapOverviews.ts` must stay **free of imports**. They are loaded by the browser and by the server.
- **The anti-ghosting property is untouchable.** Nothing here may show a viewer information the server held back. Ghost treatment stays on player records only, never on entities.
- Do not deploy anything. Do not touch `plugin/`.
- Run `npm test` and `npm run typecheck` before each commit.

---

## Task V1: crop each map to the geometry it actually contains

**Files:**
- Modify: `tools/gen-overviews.py`, `src/mapOverviews.ts` (regenerated)
- Modify: `src/mapTransform.ts`, `web/src/replay/draw.ts`, `web/src/replay/useMapLayer.ts`, `web/src/replay/ReplayCanvas.tsx`
- Test: `tests/mapTransform.test.ts`, `tests/mapOverviews.test.ts`, `web/src/replay/draw.test.ts`

**Interfaces:**
- Consumes: the source PNGs in `/home/volence/l4d/overviews/out/`, read-only.
- Produces:
  - `OVERVIEWS[map].contentBox: { x0: number; y0: number; x1: number; y1: number }` in `src/mapOverviews.ts`, image pixel coordinates, right and bottom exclusive.
  - In `src/mapTransform.ts`: `interface ViewBox { x0: number; y0: number; x1: number; y1: number }`, `interface View { scale: number; offsetX: number; offsetY: number; box: ViewBox }`, and `fitView(box: ViewBox, canvasW: number, canvasH: number, padFraction?: number): View`.
  - `projectView(t: MapTransform, v: View, x: number, y: number): { px: number; py: number }` replacing the current `project` plus `scaleFor` pair.

- [ ] **Step 1: Compute the content box in the generator**

A layer shows everything below its cut and renders pure black where there is no geometry, so the union of every layer's non-black region is the map's true footprint. Take the union rather than per-layer boxes: all layers of a map share one transform and must stay pixel-aligned, and a deep layer showing only a basement would otherwise crop to the basement.

Compute it from the **source PNGs**, which are lossless. The committed WebP is lossy and would put faint noise in the void.

In `tools/gen-overviews.py`, for each map, open every layer, convert to greyscale, and take the bounding box of pixels above a small threshold. Pillow's `Image.point` plus `getbbox` does this without a Python-level pixel loop:

```python
THRESHOLD = 12  # mat_fullbright void is pure black; this only rejects encoder noise

def content_box(paths):
    """Union of the non-black bounding boxes of every layer of one map."""
    box = None
    for p in paths:
        with Image.open(p) as im:
            mask = im.convert('L').point(lambda v: 255 if v > THRESHOLD else 0)
            b = mask.getbbox()
        if b is None:
            continue          # a layer with no geometry at all, which is legal
        box = b if box is None else (
            min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3])
        )
    return box
```

Emit it per map, beside `layers`. If a map somehow has no geometry in any layer, emit the full image rect rather than omitting the field, so consumers never have to branch.

Print each map's box and the fraction of the frame it covers, so the run reports what it found.

- [ ] **Step 2: Regenerate and sanity check**

Run `/home/volence/l4d/hud/.venv/bin/python tools/gen-overviews.py /home/volence/l4d/overviews/out src/mapOverviews.ts`.

Expected: 22 maps, 182 layers, and a coverage fraction well under 1.0 for most maps. If any map reports a box covering essentially the whole frame, look at that map's layers before trusting it: either the capture really does fill the frame, or the threshold is picking up something that is not geometry.

- [ ] **Step 3: Write the failing tests**

In `tests/mapOverviews.test.ts`:

```ts
describe('content boxes', () => {
  it('gives every map a content box inside its image', () => {
    for (const m of Object.values(OVERVIEWS)) {
      const b = m.contentBox;
      expect(b.x0).toBeGreaterThanOrEqual(0);
      expect(b.y0).toBeGreaterThanOrEqual(0);
      expect(b.x1).toBeLessThanOrEqual(m.layers[0].width);
      expect(b.y1).toBeLessThanOrEqual(m.layers[0].height);
      expect(b.x1).toBeGreaterThan(b.x0);
      expect(b.y1).toBeGreaterThan(b.y0);
    }
  });

  // The whole point of the task. If a box covers the whole frame, cropping to
  // it buys nothing, and that means the generator found something in the void.
  it('crops a meaningful amount off at least most maps', () => {
    const fractions = Object.values(OVERVIEWS).map((m) => {
      const b = m.contentBox;
      return ((b.x1 - b.x0) * (b.y1 - b.y0)) / (m.layers[0].width * m.layers[0].height);
    });
    const median = [...fractions].sort((a, b) => a - b)[Math.floor(fractions.length / 2)];
    expect(median).toBeLessThan(0.75);
  });
});
```

In `tests/mapTransform.test.ts`:

```ts
describe('fitView', () => {
  const box = { x0: 500, y0: 100, x1: 1000, y1: 600 };   // 500 x 500

  it('centres a square box in a wide canvas and scales it to fit the short axis', () => {
    const v = fitView(box, 1000, 500, 0);
    expect(v.scale).toBe(1);          // 500 tall into 500 tall
    expect(v.offsetY).toBe(0);
    expect(v.offsetX).toBe(250);      // (1000 - 500) / 2
  });

  it('scales up a small box to fill the canvas', () => {
    const v = fitView({ x0: 0, y0: 0, x1: 250, y1: 250 }, 1000, 500, 0);
    expect(v.scale).toBe(2);
  });

  it('leaves padding when asked', () => {
    const v = fitView(box, 1000, 500, 0.1);
    expect(v.scale).toBeLessThan(1);
  });

  it('never divides by zero on a degenerate box', () => {
    const v = fitView({ x0: 10, y0: 10, x1: 10, y1: 10 }, 1000, 500, 0);
    expect(Number.isFinite(v.scale)).toBe(true);
    expect(v.scale).toBeGreaterThan(0);
  });
});

describe('projectView', () => {
  const t = {
    originX: -1000, originY: 2000, unitsPerPixel: 8,
    image: '/a.webp', width: 2048, height: 1271,
  };

  it('puts the box origin at the view offset', () => {
    const v = fitView({ x0: 100, y0: 50, x1: 1100, y1: 1050 }, 1000, 1000, 0);
    // World position that projects to image pixel (100, 50), the box corner.
    const got = projectView(t, v, -1000 + 100 * 8, 2000 - 50 * 8);
    expect(got.px).toBeCloseTo(v.offsetX, 5);
    expect(got.py).toBeCloseTo(v.offsetY, 5);
  });

  it('scales a position inside the box by the view scale', () => {
    const v = fitView({ x0: 0, y0: 0, x1: 1024, y1: 1024 }, 2048, 2048, 0);
    expect(v.scale).toBe(2);
    const got = projectView(t, v, -1000 + 10 * 8, 2000);
    expect(got.px).toBeCloseTo(20, 5);
  });
});
```

- [ ] **Step 4: Implement `fitView` and `projectView`**

In `src/mapTransform.ts`:

```ts
export interface ViewBox { x0: number; y0: number; x1: number; y1: number }

/** How a region of the layer image is placed on the canvas.
 *
 *  The captures frame each map inside a 2048x1271 image and the map itself
 *  is often a tall narrow ribbon covering a small part of it, so drawing the
 *  whole image wastes most of the canvas. This maps a chosen region of the
 *  image onto the canvas instead, preserving aspect. */
export interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
  box: ViewBox;
}

export function fitView(
  box: ViewBox, canvasW: number, canvasH: number, padFraction = 0.03,
): View {
  // A degenerate box would divide by zero. One pixel is arbitrary and
  // harmless: there is nothing to see either way, and the alternative is
  // Infinity propagating into every drawn position.
  const w = Math.max(box.x1 - box.x0, 1);
  const h = Math.max(box.y1 - box.y0, 1);
  const pad = 1 - padFraction * 2;
  const scale = Math.min(canvasW / w, canvasH / h) * pad;
  return {
    scale,
    offsetX: (canvasW - w * scale) / 2,
    offsetY: (canvasH - h * scale) / 2,
    box,
  };
}

/** World position to canvas pixel, through the layer image and the view. */
export function projectView(
  t: MapTransform, v: View, x: number, y: number,
): { px: number; py: number } {
  const img = worldToImage(t, x, y);
  return {
    px: (img.px - v.box.x0) * v.scale + v.offsetX,
    py: (img.py - v.box.y0) * v.scale + v.offsetY,
  };
}
```

- [ ] **Step 5: Draw through the view**

In `web/src/replay/draw.ts`, replace `scaleFor` and `project` with the view. `DrawArgs` gains `view: View` and drops nothing else. Every position goes through `projectView(a.transform, a.view, x, y)`.

The backdrop uses the nine-argument `drawImage` so only the cropped region is drawn:

```ts
  if (a.backdrop) {
    const b = a.view.box;
    ctx.drawImage(
      a.backdrop,
      b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0,
      a.view.offsetX, a.view.offsetY,
      (b.x1 - b.x0) * a.view.scale, (b.y1 - b.y0) * a.view.scale,
    );
  }
```

Avatar radii, arrow lengths and line widths stay in screen units and are still not multiplied by anything. That rule does not change: markers drawn at screen resolution stay sharp while the map underneath softens.

Update the existing `drawScene` regression tests to pass a view. The test that proves a player lands at a scaled canvas position rather than a raw image position must keep proving that; express it through `fitView` so it now also proves the crop offset is applied.

- [ ] **Step 6: Supply the view**

`useMapLayer` returns the `View` alongside `transform` and `backdrop`. For a map with an overview, the box is `overviewFor(map).contentBox`. For the auto-fit fallback there is no image, so the box is the full canvas rect and the view is the identity: scale 1, no offset. That keeps one code path.

`ReplayCanvas` passes the view to `drawScene` and uses `projectView` for the follow camera, exactly as it uses `project` today.

- [ ] **Step 7: Verify and commit**

`npm test`, `npm run typecheck`, then commit:

```bash
git add tools/gen-overviews.py src/mapOverviews.ts src/mapTransform.ts \
        web/src/replay/draw.ts web/src/replay/useMapLayer.ts web/src/replay/ReplayCanvas.tsx \
        tests/mapTransform.test.ts tests/mapOverviews.test.ts web/src/replay/draw.test.ts
git commit -m "feat(replay): crop each map to the geometry it actually contains"
```

---

## Task V2: make the four survivors tell each other apart

**Files:**
- Modify: `web/src/replay/draw.ts`, `web/src/replay/ReplayCanvas.tsx`, `web/src/replay/useToggles.ts`, `web/src/replay/ReplayControls.tsx`, `web/src/replay/Viewer.tsx`, `web/src/styles/app.css`
- Test: `web/src/replay/draw.test.ts`, `web/src/replay/useToggles.test.ts`

**Interfaces:**
- Produces, in `web/src/replay/draw.ts`:
  - `SLOT_COLORS: readonly string[]` (8 entries, slot indexed)
  - `slotColor(slot: number): string` replacing `teamColor`
  - `statusGlyph(state: number): string` returning one short marker or `''`
  - `DrawArgs` gains `names: Record<string, string>`, `slots: string[]`, `followSlot: number | null`
  - `ShowFlags` gains `names: boolean`
- `Toggles` gains `names: boolean`, default true.

- [ ] **Step 1: Write the failing tests**

```ts
describe('slotColor', () => {
  it('gives each of the four survivors a distinct colour', () => {
    const seen = new Set([0, 1, 2, 3].map(slotColor));
    expect(seen.size).toBe(4);
  });

  it('gives each of the four infected a distinct colour', () => {
    const seen = new Set([4, 5, 6, 7].map(slotColor));
    expect(seen.size).toBe(4);
  });

  // Team identity has to survive at a glance, so the two sets must not
  // overlap even though every slot is individually distinguishable.
  it('never reuses a survivor colour for an infected slot', () => {
    const surv = new Set([0, 1, 2, 3].map(slotColor));
    for (const s of [4, 5, 6, 7]) expect(surv.has(slotColor(s))).toBe(false);
  });
});

describe('statusGlyph', () => {
  it('marks the states worth seeing on the map', () => {
    expect(statusGlyph(STATE.PRESENT | STATE.ALIVE | STATE.INCAP)).not.toBe('');
    expect(statusGlyph(STATE.PRESENT | STATE.ALIVE | STATE.PINNED)).not.toBe('');
    expect(statusGlyph(STATE.PRESENT | STATE.ALIVE | STATE.BILED)).not.toBe('');
    expect(statusGlyph(STATE.PRESENT | STATE.ALIVE | STATE.BURNING)).not.toBe('');
    expect(statusGlyph(STATE.PRESENT | STATE.ALIVE | STATE.LEDGED)).not.toBe('');
  });

  it('marks nothing for a healthy player', () => {
    expect(statusGlyph(STATE.PRESENT | STATE.ALIVE)).toBe('');
  });

  // Pinned is the one someone watching needs to see first, so it wins when
  // several are set at once.
  it('prefers pinned when more than one applies', () => {
    const both = STATE.PRESENT | STATE.ALIVE | STATE.PINNED | STATE.BILED;
    expect(statusGlyph(both)).toBe(statusGlyph(STATE.PRESENT | STATE.ALIVE | STATE.PINNED));
  });
});
```

- [ ] **Step 2: Implement the helpers**

Eight colours, four cool for survivors and four warm for infected, each distinguishable from its team mates. Use the existing `#6fb1e0` and `#d9534f` as the first of each set so nothing already on screen changes hue wholesale.

`statusGlyph` returns a single short marker, checked in priority order: pinned, incapacitated, ledged, burning, biled. One glyph, not a stack, because at this scale a stack is a smudge.

- [ ] **Step 3: Draw the detail**

In the player loop in `drawScene`, for a present player:

- Fill with `slotColor(p.slot)` rather than the team colour.
- **Health ring.** For a living survivor, stroke an arc around the avatar spanning `health / 100` of a full circle, in the same colour ramp the HUD panel uses. A player at full health reads as a closed ring, a player about to go down as a sliver. This is the detail that makes the map readable without looking down at the panel.
- **Status glyph** drawn just above the avatar when `statusGlyph` returns one.
- **Name label** when `show.names`, drawn to the right of the avatar in a small font with a dark outline so it stays legible over both bright and dark map areas. Resolve through `names[slots[p.slot]]`, falling back to nothing rather than printing a SteamID64 on the map: a seventeen digit number next to every dot is worse than no label.
- **Follow highlight.** When `followSlot === p.slot`, stroke a wider ring outside the health ring so the followed player is findable.

Draw survivors after infected so a label never hides under an enemy dot. That is a refinement of the existing draw order, which already puts players last.

Ghost treatment is unchanged and still applies to player records only.

- [ ] **Step 4: Wire the toggle**

Add `names` to `Toggles` defaulting to true, and to the toolbar between HP and Guns with the label `Names`. `readToggles` merges over defaults, so an existing stored value without the key picks up the default.

Pass `names`, `header.slots` and `followSlot` through `ReplayCanvas` into `DrawArgs`.

- [ ] **Step 5: Verify and commit**

`npm test`, `npm run typecheck`, then commit:

```bash
git add web/src/replay/draw.ts web/src/replay/draw.test.ts web/src/replay/ReplayCanvas.tsx \
        web/src/replay/useToggles.ts web/src/replay/useToggles.test.ts \
        web/src/replay/ReplayControls.tsx web/src/replay/Viewer.tsx web/src/styles/app.css
git commit -m "feat(replay): tell the four survivors apart on the map"
```
