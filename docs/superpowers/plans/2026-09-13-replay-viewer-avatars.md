# Replay Viewer Avatars, States and Events on the Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the map's 14px dots with 22px portrait medallions carrying rim, digit badge, facing wedge, one priority state ring and the health arc; scale world entities to match; draw pins, bursts and filterable event markers from the timeline; add hover tooltips and a Key panel.

**Architecture:** `draw.ts` keeps `drawScene`, the palette and label stacking, and grows a `hits` output. New focused modules own one thing each: `stateRing.ts` (state table and priority), `pictograms.ts` (SVG path data as `Path2D`), `avatar.ts` (the medallion primitive shared by players and AI entities), `markers.ts` (event kinds, filters, positions, pins, bursts, witch state), `hitTest.ts`, `usePortraits.ts`. `Viewer` computes the timeline-derived inputs once per change and hands them to `ReplayCanvas`, which paints per animation frame as today.

**Tech Stack:** Preact + TypeScript, canvas 2D, vitest (happy-dom for `web/**`, node for `tests/**`), the existing stub-context test idiom in `web/src/replay/draw.test.ts`, `colorDistance.ts` for CIELAB and dichromacy checks.

**Spec:** `docs/superpowers/specs/2026-09-13-replay-viewer-avatars-design.md`

## Global Constraints

- No recorder or format change. Every input exists in the frames, the header and the timeline already.
- A ghost (`STATE.GHOST`) draws only a hollow ring in `GHOST_COLOR` at alpha 0.35: no pictogram, badge, wedge, arc, label, state ring, follow ring, tooltip content beyond "Unspawned infected".
- Nothing printed on the map or in a tooltip is ever a SteamID64. Names resolve through the roster and fall back to `slotLabel`.
- All chrome sizes are CSS pixels, fixed at every zoom, like the existing constants in `draw.ts`.
- State colours are provisional until they pass the dichromacy tests in Task 1; tune the value, never the threshold, and the only exceptions are the two named there.
- No em dashes anywhere (code, comments, commits).
- Run `npm test` (927 tests before this plan) and `npm run typecheck` before every commit. Both must be clean.
- The live page gets no markers or bursts: `Viewer` receives no `timeline` there, and everything timeline-driven must be a no-op when `timeline` is undefined.

---

## File Structure

| File | Responsibility |
|---|---|
| `web/src/replay/stateRing.ts` (new) | Ordered state table: bit, key, ring colour, glyph letter, label. `stateRing(state)`, `stateRingColor`, `statusGlyph`, `DEAD_COLOR`. |
| `web/src/replay/pictograms.ts` (new) | SVG path strings for smoker, boomer, hunter, tank, witch in a 20x20 box; `pictogramPath(name)` returns a cached `Path2D` or null. |
| `web/src/replay/avatar.ts` (new) | `MedallionSpec` and `drawMedallion(ctx, spec)`: rim, disc, face or pictogram, wedge, badge, state ring, arc, dead treatment, hollow ghost. Radii constants exported. |
| `web/src/replay/markers.ts` (new) | `MARKER_KINDS`, `markerEntries`, `markerKindsPresent`, `eventPosition`, `pinnersAt`, `witchStartledAt`, `BURSTS`, `BurstClock`. |
| `web/src/replay/hitTest.ts` (new) | `HitItem`, `hitTest(items, px, py)`. |
| `web/src/replay/usePortraits.ts` (new) | Loads the portrait PNGs once into `HTMLImageElement`s. |
| `web/src/replay/MarkerFilters.tsx` (new) | The Show and for selects. |
| `web/src/replay/KeyPanel.tsx` (new) | The legend, rendered from the tables. |
| `web/src/replay/ReplayTooltip.tsx` (new) | The hover tooltip element and its text. |
| `web/src/replay/draw.ts` (modify) | Players via `drawMedallion`, entity shapes and sizes, markers, bursts, pin lines, `hits` output, label gap. |
| `web/src/replay/draw.test.ts` (modify) | Palette tests for state colours; medallion, ghost, dead, entity, marker, pin assertions. |
| `web/src/replay/ReplayCanvas.tsx` (modify) | Passes portraits, previous entities, markers, bursts, witch flag, pins; records hits; owns the `BurstClock`. |
| `web/src/replay/Viewer.tsx` (modify) | Computes marker items, wires filters, tooltip, Key panel, click to seek. |
| `web/src/replay/useToggles.ts` (modify) | `key: boolean`, `showKind: string`, and a `set(k, v)` setter. |
| `web/src/replay/ReplayHud.tsx` (modify) | `Key` chip. |
| `web/src/styles/app.css` (modify) | Filters row, tooltip, key panel. |

---

### Task 1: State ring table and palette proof

**Files:**
- Create: `web/src/replay/stateRing.ts`
- Modify: `web/src/replay/draw.ts` (remove `statusGlyph` and `alertColor` bodies, re-export from stateRing)
- Test: `web/src/replay/stateRing.test.ts`, `web/src/replay/draw.test.ts`

**Interfaces:**
- Produces: `interface StateRing { key: 'pinned'|'incap'|'ledged'|'burning'|'biled'; bit: number; color: string; glyph: string; label: string }`, `STATE_RINGS: readonly StateRing[]` in priority order, `stateRing(state: number): StateRing | null`, `stateRingColor(state: number): string | null`, `statusGlyph(state: number): string`, `DEAD_COLOR = '#6d675e'`.

- [ ] **Step 1: Write the failing tests**

`web/src/replay/stateRing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { STATE } from '../../../src/replayFormat';
import { DEAD_COLOR, STATE_RINGS, stateRing, stateRingColor, statusGlyph } from './stateRing';
import { GHOST_COLOR, SLOT_COLORS } from './draw';
import { distance, type Vision } from './colorDistance';

const BITS = [STATE.PINNED, STATE.INCAP, STATE.LEDGED, STATE.BURNING, STATE.BILED];
const VISIONS: Vision[] = ['normal', 'protanopia', 'deuteranopia'];
const worst = (a: string, b: string) => Math.min(...VISIONS.map((v) => distance(a, b, v)));

describe('stateRing', () => {
  it('is null for a healthy player and for a dead one', () => {
    expect(stateRing(STATE.PRESENT | STATE.ALIVE)).toBeNull();
    expect(stateRing(STATE.PRESENT)).toBeNull();
  });

  it('picks the first state in priority order for every subset of the five bits', () => {
    for (let mask = 1; mask < 32; mask++) {
      let state = STATE.PRESENT | STATE.ALIVE;
      BITS.forEach((b, i) => { if (mask & (1 << i)) state |= b; });
      const ring = stateRing(state)!;
      const expected = STATE_RINGS.find((r) => (state & r.bit) !== 0)!;
      expect(ring).toBe(expected);
      // The glyph and the ring can never disagree: same table, same walk.
      expect(statusGlyph(state)).toBe(expected.glyph);
      expect(stateRingColor(state)).toBe(expected.color);
    }
  });

  it('keeps the letters the map has always used', () => {
    expect(statusGlyph(STATE.PINNED)).toBe('P');
    expect(statusGlyph(STATE.INCAP)).toBe('X');
    expect(statusGlyph(STATE.LEDGED)).toBe('L');
    expect(statusGlyph(STATE.BURNING)).toBe('F');
    expect(statusGlyph(STATE.BILED)).toBe('B');
    expect(statusGlyph(0)).toBe('');
  });
});

describe('state ring palette under dichromacy', () => {
  const colors = Array.from(new Set(STATE_RINGS.map((r) => r.color)));

  it('keeps the state colours at least 15 apart from one another', () => {
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        expect(worst(colors[i], colors[j])).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it('keeps every state colour clear of the ghost and dead greys', () => {
    for (const c of colors) {
      expect(worst(c, GHOST_COLOR)).toBeGreaterThanOrEqual(15);
      expect(worst(c, DEAD_COLOR)).toBeGreaterThanOrEqual(15);
    }
  });

  // Two exceptions, by name, and only these two.
  //
  // Pinned gold against infected slot 6 gold: a gold ring only ever appears
  // on a survivor, whose rim is cool, and an infected's gold rim never
  // carries a gold ring. Cross-team adjacency is the one place they meet
  // and the face inside disambiguates.
  //
  // Biled purple against the four survivor rims under protanopia and
  // deuteranopia: a dichromat cannot separate blue from purple at all, it
  // is the missing cone. No purple passes; the glyph letter B is the
  // channel for that viewer. Under normal vision the purple must still
  // clear every rim.
  it('keeps every state colour at least 15 from every slot rim, with the two named exceptions', () => {
    const pinned = STATE_RINGS.find((r) => r.key === 'pinned')!;
    const biled = STATE_RINGS.find((r) => r.key === 'biled')!;
    for (const r of STATE_RINGS) {
      for (let slot = 0; slot < 8; slot++) {
        const rim = SLOT_COLORS[slot];
        if (r === pinned && slot === 6) continue;
        if (r === biled && slot < 4) {
          expect(distance(r.color, rim, 'normal')).toBeGreaterThanOrEqual(15);
          continue;
        }
        expect(worst(r.color, rim)).toBeGreaterThanOrEqual(15);
      }
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/src/replay/stateRing.test.ts`
Expected: FAIL, cannot resolve `./stateRing`.

- [ ] **Step 3: Write the module**

`web/src/replay/stateRing.ts`:

```ts
import { STATE } from '../../../src/replayFormat';

/** One state the map colours a ring for. Order in STATE_RINGS is priority:
 *  the first whose bit is set wins, for the ring and the glyph alike. */
export interface StateRing {
  key: 'pinned' | 'incap' | 'ledged' | 'burning' | 'biled';
  bit: number;
  color: string;
  /** The one-letter glyph drawn above the medallion: the colour-blind
   *  channel, so it is in the same table as the colour and cannot drift. */
  glyph: string;
  /** For the Key panel and tooltips. */
  label: string;
}

/**
 * Pinned first because it is the state someone watching needs soonest (a
 * teammate seconds from being carried off), then the two down states, then
 * burning, then biled.
 *
 * Colours, measured with colorDistance.ts under normal vision, protanopia
 * and deuteranopia (stateRing.test.ts enforces the numbers):
 * - pinned moved from the site's rating gold #c9a45c to #e0b654 because the
 *   old gold sat 13.2 dE from the alert red, which is two states one letter
 *   apart on a dichromat's map. The new gold is 23 from red and 16 from
 *   orange; it sits 10 from infected slot 6's gold, accepted by name.
 * - incap and ledged share the site red, as the old alert ring did.
 * - burning orange clears every rim by 22 or more.
 * - biled purple clears every rim by 47 or more under normal vision and
 *   collapses onto the survivor blues for a dichromat, which no purple can
 *   avoid; the B glyph carries it there.
 */
export const STATE_RINGS: readonly StateRing[] = [
  { key: 'pinned', bit: STATE.PINNED, color: '#e0b654', glyph: 'P', label: 'Pinned' },
  { key: 'incap', bit: STATE.INCAP, color: '#de4e40', glyph: 'X', label: 'Down' },
  { key: 'ledged', bit: STATE.LEDGED, color: '#de4e40', glyph: 'L', label: 'Hanging' },
  { key: 'burning', bit: STATE.BURNING, color: '#ff7a1a', glyph: 'F', label: 'Burning' },
  { key: 'biled', bit: STATE.BILED, color: '#a85cf0', glyph: 'B', label: 'Biled' },
];

/** Rim and face treatment for a dead player. Far from every state colour and
 *  from the ghost brick, so "dead" and "unspawned" cannot be confused. */
export const DEAD_COLOR = '#6d675e';

export function stateRing(state: number): StateRing | null {
  if ((state & STATE.ALIVE) === 0) return null;
  for (const r of STATE_RINGS) if ((state & r.bit) !== 0) return r;
  return null;
}

export function stateRingColor(state: number): string | null {
  return stateRing(state)?.color ?? null;
}

/** The one status marker worth showing on the map. Same walk as the ring, so
 *  they can never disagree about which state won. Kept working for a dead or
 *  ghost record too (returns '') because draw.ts gates on those itself. */
export function statusGlyph(state: number): string {
  for (const r of STATE_RINGS) if ((state & r.bit) !== 0) return r.glyph;
  return '';
}
```

- [ ] **Step 4: Point draw.ts at it**

In `web/src/replay/draw.ts`, delete the `statusGlyph` and `alertColor` functions (the block from the `/** The one status marker worth showing on the map` comment through the end of `alertColor`), and add near the top:

```ts
import { DEAD_COLOR, stateRingColor, statusGlyph } from './stateRing';
export { statusGlyph, stateRingColor, DEAD_COLOR };
```

Replace the one call `const alert = alertColor(pl.state);` with `const alert = stateRingColor(pl.state);` (this whole block is rewritten in Task 4; this keeps the build green now).

In `web/src/replay/draw.test.ts`, the `describe('statusGlyph')` block still imports `statusGlyph` from `./draw`, which re-exports it, so it keeps passing unchanged.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run web/src/replay/stateRing.test.ts web/src/replay/draw.test.ts && npm run typecheck`
Expected: PASS. If a palette assertion fails, change the colour value in `STATE_RINGS`, never the threshold or the exception list, and re-measure with a one-off `npx tsx` script calling `distance` from `colorDistance.ts`.

- [ ] **Step 6: Commit**

```bash
git add web/src/replay/stateRing.ts web/src/replay/stateRing.test.ts web/src/replay/draw.ts
git commit -m "feat(replay): state ring table with priority, glyphs and dichromacy-proofed colours"
```

---

### Task 2: Pictograms

**Files:**
- Create: `web/src/replay/pictograms.ts`
- Test: `web/src/replay/pictograms.test.ts`

**Interfaces:**
- Produces: `PICTOGRAM_BOX = 20`, `PICTOGRAMS: Record<PictogramName, string>` with `type PictogramName = 'smoker'|'boomer'|'hunter'|'tank'|'witch'`, `pictogramPath(name: string): Path2D | null` (cached; null for unknown names or when `Path2D` is not defined), `pictogramFor(cls: number): PictogramName | null` mapping `ZOMBIE_CLASSES[cls]`.

- [ ] **Step 1: Write the failing tests**

`web/src/replay/pictograms.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PICTOGRAMS, pictogramFor, pictogramPath, resetPictogramCache } from './pictograms';

/** happy-dom has no Path2D. The stub records the path data it was built from
 *  so a test can prove the right figure was requested. */
class FakePath2D { constructor(public d: string) {} }

describe('pictograms', () => {
  beforeEach(() => { (globalThis as any).Path2D = FakePath2D; resetPictogramCache(); });
  afterEach(() => { delete (globalThis as any).Path2D; resetPictogramCache(); });

  it('has a figure for every special class and the witch', () => {
    for (const name of ['smoker', 'boomer', 'hunter', 'tank', 'witch'] as const) {
      expect(PICTOGRAMS[name]).toMatch(/^M/);
    }
  });

  it('maps the zombie class byte to a figure, and unknown classes to null', () => {
    expect(pictogramFor(1)).toBe('smoker');
    expect(pictogramFor(2)).toBe('boomer');
    expect(pictogramFor(3)).toBe('hunter');
    expect(pictogramFor(5)).toBe('tank');
    expect(pictogramFor(4)).toBe('witch');
    expect(pictogramFor(0)).toBeNull();
    expect(pictogramFor(99)).toBeNull();
  });

  it('builds each Path2D once and hands back the same object', () => {
    const a = pictogramPath('hunter') as unknown as FakePath2D;
    const b = pictogramPath('hunter') as unknown as FakePath2D;
    expect(a).toBe(b);
    expect(a.d).toBe(PICTOGRAMS.hunter);
  });

  it('is null for an unknown name', () => {
    expect(pictogramPath('charger')).toBeNull();
  });

  it('is null when the environment has no Path2D, rather than throwing', () => {
    delete (globalThis as any).Path2D;
    resetPictogramCache();
    expect(pictogramPath('tank')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run web/src/replay/pictograms.test.ts`
Expected: FAIL, cannot resolve `./pictograms`.

- [ ] **Step 3: Write the module**

`web/src/replay/pictograms.ts`:

```ts
import { ZOMBIE_CLASSES } from '../../../src/replayFormat';

export type PictogramName = 'smoker' | 'boomer' | 'hunter' | 'tank' | 'witch';

/** Every figure is drawn in a 0..20 box, feet at the bottom, and is scaled
 *  to the medallion's disc by the caller. Kept as path data rather than PNGs
 *  so a pictogram costs one `fill` and no image load. */
export const PICTOGRAM_BOX = 20;

/** Simplified side-view silhouettes: tall and thin with a tongue for the
 *  smoker, round for the boomer, crouched for the hunter, hulking for the
 *  tank, thin with raised claws for the witch. Recognisable at 16px, which is
 *  all a pictogram inside a 22px medallion gets. */
export const PICTOGRAMS: Record<PictogramName, string> = {
  smoker: 'M8.5 6 h3 a1.4 1.4 0 0 1 1.4 1.4 v7.2 a1.4 1.4 0 0 1 -1.4 1.4 h-3 a1.4 1.4 0 0 1 -1.4 -1.4 v-7.2 a1.4 1.4 0 0 1 1.4 -1.4 Z M10 1.8 a2.2 2.2 0 1 0 0.01 0 Z M11 9 Q17 8 18 14 L16.6 14.4 Q15.8 9.8 11 10.6 Z',
  boomer: 'M10 6 a6.5 5.5 0 1 0 0.01 0 Z M10 2.1 a2.4 2.4 0 1 0 0.01 0 Z',
  hunter: 'M4 15 Q6 7 12 6 Q15 5 16 8 Q14 9 12 10 Q9 12 9 16 Z M14.5 2.8 a2.2 2.2 0 1 0 0.01 0 Z',
  tank: 'M3 17 L4 9 Q6 5 10 5.5 Q14 5 16 9 L17 17 Z M10 1.5 a2 2 0 1 0 0.01 0 Z',
  witch: 'M6 17 Q7 9 10 7 Q13 9 14 17 Z M10 2.1 a2.4 2.4 0 1 0 0.01 0 Z M4 10 Q7 8 8 11 L6.8 11.6 Q6.2 9.8 4.4 11 Z M16 10 Q13 8 12 11 L13.2 11.6 Q13.8 9.8 15.6 11 Z',
};

/** Zombie class byte (`m_zombieClass`, recorded in `cls` for every infected
 *  player in every format version) to figure. 0 is "no class yet". */
export function pictogramFor(cls: number): PictogramName | null {
  const name = ZOMBIE_CLASSES[cls];
  return name && name in PICTOGRAMS ? (name as PictogramName) : null;
}

let cache = new Map<string, Path2D>();

/** For tests: happy-dom has no Path2D, so tests install a stub and must be
 *  able to drop anything built under a previous stub. */
export function resetPictogramCache(): void { cache = new Map(); }

export function pictogramPath(name: string): Path2D | null {
  const d = (PICTOGRAMS as Record<string, string>)[name];
  if (!d || typeof Path2D === 'undefined') return null;
  let p = cache.get(name);
  if (!p) { p = new Path2D(d); cache.set(name, p); }
  return p;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run web/src/replay/pictograms.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/replay/pictograms.ts web/src/replay/pictograms.test.ts
git commit -m "feat(replay): class pictograms as cached Path2D figures"
```

---

### Task 3: The medallion primitive

**Files:**
- Create: `web/src/replay/avatar.ts`
- Test: `web/src/replay/avatar.test.ts`

**Interfaces:**
- Consumes: `pictogramPath` (Task 2), `TEMP_HEALTH_COLOR` from `./hud`.
- Produces:

```ts
export const AVATAR_BASE_R = 11;      // 22px medallion
export const TANK_BASE_R = 15;        // 30px, player tank and AI tank alike
export const ENTITY_MEDAL_R = 9;      // 18px witch, AI specials, survivor bots
export const RIM_W = 2.5;
export const STATE_RING_W = 3;
export const STATE_RING_GAP = 1.5;    // ring radius = r + STATE_RING_GAP
export const ARC_W = 2;
export const ARC_GAP = 5.5;           // arc radius = r + ARC_GAP
export const FOLLOW_RING_GAP = 10;
export const FOLLOW_RING_WIDTH = 2;
export const BADGE_R = 4.5;
export const WEDGE_LEN = 5;
export const DISC_COLOR = '#14110f';

export interface MedallionSpec {
  x: number; y: number; r: number;
  /** Rim colour: slot colour, entity colour, or DEAD_COLOR. */
  rim: string;
  /** Portrait to clip into the disc, if any. */
  face?: HTMLImageElement | null;
  /** Pictogram name to fill in white over the disc, if any. */
  pictogram?: string | null;
  /** Digit badge on the rim's lower right: text plus ink colour. */
  badge?: { text: string; ink: string } | null;
  /** Facing in degrees, 0 along +x, drawn as a wedge on the rim. */
  yaw?: number | null;
  /** State ring colour, drawn under the rim at r + STATE_RING_GAP. */
  ring?: string | null;
  /** Health arc fractions and colour; drawn at r + ARC_GAP. */
  arc?: { perm: number; temp: number; color: string } | null;
  /** Desaturate and dim the face, draw a dagger, no badge or wedge. */
  dead?: boolean;
  /** Ghost: only a hollow ring in `rim`. Everything else is ignored. */
  hollow?: boolean;
  alpha?: number;
  /** The bright follow ring outside everything. */
  follow?: boolean;
}

export function drawMedallion(ctx: CanvasRenderingContext2D, s: MedallionSpec): void;
```

- [ ] **Step 1: Write the failing tests**

`web/src/replay/avatar.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AVATAR_BASE_R, ARC_GAP, DISC_COLOR, STATE_RING_GAP, drawMedallion, type MedallionSpec,
} from './avatar';
import { resetPictogramCache } from './pictograms';
import { TEMP_HEALTH_COLOR } from './hud';

class FakePath2D { constructor(public d: string) {} }

/** Records every context call with the paint state at the time. `fill` and
 *  `stroke` are recorded with the Path2D argument when one was passed, so a
 *  test can tell a pictogram fill from a disc fill. */
function stubCtx() {
  const calls: { fn: string; args: unknown[]; fill: string; stroke: string; width: number; alpha: number }[] = [];
  let fillStyle = ''; let strokeStyle = ''; let lineWidth = 0; let globalAlpha = 1;
  const rec = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args, fill: fillStyle, stroke: strokeStyle, width: lineWidth, alpha: globalAlpha });
  };
  const ctx = {
    save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'), closePath: rec('closePath'),
    arc: rec('arc'), moveTo: rec('moveTo'), lineTo: rec('lineTo'), fill: rec('fill'), stroke: rec('stroke'),
    clip: rec('clip'), drawImage: rec('drawImage'), fillText: rec('fillText'), strokeText: rec('strokeText'),
    translate: rec('translate'), scale: rec('scale'), rotate: rec('rotate'),
    set fillStyle(v: string) { fillStyle = v; }, set strokeStyle(v: string) { strokeStyle = v; },
    set lineWidth(v: number) { lineWidth = v; }, set globalAlpha(v: number) { globalAlpha = v; },
    set font(_v: string) {}, set textAlign(_v: string) {}, set textBaseline(_v: string) {},
    set filter(_v: string) {}, set lineCap(_v: string) {},
  } as unknown as CanvasRenderingContext2D;
  return { calls, ctx };
}

const face = { width: 64, height: 64 } as HTMLImageElement;
const base: MedallionSpec = { x: 100, y: 50, r: AVATAR_BASE_R, rim: '#57a7f1' };

describe('drawMedallion', () => {
  beforeEach(() => { (globalThis as any).Path2D = FakePath2D; resetPictogramCache(); });
  afterEach(() => { delete (globalThis as any).Path2D; resetPictogramCache(); });

  it('clips the portrait into the disc and strokes the rim in the slot colour', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, { ...base, face });
    const clip = calls.findIndex((c) => c.fn === 'clip');
    const img = calls.findIndex((c) => c.fn === 'drawImage');
    expect(clip).toBeGreaterThan(-1);
    expect(img).toBeGreaterThan(clip);
    // Drawn to the disc's bounding square: x - r, y - r, 2r, 2r.
    expect(calls[img].args.slice(1)).toEqual([100 - 11, 50 - 11, 22, 22]);
    const rim = calls.filter((c) => c.fn === 'stroke' && c.stroke === '#57a7f1');
    expect(rim.length).toBeGreaterThan(0);
  });

  it('fills the pictogram over a dark disc when there is no face', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, { ...base, rim: '#cc4760', pictogram: 'hunter' });
    expect(calls.some((c) => c.fn === 'fill' && c.fill === DISC_COLOR)).toBe(true);
    const pict = calls.find((c) => c.fn === 'fill' && c.args[0] instanceof FakePath2D);
    expect(pict).toBeTruthy();
    expect(pict!.fill).toBe('#ffffff');
    expect(calls.some((c) => c.fn === 'drawImage')).toBe(false);
  });

  it('draws the state ring under the rim at r + gap, and the arc outside at r + arc gap', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, { ...base, ring: '#a85cf0', arc: { perm: 0.5, temp: 0.25, color: '#45b39c' } });
    const arcs = calls.filter((c) => c.fn === 'arc');
    const ring = arcs.find((c) => c.args[2] === AVATAR_BASE_R + STATE_RING_GAP);
    expect(ring).toBeTruthy();
    const ringStroke = calls[calls.indexOf(ring!) + 1];
    expect(ringStroke.fn).toBe('stroke');
    expect(ringStroke.stroke).toBe('#a85cf0');
    const health = arcs.filter((c) => c.args[2] === AVATAR_BASE_R + ARC_GAP);
    // Permanent then temporary: two arcs at the arc radius.
    expect(health).toHaveLength(2);
    const [perm, temp] = health;
    expect(perm.args[3]).toBeCloseTo(-Math.PI / 2);
    expect(perm.args[4]).toBeCloseTo(-Math.PI / 2 + Math.PI);
    expect(temp.args[4]).toBeCloseTo(-Math.PI / 2 + Math.PI * 1.5);
    expect(calls[calls.indexOf(temp) + 1].stroke).toBe(TEMP_HEALTH_COLOR);
  });

  it('draws the badge digit and the facing wedge for a living player', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, { ...base, badge: { text: '3', ink: '#0b0908' }, yaw: 90 });
    const digit = calls.find((c) => c.fn === 'fillText');
    expect(digit?.args[0]).toBe('3');
    expect(digit?.fill).toBe('#0b0908');
    // yaw 90 is straight up on screen (canvas y grows down), so the wedge's
    // apex sits above the centre.
    const wedge = calls.filter((c) => c.fn === 'lineTo');
    expect(wedge.length).toBeGreaterThanOrEqual(2);
    const apexY = Math.min(...calls.filter((c) => c.fn === 'moveTo' || c.fn === 'lineTo').map((c) => c.args[1] as number));
    expect(apexY).toBeLessThan(50 - AVATAR_BASE_R);
  });

  it('a hollow ghost is one stroked arc in the rim colour and nothing else', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, {
      ...base, rim: '#9c5f5a', hollow: true, alpha: 0.35,
      face, pictogram: 'hunter', badge: { text: '1', ink: '#fff' }, yaw: 0,
      ring: '#a85cf0', arc: { perm: 1, temp: 0, color: '#45b39c' }, follow: true,
    });
    expect(calls.filter((c) => c.fn === 'arc')).toHaveLength(1);
    expect(calls.filter((c) => c.fn === 'stroke')).toHaveLength(1);
    expect(calls.find((c) => c.fn === 'stroke')!.stroke).toBe('#9c5f5a');
    expect(calls.find((c) => c.fn === 'stroke')!.alpha).toBe(0.35);
    for (const fn of ['fill', 'drawImage', 'fillText', 'lineTo', 'clip']) {
      expect(calls.filter((c) => c.fn === fn)).toHaveLength(0);
    }
  });

  it('a dead player gets a dagger and keeps face and rim, with no badge, wedge or arc', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, {
      ...base, rim: '#6d675e', dead: true, face,
      badge: { text: '2', ink: '#fff' }, yaw: 45, arc: { perm: 1, temp: 0, color: '#45b39c' },
    });
    expect(calls.some((c) => c.fn === 'drawImage')).toBe(true);
    const texts = calls.filter((c) => c.fn === 'fillText').map((c) => c.args[0]);
    expect(texts).toEqual(['†']);
    expect(calls.filter((c) => c.fn === 'arc' && c.args[2] === AVATAR_BASE_R + ARC_GAP)).toHaveLength(0);
    expect(calls.filter((c) => c.fn === 'lineTo')).toHaveLength(0);
  });

  it('draws the follow ring outside everything, white over a dark halo', () => {
    const { calls, ctx } = stubCtx();
    drawMedallion(ctx, { ...base, follow: true });
    const strokes = calls.filter((c) => c.fn === 'stroke');
    const last = strokes[strokes.length - 1];
    const halo = strokes[strokes.length - 2];
    expect(last.stroke).toBe('#ffffff');
    expect(halo.stroke).toBe('rgba(0,0,0,0.85)');
    expect(halo.width).toBeGreaterThan(last.width);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run web/src/replay/avatar.test.ts`
Expected: FAIL, cannot resolve `./avatar`.

- [ ] **Step 3: Write the module**

`web/src/replay/avatar.ts`:

```ts
import { pictogramPath, PICTOGRAM_BOX } from './pictograms';
import { TEMP_HEALTH_COLOR } from './hud';

/** Base radii, CSS pixels, fixed at every zoom. */
export const AVATAR_BASE_R = 11;
export const TANK_BASE_R = 15;
export const ENTITY_MEDAL_R = 9;
export const RIM_W = 2.5;
/** A 1px near-black edge outside the rim so a cyan rim survives pale map. */
export const RIM_EDGE_W = 1;
export const STATE_RING_W = 3;
export const STATE_RING_GAP = 1.5;
export const ARC_W = 2;
export const ARC_GAP = 5.5;
export const FOLLOW_RING_GAP = 10;
export const FOLLOW_RING_WIDTH = 2;
export const BADGE_R = 4.5;
export const BADGE_FONT_PX = 7;
export const WEDGE_LEN = 5;
export const WEDGE_HALF_W = 3.2;
export const DISC_COLOR = '#14110f';
export const HALO = 'rgba(0,0,0,0.85)';

export interface MedallionSpec {
  x: number; y: number; r: number;
  rim: string;
  face?: HTMLImageElement | null;
  pictogram?: string | null;
  badge?: { text: string; ink: string } | null;
  yaw?: number | null;
  ring?: string | null;
  arc?: { perm: number; temp: number; color: string } | null;
  dead?: boolean;
  hollow?: boolean;
  alpha?: number;
  follow?: boolean;
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

/**
 * One medallion: state ring, rim edge, rim, disc, face or pictogram, wedge,
 * badge, arc, follow ring, in that order so each sits over the last.
 *
 * A hollow spec (a ghost) is one stroked circle and returns early: the
 * anti-ghosting rule is enforced here, structurally, rather than by every
 * caller remembering to leave fields blank.
 */
export function drawMedallion(ctx: CanvasRenderingContext2D, s: MedallionSpec): void {
  const { x, y, r } = s;
  ctx.save();
  ctx.globalAlpha = s.alpha ?? 1;

  if (s.hollow) {
    circle(ctx, x, y, r);
    ctx.strokeStyle = s.rim;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (s.ring) {
    circle(ctx, x, y, r + STATE_RING_GAP);
    ctx.strokeStyle = s.ring;
    ctx.lineWidth = STATE_RING_W;
    ctx.stroke();
  }

  // Rim: dark edge first, colour on top, so the colour keeps its full width.
  circle(ctx, x, y, r);
  ctx.strokeStyle = HALO;
  ctx.lineWidth = RIM_W + RIM_EDGE_W * 2;
  ctx.stroke();
  circle(ctx, x, y, r);
  ctx.strokeStyle = s.rim;
  ctx.lineWidth = RIM_W;
  ctx.stroke();

  // Disc, then the face clipped to it or the pictogram over it.
  const inner = r - RIM_W / 2;
  circle(ctx, x, y, inner);
  ctx.fillStyle = DISC_COLOR;
  ctx.fill();
  if (s.face) {
    ctx.save();
    circle(ctx, x, y, inner);
    ctx.clip();
    if (s.dead) ctx.filter = 'grayscale(1) brightness(0.55)';
    ctx.drawImage(s.face, x - r, y - r, r * 2, r * 2);
    ctx.restore();
  } else if (s.pictogram) {
    const path = pictogramPath(s.pictogram);
    if (path) {
      ctx.save();
      const scale = (inner * 2 * 0.72) / PICTOGRAM_BOX;
      ctx.translate(x - (PICTOGRAM_BOX * scale) / 2, y - (PICTOGRAM_BOX * scale) / 2);
      ctx.scale(scale, scale);
      ctx.fillStyle = s.dead ? '#8a8a8a' : '#ffffff';
      ctx.fill(path);
      ctx.restore();
    }
  }

  if (s.dead) {
    ctx.font = `bold ${Math.round(r * 1.1)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = HALO;
    ctx.strokeText('†', x, y + 1);
    ctx.fillStyle = '#c9c9c9';
    ctx.fillText('†', x, y + 1);
  } else {
    if (typeof s.yaw === 'number') {
      // Yaw is degrees with 0 along +x and canvas y grows down, so the sine
      // is negated (same convention the old arrow used).
      const a = (s.yaw * Math.PI) / 180;
      const dx = Math.cos(a); const dy = -Math.sin(a);
      const bx = x + dx * r; const by = y + dy * r;        // base centre, on the rim
      const ax = x + dx * (r + WEDGE_LEN); const ay = y + dy * (r + WEDGE_LEN);
      const px = -dy; const py = dx;                       // perpendicular
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx + px * WEDGE_HALF_W, by + py * WEDGE_HALF_W);
      ctx.lineTo(bx - px * WEDGE_HALF_W, by - py * WEDGE_HALF_W);
      ctx.closePath();
      ctx.fillStyle = s.rim;
      ctx.fill();
      ctx.strokeStyle = HALO;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (s.badge) {
      const bx = x + r * Math.SQRT1_2; const by = y + r * Math.SQRT1_2;
      circle(ctx, bx, by, BADGE_R);
      ctx.fillStyle = s.rim;
      ctx.fill();
      ctx.strokeStyle = HALO;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.font = `bold ${BADGE_FONT_PX}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = s.badge.ink;
      ctx.fillText(s.badge.text, bx, by + 0.5);
    }
    if (s.arc) {
      const R = r + ARC_GAP;
      const start = -Math.PI / 2;
      const mid = start + s.arc.perm * Math.PI * 2;
      ctx.lineWidth = ARC_W;
      ctx.beginPath();
      ctx.arc(x, y, R, start, mid);
      ctx.strokeStyle = s.arc.color;
      ctx.stroke();
      // Always issued, even at zero temp, so the two arcs are one shape to
      // test against; a zero-length arc paints nothing.
      ctx.beginPath();
      ctx.arc(x, y, R, mid, mid + s.arc.temp * Math.PI * 2);
      ctx.strokeStyle = TEMP_HEALTH_COLOR;
      ctx.stroke();
    }
  }

  if (s.follow) {
    circle(ctx, x, y, r + FOLLOW_RING_GAP);
    ctx.strokeStyle = HALO;
    ctx.lineWidth = FOLLOW_RING_WIDTH + 2;
    ctx.stroke();
    circle(ctx, x, y, r + FOLLOW_RING_GAP);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = FOLLOW_RING_WIDTH;
    ctx.stroke();
  }
  ctx.restore();
}
```

Note the arc test in Step 1 expects exactly two arcs at `r + ARC_GAP`; the implementation above always issues both. The hollow test expects one arc and one stroke: the early return guarantees it.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run web/src/replay/avatar.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/replay/avatar.ts web/src/replay/avatar.test.ts
git commit -m "feat(replay): medallion primitive with rim, face or pictogram, wedge, badge, state ring, arc"
```

---

### Task 4: Players drawn as medallions

**Files:**
- Modify: `web/src/replay/draw.ts` (player loop, `avatarRadius`, label gap, `DrawArgs.portraits`)
- Modify: `web/src/replay/draw.test.ts` (ghost, health arc, radius tests)
- Create: `web/src/replay/usePortraits.ts`
- Modify: `web/src/replay/ReplayCanvas.tsx`, `web/src/replay/Viewer.tsx` (thread `portraits`)

**Interfaces:**
- Consumes: `drawMedallion`, radii constants (Task 3); `stateRingColor`, `statusGlyph`, `DEAD_COLOR` (Task 1); `pictogramFor` (Task 2); `portraitFor` from `./hud`; `healthBar` from `./hud`.
- Produces: `DrawArgs.portraits: Record<string, HTMLImageElement>` keyed by portrait URL (the string `portraitFor` returns); `avatarRadius(z, medianZ, base = AVATAR_BASE_R)`; `playerBaseRadius(p: PlayerSample): number` (15 for a player tank, else 11); `usePortraits(): Record<string, HTMLImageElement>`.

- [ ] **Step 1: Update the tests first**

In `web/src/replay/draw.test.ts`:

1. `describe('avatarRadius')`: change `it('is the base size at the team median')` to expect `avatarRadius(100, 100)` to be `11` (was 7), and add:

```ts
  it('gives a player tank the big base radius', () => {
    expect(playerBaseRadius(player({ slot: 4, cls: 5, infected: true }))).toBe(15);
    expect(playerBaseRadius(player({ slot: 4, cls: 3, infected: true }))).toBe(11);
    expect(playerBaseRadius(player({ slot: 0, cls: 5, infected: false }))).toBe(11);
  });
```

(`player()` is the fixture helper already in that file; add `playerBaseRadius` to the import from `./draw`.)

2. In the `stubCtx()` inside `describe('drawScene')`, add recorders for the new calls the medallion makes, keeping the existing shape: add `clip: rec('clip'), closePath: rec('closePath'), translate: rec('translate'), scale: rec('scale'), rotate: rec('rotate')` and `set filter(_v: string) {}, set lineCap(_v: string) {}` to the object, and change `rec` to keep non-numeric args too in a second field:

```ts
    const rec = (fn: string) => (...args: unknown[]) => {
      calls.push({
        fn,
        args: args.filter((a) => typeof a === 'number') as number[],
        raw: args,
        stroke: strokeStyle, fill: fillStyle, width: lineWidth,
      });
    };
```

and add `raw: unknown[]` to the `calls` element type.

3. Every `drawScene(ctx, { ... })` call in the file gains `portraits: {}` (the type requires it). Do this with a search for `followSlot:` inside the file and add `portraits: {},` on the line before each.

4. Replace the two ghost tests' expectations:
   - `'keeps a ghost hollow: ...'`: expect exactly one `arc`, zero `fill`, zero `drawImage`, zero `clip`, zero texts, and exactly ONE stroke, in `GHOST_COLOR` (the facing arrow is gone: a ghost now has no wedge).
   - `'draws every ghost in one muted colour...'`: unchanged assertions apart from the stroke count if it asserts one; check and set to 1.

5. Replace `'draws the health ring as an arc spanning health/100...'` and the two temp-arc tests so they look for arcs at radius `r + ARC_GAP` where `r = AVATAR_BASE_R` (import both from `./avatar`), instead of the old `r + 3`. The sweep assertions stay the same numbers.

6. Add:

```ts
  it('draws a survivor face from the portraits map, clipped, for a format 2 file', () => {
    const { transform, view } = identityScene();
    const { calls, ctx } = stubCtx();
    const img = { width: 64, height: 64 } as HTMLImageElement;
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0, cls: 2, infected: false, state: STATE.PRESENT | STATE.ALIVE, health: 100 })],
      entities: [], show: { ci: true, entities: true, names: false },
      width: 1280, height: 794, names: {}, slots: ['', '', '', '', '', '', '', ''],
      followSlot: null, portraits: { '/portraits/francis.png': img }, version: 2,
    });
    const draw = calls.find((c) => c.fn === 'drawImage');
    expect(draw?.raw[0]).toBe(img);
    expect(calls.some((c) => c.fn === 'clip')).toBe(true);
  });

  it('draws the silhouette, not a face, for a format 1 survivor', () => {
    const { transform, view } = identityScene();
    const { calls, ctx } = stubCtx();
    const face = { width: 64, height: 64 } as HTMLImageElement;
    const unknown = { width: 128, height: 128 } as HTMLImageElement;
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0, cls: 2, infected: false, state: STATE.PRESENT | STATE.ALIVE, health: 100 })],
      entities: [], show: { ci: true, entities: true, names: false },
      width: 1280, height: 794, names: {}, slots: ['', '', '', '', '', '', '', ''],
      followSlot: null, portraits: { '/portraits/francis.png': face, '/portraits/unknown.png': unknown }, version: 1,
    });
    expect(calls.find((c) => c.fn === 'drawImage')?.raw[0]).toBe(unknown);
  });

  it('draws a dead survivor in the dead grey with a dagger and no arc', () => {
    const { transform, view } = identityScene();
    const { calls, texts, ctx } = stubCtx();
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 1, infected: false, state: STATE.PRESENT, health: 0 })],
      entities: [], show: { ci: true, entities: true, names: false },
      width: 1280, height: 794, names: {}, slots: ['', '', '', '', '', '', '', ''],
      followSlot: null, portraits: {}, version: 3,
    });
    expect(calls.some((c) => c.fn === 'stroke' && c.stroke === DEAD_COLOR)).toBe(true);
    expect(texts.map((t) => t.text)).toEqual(['†']);
    expect(calls.filter((c) => c.fn === 'arc' && c.args[2] === AVATAR_BASE_R + ARC_GAP)).toHaveLength(0);
  });

  it('gives a living player tank the big radius and an arc over the 8000 pool', () => {
    const { transform, view } = identityScene();
    const { calls, ctx } = stubCtx();
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 5, cls: 5, infected: true, state: STATE.PRESENT | STATE.ALIVE, health: 4000, temp: 0 })],
      entities: [], show: { ci: true, entities: true, names: false },
      width: 1280, height: 794, names: {}, slots: ['', '', '', '', '', '', '', ''],
      followSlot: null, portraits: {}, version: 3,
    });
    const arc = calls.find((c) => c.fn === 'arc' && c.args[2] === TANK_BASE_R + ARC_GAP);
    expect(arc).toBeTruthy();
    expect(arc!.args[4] - arc!.args[3]).toBeCloseTo(Math.PI);
  });

  it('colours the state ring by priority and puts the glyph above', () => {
    const { transform, view } = identityScene();
    const { calls, texts, ctx } = stubCtx();
    drawScene(ctx, {
      transform, view, backdrop: null, trail: [],
      players: [player({ slot: 0, infected: false, state: STATE.PRESENT | STATE.ALIVE | STATE.BILED | STATE.INCAP, health: 20 })],
      entities: [], show: { ci: true, entities: true, names: false },
      width: 1280, height: 794, names: {}, slots: ['', '', '', '', '', '', '', ''],
      followSlot: null, portraits: {}, version: 3,
    });
    const ring = calls.find((c) => c.fn === 'arc' && c.args[2] === AVATAR_BASE_R + STATE_RING_GAP);
    expect(calls[calls.indexOf(ring!) + 1].stroke).toBe(stateRingColor(STATE.INCAP));
    expect(texts.some((t) => t.text === 'X')).toBe(true);
  });
```

Import `AVATAR_BASE_R, ARC_GAP, STATE_RING_GAP, TANK_BASE_R` from `./avatar`, `DEAD_COLOR, stateRingColor` from `./stateRing`. The `player()` fixture must accept `cls`, `temp` and `infected` overrides; check its definition at the top of the file and extend the defaults with `cls: 0, temp: 0, infected: undefined` if missing.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run web/src/replay/draw.test.ts`
Expected: FAIL on `portraits`/`version` not in `DrawArgs`, `playerBaseRadius` missing, radius 7 vs 11.

- [ ] **Step 3: Rewrite the player loop in draw.ts**

In `web/src/replay/draw.ts`:

1. Imports:

```ts
import {
  AVATAR_BASE_R, TANK_BASE_R, FOLLOW_RING_GAP, drawMedallion,
} from './avatar';
import { DEAD_COLOR, stateRingColor, statusGlyph } from './stateRing';
import { pictogramFor } from './pictograms';
import { healthBar, portraitFor } from './hud';
import { ZOMBIE_CLASSES } from '../../../src/replayFormat';
```

Delete the old `HEALTH_RING_GAP`, `HEALTH_RING_WIDTH`, `ALERT_RING_WIDTH`, `FOLLOW_RING_GAP`, `FOLLOW_RING_WIDTH` constants and `SLOT_NUMBER_PX` (the badge replaces the centre digit). Re-export `FOLLOW_RING_WIDTH` from `./avatar` if anything imports it from `./draw` (grep first; `useCamera` or tests may).

2. `avatarRadius` default base becomes `AVATAR_BASE_R`, and add:

```ts
/** A player tank is drawn at the AI tank's size: the biggest thing on the
 *  field is the biggest thing on the map. `cls` 5 is the tank in
 *  `m_zombieClass`, the same test HudStrip.maxHealthFor makes. */
export function playerBaseRadius(p: PlayerSample): number {
  return !isSurvivor(p) && ZOMBIE_CLASSES[p.cls] === 'tank' ? TANK_BASE_R : AVATAR_BASE_R;
}

/** The health pool a player's arc is drawn over. */
export function maxHealthOf(p: PlayerSample): number {
  return !isSurvivor(p) && ZOMBIE_CLASSES[p.cls] === 'tank' ? 8000 : 100;
}
```

3. `DrawArgs` gains:

```ts
  /** Decoded portrait images by URL (the string `portraitFor` returns). An
   *  image not yet loaded is simply absent and the disc draws without it. */
  portraits: Record<string, HTMLImageElement>;
  /** Replay format version, for `portraitFor`'s "is the character byte
   *  real" check. */
  version: number;
```

4. Constants: `GLYPH_GAP` becomes `FOLLOW_RING_GAP + 3` (13), `LABEL_GAP` becomes `FOLLOW_RING_GAP + LABEL_PAD_X + 4` (17) so the plate's left edge sits at `r + 14`, clear of the follow halo at `r + 12`. Update the comments above them to say why.

5. Replace the body of the player loop (from `const r = avatarRadius(pl.z, median);` down to, and including, the follow highlight block) with:

```ts
    const r = avatarRadius(pl.z, median, playerBaseRadius(pl));
    const color = slotColor(pl.slot);
    const ghost = (pl.state & STATE.GHOST) !== 0;
    const survivor = isSurvivor(pl);

    if (ghost) {
      // The whole anti-ghosting contract in one call: hollow, muted, no
      // chrome. drawMedallion ignores every other field when `hollow` is set.
      drawMedallion(ctx, { x: p.px, y: p.py, r, rim: GHOST_COLOR, hollow: true, alpha: 0.35 });
      continue;
    }

    const faceUrl = survivor ? portraitFor(pl.cls, a.version, true) : null;
    const face = faceUrl ? a.portraits[faceUrl] ?? null : null;
    const pictogram = survivor ? null : pictogramFor(pl.cls);
    const bar = alive ? healthBar(pl.health, pl.temp, maxHealthOf(pl), pl.state) : null;
    // Survivors always carry an arc; among infected only the tank has a pool
    // worth reading (HudStrip draws the same two cases).
    const arc = bar && (survivor || ZOMBIE_CLASSES[pl.cls] === 'tank')
      ? { perm: bar.perm, temp: bar.temp, color: bar.color } : null;

    drawMedallion(ctx, {
      x: p.px, y: p.py, r,
      rim: alive ? color : DEAD_COLOR,
      face,
      pictogram,
      badge: alive ? { text: slotNumber(pl.slot), ink: numberInk(color) } : null,
      yaw: alive ? pl.yaw : null,
      ring: alive ? stateRingColor(pl.state) : null,
      arc,
      dead: !alive,
      alpha: alive ? 1 : 0.7,
      follow: a.followSlot === pl.slot,
    });

    // Status glyph above the medallion: the colour-blind channel for the
    // ring, from the same table, so the two cannot disagree.
    const glyph = alive ? statusGlyph(pl.state) : '';
    if (glyph) {
      const gy = p.py - r - GLYPH_GAP;
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(glyph, p.px, gy);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(glyph, p.px, gy);
    }

    if (a.show.names) {
      const name = a.names[a.slots[pl.slot]] || slotLabel(pl.slot);
      labels.push({
        ax: p.px + r, ay: p.py,
        px: p.px + r + LABEL_GAP, py: p.py,
        text: name, color: alive ? color : DEAD_COLOR,
      });
    }
```

Keep the `ctx.save()` / `ctx.restore()` around each player and the `if ((pl.state & STATE.PRESENT) === 0) continue;` guard and `const alive = ...` line above this block. Remove the old arrow, centre digit, health ring, alert ring and follow ring code entirely.

6. `sceneCounts`, labels and everything else stay.

- [ ] **Step 4: The portraits hook and the wiring**

`web/src/replay/usePortraits.ts`:

```ts
import { useEffect, useState } from 'preact/hooks';
import { SURVIVOR_CHARACTERS } from '../../../src/replayFormat';

/** Every portrait the map can ask for. `portraitFor` in hud.ts builds the
 *  same URLs; this list exists so they load once, up front, rather than on
 *  the first frame that needs each. */
export const PORTRAIT_URLS: readonly string[] = [
  ...SURVIVOR_CHARACTERS.map((n) => `/portraits/${n}.png`),
  '/portraits/unknown.png',
];

/**
 * Decoded portraits by URL, filled in as each finishes loading.
 *
 * A fresh object on every load rather than a mutated one, because the canvas
 * repaints on prop identity: the paused viewer that first drew discs with no
 * faces has to be told to draw again once the faces exist.
 */
export function usePortraits(): Record<string, HTMLImageElement> {
  const [loaded, setLoaded] = useState<Record<string, HTMLImageElement>>({});
  useEffect(() => {
    let cancelled = false;
    for (const url of PORTRAIT_URLS) {
      const img = new Image();
      img.onload = () => { if (!cancelled) setLoaded((m) => ({ ...m, [url]: img })); };
      img.src = url;
    }
    return () => { cancelled = true; };
  }, []);
  return loaded;
}
```

In `ReplayCanvas.tsx`: add `portraits: Record<string, HTMLImageElement>; version: number;` to `ReplayCanvasProps`, pass both through to `drawScene` in `paint`, and add `props.portraits, props.version` to the repaint effect's dependency list.

In `Viewer.tsx`: `const portraits = usePortraits();` after `useToggles()`, and pass `portraits={portraits} version={header.version}` to `<ReplayCanvas>`.

`renderRate.test.tsx` and `Viewer.test.tsx` may construct `ReplayCanvas` props directly; run the suite and add `portraits: {}` / `version: 1` where the type demands.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run web/src/replay && npm run typecheck`
Expected: PASS. Then open the local viewer (`pug-dev` launch config, `/replay/file/pug_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_0_1.rpl`, zoom 4x) and confirm the medallions draw with silhouettes, rims, badges and wedges. Screenshot for the record.

- [ ] **Step 6: Commit**

```bash
git add web/src/replay
git commit -m "feat(replay): players as portrait medallions with rim, badge, wedge, state ring and arc"
```

---

### Task 5: World entities at the medium scale

**Files:**
- Modify: `web/src/replay/draw.ts` (`ENTITY_STYLES`, entity loop, `DrawArgs.entitiesPrev`, `DrawArgs.witchStartled`)
- Modify: `web/src/replay/draw.test.ts`
- Modify: `web/src/replay/ReplayCanvas.tsx` (pass `pair.a.entities`)

**Interfaces:**
- Consumes: `drawMedallion`, `ENTITY_MEDAL_R`, `TANK_BASE_R` (Task 3).
- Produces: `ENTITY_STYLES: Record<number, { color: string; radius: number; shape: 'figure' | 'medallion' | 'rock' | 'dot'; pictogram?: string }>`, `entityStyle(kind)` unchanged signature plus `shape`; `DrawArgs.entitiesPrev: EntitySample[]`, `DrawArgs.witchStartled: boolean`; `ROCK_STREAK_PX = 12`.

- [ ] **Step 1: Write the failing tests**

Add to `draw.test.ts`:

```ts
describe('entity styles', () => {
  it('sizes and shapes every kind as the spec table says', () => {
    expect(entityStyle(ENTITY_KIND.COMMON)).toMatchObject({ radius: 3.5, shape: 'figure' });
    expect(entityStyle(ENTITY_KIND.WITCH)).toMatchObject({ radius: 9, shape: 'medallion', pictogram: 'witch' });
    expect(entityStyle(ENTITY_KIND.TANK_ROCK)).toMatchObject({ radius: 5, shape: 'rock' });
    expect(entityStyle(ENTITY_KIND.TANK_AI)).toMatchObject({ radius: 15, shape: 'medallion', pictogram: 'tank' });
    expect(entityStyle(ENTITY_KIND.SURVIVOR_BOT)).toMatchObject({ radius: 9, shape: 'medallion' });
    expect(entityStyle(ENTITY_KIND.SMOKER_AI)).toMatchObject({ radius: 9, shape: 'medallion', pictogram: 'smoker' });
    expect(entityStyle(ENTITY_KIND.BOOMER_AI)).toMatchObject({ radius: 9, shape: 'medallion', pictogram: 'boomer' });
    expect(entityStyle(ENTITY_KIND.HUNTER_AI)).toMatchObject({ radius: 9, shape: 'medallion', pictogram: 'hunter' });
  });

  it('keeps every entity colour unchanged, since the slot palette was tested against them', () => {
    expect(entityStyle(ENTITY_KIND.COMMON)!.color).toBe('#6b6f57');
    expect(entityStyle(ENTITY_KIND.HUNTER_AI)!.color).toBe('#8d6bb0');
  });
});
```

And inside `describe('drawScene')`:

```ts
  const baseArgs = (transform: MapTransform, view: View) => ({
    transform, view, backdrop: null, trail: [], players: [], entitiesPrev: [],
    show: { ci: true, entities: true, names: false }, width: 1280, height: 794,
    names: {}, slots: ['', '', '', '', '', '', '', ''], followSlot: null,
    portraits: {}, version: 3, witchStartled: false,
  });

  it('draws a common as a two-part figure, not a dot', () => {
    const { transform, view } = identityScene();
    const { calls, ctx } = stubCtx();
    drawScene(ctx, { ...baseArgs(transform, view), entities: [{ ref: 1, kind: ENTITY_KIND.COMMON, state: 0, x: 640, y: -300, z: 0, health: 50 }] });
    // Body ellipse plus head disc: two fills in the common colour family.
    expect(calls.filter((c) => c.fn === 'fill').length).toBe(2);
    expect(calls.some((c) => c.fn === 'ellipse')).toBe(true);
  });

  it('draws an AI hunter as an 18px medallion with the hunter pictogram and no badge', () => {
    const { transform, view } = identityScene();
    const { calls, texts, ctx } = stubCtx();
    drawScene(ctx, { ...baseArgs(transform, view), entities: [{ ref: 1, kind: ENTITY_KIND.HUNTER_AI, state: 0, x: 640, y: -300, z: 0, health: 250 }] });
    expect(calls.some((c) => c.fn === 'arc' && c.args[2] === ENTITY_MEDAL_R && c.stroke === '')).toBe(true);
    expect(calls.some((c) => c.fn === 'fill' && c.raw[0] instanceof FakePath2D)).toBe(true);
    expect(texts).toHaveLength(0);
  });

  it('draws a rock as a polygon with a streak back along its travel', () => {
    const { transform, view } = identityScene();
    const { calls, ctx } = stubCtx();
    drawScene(ctx, {
      ...baseArgs(transform, view),
      entitiesPrev: [{ ref: 7, kind: ENTITY_KIND.TANK_ROCK, state: 0, x: 600, y: -300, z: 0, health: 0 }],
      entities: [{ ref: 7, kind: ENTITY_KIND.TANK_ROCK, state: 0, x: 640, y: -300, z: 0, health: 0 }],
    });
    // Six-sided polygon: one moveTo and five lineTo, then the streak's own
    // moveTo/lineTo pair.
    expect(calls.filter((c) => c.fn === 'lineTo').length).toBe(6);
    const streak = calls.filter((c) => c.fn === 'stroke').pop()!;
    expect(streak.stroke).toBe('#b07a3c');
  });

  it('draws no streak for a rock that has not moved', () => {
    const { transform, view } = identityScene();
    const { calls, ctx } = stubCtx();
    const rock = { ref: 7, kind: ENTITY_KIND.TANK_ROCK, state: 0, x: 640, y: -300, z: 0, health: 0 };
    drawScene(ctx, { ...baseArgs(transform, view), entitiesPrev: [rock], entities: [rock] });
    expect(calls.filter((c) => c.fn === 'lineTo').length).toBe(5);
  });

  it('turns the witch rim red once startled', () => {
    const { transform, view } = identityScene();
    const witch = { ref: 3, kind: ENTITY_KIND.WITCH, state: 0, x: 640, y: -300, z: 0, health: 1000 };
    const calm = stubCtx();
    drawScene(calm.ctx, { ...baseArgs(transform, view), entities: [witch] });
    expect(calm.calls.some((c) => c.fn === 'stroke' && c.stroke === '#e8e8e8')).toBe(true);
    const mad = stubCtx();
    drawScene(mad.ctx, { ...baseArgs(transform, view), entities: [witch], witchStartled: true });
    expect(mad.calls.some((c) => c.fn === 'stroke' && c.stroke === '#de4e40')).toBe(true);
    expect(mad.calls.some((c) => c.fn === 'stroke' && c.stroke === '#e8e8e8')).toBe(false);
  });
```

Add `ellipse: rec('ellipse')` to the stub, `FakePath2D` global install in a `beforeEach` for the `drawScene` describe (as in avatar.test.ts, with `resetPictogramCache`), and import `ENTITY_MEDAL_R` from `./avatar`. Every existing `drawScene` call gains `entitiesPrev: [], witchStartled: false` (or switch them to spread `baseArgs`).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run web/src/replay/draw.test.ts`
Expected: FAIL on missing `shape`, `entitiesPrev`, `witchStartled`.

- [ ] **Step 3: Implement**

In `draw.ts`:

```ts
export type EntityShape = 'figure' | 'medallion' | 'rock' | 'dot';
export interface EntityStyle { color: string; radius: number; shape: EntityShape; pictogram?: string }

/** Colours are unchanged from the dot era, because the slot palette's tests
 *  measure against them. Sizes and shapes are the spec's "medium" scale:
 *  next to a 22px medallion a 4px common was gravel and a 6px rock a crumb. */
const ENTITY_STYLES: Record<number, EntityStyle> = {
  [ENTITY_KIND.COMMON]: { color: '#6b6f57', radius: 3.5, shape: 'figure' },
  [ENTITY_KIND.WITCH]: { color: '#e8e8e8', radius: ENTITY_MEDAL_R, shape: 'medallion', pictogram: 'witch' },
  [ENTITY_KIND.TANK_ROCK]: { color: '#b07a3c', radius: 5, shape: 'rock' },
  [ENTITY_KIND.TANK_AI]: { color: '#c0563a', radius: TANK_BASE_R, shape: 'medallion', pictogram: 'tank' },
  [ENTITY_KIND.SURVIVOR_BOT]: { color: '#4d7d9e', radius: ENTITY_MEDAL_R, shape: 'medallion' },
  [ENTITY_KIND.SMOKER_AI]: { color: '#7aa65f', radius: ENTITY_MEDAL_R, shape: 'medallion', pictogram: 'smoker' },
  [ENTITY_KIND.BOOMER_AI]: { color: '#9e8a3f', radius: ENTITY_MEDAL_R, shape: 'medallion', pictogram: 'boomer' },
  [ENTITY_KIND.HUNTER_AI]: { color: '#8d6bb0', radius: ENTITY_MEDAL_R, shape: 'medallion', pictogram: 'hunter' },
};

export function entityStyle(kind: number): EntityStyle | null {
  return ENTITY_STYLES[kind] ?? null;
}

/** How long the rock's motion streak is, in CSS pixels. */
export const ROCK_STREAK_PX = 12;
/** Witch rim once startled: the alert red, until witch_killed. */
export const WITCH_STARTLED_COLOR = '#de4e40';
```

`DrawArgs` gains:

```ts
  /** The earlier of the two frames the scene was interpolated between, for
   *  motion (the rock streak). Matched by `ref`. */
  entitiesPrev: EntitySample[];
  /** A witch_aggro has happened with no witch_killed after it. */
  witchStartled: boolean;
```

Replace the entity loop with:

```ts
  const prevByRef = new Map<number, EntitySample>();
  for (const e of a.entitiesPrev) prevByRef.set(e.ref, e);

  for (const e of a.entities) {
    const style = entityStyle(e.kind);
    if (!style) continue;
    const isCommon = e.kind === ENTITY_KIND.COMMON;
    if (isCommon && !a.show.ci) continue;
    if (!isCommon && !a.show.entities) continue;
    const p = projectView(a.transform, a.view, e.x, e.y);
    ctx.save();
    switch (style.shape) {
      case 'figure': {
        // Head and shoulders: a horde reads as bodies rather than gravel.
        const r = style.radius;
        ctx.fillStyle = style.color;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.ellipse(p.px, p.py + r * 0.15, r, r * 0.72, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = shade(style.color, 0.6);
        ctx.beginPath();
        ctx.arc(p.px, p.py, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'medallion': {
        const startled = e.kind === ENTITY_KIND.WITCH && a.witchStartled;
        drawMedallion(ctx, {
          x: p.px, y: p.py, r: style.radius,
          rim: startled ? WITCH_STARTLED_COLOR : style.color,
          pictogram: style.pictogram ?? null,
          face: style.pictogram ? null : a.portraits['/portraits/unknown.png'] ?? null,
        });
        break;
      }
      case 'rock': {
        const prev = prevByRef.get(e.ref);
        if (prev && prev.kind === e.kind) {
          const q = projectView(a.transform, a.view, prev.x, prev.y);
          const dx = p.px - q.px; const dy = p.py - q.py;
          const len = Math.hypot(dx, dy);
          if (len > 0.5) {
            ctx.beginPath();
            ctx.moveTo(p.px, p.py);
            ctx.lineTo(p.px - (dx / len) * ROCK_STREAK_PX, p.py - (dy / len) * ROCK_STREAK_PX);
            ctx.strokeStyle = style.color;
            ctx.lineWidth = 2;
            ctx.globalAlpha = 0.6;
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
        // Six-point rock, drawn after the streak so it sits on top.
        const r = style.radius;
        const pts = [[-0.6, 0.4], [-0.4, -0.7], [0.2, -0.9], [0.8, -0.2], [0.6, 0.6], [-0.1, 0.9]];
        ctx.beginPath();
        pts.forEach(([ux, uy], i) => {
          const x = p.px + ux * r; const y = p.py + uy * r;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = style.color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        break;
      }
      default: {
        ctx.fillStyle = style.color;
        ctx.beginPath();
        ctx.arc(p.px, p.py, style.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
```

Note: in the rock test the streak stroke must be the LAST stroke; draw the streak after the polygon instead, or adjust the test to find any stroke in `#b07a3c`. Choose one and keep them consistent: draw the polygon first, then the streak, so a moving rock trails visibly over the polygon edge (matches the test as written).

Add a small helper in `draw.ts`:

```ts
/** Darken a hex colour by a factor; the common's head against its body. */
export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.round(v * f).toString(16).padStart(2, '0');
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}
```

In `ReplayCanvas.tsx` `paint`, pass `entitiesPrev: pair ? pair.a.entities : []` and `witchStartled: p.witchStartled` (add `witchStartled: boolean` to `ReplayCanvasProps` and to the repaint effect deps). In `Viewer.tsx` pass `witchStartled={false}` for now (Task 6 computes it).

The `sceneCounts` "keeps every slot clear of every world entity colour" palette test still reads `entityStyle(kind)!.color`, unchanged.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run web/src/replay && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/replay
git commit -m "feat(replay): commons as figures, AI specials and witch as medallions, rock with a streak, startled witch"
```

---

### Task 6: Marker kinds, filters, positions, pins, witch state, bursts

**Files:**
- Create: `web/src/replay/markers.ts`
- Test: `web/src/replay/markers.test.ts`

**Interfaces:**
- Consumes: `TimelineEntry`, `TimelineEvent` from `./timeline`; `roleOf` from `./eventText`; `bracket`, `interpolatePlayers` from `./interpolate`; `Frame` from replayFormat.
- Produces:

```ts
export interface MarkerKind { kind: string; letter: string; color: string; label: string; inAll: boolean }
export const MARKER_KINDS: readonly MarkerKind[];
export const MARKER_COLORS: { boom: string; red: string; white: string; green: string; grey: string; gold: string };
export function markerKind(kind: string): MarkerKind | null;
export function markerKindsPresent(timeline: TimelineEntry[]): { kind: MarkerKind; count: number }[];
/** showKind 'all' = every kind with inAll; a slug = that kind only. selected as in tickEntries. */
export function markerEntries(timeline: TimelineEntry[], showKind: string, selected: string | null): TimelineEvent[];
export interface WorldPos { x: number; y: number; z: number }
export function eventPosition(frames: Frame[], slots: string[], e: TimelineEvent): WorldPos | null;
export function pinnersAt(timeline: TimelineEntry[], tMs: number): Map<string, string>; // victim -> pinner
export function witchStartledAt(timeline: TimelineEntry[], tMs: number): boolean;
export interface BurstStyle { kind: 'pulse' | 'flash' | 'burst' | 'line'; color: string; lifeMs: number; at: 'actor' | 'target' }
export const BURSTS: Record<string, BurstStyle>;
export interface ActiveBurst { entry: TimelineEvent; style: BurstStyle; startedAt: number }
export class BurstClock { advance(tMs: number, nowMs: number, timeline: TimelineEntry[]): ActiveBurst[] }
export const BURST_MAX_STEP_MS = 2000;
```

- [ ] **Step 1: Write the failing tests**

`web/src/replay/markers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Frame } from '../../../src/replayFormat';
import { STATE } from '../../../src/replayFormat';
import type { TimelineEntry, TimelineEvent } from './timeline';
import {
  BURSTS, BurstClock, MARKER_KINDS, eventPosition, markerEntries, markerKind, markerKindsPresent,
  pinnersAt, witchStartledAt,
} from './markers';

const ev = (seq: number, tMs: number, event: string, actor: string, target: string | null, value = 0): TimelineEvent =>
  ({ seq, tMs, kind: 'event', event, actor, target, value });
const chat = (seq: number, tMs: number, actor: string): TimelineEntry =>
  ({ seq, tMs, kind: 'chat', actor, team: 'survivor', text: 'hi' });

const T: TimelineEntry[] = [
  ev(1, 1000, 'boom', 'B', 'A'),
  ev(2, 2000, 'dp', 'H', 'C', 25),
  chat(3, 2500, 'A'),
  ev(4, 3000, 'boom', 'B', 'C'),
  ev(5, 4000, 'ff', 'A', 'C', 12),
  ev(6, 5000, 'si_spawn', 'H', null, 3),
  ev(7, 6000, 'death', 'A', 'H'),
  ev(8, 7000, 'revive', 'C', 'A'),
];

describe('MARKER_KINDS', () => {
  it('maps every mapped kind to a letter and a colour, and leaves spawns unmapped', () => {
    for (const k of ['boom', 'dp', 'skeet', 'cleared', 'incap', 'death', 'pinned', 'tank_death', 'witch_aggro', 'witch_killed', 'car_alarm', 'ff', 'revive']) {
      expect(markerKind(k)).toBeTruthy();
    }
    expect(markerKind('si_spawn')).toBeNull();
    expect(markerKind('tank_spawn')).toBeNull();
    expect(markerKind('tank_take')).toBeNull();
  });

  it('excludes ff and revive from All events', () => {
    expect(markerKind('ff')!.inAll).toBe(false);
    expect(markerKind('revive')!.inAll).toBe(false);
    expect(markerKind('boom')!.inAll).toBe(true);
  });
});

describe('markerKindsPresent', () => {
  it('lists the kinds in this timeline with counts, in table order', () => {
    expect(markerKindsPresent(T).map((k) => [k.kind.kind, k.count])).toEqual([
      ['boom', 2], ['dp', 1], ['death', 1], ['ff', 1], ['revive', 1],
    ]);
  });
});

describe('markerEntries', () => {
  it('"all" for everyone is every inAll kind, no chat, no spawns, no ff', () => {
    expect(markerEntries(T, 'all', null).map((e) => e.seq)).toEqual([1, 2, 4, 7]);
  });
  it('a kind narrows to that kind, including ones outside All', () => {
    expect(markerEntries(T, 'boom', null).map((e) => e.seq)).toEqual([1, 4]);
    expect(markerEntries(T, 'ff', null).map((e) => e.seq)).toEqual([5]);
  });
  it('a player narrows to events they were actor or target of, in round order', () => {
    expect(markerEntries(T, 'all', 'C').map((e) => e.seq)).toEqual([2, 4]);
    expect(markerEntries(T, 'boom', 'C').map((e) => e.seq)).toEqual([4]);
    expect(markerEntries(T, 'all', 'A').map((e) => e.seq)).toEqual([1, 7]);
  });
  it('an empty selected string (unrostered slot) selects nothing', () => {
    expect(markerEntries(T, 'all', '')).toEqual([]);
  });
});

const sample = (slot: number, x: number, state = STATE.PRESENT | STATE.ALIVE) => ({
  slot, x, y: 10 * slot, z: 0, yaw: 0, pitch: 0, state, health: 100, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
});
const frame = (tMs: number, xs: number[]): Frame => ({
  tMs, players: xs.map((x, i) => sample(i, x)), entities: [], offset: 0,
} as Frame);
const FR = [frame(0, [0, 100, 200, 300, 400, 500, 600, 700]), frame(1000, [10, 110, 210, 310, 410, 510, 610, 710])];
const SLOTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

describe('eventPosition', () => {
  it('is the target position for a target-first kind, interpolated at the event time', () => {
    expect(eventPosition(FR, SLOTS, ev(1, 500, 'boom', 'F', 'C'))).toEqual({ x: 205, y: 20, z: 0 });
  });
  it('is the actor position when there is no target', () => {
    expect(eventPosition(FR, SLOTS, ev(1, 500, 'car_alarm', 'B', null))).toEqual({ x: 105, y: 10, z: 0 });
  });
  it('falls back to the actor when the target is not in the roster, and null when neither is', () => {
    expect(eventPosition(FR, SLOTS, ev(1, 500, 'dp', 'H', 'nobody'))).toEqual({ x: 705, y: 70, z: 0 });
    expect(eventPosition(FR, SLOTS, ev(1, 500, 'dp', 'x', 'y'))).toBeNull();
    expect(eventPosition([], SLOTS, ev(1, 500, 'dp', 'H', 'C'))).toBeNull();
  });
  it('treats an empty slot record as unresolvable', () => {
    const empty = frame(0, [0, 0, 0, 0, 0, 0, 0, 0]);
    empty.players[2].state = 0;
    expect(eventPosition([empty], SLOTS, ev(1, 0, 'boom', 'F', 'C'))).toBeNull();
  });
});

describe('pinnersAt', () => {
  const P: TimelineEntry[] = [
    ev(1, 1000, 'pinned', 'H', 'A'),
    ev(2, 1500, 'pinned', 'S', 'C'),
    ev(3, 2000, 'cleared', 'B', 'A'),
    ev(4, 3000, 'pinned', 'H', 'A'),
  ];
  it('names the most recent pinner of each victim at or before the time', () => {
    expect([...pinnersAt(P, 1600)]).toEqual([['A', 'H'], ['C', 'S']]);
    expect([...pinnersAt(P, 3500)]).toEqual([['A', 'H'], ['C', 'S']]);
    expect([...pinnersAt(P, 500)]).toEqual([]);
  });
});

describe('witchStartledAt', () => {
  const W: TimelineEntry[] = [ev(1, 1000, 'witch_aggro', 'A', null), ev(2, 5000, 'witch_killed', 'B', null)];
  it('is true between the startle and the kill, false before and after', () => {
    expect(witchStartledAt(W, 500)).toBe(false);
    expect(witchStartledAt(W, 3000)).toBe(true);
    expect(witchStartledAt(W, 6000)).toBe(false);
    expect(witchStartledAt([], 3000)).toBe(false);
  });
});

describe('BurstClock', () => {
  it('starts a burst when the playhead crosses an event during a small forward step, and ages it out', () => {
    const c = new BurstClock();
    expect(c.advance(900, 0, T)).toEqual([]);
    const a = c.advance(1100, 16, T);
    expect(a.map((b) => b.entry.seq)).toEqual([1]);
    expect(a[0].style).toBe(BURSTS.boom);
    expect(a[0].startedAt).toBe(16);
    // Still alive inside its life, gone after.
    expect(c.advance(1200, 16 + BURSTS.boom.lifeMs - 1, T)).toHaveLength(1);
    expect(c.advance(1300, 16 + BURSTS.boom.lifeMs + 1, T)).toHaveLength(0);
  });
  it('does not replay bursts across a seek, forward or back', () => {
    const c = new BurstClock();
    c.advance(900, 0, T);
    expect(c.advance(5000, 16, T)).toEqual([]);      // jump forward past 1, 2, 4
    expect(c.advance(1500, 32, T)).toEqual([]);      // jump back
    expect(c.advance(2100, 48, T).map((b) => b.entry.seq)).toEqual([2]);
  });
  it('ignores kinds with no burst and chat', () => {
    const c = new BurstClock();
    c.advance(4900, 0, T);
    expect(c.advance(5100, 16, T)).toEqual([]);     // si_spawn
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run web/src/replay/markers.test.ts`
Expected: FAIL, cannot resolve `./markers`.

- [ ] **Step 3: Write the module**

`web/src/replay/markers.ts`:

```ts
import type { Frame } from '../../../src/replayFormat';
import { STATE } from '../../../src/replayFormat';
import { bracket, interpolatePlayers } from './interpolate';
import { roleOf } from './eventText';
import type { TimelineEntry, TimelineEvent } from './timeline';

export const MARKER_COLORS = {
  boom: '#a85cf0', red: '#de4e40', white: '#f2f2f2', green: '#7aa65f', grey: '#c9c9c9', gold: '#e0b654',
} as const;

export interface MarkerKind {
  kind: string;
  letter: string;
  color: string;
  label: string;
  /** Part of "All events". ff and revive are not: an FF tag on every tick is
   *  noise, and both are there when asked for by name. */
  inAll: boolean;
}

/** Kinds with a place on the map. Spawns and tank hand-offs have none. */
export const MARKER_KINDS: readonly MarkerKind[] = [
  { kind: 'boom', letter: 'B', color: MARKER_COLORS.boom, label: 'Boom', inAll: true },
  { kind: 'dp', letter: 'P', color: MARKER_COLORS.red, label: 'Pounce', inAll: true },
  { kind: 'skeet', letter: 'S', color: MARKER_COLORS.white, label: 'Skeet', inAll: true },
  { kind: 'cleared', letter: 'C', color: MARKER_COLORS.white, label: 'Clear', inAll: true },
  { kind: 'incap', letter: 'X', color: MARKER_COLORS.red, label: 'Incap', inAll: true },
  { kind: 'death', letter: '†', color: MARKER_COLORS.grey, label: 'Death', inAll: true },
  { kind: 'pinned', letter: 'T', color: MARKER_COLORS.green, label: 'Pin', inAll: true },
  { kind: 'tank_death', letter: 'K', color: MARKER_COLORS.white, label: 'Tank kill', inAll: true },
  { kind: 'witch_aggro', letter: 'W', color: MARKER_COLORS.white, label: 'Witch startled', inAll: true },
  { kind: 'witch_killed', letter: 'W', color: MARKER_COLORS.white, label: 'Witch killed', inAll: true },
  { kind: 'car_alarm', letter: 'A', color: MARKER_COLORS.gold, label: 'Car alarm', inAll: true },
  { kind: 'ff', letter: 'F', color: MARKER_COLORS.red, label: 'Friendly fire', inAll: false },
  { kind: 'revive', letter: 'R', color: MARKER_COLORS.green, label: 'Revive', inAll: false },
];

const BY_KIND = new Map(MARKER_KINDS.map((k) => [k.kind, k]));

export function markerKind(kind: string): MarkerKind | null {
  return BY_KIND.get(kind) ?? null;
}

/** The kinds this timeline actually has, with counts, in table order: what
 *  the Show select lists. */
export function markerKindsPresent(timeline: TimelineEntry[]): { kind: MarkerKind; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of timeline) {
    if (e.kind !== 'event' || !BY_KIND.has(e.event)) continue;
    counts.set(e.event, (counts.get(e.event) ?? 0) + 1);
  }
  return MARKER_KINDS.filter((k) => counts.has(k.kind)).map((k) => ({ kind: k, count: counts.get(k.kind)! }));
}

/**
 * The events to tag on the map, in round order.
 *
 * `selected` follows tickEntries' contract: null is everyone, '' is an
 * unrostered slot and matches nothing, a SteamID64 matches events it was
 * actor or target of.
 */
export function markerEntries(
  timeline: TimelineEntry[], showKind: string, selected: string | null,
): TimelineEvent[] {
  if (selected === '') return [];
  const out: TimelineEvent[] = [];
  for (const e of timeline) {
    if (e.kind !== 'event') continue;
    const k = BY_KIND.get(e.event);
    if (!k) continue;
    if (showKind === 'all' ? !k.inAll : e.event !== showKind) continue;
    if (selected !== null && roleOf(e, selected) === null) continue;
    out.push(e);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export interface WorldPos { x: number; y: number; z: number }

/**
 * Where an event happened: the target's position at that moment, else the
 * actor's, interpolated between the two frames around the event time. Null
 * when neither resolves to an occupied slot, in which case the rail still
 * shows the event and the map does not.
 */
export function eventPosition(frames: Frame[], slots: string[], e: TimelineEvent): WorldPos | null {
  const pair = bracket(frames, e.tMs);
  if (!pair) return null;
  const players = interpolatePlayers(pair.a, pair.b, pair.f);
  for (const id of [e.target, e.actor]) {
    if (!id) continue;
    const slot = slots.indexOf(id);
    if (slot < 0) continue;
    const p = players[slot];
    if (!p || (p.state & STATE.PRESENT) === 0) continue;
    return { x: p.x, y: p.y, z: p.z };
  }
  return null;
}

/** Victim SteamID64 to the SteamID64 of whoever pinned them most recently at
 *  or before `tMs`. Whether the pin is still on is the victim's PINNED bit,
 *  read from the frame by the caller; this only answers "by whom". */
export function pinnersAt(timeline: TimelineEntry[], tMs: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of timeline) {
    if (e.kind !== 'event' || e.event !== 'pinned' || e.tMs > tMs || !e.target) continue;
    out.set(e.target, e.actor);
  }
  return out;
}

/** A witch_aggro at or before `tMs` with no witch_killed after it. */
export function witchStartledAt(timeline: TimelineEntry[], tMs: number): boolean {
  let startled = false;
  for (const e of [...timeline].sort((a, b) => a.seq - b.seq)) {
    if (e.kind !== 'event' || e.tMs > tMs) continue;
    if (e.event === 'witch_aggro') startled = true;
    else if (e.event === 'witch_killed') startled = false;
  }
  return startled;
}

export interface BurstStyle {
  kind: 'pulse' | 'flash' | 'burst' | 'line';
  color: string;
  lifeMs: number;
  at: 'actor' | 'target';
}

/** What flashes on the map in the second an event happens. Wall-clock
 *  lived, drawn under the medallions, indifferent to the marker filters. */
export const BURSTS: Record<string, BurstStyle> = {
  boom: { kind: 'pulse', color: MARKER_COLORS.boom, lifeMs: 1000, at: 'target' },
  dp: { kind: 'flash', color: MARKER_COLORS.red, lifeMs: 500, at: 'target' },
  incap: { kind: 'flash', color: MARKER_COLORS.red, lifeMs: 500, at: 'target' },
  death: { kind: 'flash', color: MARKER_COLORS.red, lifeMs: 500, at: 'target' },
  skeet: { kind: 'burst', color: MARKER_COLORS.white, lifeMs: 600, at: 'target' },
  cleared: { kind: 'burst', color: MARKER_COLORS.white, lifeMs: 600, at: 'target' },
  pinned: { kind: 'line', color: MARKER_COLORS.green, lifeMs: 300, at: 'target' },
  witch_aggro: { kind: 'burst', color: MARKER_COLORS.white, lifeMs: 600, at: 'actor' },
  witch_killed: { kind: 'burst', color: MARKER_COLORS.white, lifeMs: 600, at: 'actor' },
  tank_death: { kind: 'burst', color: MARKER_COLORS.white, lifeMs: 600, at: 'actor' },
  car_alarm: { kind: 'burst', color: MARKER_COLORS.gold, lifeMs: 600, at: 'actor' },
};

export interface ActiveBurst { entry: TimelineEvent; style: BurstStyle; startedAt: number }

/** A forward step larger than this is a seek, not playback, and starts
 *  nothing: a seek to the finale must not fire every burst of the round. */
export const BURST_MAX_STEP_MS = 2000;

/**
 * Turns the playhead into bursts. Kept as an object because the crossing
 * test needs the previous playhead, and the age needs wall time.
 */
export class BurstClock {
  private lastTMs = Number.NaN;
  private active: ActiveBurst[] = [];

  advance(tMs: number, nowMs: number, timeline: TimelineEntry[]): ActiveBurst[] {
    const prev = this.lastTMs;
    this.lastTMs = tMs;
    const step = tMs - prev;
    if (Number.isFinite(step) && step > 0 && step <= BURST_MAX_STEP_MS) {
      for (const e of timeline) {
        if (e.kind !== 'event' || e.tMs <= prev || e.tMs > tMs) continue;
        const style = BURSTS[e.event];
        if (style) this.active.push({ entry: e, style, startedAt: nowMs });
      }
    }
    this.active = this.active.filter((b) => nowMs - b.startedAt <= b.style.lifeMs);
    return this.active;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run web/src/replay/markers.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/replay/markers.ts web/src/replay/markers.test.ts
git commit -m "feat(replay): marker kinds, filters, event positions, pinners, witch state and burst clock"
```

---

### Task 7: Draw markers, bursts and pin lines; hit items out

**Files:**
- Create: `web/src/replay/hitTest.ts`
- Test: `web/src/replay/hitTest.test.ts`, `web/src/replay/draw.test.ts`
- Modify: `web/src/replay/draw.ts` (`DrawArgs.markers`, `.bursts`, `.pinners`, `.nowMs`, `.hits`; three new draw passes; hit recording)

**Interfaces:**
- Consumes: `MarkerKind`, `ActiveBurst`, `WorldPos` (Task 6); `drawMedallion` radii.
- Produces:

```ts
// hitTest.ts
export type HitItem =
  | { kind: 'player'; px: number; py: number; r: number; slot: number }
  | { kind: 'entity'; px: number; py: number; r: number; entityKind: number; health: number; state: number }
  | { kind: 'marker'; px: number; py: number; r: number; seq: number };
export function hitTest(items: readonly HitItem[], px: number, py: number): HitItem | null;
export const MARKER_HIT_R = 8;

// draw.ts additions
export interface MarkerItem { entry: TimelineEvent; kind: MarkerKind; pos: WorldPos; index: number | null }
export interface BurstItem { burst: ActiveBurst; pos: WorldPos; from: WorldPos | null }
export const MARKER_SIZE = 12;
DrawArgs.markers: MarkerItem[]; DrawArgs.bursts: BurstItem[]; DrawArgs.pinners: Map<string, string>;
DrawArgs.nowMs: number; DrawArgs.tMs: number; DrawArgs.hits?: HitItem[]  // filled if present
```

- [ ] **Step 1: Write the failing tests**

`web/src/replay/hitTest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { hitTest, type HitItem } from './hitTest';

const items: HitItem[] = [
  { kind: 'marker', px: 100, py: 100, r: 8, seq: 5 },
  { kind: 'entity', px: 104, py: 100, r: 9, entityKind: 8, health: 250, state: 0 },
  { kind: 'player', px: 108, py: 100, r: 17, slot: 2 },
];

describe('hitTest', () => {
  it('is null on an empty scene or a miss', () => {
    expect(hitTest([], 100, 100)).toBeNull();
    expect(hitTest(items, 300, 300)).toBeNull();
  });
  it('returns the topmost (last drawn) item under the pointer', () => {
    expect(hitTest(items, 100, 100)).toMatchObject({ kind: 'player', slot: 2 });
  });
  it('respects each item radius', () => {
    expect(hitTest(items, 92, 100)).toMatchObject({ kind: 'player' });   // 16 from the player centre, inside 17
    expect(hitTest(items, 90, 100)).toMatchObject({ kind: 'marker' });   // 18 from the player, 10 from the marker: miss both
  });
});
```

(Correct the third case: 90 is 10 from the marker centre, outside r 8, and 14 from the entity, outside 9, and 18 from the player, outside 17, so it is null. Write `expect(hitTest(items, 90, 100)).toBeNull();` and add `expect(hitTest(items, 94, 100)).toMatchObject({ kind: 'marker' })` since 94 is 6 from the marker, 10 from the entity, 14 from the player.)

Add to `draw.test.ts` inside `describe('drawScene')`:

```ts
  const mk = (seq: number, event: string, x: number, index: number | null = null) => ({
    entry: { seq, tMs: seq * 1000, kind: 'event' as const, event, actor: 'A', target: 'B', value: 0 },
    kind: markerKind(event)!, pos: { x, y: -300, z: 0 }, index,
  });

  it('draws a marker tag with its letter, dims one ahead of the playhead, and numbers a selected list', () => {
    const { transform, view } = identityScene();
    const { calls, texts, ctx } = stubCtx();
    drawScene(ctx, {
      ...baseArgs(transform, view), entities: [], tMs: 1500,
      markers: [mk(1, 'boom', 600, 1), mk(2, 'dp', 700, 2)],
    });
    expect(texts.map((t) => t.text)).toEqual(expect.arrayContaining(['B', 'P', '1', '2']));
    const rects = calls.filter((c) => c.fn === 'fillRect' && c.args[2] === MARKER_SIZE);
    expect(rects).toHaveLength(2);
    // The second marker is ahead of the playhead: drawn at reduced alpha.
    expect(rects[1].alpha).toBeLessThan(rects[0].alpha);
  });

  it('records a hit item per player, entity and marker, players last', () => {
    const { transform, view } = identityScene();
    const { ctx } = stubCtx();
    const hits: HitItem[] = [];
    drawScene(ctx, {
      ...baseArgs(transform, view), hits,
      players: [player({ slot: 0, infected: false, state: STATE.PRESENT | STATE.ALIVE, health: 100 })],
      entities: [{ ref: 1, kind: ENTITY_KIND.HUNTER_AI, state: 0, x: 600, y: -300, z: 0, health: 250 }],
      markers: [mk(1, 'boom', 700)],
    });
    expect(hits.map((h) => h.kind)).toEqual(['marker', 'entity', 'player']);
  });

  it('draws a pin line from the pinner to a pinned victim, in the pinner slot colour', () => {
    const { transform, view } = identityScene();
    const { calls, ctx } = stubCtx();
    drawScene(ctx, {
      ...baseArgs(transform, view),
      slots: ['A', '', '', '', 'H', '', '', ''],
      players: [
        player({ slot: 0, infected: false, state: STATE.PRESENT | STATE.ALIVE | STATE.PINNED, health: 100 }),
        player({ slot: 4, infected: true, cls: 3, x: 700, state: STATE.PRESENT | STATE.ALIVE, health: 250 }),
      ],
      pinners: new Map([['A', 'H']]),
    });
    const line = calls.find((c) => c.fn === 'stroke' && c.stroke === SLOT_COLORS[4] && c.width === 2);
    expect(line).toBeTruthy();
  });

  it('draws no pin line to a ghost pinner', () => {
    const { transform, view } = identityScene();
    const { calls, ctx } = stubCtx();
    drawScene(ctx, {
      ...baseArgs(transform, view),
      slots: ['A', '', '', '', 'H', '', '', ''],
      players: [
        player({ slot: 0, infected: false, state: STATE.PRESENT | STATE.ALIVE | STATE.PINNED, health: 100 }),
        player({ slot: 4, infected: true, cls: 3, x: 700, state: STATE.PRESENT | STATE.ALIVE | STATE.GHOST, health: 250 }),
      ],
      pinners: new Map([['A', 'H']]),
    });
    expect(calls.filter((c) => c.fn === 'stroke' && c.stroke === SLOT_COLORS[4])).toHaveLength(0);
  });

  it('draws a boom burst as a pulse whose ring grows with age', () => {
    const { transform, view } = identityScene();
    const young = stubCtx(); const old = stubCtx();
    const burst = { entry: mk(1, 'boom', 600).entry, style: BURSTS.boom, startedAt: 0 };
    const args = (nowMs: number) => ({ ...baseArgs(transform, view), nowMs, bursts: [{ burst, pos: { x: 600, y: -300, z: 0 }, from: null }] });
    drawScene(young.ctx, args(100));
    drawScene(old.ctx, args(800));
    const ring = (c: ReturnType<typeof stubCtx>) => c.calls.filter((x) => x.fn === 'arc' && x.stroke === BURSTS.boom.color).pop()!;
    expect(ring(old).args[2]).toBeGreaterThan(ring(young).args[2]);
  });
```

Add `tMs: 0, nowMs: 0, markers: [], bursts: [], pinners: new Map()` to `baseArgs`, and `alpha` recording to the stub (`set globalAlpha(v) { alpha = v; }` stored on each call). Import `markerKind, BURSTS` from `./markers`, `MARKER_SIZE` from `./draw`, `HitItem` from `./hitTest`.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run web/src/replay/hitTest.test.ts web/src/replay/draw.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`web/src/replay/hitTest.ts`:

```ts
export type HitItem =
  | { kind: 'player'; px: number; py: number; r: number; slot: number }
  | { kind: 'entity'; px: number; py: number; r: number; entityKind: number; health: number; state: number }
  | { kind: 'marker'; px: number; py: number; r: number; seq: number };

/** Hit radius for a marker tag: the tag is 12px square, and a finger or a
 *  quick mouse wants a little more than that. */
export const MARKER_HIT_R = 8;

/** The topmost item under the pointer: items are recorded in draw order, so
 *  the last one within its radius is the one painted on top. */
export function hitTest(items: readonly HitItem[], px: number, py: number): HitItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const dx = it.px - px; const dy = it.py - py;
    if (dx * dx + dy * dy <= it.r * it.r) return it;
  }
  return null;
}
```

In `draw.ts`:

```ts
import type { ActiveBurst, MarkerKind, WorldPos } from './markers';
import type { TimelineEvent } from './timeline';
import { MARKER_HIT_R, type HitItem } from './hitTest';

export interface MarkerItem { entry: TimelineEvent; kind: MarkerKind; pos: WorldPos; index: number | null }
export interface BurstItem { burst: ActiveBurst; pos: WorldPos; from: WorldPos | null }
export const MARKER_SIZE = 12;
const MARKER_AHEAD_ALPHA = 0.45;
```

`DrawArgs` gains:

```ts
  /** Event tags to leave on the map, already filtered and positioned. */
  markers: MarkerItem[];
  /** Bursts alive right now, positioned. */
  bursts: BurstItem[];
  /** Victim SteamID64 to pinner SteamID64, from `pinnersAt`. */
  pinners: Map<string, string>;
  /** Playhead, for dimming tags ahead of it. */
  tMs: number;
  /** Wall clock, for burst ages. */
  nowMs: number;
  /** If given, filled with what was drawn where, in draw order. */
  hits?: HitItem[];
```

Insert after the trail and before the entity loop:

```ts
  // Markers: under everything that moves, over the trail. A tag never hides
  // a player; a player standing on a tag hides only the tag.
  for (const m of a.markers) {
    const p = projectView(a.transform, a.view, m.pos.x, m.pos.y);
    const half = MARKER_SIZE / 2;
    ctx.save();
    ctx.globalAlpha = m.entry.tMs > a.tMs ? MARKER_AHEAD_ALPHA : 1;
    ctx.fillStyle = 'rgba(5,4,3,0.82)';
    ctx.fillRect(p.px - half, p.py - half, MARKER_SIZE, MARKER_SIZE);
    ctx.strokeStyle = m.kind.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(p.px - half + 1, p.py - half + 1, MARKER_SIZE - 2, MARKER_SIZE - 2);
    ctx.font = 'bold 7px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(m.kind.letter, p.px, p.py + 0.5);
    if (m.index !== null) {
      // Bookmark number, matching the rail's order for the selected player.
      ctx.beginPath();
      ctx.arc(p.px + half, p.py - half, 5, 0, Math.PI * 2);
      ctx.fillStyle = m.kind.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = numberInk(m.kind.color);
      ctx.fillText(String(m.index), p.px + half, p.py - half + 0.5);
    }
    ctx.restore();
    a.hits?.push({ kind: 'marker', px: p.px, py: p.py, r: MARKER_HIT_R, seq: m.entry.seq });
  }

  // Bursts: wall-clock animations at an event's position.
  for (const b of a.bursts) {
    const age = Math.max(0, Math.min(1, (a.nowMs - b.burst.startedAt) / b.burst.style.lifeMs));
    const p = projectView(a.transform, a.view, b.pos.x, b.pos.y);
    const color = b.burst.style.color;
    ctx.save();
    switch (b.burst.style.kind) {
      case 'pulse': {
        ctx.globalAlpha = (1 - age) * 0.5;
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(p.px, p.py, 10 + age * 8, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = (1 - age) * 0.9;
        ctx.strokeStyle = color; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(p.px, p.py, 10 + age * 20, 0, Math.PI * 2); ctx.stroke();
        break;
      }
      case 'burst': {
        ctx.globalAlpha = (1 - age) * 0.8;
        ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.px, p.py, 8 + age * 18, 0, Math.PI * 2); ctx.stroke();
        break;
      }
      case 'flash':
      case 'line': {
        ctx.globalAlpha = (1 - age) * 0.9;
        if (b.from) {
          const q = projectView(a.transform, a.view, b.from.x, b.from.y);
          ctx.beginPath(); ctx.moveTo(q.px, q.py); ctx.lineTo(p.px, p.py);
          ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4; ctx.stroke();
          ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
        }
        if (b.burst.style.kind === 'flash') {
          ctx.strokeStyle = color; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(p.px, p.py, 6 + age * 6, 0, Math.PI * 2); ctx.stroke();
        }
        break;
      }
    }
    ctx.restore();
  }
```

Record entity hits: in the entity loop, after drawing each non-common entity, `a.hits?.push({ kind: 'entity', px: p.px, py: p.py, r: style.radius + 4, entityKind: e.kind, health: e.health, state: e.state });` (commons are skipped: a horde of thirty tooltips is noise).

Pin lines, inserted after the entity loop and before the player loop (so the lines sit under both medallions):

```ts
  // Pin lines: from the pinner to the pinned survivor while PINNED is set.
  // Only to a spawned pinner, so a ghost is never given a line.
  if (a.pinners.size > 0) {
    const bySteam = new Map<string, PlayerSample>();
    a.players.forEach((pl) => { const id = a.slots[pl.slot]; if (id) bySteam.set(id, pl); });
    for (const [victimId, pinnerId] of a.pinners) {
      const v = bySteam.get(victimId); const k = bySteam.get(pinnerId);
      if (!v || !k) continue;
      if ((v.state & STATE.PINNED) === 0) continue;
      if ((k.state & STATE.ALIVE) === 0 || (k.state & STATE.GHOST) !== 0) continue;
      const pv = projectView(a.transform, a.view, v.x, v.y);
      const pk = projectView(a.transform, a.view, k.x, k.y);
      ctx.save();
      ctx.beginPath(); ctx.moveTo(pk.px, pk.py); ctx.lineTo(pv.px, pv.py);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 4; ctx.stroke();
      ctx.strokeStyle = slotColor(k.slot); ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
    }
  }
```

Player hits: at the end of each non-ghost player's block, `a.hits?.push({ kind: 'player', px: p.px, py: p.py, r: r + 6, slot: pl.slot });`. Ghosts record nothing.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run web/src/replay && npm run typecheck`
Expected: PASS. (`ReplayCanvas.paint` does not compile until it passes the new fields; give it `markers: [], bursts: [], pinners: new Map(), tMs: t, nowMs: 0` for now, Task 8 wires the real values.)

- [ ] **Step 5: Commit**

```bash
git add web/src/replay
git commit -m "feat(replay): marker tags, bursts and pin lines on the map, hit items recorded per paint"
```

---

### Task 8: Toggles, filters, and wiring through Viewer and ReplayCanvas

**Files:**
- Modify: `web/src/replay/useToggles.ts`, `web/src/replay/useToggles.test.ts`
- Create: `web/src/replay/MarkerFilters.tsx`, `web/src/replay/MarkerFilters.test.tsx`
- Modify: `web/src/replay/ReplayCanvas.tsx`, `web/src/replay/Viewer.tsx`, `web/src/styles/app.css`

**Interfaces:**
- Consumes: `markerKindsPresent`, `markerEntries`, `eventPosition`, `pinnersAt`, `witchStartledAt`, `BurstClock`, `BURSTS` (Task 6); `MarkerItem`, `BurstItem` (Task 7).
- Produces: `Toggles.key: boolean`, `Toggles.showKind: string` (default `'all'`); `useToggles(): [Toggles, toggle(k), set<K>(k, v)]`; `MarkerFilters` props `{ timeline: TimelineEntry[]; showKind: string; setShowKind(k: string): void; slots: string[]; names: Record<string,string>; follow: Follow; setFollow(f: Follow): void }`; `ReplayCanvasProps` gains `markers, bursts, pinners, timeline, witchStartled, hitsRef: { current: HitItem[] }`.

- [ ] **Step 1: Failing tests**

In `web/src/replay/useToggles.test.ts` add:

```ts
  it('defaults key off and showKind to all, and merges old storage without them', () => {
    expect(DEFAULT_TOGGLES.key).toBe(false);
    expect(DEFAULT_TOGGLES.showKind).toBe('all');
    expect(readToggles(JSON.stringify({ hp: false }))).toMatchObject({ hp: false, key: false, showKind: 'all' });
  });
```

`web/src/replay/MarkerFilters.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { MarkerFilters } from './MarkerFilters';
import { FREE } from './camera';
import type { TimelineEntry } from './timeline';

const T: TimelineEntry[] = [
  { seq: 1, tMs: 1000, kind: 'event', event: 'boom', actor: 'B', target: 'A', value: 0 },
  { seq: 2, tMs: 2000, kind: 'event', event: 'boom', actor: 'B', target: 'C', value: 0 },
  { seq: 3, tMs: 3000, kind: 'event', event: 'dp', actor: 'H', target: 'A', value: 20 },
  { seq: 4, tMs: 4000, kind: 'event', event: 'si_spawn', actor: 'H', target: null, value: 3 },
];
const slots = ['A', 'B', '', '', 'H', '', '', ''];
const names = { A: 'alice', B: 'bob', H: 'hunterman' };

describe('MarkerFilters', () => {
  it('lists All events plus the kinds present with counts, and the rostered players', () => {
    render(<MarkerFilters timeline={T} showKind="all" setShowKind={() => {}} slots={slots} names={names} follow={FREE} setFollow={() => {}} />);
    const show = screen.getByLabelText('Show') as HTMLSelectElement;
    expect([...show.options].map((o) => o.textContent)).toEqual(['All events', 'Boom (2)', 'Pounce (1)']);
    const who = screen.getByLabelText('for') as HTMLSelectElement;
    expect([...who.options].map((o) => o.textContent)).toEqual(['Everyone', 'alice', 'bob', 'hunterman']);
  });

  it('choosing a player follows that slot, and Everyone frees the camera', () => {
    const setFollow = vi.fn();
    render(<MarkerFilters timeline={T} showKind="all" setShowKind={() => {}} slots={slots} names={names} follow={{ kind: 'slot', slot: 1 }} setFollow={setFollow} />);
    const who = screen.getByLabelText('for') as HTMLSelectElement;
    expect(who.value).toBe('4');
    fireEvent.change(who, { target: { value: '4' } });
    expect(setFollow).toHaveBeenCalledWith({ kind: 'slot', slot: 4 });
    fireEvent.change(who, { target: { value: '' } });
    expect(setFollow).toHaveBeenCalledWith(FREE);
  });

  it('choosing a kind reports it', () => {
    const setShowKind = vi.fn();
    render(<MarkerFilters timeline={T} showKind="all" setShowKind={setShowKind} slots={slots} names={names} follow={FREE} setFollow={() => {}} />);
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'dp' } });
    expect(setShowKind).toHaveBeenCalledWith('dp');
  });
});
```

(In the second test the initial `who.value` is `'1'`, since follow is slot 1; fix the expectation to `'1'`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run web/src/replay/useToggles.test.ts web/src/replay/MarkerFilters.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`useToggles.ts`: add `key: boolean; showKind: string;` to `Toggles`, `key: false, showKind: 'all'` to `DEFAULT_TOGGLES`, and a setter:

```ts
export function useToggles(): [Toggles, (k: keyof Toggles) => void, <K extends keyof Toggles>(k: K, v: Toggles[K]) => void] {
  ...
  const set = useCallback(<K extends keyof Toggles>(k: K, v: Toggles[K]) => {
    setToggles((t) => {
      const next = { ...t, [k]: v };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* not fatal */ }
      return next;
    });
  }, []);
  return [toggles, toggle, set];
}
```

`toggle` must only flip boolean keys; leave its body, and type `k` as `Exclude<keyof Toggles, 'showKind'>` where `TOGGLE_LABELS` is typed in `ReplayHud.tsx`.

`MarkerFilters.tsx`:

```tsx
import { FREE, followSlotOf, type Follow } from './camera';
import { markerKindsPresent } from './markers';
import { slotLabel } from './draw';
import type { TimelineEntry } from './timeline';

/**
 * The two controls above the stage: Show picks the event kind, for narrows
 * to a player. "for" IS the follow row's selection (the owner's model:
 * pick the kind, then the player), so either control changes the other.
 */
export function MarkerFilters(
  { timeline, showKind, setShowKind, slots, names, follow, setFollow }: {
    timeline: TimelineEntry[]; showKind: string; setShowKind: (k: string) => void;
    slots: string[]; names: Record<string, string>; follow: Follow; setFollow: (f: Follow) => void;
  },
) {
  const kinds = markerKindsPresent(timeline);
  const followSlot = followSlotOf(follow);
  return (
    <div class="replay__filters">
      <label class="replay__filter">
        <span>Show</span>
        <select value={showKind} onChange={(e) => setShowKind((e.target as HTMLSelectElement).value)} aria-label="Show">
          <option value="all">All events</option>
          {kinds.map(({ kind, count }) => (
            <option key={kind.kind} value={kind.kind}>{kind.label} ({count})</option>
          ))}
        </select>
      </label>
      <label class="replay__filter">
        <span>for</span>
        <select
          value={followSlot === null ? '' : String(followSlot)}
          aria-label="for"
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            setFollow(v === '' ? FREE : { kind: 'slot', slot: Number(v) });
          }}
        >
          <option value="">Everyone</option>
          {slots.map((id, i) => id ? <option key={i} value={String(i)}>{names[id] ?? slotLabel(i)}</option> : null)}
        </select>
      </label>
    </div>
  );
}
```

`ReplayCanvas.tsx`: add to props `markers: MarkerItem[]; bursts: TimelineEntry[]; pinnersTimeline: TimelineEntry[]; witchStartled: boolean; hitsRef: { current: HitItem[] }; frames` (already there); own a `const clock = useRef(new BurstClock())`. In `paint` (make `paint` take the clock too):

```ts
  const t = p.timeRef.current;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const active = clock.advance(t, now, p.timeline);
  const bursts: BurstItem[] = [];
  for (const b of active) {
    const pos = eventPosition(p.frames, slots, b.entry);
    if (!pos) continue;
    const from = b.style.kind === 'flash' || b.style.kind === 'line'
      ? actorPosition(p.frames, slots, b.entry) : null;
    bursts.push({ burst: b, pos, from });
  }
  const hits: HitItem[] = [];
  drawScene(ctx, { ..., markers: p.markers, bursts, pinners: pinnersAt(p.timeline, t), tMs: t, nowMs: now,
    witchStartled: p.witchStartled, entitiesPrev: pair ? pair.a.entities : [], portraits: p.portraits,
    version: p.version, hits });
  p.hitsRef.current = hits;
```

`actorPosition` is `eventPosition` with the actor forced: add to `markers.ts`:

```ts
/** The actor's position only (the "from" end of a flash line). */
export function actorPosition(frames: Frame[], slots: string[], e: TimelineEvent): WorldPos | null {
  return eventPosition(frames, slots, { ...e, target: null });
}
```

and export it (add a one-line test in markers.test.ts: `expect(actorPosition(FR, SLOTS, ev(1, 500, 'dp', 'H', 'C'))).toEqual({ x: 705, y: 70, z: 0 })`).

Add `p.timeline` (default `[]`) and `p.witchStartled`, `p.markers` to the repaint effect deps.

`Viewer.tsx`:

```ts
  const [toggles, toggle, setToggle] = useToggles();
  const tl = timeline ?? NO_TIMELINE;   // const NO_TIMELINE: TimelineEntry[] = [] at module level
  const markers = useMemo<MarkerItem[]>(() => {
    if (!header || tl.length === 0 || !toggles.events) return [];
    const list = markerEntries(tl, toggles.showKind, selected);
    const out: MarkerItem[] = [];
    list.forEach((entry, i) => {
      const pos = eventPosition(frames, header.slots, entry);
      const kind = markerKind(entry.event);
      if (pos && kind) out.push({ entry, kind, pos, index: selected ? i + 1 : null });
    });
    return out;
  }, [tl, toggles.showKind, toggles.events, selected, frames.length, header?.slots]);
  const witchStartled = useMemo(() => witchStartledAt(tl, playback.tMs), [tl, playback.tMs]);
  const hitsRef = useRef<HitItem[]>([]);
```

Pass `markers`, `timeline={toggles.events ? tl : NO_TIMELINE}`, `witchStartled`, `hitsRef`, `portraits`, `version={header.version}` to `<ReplayCanvas>`. Render `<MarkerFilters>` directly above the stage inside `replay__frame`'s sibling position (above `{canvas}` in the non-theater layout, and inside `theater__top` after the controls in theater), only when `timeline` is defined.

Note `index` is 1-based and follows `markerEntries`' round order, which is also the order `tickEntries` gives the rail for that player once filtered to mapped kinds; the rail groups by kind, so the number is the position in the player's mapped-event list, and the rail shows the same number by looking it up (Task 10 adds it there).

`app.css`:

```css
.replay__filters { display: flex; gap: var(--sp-3); align-items: center; flex-wrap: wrap; padding: 0 var(--sp-2); }
.replay__filter { display: inline-flex; align-items: center; gap: var(--sp-1); font-family: var(--font-label); font-size: var(--fs-dense); letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
.replay__filter select { background: rgba(21, 17, 14, 0.85); color: var(--text); border: 1px solid var(--line); padding: 2px 6px; font: inherit; text-transform: none; letter-spacing: 0; }
```

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck`
Expected: PASS. Open the local viewer on a match with a timeline (`/match/9001`, which has 9 seeded events) and confirm tags appear, the Show select lists kinds with counts, picking a player in the follow row changes the for select and numbers the tags, and a boom pulses when the playhead crosses it.

- [ ] **Step 5: Commit**

```bash
git add web/src/replay web/src/styles/app.css
git commit -m "feat(replay): Show and for filters, markers and bursts wired through the viewer"
```

---

### Task 9: Tooltips and click to seek

**Files:**
- Create: `web/src/replay/ReplayTooltip.tsx`, `web/src/replay/tooltipText.ts`
- Test: `web/src/replay/tooltipText.test.ts`
- Modify: `web/src/replay/Viewer.tsx`, `web/src/styles/app.css`

**Interfaces:**
- Consumes: `HitItem`, `hitTest` (Task 7); `statusFlags`, `healthBar` from `./hud`; `eventSentence` from `./eventText`; `formatTime` from `./ReplayControls`; `entityStyle`, `slotLabel` from `./draw`; `pictogramFor`; `SURVIVOR_CHARACTERS`, `ZOMBIE_CLASSES`, `ENTITY_KIND`.
- Produces: `tooltipText(hit: HitItem, ctx: { players: PlayerSample[]; slots: string[]; names: Record<string,string>; version: number; timeline: TimelineEntry[]; witchStartled: boolean }): string | null`; `ReplayTooltip` props `{ text: string | null; x: number; y: number; stageW: number; stageH: number }`.

- [ ] **Step 1: Failing tests**

`web/src/replay/tooltipText.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ENTITY_KIND, STATE } from '../../../src/replayFormat';
import { tooltipText } from './tooltipText';

const sample = (over: Record<string, unknown>) => ({
  slot: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: STATE.PRESENT | STATE.ALIVE, health: 100, temp: 0,
  cls: 0, weapon: 0, clip: 0, reserve: 0, infected: false, ...over,
});
const base = {
  slots: ['A', '', '', '', 'H', '', '', ''], names: { A: 'alice', H: 'hank' }, version: 2,
  timeline: [{ seq: 3, tMs: 61000, kind: 'event' as const, event: 'dp', actor: 'H', target: 'A', value: 24 }],
  witchStartled: false,
};

describe('tooltipText', () => {
  it('names a survivor with character, states and health, never the SteamID', () => {
    const players = [sample({ slot: 0, cls: 2, health: 34, temp: 20, state: STATE.PRESENT | STATE.ALIVE | STATE.BILED })];
    expect(tooltipText({ kind: 'player', px: 0, py: 0, r: 1, slot: 0 }, { ...base, players }))
      .toBe('alice · Francis · Biled · 34 + 20');
  });
  it('names an infected by class, and a ghost only as unspawned', () => {
    const hunter = sample({ slot: 4, cls: 3, infected: true, health: 250 });
    expect(tooltipText({ kind: 'player', px: 0, py: 0, r: 1, slot: 4 }, { ...base, players: [hunter] })).toBe('hank · Hunter · 250');
    const ghost = sample({ slot: 4, cls: 3, infected: true, state: STATE.PRESENT | STATE.ALIVE | STATE.GHOST });
    expect(tooltipText({ kind: 'player', px: 0, py: 0, r: 1, slot: 4 }, { ...base, players: [ghost] })).toBe('Unspawned infected');
  });
  it('falls back to the slot label with no roster', () => {
    const players = [sample({ slot: 1, health: 100 })];
    expect(tooltipText({ kind: 'player', px: 0, py: 0, r: 1, slot: 1 }, { ...base, players, version: 1 })).toBe('S2 · 100');
  });
  it('describes entities, including a startled witch and a tank with health', () => {
    const ctx = { ...base, players: [] };
    expect(tooltipText({ kind: 'entity', px: 0, py: 0, r: 1, entityKind: ENTITY_KIND.WITCH, health: 1000, state: 0 }, ctx)).toBe('Witch');
    expect(tooltipText({ kind: 'entity', px: 0, py: 0, r: 1, entityKind: ENTITY_KIND.WITCH, health: 1000, state: 0 }, { ...ctx, witchStartled: true })).toBe('Witch · startled');
    expect(tooltipText({ kind: 'entity', px: 0, py: 0, r: 1, entityKind: ENTITY_KIND.TANK_AI, health: 6200, state: 0 }, ctx)).toBe('AI tank · 6200');
    expect(tooltipText({ kind: 'entity', px: 0, py: 0, r: 1, entityKind: ENTITY_KIND.TANK_ROCK, health: 0, state: 0 }, ctx)).toBe('Rock');
  });
  it('reads a marker as the time and the event sentence', () => {
    expect(tooltipText({ kind: 'marker', px: 0, py: 0, r: 1, seq: 3 }, { ...base, players: [] })).toBe('1:01 · hank pounced alice for 24');
    expect(tooltipText({ kind: 'marker', px: 0, py: 0, r: 1, seq: 99 }, { ...base, players: [] })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run web/src/replay/tooltipText.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`web/src/replay/tooltipText.ts`:

```ts
import { ENTITY_KIND, STATE, SURVIVOR_CHARACTERS, ZOMBIE_CLASSES, type PlayerSample } from '../../../src/replayFormat';
import type { HitItem } from './hitTest';
import { isSurvivor, slotLabel } from './draw';
import { statusFlags } from './hud';
import { eventSentence } from './eventText';
import { formatTime } from './ReplayControls';
import type { TimelineEntry } from './timeline';

export interface TooltipContext {
  players: PlayerSample[];
  slots: string[];
  names: Record<string, string>;
  version: number;
  timeline: TimelineEntry[];
  witchStartled: boolean;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const ENTITY_NAMES: Record<number, string> = {
  [ENTITY_KIND.COMMON]: 'Common', [ENTITY_KIND.WITCH]: 'Witch', [ENTITY_KIND.TANK_ROCK]: 'Rock',
  [ENTITY_KIND.TANK_AI]: 'AI tank', [ENTITY_KIND.SURVIVOR_BOT]: 'Survivor bot',
  [ENTITY_KIND.SMOKER_AI]: 'AI smoker', [ENTITY_KIND.BOOMER_AI]: 'AI boomer', [ENTITY_KIND.HUNTER_AI]: 'AI hunter',
};

/** One line for the hover tooltip, or null when there is nothing to say.
 *  Names resolve through the roster and fall back to the slot label; a
 *  SteamID64 is never printed. */
export function tooltipText(hit: HitItem, c: TooltipContext): string | null {
  if (hit.kind === 'marker') {
    const e = c.timeline.find((t) => t.kind === 'event' && t.seq === hit.seq);
    if (!e || e.kind !== 'event') return null;
    const nameOf = (id: string) => c.names[id] ?? slotLabel(Math.max(0, c.slots.indexOf(id)));
    return `${formatTime(e.tMs)} · ${eventSentence(e, nameOf)}`;
  }
  if (hit.kind === 'entity') {
    const parts = [ENTITY_NAMES[hit.entityKind] ?? 'Entity'];
    if (hit.entityKind === ENTITY_KIND.WITCH && c.witchStartled) parts.push('startled');
    if (hit.entityKind === ENTITY_KIND.TANK_AI) parts.push(String(hit.health));
    return parts.join(' · ');
  }
  const p = c.players.find((pl) => pl.slot === hit.slot);
  if (!p) return null;
  if ((p.state & STATE.GHOST) !== 0) return 'Unspawned infected';
  const name = c.names[c.slots[p.slot]] || slotLabel(p.slot);
  const parts = [name];
  if (isSurvivor(p)) {
    if (c.version >= 2 && SURVIVOR_CHARACTERS[p.cls]) parts.push(cap(SURVIVOR_CHARACTERS[p.cls]));
  } else if (ZOMBIE_CLASSES[p.cls]) {
    parts.push(cap(ZOMBIE_CLASSES[p.cls]));
  }
  const flags = statusFlags(p.state);
  if (flags.length && (p.state & STATE.ALIVE) !== 0) parts.push(...flags);
  if ((p.state & STATE.ALIVE) === 0) parts.push('Dead');
  else parts.push(p.temp > 0 ? `${p.health} + ${p.temp}` : String(p.health));
  return parts.join(' · ');
}
```

(`statusFlags` returns `['Dead']` for a dead player already; the branch above avoids printing it twice: dead players skip flags and push 'Dead' once. Check the test expectations against `statusFlags`' exact strings, 'Biled' is one of them.)

`web/src/replay/ReplayTooltip.tsx`:

```tsx
/** The one tooltip over the stage. Positioned above-right of the pointer
 *  and flipped when it would leave the stage. */
export function ReplayTooltip(
  { text, x, y, stageW, stageH }: { text: string | null; x: number; y: number; stageW: number; stageH: number },
) {
  if (!text) return null;
  const flipX = x > stageW - 180;
  const flipY = y < 40;
  const style = {
    left: `${flipX ? x - 12 : x + 12}px`,
    top: `${flipY ? y + 14 : y - 10}px`,
    transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '0' : '-100%'})`,
  };
  return <div class="replay__tip" role="tooltip" style={style}>{text}</div>;
}
```

`Viewer.tsx`: keep `const [hover, setHover] = useState<{ x: number; y: number; hit: HitItem | null }>(...)`. On the stage `div`, add:

```tsx
      onPointerMove={(e) => {
        camera.onPointerMove?.(e);
        if (camera.dragging) { setHover(null); return; }
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left; const y = e.clientY - rect.top;
        const s = shiftRef.current;
        const hit = hitTest(hitsRef.current, x - s.x, y - s.y);
        setHover(hit ? { x, y, hit } : null);
      }}
      onPointerLeave={() => setHover(null)}
      onClick={(e) => {
        if (!hover?.hit || hover.hit.kind !== 'marker') return;
        const entry = tl.find((t) => t.kind === 'event' && t.seq === (hover.hit as { seq: number }).seq);
        if (entry) playback.seek(entry.tMs);
      }}
```

(The follow camera translates the scene by `shiftRef`, so pointer coordinates are moved back by it before hit testing. Check `useCamera` for an existing pointer-move handler name and call it first; if none is exposed, omit that line.) Throttle: hit testing runs on every pointermove, which is at most the display rate; the loop is `hits.length` comparisons, fine.

Render `<ReplayTooltip text={hover ? tooltipText(hover.hit, { players: livePlayers, slots: header.slots, names, version: header.version, timeline: tl, witchStartled }) : null} x={hover?.x ?? 0} y={hover?.y ?? 0} stageW={size.cssW} stageH={size.cssH} />` inside the stage div after the vignette.

`app.css`:

```css
.replay__tip { position: absolute; z-index: 3; pointer-events: none; background: rgba(5, 4, 3, 0.92); color: var(--text); border: 1px solid var(--line); padding: 3px 7px; font-size: 12px; white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
```

- [ ] **Step 4: Run the tests and try it**

Run: `npm test && npm run typecheck`. Then in the local viewer hover a medallion, an AI special and a tag; click a tag and confirm the playhead moves. In the in-app Browser pane `read_page` can confirm the tooltip element's text after a `computer hover`.

- [ ] **Step 5: Commit**

```bash
git add web/src/replay web/src/styles/app.css
git commit -m "feat(replay): hover tooltips for medallions, entities and tags; click a tag to seek"
```

---

### Task 10: Key panel, Key chip, rail numbers

**Files:**
- Create: `web/src/replay/KeyPanel.tsx`, `web/src/replay/KeyPanel.test.tsx`
- Modify: `web/src/replay/ReplayHud.tsx` (`TOGGLE_LABELS` gains `['key', 'Key']`), `web/src/replay/Viewer.tsx`, `web/src/replay/TimelineRail.tsx`, `web/src/styles/app.css`

**Interfaces:**
- Consumes: `SLOT_COLORS`, `GHOST_COLOR`, `entityStyle`, `slotLabel` (draw), `STATE_RINGS`, `DEAD_COLOR` (stateRing), `PICTOGRAMS` (pictograms), `MARKER_KINDS` (markers).
- Produces: `KeyPanel` props `{ onClose(): void }`.

- [ ] **Step 1: Failing test**

`web/src/replay/KeyPanel.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { KeyPanel } from './KeyPanel';
import { STATE_RINGS } from './stateRing';
import { MARKER_KINDS } from './markers';

describe('KeyPanel', () => {
  it('lists every state, every marker letter, the ghost and the dead treatment, from the tables', () => {
    render(<KeyPanel onClose={() => {}} />);
    for (const r of STATE_RINGS) expect(screen.getByText(r.label)).toBeTruthy();
    for (const k of MARKER_KINDS) expect(screen.getAllByText(k.label).length).toBeGreaterThan(0);
    expect(screen.getByText('Unspawned infected')).toBeTruthy();
    expect(screen.getByText('Dead')).toBeTruthy();
    expect(screen.getByText('S1')).toBeTruthy();
    expect(screen.getByText('I4')).toBeTruthy();
  });
  it('closes on Escape and on its button', () => {
    const onClose = vi.fn();
    render(<KeyPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close key' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run web/src/replay/KeyPanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`KeyPanel.tsx`:

```tsx
import { useEffect } from 'preact/hooks';
import { ENTITY_KIND } from '../../../src/replayFormat';
import { GHOST_COLOR, SLOT_COLORS, entityStyle, slotLabel } from './draw';
import { DEAD_COLOR, STATE_RINGS } from './stateRing';
import { PICTOGRAMS, type PictogramName } from './pictograms';
import { MARKER_KINDS } from './markers';

function Swatch({ color, ring }: { color: string; ring?: boolean }) {
  return <span class={`key__swatch${ring ? ' key__swatch--ring' : ''}`} style={{ color }} aria-hidden="true" />;
}

function Pict({ name }: { name: PictogramName }) {
  return (
    <svg class="key__pict" viewBox="0 0 20 20" aria-hidden="true"><path d={PICTOGRAMS[name]} fill="currentColor" /></svg>
  );
}

const ENTITY_ROWS: [number, string][] = [
  [ENTITY_KIND.COMMON, 'Common'], [ENTITY_KIND.WITCH, 'Witch'], [ENTITY_KIND.TANK_ROCK, 'Rock'],
  [ENTITY_KIND.TANK_AI, 'AI tank'], [ENTITY_KIND.SURVIVOR_BOT, 'Survivor bot'],
  [ENTITY_KIND.SMOKER_AI, 'AI smoker'], [ENTITY_KIND.BOOMER_AI, 'AI boomer'], [ENTITY_KIND.HUNTER_AI, 'AI hunter'],
];

/**
 * The legend, built from the same tables the canvas draws from, so adding a
 * state or a marker kind puts it here with no second edit.
 */
export function KeyPanel({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div class="key" role="dialog" aria-label="Map key">
      <div class="key__head">
        <span class="label">Key</span>
        <button type="button" class="chip" onClick={onClose} aria-label="Close key">Close</button>
      </div>
      <div class="key__cols">
        <section>
          <h5>Players</h5>
          <ul>
            {SLOT_COLORS.map((c, i) => <li key={i}><Swatch color={c} ring />{slotLabel(i)}</li>)}
            <li><Swatch color={GHOST_COLOR} ring />Unspawned infected</li>
            <li><Swatch color={DEAD_COLOR} ring />Dead</li>
          </ul>
        </section>
        <section>
          <h5>State ring</h5>
          <ul>{STATE_RINGS.map((r) => <li key={r.key}><Swatch color={r.color} ring />{r.label} <span class="muted">{r.glyph}</span></li>)}</ul>
          <h5>Infected class</h5>
          <ul>{(Object.keys(PICTOGRAMS) as PictogramName[]).map((n) => <li key={n}><Pict name={n} />{n.charAt(0).toUpperCase() + n.slice(1)}</li>)}</ul>
        </section>
        <section>
          <h5>World</h5>
          <ul>{ENTITY_ROWS.map(([k, label]) => <li key={k}><Swatch color={entityStyle(k)!.color} />{label}</li>)}</ul>
        </section>
        <section>
          <h5>Events</h5>
          <ul>{MARKER_KINDS.map((k) => <li key={k.kind}><span class="key__tag" style={{ borderColor: k.color }}>{k.letter}</span>{k.label}</li>)}</ul>
        </section>
      </div>
    </div>
  );
}
```

`ReplayHud.tsx`: add `['key', 'Key']` to `TOGGLE_LABELS`. `Viewer.tsx`: render `{toggles.key && <KeyPanel onClose={() => setToggle('key', false)} />}` inside the stage div (after the HUD) in both layouts.

`TimelineRail.tsx`: when `selected !== null`, compute `const numbered = new Map(markerEntries(timeline, 'all', selected).map((e, i) => [e.seq, i + 1]))` and render `<span class="replay__entry-n">{numbered.get(e.seq)}</span>` before the time on entries that have one, so the rail's numbers match the tags' (with Show at All events; a narrowed Show renumbers the tags only, which the tag tooltips still explain by sentence).

`app.css`:

```css
.key { position: absolute; z-index: 4; top: var(--sp-3); left: var(--sp-3); max-width: min(92%, 640px); max-height: calc(100% - 2 * var(--sp-3)); overflow: auto; background: rgba(5, 4, 3, 0.94); border: 1px solid var(--line); padding: var(--sp-2) var(--sp-3); font-size: 12px; pointer-events: auto; }
.key__head { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--sp-2); }
.key__cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--sp-3); }
.key h5 { margin: 0 0 var(--sp-1); font-family: var(--font-label); font-size: var(--fs-dense); letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
.key ul { list-style: none; margin: 0 0 var(--sp-2); padding: 0; }
.key li { display: flex; align-items: center; gap: 6px; line-height: 1.6; }
.key__swatch { width: 12px; height: 12px; border-radius: 50%; background: currentColor; flex: none; }
.key__swatch--ring { background: #14110f; border: 2.5px solid currentColor; }
.key__pict { width: 14px; height: 14px; color: #fff; flex: none; }
.key__tag { display: inline-flex; width: 12px; height: 12px; align-items: center; justify-content: center; border: 2px solid; background: rgba(5, 4, 3, 0.82); font: bold 7px sans-serif; color: #fff; flex: none; }
.replay__entry-n { display: inline-block; min-width: 1.2em; margin-right: 4px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
```

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck`
Expected: PASS. Open the viewer, press the Key chip, confirm every table row appears and Escape closes it.

- [ ] **Step 5: Commit**

```bash
git add web/src/replay web/src/styles/app.css
git commit -m "feat(replay): Key panel from the drawing tables, Key chip, rail bookmark numbers"
```

---

### Task 11: Visual pass, performance check, docs

**Files:**
- Modify: `docs/superpowers/specs/2026-09-13-replay-viewer-avatars-design.md` (append "Built" note), `web/src/replay/draw.ts` comments if any constant moved

- [ ] **Step 1: Screenshots at both widths**

With `npm run dev` on 5173 and the seeded match 9001, run `npm run shoot` and open `shots/match-9001-1400.png` and `shots/match-9001-390.png`. Check: medallions with silhouettes, rims and badges; tags with letters; the filters row above the stage; nothing overflowing horizontally at 390. Also load `/replay/file/pug_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_0_1.rpl` at zoom 6x for the cluster case and screenshot with the Browser pane.

- [ ] **Step 2: Frame cost**

In headless Chrome (the `google-chrome-stable --headless=new --remote-debugging-port` CDP approach from `l4d1-replay-viewer` notes) or the in-app pane, run this once on the standalone replay at 1x playback:

```js
const c = document.querySelector('canvas'); const ctx = c.getContext('2d');
let n = 0, t = 0; const orig = ctx.drawImage;
// Sample: time 120 rAF paints via performance.now around the loop's paint.
```

Simpler: add a temporary `performance.mark`/`measure` pair around `drawScene` in `paint`, read `performance.getEntriesByName` after ten seconds, and remove it. Target: median under 2 ms on the workstation with eight players and the fixture's 14 commons. Record the number in the spec's "Built" note. If over budget, the first candidates are the per-frame `pinnersAt` walk (cache by `tMs` in `ReplayCanvas`) and the per-marker `fillText`.

- [ ] **Step 3: Spec note**

Append to the spec:

```markdown
## Built 2026-09-13

Tasks 1 to 10 of `docs/superpowers/plans/2026-09-13-replay-viewer-avatars.md`.
Pinned gold moved from #c9a45c to #e0b654 (see stateRing.ts). Biled purple is
exempt from the dichromacy rim test against survivor slots, by name, with the
B glyph as the channel. Draw cost measured at <N> ms median per frame.
```

- [ ] **Step 4: Full suite, commit**

```bash
npm test && npm run typecheck
git add docs/superpowers/specs/2026-09-13-replay-viewer-avatars-design.md web/src/replay
git commit -m "docs(design): record the avatars build, measured frame cost"
```

Deploying is a separate go-ahead (the live box); do not run `deploy-web.sh` as part of this plan.

---

## Self-review

**Spec coverage.** Section 1 medallions: Tasks 3 and 4 (size, face, pictogram, rim, badge, wedge, ghost, dead, draw order, portrait loading). Section 2 state ring, arc, glyph, follow ring, label gap, palette proof: Tasks 1, 3, 4. Section 3 entities, rock streak, startled witch: Task 5 (witch flag computed in Task 8). Section 4 pins, bursts, markers, filters, numbering, time dimming, click to seek, layering, Events toggle: Tasks 6, 7, 8, 9. Section 5 tooltips and Key: Tasks 9, 10. Section 6 code shape: the module split matches. Section 7 testing: each task carries its tests; the visual and shoot pass is Task 11. Section 9 frame cost: Task 11.

**Placeholders.** None: every step carries its code. Task 11's `<N>` is filled by the measurement in that task.

**Type consistency.** `DrawArgs` fields introduced: `portraits`, `version` (Task 4); `entitiesPrev`, `witchStartled` (Task 5); `markers`, `bursts`, `pinners`, `tMs`, `nowMs`, `hits` (Task 7). `ReplayCanvas` passes all of them in Task 8; Tasks 4, 5 and 7 each note the interim values so the build stays green. `useToggles` returns a triple from Task 8 on; `Viewer` is the only caller. `MarkerItem.index` is 1-based both on the tag (Task 7) and in the rail (Task 10). `FOLLOW_RING_GAP` now lives in `avatar.ts`; Task 4 tells the implementer to re-export it from `draw.ts` if anything imports it from there.
