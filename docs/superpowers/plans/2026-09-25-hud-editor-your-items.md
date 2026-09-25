# HUD editor "Your items" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new survivor element, Your items, that shows your own medkit, pills and throwable as one row the player can place anywhere at or right of their health bar, with the stock item slots switched off, the limit shown while placing, and a download that keeps the health card exactly where it was.

**Architecture:** A pure geometry module (`web/src/hud/youritems.ts`) turns four numbers (the health bar's drawn x, the screen width, the font's tall, the alignment) into the row's drawn box and the Items Label the download writes. `build.ts` reads those numbers off a design (`ownBarX`, `yourItemsInput`, `yourItemsLayout`), answers `elementRect` for the element, and adds one download-only pass (`yourItemsPass`, after `scalePass`, before `reviveAnchorPass`) that makes the own panel full screen and re-expresses every piece at its old screen place. `edit.ts` turns it on and off in one edit and routes every move through the bar limit; `mock.ts` draws the row with the teammate cards' own glyph painter and draws the limit in the editor chrome only.

**Tech Stack:** TypeScript, Preact, Vitest (happy-dom and node environments), the repo's KeyValues reader (`kv.ts`) and VPK writer.

**Spec:** `docs/superpowers/specs/2026-09-25-hud-editor-your-items-design.md` (evidence: `/home/volence/l4d/hud/probe-your-items/RESULTS.md`, `/home/volence/l4d/hud/probe-your-items/build.mts`, `/home/volence/l4d/hud/probe-own-items/RESULTS.md`).

## Global Constraints

- Work only in `/home/volence/l4d/pug/.claude/worktrees/your-items` (branch `your-items`). NEVER `git stash`, never checkout or switch branches, never move HEAD except by your own commits, never touch `/home/volence/l4d/pug` (other sessions use it). `git add` only the files your task names.
- No em dashes anywhere: code, comments, test names, commit messages, UI text. Rephrase by meaning.
- Off by default: `DEFAULT_DESIGN` gains nothing, and every saved design (including one that stores Your items with `visible: false`) builds byte-identically. `web/src/hud/download.golden.test.ts` must pass unchanged, hashes untouched.
- Element id `yourItems`, label `Your items`, survivor side, listed in Layers under "You" right after Your health.
- Fonts exactly: `L4D_Icons` (16), `L4D_Icons_medium` (18, default, the teammate cards' font), `L4D_Icons_large` (24). Colour is `fgcolor_override`; unset means the game's white. Alignment `right` (default) or `center` only; no Left.
- Turning on is ONE edit: `visible: true` plus `weapons.itemSize = 0` plus `weapons.itemIcons = false` (one Undo restores all). Turning off only hides the element and leaves the weapons fields.
- The element's note, verbatim: `The game puts your health bar at this row's left edge, so the icons can only sit level with or right of your health bar.`
- The import note, verbatim text: `This HUD already places your items itself.`
- The limit line label, verbatim: `Your health bar's edge`. The limit colour must differ from the pink snap guides (`#ff4fa3`). The limit is drawn only in the editor chrome (`HudView`), never into a share, publish or close-up image.
- Build pass order: `yourItemsPass` runs after `scalePass` and before `reviveAnchorPass` in `buildHud`.
- Match the codebase's comment style: long doc comments that cite probe evidence by path.
- Commands, from the worktree root: `npx vitest run web/src/hud/<file>` for one file, `npx vitest run` for the suite (7468 tests passing at the start), `npm run typecheck`. If `node_modules` is missing, `ln -s /home/volence/l4d/pug/node_modules node_modules` (it is gitignored; check with `ls -d node_modules` first).

## Review Focus

1. A drag of Your items that the snap pulls onto a target left of the bar: the row stops at the bar's edge, and no pink guide is drawn at an x the row is not at (Task 5's `yourItemsHeld` test; Task 7 wires it into the drag).
2. Switching the aspect (16:9 to 4:3) after placing the row near the right edge: preview and download both hold the row on the narrower screen (Task 4 test "holds a row placed at 16:9 on a 4:3 screen").
3. Picking Large at the screen's right edge with Right alignment: the right end stays put and the row stays on screen (Task 5 test "holds a large row at the screen edge on screen").
4. A design that says `visible: true` but stores no place (hand-edited, an old share link): preview and download agree, both at the home spot (Task 4 test "builds a design with no stored place at the home spot the preview draws").
5. A typed X past Centre's right limit: the row lands at the widest centre that fits, and the drawn right-hand limit line is exactly where it stopped (Task 5 test "stops at the screen edge, and Centre at its right limit").

## File map

- Create `web/src/hud/youritems.ts`: constants, types and pure geometry (`itemRowWidth`, `rowLayout`, `rowXRange`, `placeRow`, `rowLimitLines`). Test: `web/src/hud/youritems.test.ts`.
- Modify `web/src/hud/render.ts`: `ITEM_ROW` and the row width move to `youritems.ts` (re-exported, behaviour unchanged).
- Modify `web/src/hud/elements.ts`, `web/src/hud/design.ts`: the registry entry and the stored fields. Tests: `elements.test.ts`, `design.test.ts`.
- Modify `web/src/hud/weaponColumn.ts`: `weaponRowsEdge` for the home spot.
- Modify `web/src/hud/build.ts`: the read side (Task 3) and the download pass (Task 4). Test: create `web/src/hud/build.youritems.test.ts`; adjust `build.test.ts`, `community/publish.test.ts`, `routes/Hud.test.tsx` where the new element shows up.
- Modify `web/src/hud/edit.ts`: `setYourItems`, `setItemsLook`, `yourItemsHeld`, the `placeElement` and `setSelectionVisible` routes. Test: `edit.test.ts`.
- Modify `web/src/hud/mock.ts`: `paintYourItems`, `HudView.limits`, `drawLimits`. Test: create `web/src/hud/youritems.preview.test.ts`.
- Modify `web/src/routes/hud/LayersPanel.tsx`, `web/src/routes/hud/ContextPanel.tsx`, `web/src/routes/Hud.tsx`. Test: `routes/Hud.test.tsx`.
- Outside the repo (Task 8 only): `/home/volence/l4d/hud/probe-your-items/p4/`.

## Decisions this plan makes where the spec is silent

- `yourItemsPass` is download-only (like `elementHidePass` and `codeShownPass`); `buildTrees` does not run it. The preview draws the own card from `LocalPlayer` inside the element (`mock.ts paintOwnHealth`, `panelBoxes`), which a full-screen frame would break, and spec 4 says the preview never needs the full-screen frame. Task 4's equivalence test (every piece's screen box equal with the element on and off, both presets, all three aspects) is what keeps the preview and the download in step.
- The Label is `tall = font tall + 6` (3 units above and below the glyph cell): medium gives 24, the exact Label probe p3 drew. The Label ends at least `EDGE_MARGIN = 2` units in from the screen's right edge: probe-own-items v3 saw a glyph cut when the Label ended exactly at the edge.
- The stored `x`, `y` are the row box's top-left in whole units. The drawn row follows from the Label's whole-unit width, so it sits within half a unit of the stored x; the X box shows the drawn x rounded, which is the stored x for every font.
- "The weapon selection's drawn right edge" is the weapon boxes' right edge (`RightSideIndent` in from the panel's), where the pistol box ends.
- The alignment select reads "Right" and "Centre" (the codebase's spelling, as the kill notices' "Centre"); the stored value is `center`.
- The Centre right-hand limit's label: `Right limit for a centred row`. The unreadable-import note: `The editor cannot read where this HUD puts your health panel, so it cannot place your items here.`
- With Your health hidden, the bar limit still applies (the bar is still where the game puts it, just hidden).

---

### Task 1: The geometry module

**Files:**
- Create: `web/src/hud/youritems.ts`
- Modify: `web/src/hud/render.ts:1186-1198` (ITEM_ROW, itemRowWidth)
- Test: `web/src/hud/youritems.test.ts`

**Interfaces:**
- Consumes: `ICON_ADVANCE`, `ICON_SPACE` from `web/src/hud/art/index.ts`; `SCREEN_H` from `units.ts`; `type Box` from `design.ts` (type only, no runtime import, so `design.ts` can import this module).
- Produces (all exported from `youritems.ts`):
  - `YOUR_ITEMS = 'yourItems'`
  - `type ItemFont = 'L4D_Icons' | 'L4D_Icons_medium' | 'L4D_Icons_large'`, `ITEM_FONTS: readonly ItemFont[]`, `DEFAULT_ITEM_FONT: ItemFont`, `ITEM_FONT_TALL: Readonly<Record<ItemFont, number>>`, `ITEM_FONT_LABELS: Readonly<Record<ItemFont, string>>`
  - `type ItemAlign = 'right' | 'center'`
  - `ITEM_ROW: readonly string[]`, `itemRowWidth(s: number): number`
  - `LABEL_PAD = 3`, `EDGE_MARGIN = 2`
  - `interface RowInput { barX: number; screenW: number; tall: number; align: ItemAlign }`
  - `interface RowLayout { row: Box; label: Box }`
  - `interface LimitLine { x: number; side: 'left' | 'right'; label: string }`
  - `BAR_EDGE_LABEL`, `CENTRE_EDGE_LABEL`
  - `rowLayout(inp: RowInput, at: { x: number; y: number }): RowLayout`
  - `rowXRange(inp: RowInput): { min: number; max: number }`
  - `placeRow(inp: RowInput, want: { x: number; y: number }): { x: number; y: number }`
  - `rowLimitLines(inp: RowInput): LimitLine[]`
  - `render.ts` keeps exporting `ITEM_ROW` (re-export) so `render.test.ts` is untouched.

- [ ] **Step 1: Write the failing test**

Create `web/src/hud/youritems.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  ITEM_ROW, itemRowWidth, rowLayout, rowXRange, placeRow, rowLimitLines, EDGE_MARGIN, LABEL_PAD, BAR_EDGE_LABEL, CENTRE_EDGE_LABEL,
  ITEM_FONTS, ITEM_FONT_TALL, DEFAULT_ITEM_FONT, type RowInput,
} from './youritems';
import { ITEM_ROW as RENDER_ITEM_ROW } from './render';
import { ICON_ADVANCE, ICON_SPACE } from './art/index';

/** Stock at 16:9, fitted as a new design ships: the bar is drawn at 728 + 0 + 26. */
const STOCK: RowInput = { barX: 754, screenW: 853, tall: 18, align: 'right' };
/** Modern at 16:9: the bar at 8 + 3 + 31 (probe-your-items p2: the Label at x 42). */
const MODERN: RowInput = { barX: 42, screenW: 853, tall: 18, align: 'center' };

describe('the item row', () => {
  it('is the full loadout the game writes, medkit, pills, pipe bomb, the same row the teammate cards draw', () => {
    expect(ITEM_ROW).toEqual(['icon/item/medkit', 'icon/item/pills', 'icon/item/pipebomb']);
    expect(RENDER_ITEM_ROW).toBe(ITEM_ROW);
  });
  it('is each glyph\'s advance and a space between two, at the font\'s tall', () => {
    const s = 18;
    const want = ITEM_ROW.reduce((w, n, i) => w + ICON_ADVANCE[n] * s + (i ? ICON_SPACE * s : 0), 0);
    expect(itemRowWidth(s)).toBeCloseTo(want, 9);
    expect(itemRowWidth(18)).toBeCloseTo(47.5668, 3);
  });
  it('offers the game\'s three item icon fonts, medium by default', () => {
    expect(ITEM_FONTS).toEqual(['L4D_Icons', 'L4D_Icons_medium', 'L4D_Icons_large']);
    expect(ITEM_FONT_TALL).toEqual({ L4D_Icons: 16, L4D_Icons_medium: 18, L4D_Icons_large: 24 });
    expect(DEFAULT_ITEM_FONT).toBe('L4D_Icons_medium');
  });
});

describe('rowLayout, Right', () => {
  it('starts the Label at the bar and ends it where the row ends', () => {
    const { row, label } = rowLayout(STOCK, { x: 797, y: 233 });
    expect(label).toEqual({ x: 754, y: 233 - LABEL_PAD, w: 91, h: 18 + 2 * LABEL_PAD });
    expect(row.x + row.w).toBeCloseTo(label.x + label.w, 9);
    expect(row).toMatchObject({ y: 233, h: 18 });
    expect(row.x).toBeCloseTo(797.4332, 3);
  });
  it('holds the row at the bar\'s edge', () => {
    const { row, label } = rowLayout(STOCK, { x: 600, y: 233 });
    expect(label.w).toBe(Math.ceil(itemRowWidth(18)));
    expect(row.x).toBeGreaterThanOrEqual(754);
    expect(row.x).toBeLessThan(755);
  });
  it('holds the Label EDGE_MARGIN in from the screen edge', () => {
    const { label, row } = rowLayout(STOCK, { x: 900, y: 233 });
    expect(label.x + label.w).toBe(853 - EDGE_MARGIN);
    expect(row.x + row.w).toBeCloseTo(853 - EDGE_MARGIN, 9);
  });
  it('lets the bar\'s edge win when the row cannot fit right of it', () => {
    const inp = { ...STOCK, barX: 840 };
    const { row } = rowLayout(inp, { x: 0, y: 0 });
    expect(row.x).toBeGreaterThanOrEqual(840);
  });
  it('keeps the row on screen top to bottom, in whole units', () => {
    expect(rowLayout(STOCK, { x: 797, y: -50 }).row.y).toBe(0);
    expect(rowLayout(STOCK, { x: 797, y: 1000 }).row.y).toBe(480 - 18);
    expect(rowLayout(STOCK, { x: 797, y: 100.4 }).row.y).toBe(100);
  });
});

describe('rowLayout, Centre', () => {
  it('spans the Label from the bar to 2 x centre - bar, an even width', () => {
    const { row, label } = rowLayout(MODERN, { x: 420, y: 250 });
    expect(label.x).toBe(42);
    expect(label.w % 2).toBe(0);
    expect(label.w).toBe(804);
    expect(row.x + row.w / 2).toBeCloseTo(label.x + label.w / 2, 9);
  });
  it('falls back to the widest centre that fits', () => {
    const { label } = rowLayout(MODERN, { x: 800, y: 250 });
    expect(label.w).toBe(2 * Math.floor((853 - EDGE_MARGIN - 42) / 2));
    expect(label.x + label.w).toBeLessThanOrEqual(853 - EDGE_MARGIN);
  });
  it('holds the centre at least half a row right of the bar', () => {
    const { row, label } = rowLayout(MODERN, { x: 0, y: 250 });
    expect(label.w).toBe(2 * Math.ceil(itemRowWidth(18) / 2));
    expect(row.x).toBeGreaterThanOrEqual(42);
  });
});

describe('placeRow', () => {
  for (const inp of [STOCK, MODERN, { ...STOCK, tall: 16 }, { ...STOCK, tall: 24 }, { ...MODERN, tall: 24 }, { ...STOCK, barX: 380.5 }]) {
    it(`stores whole units inside the reachable range, and a stored place draws where it was asked (${inp.align}, ${inp.tall}, bar ${inp.barX})`, () => {
      const r = rowXRange(inp);
      for (let x = r.min - 30; x <= r.max + 30; x += 7.3) {
        const at = placeRow(inp, { x, y: 100 });
        expect(Number.isInteger(at.x) && Number.isInteger(at.y)).toBe(true);
        const drawn = rowLayout(inp, at).row.x;
        expect(drawn).toBeGreaterThanOrEqual(r.min - 1e-9);
        expect(drawn).toBeLessThanOrEqual(r.max + 1e-9);
        // Placing at where it is drawn stores the same number again (an arrow press or a drag start never jumps).
        expect(placeRow(inp, { x: drawn, y: 100 })).toEqual(at);
        if (x > r.min + 1 && x < r.max - 1) expect(Math.abs(drawn - x)).toBeLessThan(1);
      }
    });
  }
});

describe('rowLimitLines', () => {
  it('is the bar\'s edge for Right', () => {
    expect(rowLimitLines(STOCK)).toEqual([{ x: 754, side: 'left', label: BAR_EDGE_LABEL }]);
    expect(BAR_EDGE_LABEL).toBe("Your health bar's edge");
  });
  it('adds the Centre right-hand limit where the widest centred row ends, when that is short of the screen edge', () => {
    const lines = rowLimitLines(MODERN);
    expect(lines[0]).toEqual({ x: 42, side: 'left', label: BAR_EDGE_LABEL });
    expect(lines[1].side).toBe('right');
    expect(lines[1].label).toBe(CENTRE_EDGE_LABEL);
    expect(lines[1].x).toBeCloseTo(rowXRange(MODERN).max + itemRowWidth(18), 9);
    expect(lines[1].x).toBeLessThan(853);
  });
  it('leaves the right-hand line out when it would be past the screen edge', () => {
    expect(rowLimitLines({ ...MODERN, barX: 840 })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/hud/youritems.test.ts`
Expected: FAIL, "Failed to resolve import ./youritems".

- [ ] **Step 3: Write the module**

Create `web/src/hud/youritems.ts`:

```ts
/**
 * "Your items": your own medkit, pills and throwable as one row placed
 * anywhere at or right of your health bar
 * (docs/superpowers/specs/2026-09-25-hud-editor-your-items-design.md).
 *
 * The geometry, pure: where the preview draws the row and what Items Label
 * the download writes for it, from the four numbers that decide both (the
 * health bar's drawn x, the screen width, the font's tall, the alignment).
 * build.ts reads those numbers off a design (yourItemsInput); nothing here
 * reads a design, so every rule is tested on plain numbers.
 *
 * Why the bar: client.dll puts your health bar at the own panel's Items
 * child's x, at spawn and after every revive (probe-own-items v2: an Items
 * at x 20 pulled the bar to x 20, /home/volence/l4d/hud/probe-own-items/RESULTS.md).
 * So the Label starts at the bar's x and the glyphs can only sit at or right
 * of it. Right and Centre are resolution independent; Left would need
 * textinsetx, which is raw screen pixels (probe-your-items p1: 40 put the
 * glyphs 40 px in at 1080p, not 90; p2: 400 put them 400 px in,
 * /home/volence/l4d/hud/probe-your-items/RESULTS.md).
 */
import type { Box } from './design';
import { ICON_ADVANCE, ICON_SPACE } from './art/index';
import { SCREEN_H } from './units';

export const YOUR_ITEMS = 'yourItems';

/** The game's three item icon fonts (the ToolBox face at three talls in both presets' clientscheme.res). */
export type ItemFont = 'L4D_Icons' | 'L4D_Icons_medium' | 'L4D_Icons_large';
export const ITEM_FONTS: readonly ItemFont[] = ['L4D_Icons', 'L4D_Icons_medium', 'L4D_Icons_large'];
/** The stock teammate card's Items font. */
export const DEFAULT_ITEM_FONT: ItemFont = 'L4D_Icons_medium';
/** Each font's tall in the stock and Modern schemes: the fallback when a scheme lacks the font. */
export const ITEM_FONT_TALL: Readonly<Record<ItemFont, number>> = { L4D_Icons: 16, L4D_Icons_medium: 18, L4D_Icons_large: 24 };
export const ITEM_FONT_LABELS: Readonly<Record<ItemFont, string>> = {
  L4D_Icons: 'Small (16)', L4D_Icons_medium: 'Medium (18)', L4D_Icons_large: 'Large (24)',
};

/** Which end of the row stays put as items come and go: the Label's textAlignment east or center. */
export type ItemAlign = 'right' | 'center';

/**
 * The row the preview shows: a full loadout, in the order the game writes it.
 * client.dll builds the Items label's text as the medkit ('!'), the pills
 * ('"'), then one throwable (the pipe bomb '$', or the molotov '#' when that
 * is what is carried), with a space between each; a survivor carries one
 * throwable, so the row shows the pipe bomb.
 */
export const ITEM_ROW: readonly string[] = ['icon/item/medkit', 'icon/item/pills', 'icon/item/pipebomb'];

/** How wide the row is at s units (or canvas pixels) tall: each glyph's advance, and a space between two. */
export function itemRowWidth(s: number): number {
  return ITEM_ROW.reduce((w, name, i) => w + (ICON_ADVANCE[name] ?? 1) * s + (i ? ICON_SPACE * s : 0), 0);
}

/**
 * Units the Label reaches above and below the glyph cell: medium's 18 becomes
 * a 24-tall Label, the one probe p3 drew (a Label as tall as its font risks
 * clipping the glyph's last pixel row).
 */
export const LABEL_PAD = 3;
/**
 * Units the Label stays in from the screen's right edge: probe-own-items v3
 * saw an east-aligned medkit glyph cut where its Label ended exactly at the
 * edge (runs/v3 5-pipe-thrown).
 */
export const EDGE_MARGIN = 2;

export interface RowInput {
  /** Your health bar's drawn x on screen, units. */
  barX: number;
  screenW: number;
  /** The font's tall, units. */
  tall: number;
  align: ItemAlign;
}
export interface RowLayout {
  /** The glyph row as the preview draws it, a full loadout wide. */
  row: Box;
  /** The Items Label the download writes, in screen units. */
  label: Box;
}
/** A limit drawn while the row is placed: everything on `side` of `x` is out of reach. */
export interface LimitLine { x: number; side: 'left' | 'right'; label: string }
export const BAR_EDGE_LABEL = "Your health bar's edge";
export const CENTRE_EDGE_LABEL = 'Right limit for a centred row';

/**
 * The Label's narrowest and widest wide, whole units: never narrower than the
 * row, never past EDGE_MARGIN from the screen edge. Centre's is even, so its
 * centre is a whole unit from the bar. The narrowest wins where they cross:
 * the bar's edge is the rule the game enforces, the screen edge only clips.
 */
function labelWidths(inp: RowInput): { min: number; max: number } {
  const rowW = itemRowWidth(inp.tall);
  const room = inp.screenW - EDGE_MARGIN - inp.barX;
  if (inp.align === 'center') {
    const min = 2 * Math.ceil(rowW / 2);
    return { min, max: Math.max(min, 2 * Math.floor(room / 2)) };
  }
  const min = Math.ceil(rowW);
  return { min, max: Math.max(min, Math.floor(room)) };
}

/** Where the row is drawn in a Label `w` wide: its right end at the Label's (east), or its centre at the Label's (center). */
function rowXFor(inp: RowInput, w: number): number {
  const rowW = itemRowWidth(inp.tall);
  return inp.align === 'center' ? inp.barX + w / 2 - rowW / 2 : inp.barX + w - rowW;
}

/** The drawn row's x range: from the bar's edge to the screen's (Centre: the widest centre that fits). */
export function rowXRange(inp: RowInput): { min: number; max: number } {
  const w = labelWidths(inp);
  return { min: rowXFor(inp, w.min), max: rowXFor(inp, w.max) };
}

/**
 * The row stored at `at` (its box's top-left) as the game draws it: the
 * Label from the bar's x, as wide as puts the row's steady end nearest where
 * it was asked, held by labelWidths; its y whole and on screen.
 */
export function rowLayout(inp: RowInput, at: { x: number; y: number }): RowLayout {
  const rowW = itemRowWidth(inp.tall);
  const { min, max } = labelWidths(inp);
  const want = inp.align === 'center' ? 2 * Math.round(at.x + rowW / 2 - inp.barX) : Math.round(at.x + rowW - inp.barX);
  const w = Math.min(max, Math.max(min, want));
  const y = Math.min(SCREEN_H - inp.tall, Math.max(0, Math.round(at.y)));
  return {
    row: { x: rowXFor(inp, w), y, w: rowW, h: inp.tall },
    label: { x: inp.barX, y: y - LABEL_PAD, w, h: inp.tall + 2 * LABEL_PAD },
  };
}

/**
 * The stored numbers for a row asked for at `want` (a drag, an arrow, a typed
 * X): whole units, the x held to the whole units that still draw inside the
 * drawn range (rowXRange): rowLayout rounds the Label's wide, so a stored x
 * within half a unit of a limit draws exactly at it. A press past a limit
 * stores the limit, and a stored x always reads back from where it is drawn
 * (Math.round of the drawn x), so an arrow press never jumps.
 */
export function placeRow(inp: RowInput, want: { x: number; y: number }): { x: number; y: number } {
  const r = rowXRange(inp);
  const x = Math.min(Math.floor(r.max + 0.5), Math.max(Math.ceil(r.min - 0.5), Math.round(want.x)));
  const y = Math.min(SCREEN_H - inp.tall, Math.max(0, Math.round(want.y)));
  return { x, y };
}

/**
 * What the editor shows while the row is selected (spec section 2): the bar's
 * edge always, and for Centre the right end of the widest centred row when
 * that is short of the screen edge. Right's own right limit is the screen
 * edge less EDGE_MARGIN, which needs no line.
 */
export function rowLimitLines(inp: RowInput): LimitLine[] {
  const lines: LimitLine[] = [{ x: inp.barX, side: 'left', label: BAR_EDGE_LABEL }];
  if (inp.align === 'center') {
    const right = rowXRange(inp).max + itemRowWidth(inp.tall);
    if (right < inp.screenW) lines.push({ x: right, side: 'right', label: CENTRE_EDGE_LABEL });
  }
  return lines;
}
```

In `web/src/hud/render.ts`, replace the block from the `ITEM_ROW` doc comment through the private `itemRowWidth` (lines 1186-1198, "The row the preview shows" to the closing brace of `itemRowWidth`) with:

```ts
/**
 * The row the preview shows and its width live in youritems.ts, which the
 * Your items element shares: one row, drawn the same way on the cards and on
 * your own row.
 */
export { ITEM_ROW } from './youritems';
```

and add `itemRowWidth` and `ITEM_ROW` to the imports at the top of `render.ts`:

```ts
import { ITEM_ROW, itemRowWidth } from './youritems';
```

(`drawItems` and `itemRowStart` keep calling `itemRowWidth` and `ITEM_ROW` by the same names.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src/hud/youritems.test.ts web/src/hud/render.test.ts`
Expected: PASS (render.test.ts unchanged and green).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` (expected: no errors)

```bash
git add web/src/hud/youritems.ts web/src/hud/youritems.test.ts web/src/hud/render.ts
git commit -m "HUD editor: Your items geometry (row, Label, limits)"
```

---

### Task 2: The element and its stored fields

**Files:**
- Modify: `web/src/hud/elements.ts` (entry after `ownHealth`)
- Modify: `web/src/hud/design.ts` (`ElementOverride`, `element()`)
- Test: `web/src/hud/elements.test.ts`, `web/src/hud/design.test.ts`

**Interfaces:**
- Consumes: `YOUR_ITEMS`, `ITEM_FONTS`, `type ItemFont`, `type ItemAlign` from Task 1.
- Produces: `ElementOverride.itemFont?: ItemFont`, `ElementOverride.itemAlign?: ItemAlign`; registry entry `elementById('yourItems')` with `key: 'Items'`, `file: 'resource/ui/hud/localplayerpanel.res'`, `move: true`, `resize: 'none'`, `props: ['visible']`, `note` (verbatim, Global Constraints). Nothing builds it yet: `baseHasElement` still answers false (no Items block in a base file), so no pass, no Layers row and no painter sees it until Task 3.

- [ ] **Step 1: Write the failing tests**

In `web/src/hud/elements.test.ts`, change the first test's title and id list, and exempt the new key from the base-file check:

```ts
  it('has unique ids and the twenty-eight elements', () => {
    const ids = ELEMENTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['abilityMarker', 'abilityRing', 'chat', 'finaleMeter', 'ghostPanel', 'holdoutTimer', 'infectedRow', 'infectedVoice',
      'killNotices', 'leavingArea', 'ownHealth', 'ownMic', 'perilNotice', 'progressBar', 'siHealth', 'spawnCountdown', 'tankPanel', 'teamColumn',
      'voiceList', 'vote', 'weaponSelection', 'xhair', 'yourItems', 'zombiePanel', 'tabBoard', 'tabVersus', 'tabSurvivors', 'tabInfected'].sort());
  });
```

and in the "every key exists" test:

```ts
        if (e.id === 'xhair') continue;            // added by the generator, absent from stock
        if (e.id === 'yourItems') continue;        // the Items Label build.ts yourItemsPass adds; no base file has it
```

Append to `elements.test.ts`:

```ts
describe('Your items (spec 2026-09-25-hud-editor-your-items-design.md)', () => {
  it('is the own panel\'s Items Label, survivor only, moved but never sized, right after Your health', () => {
    const el = elementById('yourItems')!;
    expect(el).toMatchObject({ label: 'Your items', side: 'survivor', key: 'Items', file: 'resource/ui/hud/localplayerpanel.res',
      move: true, resize: 'none', children: [], props: ['visible'] });
    expect(el.note).toBe("The game puts your health bar at this row's left edge, so the icons can only sit level with or right of your health bar.");
    const ids = ELEMENTS.map((e) => e.id);
    expect(ids.indexOf('yourItems')).toBe(ids.indexOf('ownHealth') + 1);
  });
});
```

In `web/src/hud/design.test.ts` append:

```ts
describe('validateDesign: Your items', () => {
  it('keeps what it offers: shown, a place, a colour, a font and an alignment', () => {
    const d = validateDesign({ v: 1, elements: { yourItems: {
      visible: true, x: 790, y: 230, color: '255 0 255 255', itemFont: 'L4D_Icons_large', itemAlign: 'center',
      scale: 2, w: 90, h: 40, fit: true, keys: { font: 'x' }, dir: 'row',
    } } });
    expect(d.elements.yourItems).toEqual({ visible: true, x: 790, y: 230, color: '255 0 255 255', itemFont: 'L4D_Icons_large', itemAlign: 'center' });
  });
  it('drops a font or an alignment the game does not have', () => {
    const d = validateDesign({ v: 1, elements: { yourItems: { visible: true, itemFont: 'Default', itemAlign: 'left' } } });
    expect(d.elements.yourItems).toEqual({ visible: true });
  });
  it('keeps the font and alignment fields on no other element', () => {
    const d = validateDesign({ v: 1, elements: { chat: { x: 10, itemFont: 'L4D_Icons_large', itemAlign: 'center' } } });
    expect(d.elements.chat).toEqual({ x: 10 });
  });
  it('is not in a new design', () => {
    expect(DEFAULT_DESIGN.elements.yourItems).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/src/hud/elements.test.ts web/src/hud/design.test.ts`
Expected: FAIL (no `yourItems` element; the element's fields are not kept).

- [ ] **Step 3: Implement**

In `web/src/hud/elements.ts`, add the import and insert the entry directly after the `ownHealth` entry:

```ts
import { YOUR_ITEMS } from './youritems';
```

```ts
  /**
   * Your items: your own medkit, pills and throwable, anywhere at or right
   * of your health bar (docs/superpowers/specs/2026-09-25-hud-editor-your-items-design.md).
   * It is the own panel's Items Label, which client.dll fills with ToolBox
   * glyphs but only as a direct child of that panel
   * (/home/volence/l4d/hud/probe-own-items/RESULTS.md, v1), and which
   * build.ts yourItemsPass adds with the panel made full screen
   * (/home/volence/l4d/hud/probe-your-items/RESULTS.md, p1 to p3). No base
   * file has the block, so `key` names the one the build writes, and
   * baseHasElement answers for it from Your health's own panel. Off until
   * the player turns it on: an absent `visible` is off, never the file's.
   */
  { id: YOUR_ITEMS, label: 'Your items', side: 'survivor', key: 'Items', file: 'resource/ui/hud/localplayerpanel.res',
    move: true, resize: 'none', children: [], props: ['visible'],
    note: "The game puts your health bar at this row's left edge, so the icons can only sit level with or right of your health bar." },
```

In `web/src/hud/design.ts`, add the import:

```ts
import { YOUR_ITEMS, ITEM_FONTS, type ItemFont, type ItemAlign } from './youritems';
```

add to `ElementOverride` (after `noticeBox`):

```ts
  /** Your items only: the item icon font (youritems.ts ITEM_FONTS). Absent means L4D_Icons_medium, the teammate cards' font. */
  itemFont?: ItemFont;
  /** Your items only: which end of the row stays put as items come and go. Absent means 'right'. */
  itemAlign?: ItemAlign;
```

and in `element()`, directly before its final `return out;`:

```ts
  // Your items keeps only what it offers (youritems.ts): shown or not, a
  // place, a colour, a font and an alignment. Its place is the row's
  // top-left in whole units; the bar limit is applied where it is drawn and
  // built (build.ts yourItemsLayout), not here, since it moves with Your health.
  if (id === YOUR_ITEMS) {
    const keep: ElementOverride = {};
    if (out.visible !== undefined) keep.visible = out.visible;
    if (out.x !== undefined) keep.x = out.x;
    if (out.y !== undefined) keep.y = out.y;
    if (out.color) keep.color = out.color;
    if (ITEM_FONTS.includes(raw.itemFont as ItemFont)) keep.itemFont = raw.itemFont as ItemFont;
    if (raw.itemAlign === 'right' || raw.itemAlign === 'center') keep.itemAlign = raw.itemAlign;
    return keep;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src/hud/elements.test.ts web/src/hud/design.test.ts web/src/hud/download.golden.test.ts web/src/hud/build.test.ts`
Expected: PASS (golden hashes untouched).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add web/src/hud/elements.ts web/src/hud/design.ts web/src/hud/elements.test.ts web/src/hud/design.test.ts
git commit -m "HUD editor: Your items element and its stored fields"
```

---

### Task 3: build.ts reads Your items (bar x, blocked imports, home, rect)

**Files:**
- Modify: `web/src/hud/weaponColumn.ts` (add `weaponRowsEdge`)
- Modify: `web/src/hud/build.ts` (new exports; `elementRect`, `baseHasElement`, `layoutPass`, `elementHidePass` skip the element)
- Modify: `web/src/routes/hud/LayersPanel.tsx` (GROUPS: `yourItems` after `ownHealth`)
- Create: `web/src/hud/build.youritems.test.ts`
- Modify tests that list elements: `web/src/hud/build.test.ts:1758`, `web/src/community/publish.test.ts:185`, `web/src/routes/Hud.test.tsx:1405-1411`

**Interfaces:**
- Consumes: Task 1 (`rowLayout`, `rowLimitLines`, `itemRowWidth`, `ITEM_FONT_TALL`, `DEFAULT_ITEM_FONT`, `YOUR_ITEMS`, types), Task 2's registry entry and fields.
- Produces (exported from `build.ts`):
  - `ITEMS_OWN_NOTE = 'This HUD already places your items itself.'`
  - `ITEMS_UNREAD_NOTE = 'The editor cannot read where this HUD puts your health panel, so it cannot place your items here.'`
  - `ownBarX(design: HudDesign): number | undefined`
  - `yourItemsBlocked(design: HudDesign): string | null`
  - `yourItemsOn(design: HudDesign): boolean`
  - `yourItemsInput(design: HudDesign): RowInput`
  - `yourItemsHome(design: HudDesign): { x: number; y: number }`
  - `yourItemsLayout(design: HudDesign): RowLayout`
  - `yourItemsLimits(design: HudDesign): LimitLine[]`
  - `elementRect(design, 'yourItems', aspect)` returns `{ ...row, visible: yourItemsOn(design) }`
  - private (used by Task 4): `interface Anchored`, `interface OwnFrame`, `ownFrame(tree, aspect): OwnFrame | null`, `OWN_BOX`, `OWN_KEY`
- Produces (exported from `weaponColumn.ts`): `weaponRowsEdge(c: { n: (key: string) => number; panelWide: number; u: number }): { right: number; bottom: number }`

- [ ] **Step 1: Write the failing tests**

Create `web/src/hud/build.youritems.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import {
  buildHud, elementRect, ownBarX, yourItemsBlocked, yourItemsOn, yourItemsHome, yourItemsLayout, yourItemsLimits,
  ITEMS_OWN_NOTE, ITEMS_UNREAD_NOTE,
} from './build';
import { DEFAULT_DESIGN, validateDesign, type HudDesign, type ElementOverride } from './design';
import { baseFile, registerImport, unregisterImport } from './base';
import { sampleHud } from './importFixtures';
import { panelBoxes, visibleElements } from './mock';
import { childRects } from './render';
import { weaponSlots } from './weapons';
import { ammoOnly } from './edit';
import { YOUR_ITEMS, itemRowWidth, BAR_EDGE_LABEL } from './youritems';
import type { Aspect } from './units';

const OWN = 'resource/ui/hud/localplayerpanel.res';
const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };
const ASPECTS: Aspect[] = ['16:9', '16:10', '4:3'];
/** A fresh design (your health fitted, as new designs ship) on a preset and aspect, with your health's override merged in. */
const base = (preset: 'stock' | 'modern', aspect: Aspect, own?: ElementOverride): HudDesign => {
  const d: HudDesign = { ...structuredClone(DEFAULT_DESIGN), preset, aspect };
  return own ? { ...d, elements: { ...d.elements, ownHealth: { ...d.elements.ownHealth, ...own } } } : d;
};
/** An own panel file with an Items Label of its author's: a HUD that already places your items. */
const withOwnItems = baseFile('stock', OWN).replace(/\}\s*$/, '\t"Items"\r\n\t{\r\n\t\t"ControlName"\t"Label"\r\n\t\t"fieldName"\t"Items"\r\n'
  + '\t\t"xpos"\t"26"\r\n\t\t"ypos"\t"0"\r\n\t\t"wide"\t"60"\r\n\t\t"tall"\t"20"\r\n\t\t"visible"\t"1"\r\n\t\t"font"\t"L4D_Icons_medium"\r\n\t}\r\n}\r\n');
/** An own panel file whose health bar is placed by a centre token: nothing the editor can re-express. */
const withCentredBar = baseFile('stock', OWN).replace(/("Health"\s*\{[^}]*?"xpos"\s*)"26"/, '$1"c-100"');

describe('ownBarX: your health bar as the preview draws it', () => {
  it('is 754 on stock and 42 on Modern at 16:9', () => {
    expect(ownBarX(base('stock', '16:9'))).toBe(754);
    expect(ownBarX(base('modern', '16:9'))).toBe(42);
  });
  it('follows every move, scale and fit, exactly where the preview draws the Health piece', () => {
    const designs = [
      base('stock', '16:9'), base('modern', '16:9'), base('stock', '4:3'), base('modern', '16:10'),
      base('stock', '16:9', { x: 20, y: 380 }), base('stock', '16:9', { scale: 1.5 }), base('modern', '16:9', { scale: 2, fit: false }),
      base('stock', '16:10', { x: 380, y: 200 }),
    ];
    for (const d of designs) {
      const [box] = panelBoxes(d, 'ownHealth');
      const bar = childRects(d, 'ownHealth', box, 1).find((r) => r.name === 'Health')!;
      expect(ownBarX(d), `${d.preset} ${d.aspect} ${JSON.stringify(d.elements.ownHealth)}`).toBeCloseTo(bar.x, 6);
    }
  });
});

describe('yourItemsHome: where the row first shows', () => {
  it('puts the row\'s right end at the weapon boxes\' right edge and its top just under the pistol row', () => {
    for (const d of [...ASPECTS.map((a) => base('stock', a)), base('modern', '16:9'), ammoOnly(base('stock', '16:9'))]) {
      const r = elementRect(d, 'weaponSelection', d.aspect);
      const [, pistol] = weaponSlots(d, d.aspect, r.w);
      const home = yourItemsHome(d);
      expect(home.x + itemRowWidth(18), d.aspect).toBeCloseTo(r.x + pistol.box.x + pistol.box.w, 6);
      expect(home.y, d.aspect).toBeCloseTo(r.y + pistol.frame.y + pistol.frame.h, 6);
    }
    const h = yourItemsHome(base('stock', '16:9'));
    expect(h.x).toBeCloseTo(797.4332, 3);
    expect(h.y).toBeCloseTo(233.13, 2);
  });
});

describe('the element on the canvas', () => {
  it('is off in a new design, drawn at its home, a full loadout wide', () => {
    const d = base('stock', '16:9');
    const r = elementRect(d, YOUR_ITEMS, d.aspect);
    expect(r.visible).toBe(false);
    expect(r.x).toBeCloseTo(797.4332, 3);
    expect(r.w).toBeCloseTo(itemRowWidth(18), 9);
    expect(r.h).toBe(18);
    expect(yourItemsOn(d)).toBe(false);
  });
  it('is shown once turned on, where yourItemsLayout draws it', () => {
    const d = { ...base('stock', '16:9'), elements: { ...DEFAULT_DESIGN.elements, yourItems: { visible: true, x: 760, y: 100 } } };
    expect(yourItemsOn(d)).toBe(true);
    const r = elementRect(d, YOUR_ITEMS, d.aspect);
    expect(r).toMatchObject({ ...yourItemsLayout(d).row, visible: true });
    expect(r.x).toBeGreaterThanOrEqual(754);
  });
  it('is offered on the survivor side, right after Your health, never on the infected side', () => {
    const s = visibleElements('survivor', DEFAULT_DESIGN).map((e) => e.id);
    expect(s.indexOf(YOUR_ITEMS)).toBe(s.indexOf('ownHealth') + 1);
    expect(visibleElements('infected', DEFAULT_DESIGN).map((e) => e.id)).not.toContain(YOUR_ITEMS);
  });
  it('shows the bar\'s edge as its limit', () => {
    expect(yourItemsLimits(base('stock', '16:9'))).toEqual([{ x: 754, side: 'left', label: BAR_EDGE_LABEL }]);
  });
  it('builds exactly the files it built before while it is off, whatever it stores', () => {
    for (const preset of ['stock', 'modern'] as const) {
      const d = base(preset, '16:9');
      const stored = { ...d, elements: { ...d.elements, yourItems: { visible: false, x: 700, y: 100, itemFont: 'L4D_Icons_large' as const, itemAlign: 'center' as const, color: '1 2 3 4' } } };
      expect(buildHud(stored, { fonts })).toEqual(buildHud(d, { fonts }));
    }
  });
});

describe('an imported HUD', () => {
  const ID = 'b'.repeat(64);
  afterEach(() => { unregisterImport(ID); });
  const imported = (over: Record<string, string>): HudDesign => {
    registerImport(ID, sampleHud(over));
    return validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'x' }, elements: { yourItems: { visible: true, x: 780, y: 200 } } });
  };
  it('as stock files: offered like stock', () => {
    const d = imported({});
    expect(yourItemsBlocked(d)).toBeNull();
    expect(yourItemsOn(d)).toBe(true);
  });
  it('whose own panel already has Items: blocked, with the note, and off', () => {
    const d = imported({ [OWN]: withOwnItems });
    expect(yourItemsBlocked(d)).toBe(ITEMS_OWN_NOTE);
    expect(ITEMS_OWN_NOTE).toBe('This HUD already places your items itself.');
    expect(yourItemsOn(d)).toBe(false);
    expect(elementRect(d, YOUR_ITEMS, d.aspect).visible).toBe(false);
    expect(yourItemsLimits(d)).toEqual([]);
  });
  it('whose health bar is not at a plain number: blocked, with the note', () => {
    const d = imported({ [OWN]: withCentredBar });
    expect(yourItemsBlocked(d)).toBe(ITEMS_UNREAD_NOTE);
    expect(yourItemsOn(d)).toBe(false);
  });
});
```

Update the three existing tests that enumerate elements:

`web/src/hud/build.test.ts:1758`, the `hideable` list (a hidden Your items writes nothing, Task 3's byte-identity test pins it):

```ts
  // Your items has no block of its own until it is on: off, it writes nothing (build.youritems.test.ts).
  const hideable = ELEMENTS.filter((e) => e.id !== 'xhair' && e.id !== 'abilityMarker' && e.id !== 'yourItems' && e.props.includes('visible'));
```

`web/src/community/publish.test.ts:185`:

```ts
      // Your items is listed too; a new design has it off, and drawHud skips a hidden element.
      expect(shown.sort(), preset).toEqual(['chat', 'killNotices', 'ownHealth', 'teamColumn', 'weaponSelection', 'xhair', 'yourItems']);
```

`web/src/routes/Hud.test.tsx`, in "lists the survivor Layers under their headings", add the row after the Crouch icon row:

```ts
      ['hud__layer--d1', 'Down pictureshown when down'], ['hud__layer--d1', 'Crouch iconshown when crouched'],
      ['hud__layer--d0 hud__layer--hidden', 'Your items'],
      ['hud__layer--d0', 'Weapons'], ['hud__layer--d0', 'Use / revive bar'],
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/src/hud/build.youritems.test.ts`
Expected: FAIL, "ownBarX is not a function" (or the named exports are undefined).

- [ ] **Step 3: Implement**

`web/src/hud/weaponColumn.ts`, append:

```ts
/**
 * The column's right edge (the boxes', RightSideIndent in from the panel's)
 * and the bottom of the pistol slot's box art, in panel units, with the gun
 * held, the preview's default (weapons.ts weaponSlots lays the same slots
 * out): the gun box grown WEAPON_GROW, two 640-units down to the pistol row,
 * and the pistol box's art padded two 640-units past its box. Your items
 * starts there (build.ts yourItemsHome), about where the stock item slots
 * were.
 */
export function weaponRowsEdge(c: { n: (key: string) => number; panelWide: number; u: number }): { right: number; bottom: number } {
  const pistolTop = c.n('PrimaryWeaponsYPos') + c.n('PrimaryWeaponBoxTall') * WEAPON_GROW + 2 * c.u;
  return { right: c.panelWide - c.n('RightSideIndent'), bottom: pistolTop + c.n('PistolBoxTall') + 2 * c.u };
}
```

`web/src/hud/build.ts`:

1. Imports: add `weaponRowsEdge` to the `./weaponColumn` import, and

```ts
import {
  YOUR_ITEMS, DEFAULT_ITEM_FONT, ITEM_FONT_TALL, itemRowWidth, rowLayout, rowLimitLines,
  type RowInput, type RowLayout, type LimitLine,
} from './youritems';
```

2. `layoutPass`: the skip line becomes

```ts
    // Your items has no block until yourItemsPass writes one (its place is the row's, youritems.ts).
    if (!o || el.id === 'xhair' || el.id === YOUR_ITEMS || !baseHasElement(work.key, el)) continue;
```

3. `elementHidePass`: the skip line becomes

```ts
    if (el.id === 'xhair' || el.id === YOUR_ITEMS || design.elements[el.id]?.visible !== false || !baseHasElement(work.key, el)) continue;
```

4. `baseHasElement`: after the `xhair` line add

```ts
  // Your items is a Label the build adds to Your health's own panel: offered wherever that panel is.
  if (el.id === YOUR_ITEMS) return baseHasElement(key, elementById('ownHealth')!);
```

5. `elementRect`: directly after the `if (!el) throw ...` line add

```ts
  // Your items is drawn where its row is (youritems.ts rowLayout), shown only once on and not blocked.
  if (id === YOUR_ITEMS) return { ...yourItemsLayout(design).row, visible: yourItemsOn(design) };
```

6. New section, placed directly after `reviveAnchorPass`:

```ts
/** Your own panel's frame file and its container's hudlayout.res block. */
const OWN_BOX = 'resource/ui/hud/localplayerdisplay.res';
const OWN_KEY = 'CHudLocalPlayerDisplay';

/** A position token split: its anchor ('' from the left or top, 'r' the right or bottom, 'c' the centre) and its number. */
interface Anchored { anchor: '' | 'r' | 'c'; n: number }
const ANCHORED = /^([rRcC]?)(-?\d+(?:\.\d+)?)$/;
const PLAIN = /^-?\d+(?:\.\d+)?$/;
function anchored(tok: string | undefined): Anchored | null {
  const m = ANCHORED.exec((tok ?? '0').trim());
  return m ? { anchor: m[1].toLowerCase() as Anchored['anchor'], n: parseFloat(m[2]) } : null;
}

/**
 * Your own panel as the files in `tree` place it: CHudLocalPlayerDisplay's
 * position tokens, LocalPlayer's offset inside it, and the health bar's
 * drawn x on screen (the container, plus LocalPlayer, plus Health's own
 * xpos: the own panel has no bar anchor, children.ts OWN_PANEL). Null when
 * any of it is not the plain numbers yourItemsPass can re-express on the
 * screen: LocalPlayer's offset and every piece's xpos and ypos (each line
 * the PC reads) must be plain numbers, as stock's and Modern's are. An
 * import that places them some other way is left alone (spec section 3).
 */
interface OwnFrame { x: Anchored; y: Anchored; lp: { x: number; y: number }; barX: number }
function ownFrame(tree: (path: string) => KvNode[], aspect: Aspect): OwnFrame | null {
  const container = kvFind(tree(LAYOUT), [OWN_KEY]);
  const lp = kvFind(tree(OWN_BOX), ['LocalPlayer']);
  if (!container || !lp) return null;
  const x = anchored(kvGet(container, 'xpos')), y = anchored(kvGet(container, 'ypos'));
  const lx = (kvGet(lp, 'xpos') ?? '0').trim(), ly = (kvGet(lp, 'ypos') ?? '0').trim();
  if (!x || !y || !PLAIN.test(lx) || !PLAIN.test(ly)) return null;
  const nodes = tree(OWN_PANEL.file);
  for (const n of nodes) {
    if (typeof n.value === 'string') continue;
    for (const key of ['xpos', 'ypos']) {
      if (pcEntries(n, key).some((e) => !PLAIN.test((e.value as string).trim()))) return null;
    }
  }
  const bar = kvFind(nodes, ['Health']);
  const bx = bar ? pcGet(bar, 'xpos') : undefined;
  if (bx === undefined || !PLAIN.test(bx.trim())) return null;
  const barX = parsePos(kvGet(container, 'xpos') ?? '0', screenW(aspect)) + parseFloat(lx) + parseFloat(bx);
  return { x, y, lp: { x: parseFloat(lx), y: parseFloat(ly) }, barX };
}

/**
 * Your health bar's drawn x on screen, units, after every move, scale and
 * fit (the preview's own trees), or undefined when the panel cannot be read
 * (ownFrame). Your items' Label starts here.
 */
export function ownBarX(design: HudDesign): number | undefined {
  return ownFrame(buildTrees(design), design.aspect)?.barX;
}

export const ITEMS_OWN_NOTE = 'This HUD already places your items itself.';
export const ITEMS_UNREAD_NOTE = 'The editor cannot read where this HUD puts your health panel, so it cannot place your items here.';

/**
 * Why Your items is not offered on this design's base, or null when it is:
 * an import whose own panel already has an Items child keeps its author's
 * Label (spec section 3), and one the editor cannot read is left alone
 * rather than written with a guess.
 */
export function yourItemsBlocked(design: HudDesign): string | null {
  if (kvFind(baseTree(baseOf(design), OWN_PANEL.file), ['Items'])) return ITEMS_OWN_NOTE;
  return ownFrame(buildTrees(design), design.aspect) ? null : ITEMS_UNREAD_NOTE;
}

/** Whether the design shows Your items: turned on, and not blocked. */
export function yourItemsOn(design: HudDesign): boolean {
  return design.elements[YOUR_ITEMS]?.visible === true && yourItemsBlocked(design) === null;
}

/**
 * The four numbers youritems.ts works from, off the design: the bar's x
 * (0 when unreadable, where the element is blocked anyway), the screen
 * width, the chosen font's tall in the base's scheme (the stock tall when
 * the scheme lacks it) and the alignment.
 */
export function yourItemsInput(design: HudDesign): RowInput {
  const o = design.elements[YOUR_ITEMS] ?? {};
  const font = o.itemFont ?? DEFAULT_ITEM_FONT;
  let tall: number | undefined;
  try { tall = baseFontTall(baseOf(design), font); } catch { /* an imported base not registered yet */ }
  return { barX: ownBarX(design) ?? 0, screenW: screenW(design.aspect), tall: tall && tall > 0 ? tall : ITEM_FONT_TALL[font], align: o.itemAlign ?? 'right' };
}

/**
 * Where the row first shows (spec section 1): its right end at the weapon
 * boxes' right edge, its top just under the pistol row's box art, from the
 * weapon selection as the design has it (weaponColumn.ts weaponRowsEdge,
 * the layout weapons.ts weaponSlots draws). Unclamped: rowLayout and
 * placeRow hold it at the bar's edge. A base without the weapon panel
 * starts it at the bar, mid-height.
 */
export function yourItemsHome(design: HudDesign): { x: number; y: number } {
  const inp = yourItemsInput(design);
  if (!baseHasElement(baseOf(design), elementById('weaponSelection')!)) return { x: inp.barX, y: SCREEN_H / 2 };
  const r = elementRect(design, 'weaponSelection', design.aspect);
  const panel = kvFind(buildTrees(design)(LAYOUT), ['HudWeaponSelection']);
  const n = (k: string) => {
    const v = parseFloat((panel && pcGet(panel, k)) ?? WEAPON_KEY_DEFAULTS[k]);
    return Number.isFinite(v) ? v : parseFloat(WEAPON_KEY_DEFAULTS[k]);
  };
  const edge = weaponRowsEdge({ n, panelWide: r.w, u: screenW(design.aspect) / 640 });
  return { x: r.x + edge.right - itemRowWidth(inp.tall), y: r.y + edge.bottom };
}

/** Your items as drawn and built: the stored place (or the home spot), through the bar limit and the screen edge. */
export function yourItemsLayout(design: HudDesign): RowLayout {
  const o = design.elements[YOUR_ITEMS] ?? {};
  const home = o.x === undefined || o.y === undefined ? yourItemsHome(design) : undefined;
  return rowLayout(yourItemsInput(design), { x: o.x ?? home!.x, y: o.y ?? home!.y });
}

/** The limits the editor draws while Your items is selected (spec section 2); none where it is blocked. */
export function yourItemsLimits(design: HudDesign): LimitLine[] {
  return yourItemsBlocked(design) ? [] : rowLimitLines(yourItemsInput(design));
}
```

(`pcEntries` is the private helper already defined in `build.ts`; `WEAPON_KEY_DEFAULTS`, `baseFontTall`, `formatPos`, `parsePos`, `baseTree`, `baseOf`, `OWN_PANEL` are already in scope there. `type Aspect` is already imported from `./units`.)

`web/src/routes/hud/LayersPanel.tsx`, GROUPS survivor "You":

```ts
    { title: 'You', ids: ['ownHealth', 'yourItems', 'weaponSelection', 'progressBar', 'ownMic', 'xhair'] },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src/hud/build.youritems.test.ts web/src/hud/build.test.ts web/src/hud/download.golden.test.ts web/src/community/publish.test.ts web/src/routes/Hud.test.tsx web/src/hud/mock.test.ts`
Expected: PASS. Then the full suite, `npx vitest run`; any other test that lists every element or every survivor Layers row gets `yourItems` added the same way, with a one-line comment saying it is off by default.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add web/src/hud/weaponColumn.ts web/src/hud/build.ts web/src/hud/build.youritems.test.ts web/src/hud/build.test.ts web/src/community/publish.test.ts web/src/routes/Hud.test.tsx web/src/routes/hud/LayersPanel.tsx
git commit -m "HUD editor: Your items reads the bar, the home spot and blocked imports"
```

---

### Task 4: The download pass

**Files:**
- Modify: `web/src/hud/build.ts` (`clearTextureFiles`, `weaponsPass` uses it, `yourItemsPass`, `elementHidePass` keep set, `buildHud` order)
- Test: `web/src/hud/build.youritems.test.ts` (append)

**Interfaces:**
- Consumes: Task 3's `ownFrame`, `OwnFrame`, `Anchored`, `OWN_BOX`, `OWN_KEY`, `yourItemsOn`, `yourItemsLayout`; existing `hardHide`, `pcEntries`, `pcGet`, `kvSet`, `formatPos`, `CLEAR_TEXTURE`, `CLEAR_TEXELS`, `encodeVTF`, `vmtFor`, `enc`.
- Produces: `buildHud` output with the full-screen own panel and a visible Items Label when `yourItemsOn(design)`; `elementHidePass(work, design, keep?: ReadonlySet<string>)`. `buildTrees` is NOT changed (see Decisions).

- [ ] **Step 1: Write the failing tests**

Append to `web/src/hud/build.youritems.test.ts` (add these imports at the top: `import { parseKv, kvFind, kvGet, type KvNode } from './kv';`, `import { baseOf } from './base';` merged into the existing base import, `import { parsePos, parseSize, screenW, SCREEN_H } from './units';` merged with the `Aspect` import, `import type { VpkFile } from '../vpk';`, and `EDGE_MARGIN`, `LABEL_PAD` added to the `./youritems` import):

```ts
const BOX = 'resource/ui/hud/localplayerdisplay.res';
const LAYOUT = 'scripts/hudlayout.res';
const CLEAR = 'materials/vgui/hud/hudeditor/clear';
const text = (files: VpkFile[], path: string) => { const f = files.find((x) => x.path === path); return f && new TextDecoder('latin1').decode(f.data); };
/** A file as the game reads it from this download: the shipped copy, or the base's own when none ships. */
const treeOf = (files: VpkFile[], d: HudDesign, path: string) => parseKv(text(files, path) ?? baseFile(baseOf(d), path))[0].value as KvNode[];
/** Your items on (or stored and off) with the item slots off, as setYourItems leaves a design. */
const withItems = (d: HudDesign, on: boolean, o: ElementOverride = {}): HudDesign => ({
  ...d, weapons: { ...d.weapons, itemSize: 0, itemIcons: false },
  elements: { ...d.elements, [YOUR_ITEMS]: { x: 797, y: 233, ...o, visible: on } },
});
type Rect = { x: number; y: number; w: number; h: number };
/**
 * Every own-panel piece's box on screen as the game lays out the built
 * files: CHudLocalPlayerDisplay on the screen, LocalPlayer in it, each piece
 * in LocalPlayer, each token read against its parent's size. The Items Label
 * (the element's own, or the hidden revive anchor) is not a piece of the card.
 */
function ownScreenBoxes(files: VpkFile[], d: HudDesign): Record<string, Rect> {
  const W = screenW(d.aspect);
  const c = kvFind(treeOf(files, d, LAYOUT), ['CHudLocalPlayerDisplay'])!;
  const cw = parseSize(kvGet(c, 'wide') ?? '0', W), ch = parseSize(kvGet(c, 'tall') ?? '0', SCREEN_H);
  const cx = parsePos(kvGet(c, 'xpos') ?? '0', W), cy = parsePos(kvGet(c, 'ypos') ?? '0', SCREEN_H);
  const lp = kvFind(treeOf(files, d, BOX), ['LocalPlayer'])!;
  const lw = parseSize(kvGet(lp, 'wide') ?? '0', cw), lh = parseSize(kvGet(lp, 'tall') ?? '0', ch);
  const lx = cx + parsePos(kvGet(lp, 'xpos') ?? '0', cw), ly = cy + parsePos(kvGet(lp, 'ypos') ?? '0', ch);
  const out: Record<string, Rect> = {};
  for (const n of treeOf(files, d, OWN)) {
    if (typeof n.value === 'string' || n.key === 'Items') continue;
    out[n.key] = {
      x: lx + parsePos(kvGet(n, 'xpos') ?? '0', lw), y: ly + parsePos(kvGet(n, 'ypos') ?? '0', lh),
      w: parseSize(kvGet(n, 'wide') ?? '0', lw), h: parseSize(kvGet(n, 'tall') ?? '0', lh),
    };
  }
  return out;
}

describe('the download with Your items on (spec section 3)', () => {
  const variants: [string, ElementOverride | undefined][] = [
    ['as it ships', undefined], ['moved, scaled 1.5 and unfitted', { x: 20, y: 380, scale: 1.5, fit: false }], ['moved to the centre', { x: 380, y: 200 }],
  ];
  for (const preset of ['stock', 'modern'] as const) {
    for (const aspect of ASPECTS) {
      for (const [name, own] of variants) {
        it(`${preset} ${aspect}, your health ${name}: every piece is where it was with the element off`, () => {
          const d = base(preset, aspect, own);
          const on = ownScreenBoxes(buildHud(withItems(d, true), { fonts }), d);
          const off = ownScreenBoxes(buildHud(withItems(d, false), { fonts }), d);
          expect(Object.keys(on).sort()).toEqual(Object.keys(off).sort());
          for (const k of Object.keys(off)) for (const f of ['x', 'y', 'w', 'h'] as const) expect(on[k][f], `${k} ${f}`).toBeCloseTo(off[k][f], 6);
        });
      }
    }
  }

  it('stock: writes the pieces as r positions and the Items Label at the bar\'s written x (probe p3: r99)', () => {
    const d = withItems(base('stock', '16:9'), true);
    const files = buildHud(d, { fonts });
    const own = treeOf(files, d, OWN);
    const bar = kvFind(own, ['Health'])!, items = kvFind(own, ['Items'])!;
    expect([kvGet(bar, 'xpos'), kvGet(bar, 'ypos')]).toEqual(['r99', 'r23']);
    expect(kvGet(items, 'xpos')).toBe(kvGet(bar, 'xpos'));
    expect(yourItemsLayout(d).label).toEqual({ x: 754, y: 230, w: 91, h: 18 + 2 * LABEL_PAD });
    expect(['ControlName', 'fieldName', 'ypos', 'wide', 'tall', 'visible', 'enabled', 'labelText', 'textAlignment', 'font', 'zpos'].map((k) => kvGet(items, k)))
      .toEqual(['Label', 'Items', 'c-10', '91', '24', '1', '1', '', 'east', 'L4D_Icons_medium', '3']);
    expect(kvGet(items, 'fgcolor_override')).toBeUndefined();
    // reviveAnchorPass found the Label and added no hidden one.
    expect(own.filter((n) => n.key === 'Items')).toHaveLength(1);
  });

  it('Modern: plain numbers from the left, r from the bottom (probe p2: 8 / r46)', () => {
    const d = withItems(base('modern', '16:9'), true);
    const own = treeOf(buildHud(d, { fonts }), d, OWN);
    const bar = kvFind(own, ['Health'])!;
    expect([kvGet(bar, 'xpos'), kvGet(bar, 'ypos')]).toEqual(['42', 'r22']);
    expect(kvGet(kvFind(own, ['Items'])!, 'xpos')).toBe('42');
    expect(own.filter((n) => n.key === 'Items')).toHaveLength(1);
  });

  it('Centre, a font and a colour: the Label spans bar to 2 x centre - bar', () => {
    const d = withItems(base('modern', '16:9'), true, { x: 420, y: 250, itemAlign: 'center', itemFont: 'L4D_Icons_large', color: '255 0 255 255' });
    const items = kvFind(treeOf(buildHud(d, { fonts }), d, OWN), ['Items'])!;
    const { label } = yourItemsLayout(d);
    expect(label.w % 2).toBe(0);
    expect([kvGet(items, 'textAlignment'), kvGet(items, 'font'), kvGet(items, 'fgcolor_override'), kvGet(items, 'wide'), kvGet(items, 'tall')])
      .toEqual(['center', 'L4D_Icons_large', '255 0 255 255', String(label.w), String(24 + 2 * LABEL_PAD)]);
  });

  it('makes the container and LocalPlayer the whole screen, with the clear texture as its image, shipped once', () => {
    for (const weapons of [{ itemSize: 0, itemIcons: false }, { itemSize: 24, itemIcons: true }]) {
      const d = { ...withItems(base('stock', '16:9'), true), weapons };
      const files = buildHud(d, { fonts });
      const c = kvFind(treeOf(files, d, LAYOUT), ['CHudLocalPlayerDisplay'])!;
      expect(['xpos', 'ypos', 'wide', 'tall'].map((k) => kvGet(c, k))).toEqual(['0', '0', 'f0', 'f0']);
      const lp = kvFind(treeOf(files, d, BOX), ['LocalPlayer'])!;
      expect(['xpos', 'ypos', 'wide', 'tall', 'image'].map((k) => kvGet(lp, k))).toEqual(['0', '0', 'f0', 'f0', '../vgui/hud/hudeditor/clear']);
      for (const ext of ['vtf', 'vmt']) expect(files.filter((f) => f.path === `${CLEAR}.${ext}`), `${JSON.stringify(weapons)} ${ext}`).toHaveLength(1);
    }
  });

  it('with Your health hidden: the container stays, every other piece is hard-hidden, the items show', () => {
    const d0 = base('stock', '16:9');
    const d = withItems({ ...d0, elements: { ...d0.elements, ownHealth: { ...d0.elements.ownHealth, visible: false } } }, true);
    const files = buildHud(d, { fonts });
    const own = treeOf(files, d, OWN);
    for (const n of own) {
      if (typeof n.value === 'string') continue;
      const want = n.key === 'Items' ? ['1', '91', '24'] : ['0', '0', '0'];
      expect(['visible', 'wide', 'tall'].map((k) => kvGet(n, k)), n.key).toEqual(want);
    }
    expect(kvGet(kvFind(treeOf(files, d, LAYOUT), ['CHudLocalPlayerDisplay'])!, 'wide')).toBe('f0');
    expect(kvGet(kvFind(treeOf(files, d, BOX), ['LocalPlayer'])!, 'wide')).toBe('f0');
  });

  it('draws a row stored left of a moved health bar at the new limit, without rewriting it', () => {
    const d0 = withItems(base('stock', '16:9'), true);
    const d = { ...d0, elements: { ...d0.elements, ownHealth: { ...d0.elements.ownHealth, x: 778, y: 389 } } };
    expect(ownBarX(d)).toBe(804);
    const items = kvFind(treeOf(buildHud(d, { fonts }), d, OWN), ['Items'])!;
    expect(kvGet(items, 'xpos')).toBe('r49');
    expect(kvGet(items, 'wide')).toBe(String(Math.ceil(itemRowWidth(18))));
    expect(d.elements.yourItems!.x).toBe(797);
    expect(elementRect(d, YOUR_ITEMS, d.aspect).x).toBeGreaterThanOrEqual(804);
  });

  it('holds a row placed at 16:9 on a 4:3 screen', () => {
    const d = withItems(base('stock', '4:3'), true, { x: 840 });
    const { label, row } = yourItemsLayout(d);
    expect(label.x + label.w).toBeLessThanOrEqual(640 - EDGE_MARGIN);
    const items = kvFind(treeOf(buildHud(d, { fonts }), d, OWN), ['Items'])!;
    expect(kvGet(items, 'wide')).toBe(String(label.w));
    expect(elementRect(d, YOUR_ITEMS, d.aspect).x).toBeCloseTo(row.x, 9);
  });

  it('builds a design with no stored place at the home spot the preview draws', () => {
    const d0 = base('stock', '16:9');
    const d = { ...d0, weapons: { itemSize: 0, itemIcons: false }, elements: { ...d0.elements, yourItems: { visible: true } } };
    const items = kvFind(treeOf(buildHud(d, { fonts }), d, OWN), ['Items'])!;
    const { label } = yourItemsLayout(d);
    expect([kvGet(items, 'wide'), kvGet(items, 'ypos')]).toEqual([String(label.w), 'c-10']);
  });
});

describe('the download of an imported HUD with Your items on', () => {
  const ID = 'c'.repeat(64);
  afterEach(() => { unregisterImport(ID); });
  const imported = (over: Record<string, string>): HudDesign => {
    registerImport(ID, sampleHud(over));
    return withItems(validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'x' } }), true);
  };
  it('keeps an own Items Label as its author wrote it, and the panel where it was', () => {
    const d = imported({ [OWN]: withOwnItems });
    const files = buildHud(d, { fonts });
    expect(text(files, OWN)).toBe(withOwnItems);
    expect(kvGet(kvFind(treeOf(files, d, LAYOUT), ['CHudLocalPlayerDisplay'])!, 'wide')).toBe('150');
  });
  it('writes nothing where it cannot read the panel', () => {
    const d = imported({ [OWN]: withCentredBar });
    const files = buildHud(d, { fonts });
    expect(kvFind(treeOf(files, d, OWN), ['Items'])).toBeUndefined();
    expect(kvGet(kvFind(treeOf(files, d, LAYOUT), ['CHudLocalPlayerDisplay'])!, 'xpos')).toBe('r125');
  });
  it('builds a stock-shaped import like stock', () => {
    const d = imported({});
    expect(kvGet(kvFind(treeOf(buildHud(d, { fonts }), d, OWN), ['Items'])!, 'xpos')).toBe('r99');
  });
});
```

Check the moved-health numbers before relying on them: `ownHealth` at x 778 is right-anchored (`formatPos(778, 125, 853)` gives `r75`), so the container is at 853 - 75 = 778, the fitted LocalPlayer at 0 and Health at 26: the bar at 804, the Health token `r(75 - 0 - 26)` = `r49`. If `formatPos` gives another token, take the Health token from the built file and assert the Items token equals it instead of the literal.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/src/hud/build.youritems.test.ts`
Expected: FAIL (no Items Label written; container not full screen).

- [ ] **Step 3: Implement**

In `web/src/hud/build.ts`:

1. Next to `CLEAR_TEXELS`, add the helper, and use it in `weaponsPass` in place of the two literal pushes (byte-identical):

```ts
/** The clear texture's two files, every texel transparent: shipped once however many passes point at it. */
function clearTextureFiles(): VpkFile[] {
  return [
    { path: `materials/${CLEAR_TEXTURE}.vtf`, data: encodeVTF(CLEAR_TEXELS, CLEAR_TEXELS, new Uint8ClampedArray(CLEAR_TEXELS * CLEAR_TEXELS * 4)) },
    { path: `materials/${CLEAR_TEXTURE}.vmt`, data: enc(vmtFor(CLEAR_TEXTURE)) },
  ];
}
```

```ts
    if (repoint.some(([, file]) => file === CLEAR_TEXTURE)) out.push(...clearTextureFiles());
```

2. `elementHidePass` takes the elements it must leave shown:

```ts
function elementHidePass(work: Work, design: HudDesign, keep: ReadonlySet<string> = new Set()) {
  for (const el of ELEMENTS) {
    if (el.id === 'xhair' || el.id === YOUR_ITEMS || keep.has(el.id) || design.elements[el.id]?.visible !== false || !baseHasElement(work.key, el)) continue;
```

(the rest of the function unchanged), and add one sentence to its doc comment: `Your health is left whole when Your items is on (yourItemsPass hides its pieces instead, so the items still show).`

3. After the Task 3 section, add the pass:

```ts
/** A unit count as a token's number: whole numbers stay whole, anything else keeps three decimals. */
const unitsText = (v: number): string => String(Math.round(v * 1000) / 1000);

/**
 * Your items (spec section 3; /home/volence/l4d/hud/probe-your-items/RESULTS.md
 * p1 to p3, /home/volence/l4d/hud/probe-own-items/RESULTS.md v1 to v3).
 * client.dll fills the own panel's Items Label with your item glyphs, but
 * only as a direct child of that panel, and the panel clips its children
 * (probe Q2). So to put the row anywhere, CHudLocalPlayerDisplay and
 * LocalPlayer become the whole screen (LocalPlayer with the clear texture as
 * its image, so its own art can never stretch over the screen), and every
 * piece of localplayerpanel.res is written at the same screen place it had,
 * with the anchor its container had: a right-anchored container's pieces as
 * r positions (stock r125 / r91, Health 26, 36 in a LocalPlayer at 0, 32:
 * r99, r23), a left-anchored one's as plain numbers (Modern 8: Health 31 in
 * a LocalPlayer at 3 becomes 42), a centred one's as c positions, so another
 * resolution of the same aspect lines up as the design did. Sizes are never
 * touched. p1 and p2 saw the card stay put through healthy, temp health,
 * crouch, incap and revive.
 *
 * The Items Label then starts at the bar's written x: the game draws the bar
 * at Items' x (the revive snap, which also runs at spawn; probe-own-items v2
 * saw the bar jump to an Items at x 20), so the Label's x is the bar's, and
 * its wide and textAlignment put the glyphs where the preview draws the row
 * (youritems.ts rowLayout; p3: east keeps the right end). It runs after
 * scalePass, so every number is final, and before reviveAnchorPass, which
 * then finds an Items child and adds nothing.
 *
 * Your health hidden: every other piece is hard-hidden here and the container
 * stays shown (buildHud hands elementHidePass `ownHealth` to keep), so the
 * items show without the card.
 *
 * Download only, like elementHidePass: the preview draws the own card inside
 * the element (mock.ts paintOwnHealth, panelBoxes), and the row from
 * rowLayout, so buildTrees keeps the panel as it was.
 * build.youritems.test.ts holds every piece's screen box equal with the
 * element on and off, on both presets and every aspect. Returns whether it
 * wrote the element.
 */
function yourItemsPass(work: Work, design: HudDesign, out: VpkFile[]): boolean {
  if (!yourItemsOn(design)) return false;
  const frame = ownFrame((p) => work.tree(p), design.aspect);
  if (!frame) return false;
  const tok = (a: Anchored, add: number) => (a.anchor === 'r' ? `r${unitsText(a.n - add)}` : `${a.anchor}${unitsText(a.n + add)}`);
  const nodes = work.tree(OWN_PANEL.file);
  const hideRest = design.elements.ownHealth?.visible === false;
  let top = 0;
  for (const n of nodes) {
    if (typeof n.value === 'string') continue;
    for (const [key, a, off] of [['xpos', frame.x, frame.lp.x], ['ypos', frame.y, frame.lp.y]] as const) {
      const hits = pcEntries(n, key);
      if (!hits.length) n.value.push({ key, value: tok(a, off) });
      for (const e of hits) e.value = tok(a, off + parseFloat(e.value as string));
    }
    const z = parseFloat(kvGet(n, 'zpos') ?? '');
    if (Number.isFinite(z)) top = Math.max(top, Math.round(z));
    if (hideRest) hardHide(n);
  }
  const o = design.elements[YOUR_ITEMS] ?? {};
  const { label } = yourItemsLayout(design);
  const bar = kvFind(nodes, ['Health'])!;
  const pairs: [string, string][] = [
    ['ControlName', 'Label'], ['fieldName', 'Items'], ['xpos', pcGet(bar, 'xpos')!], ['ypos', formatPos(label.y, label.h, SCREEN_H)],
    ['wide', String(label.w)], ['tall', String(label.h)], ['visible', '1'], ['enabled', '1'], ['labelText', ''],
    ['textAlignment', o.itemAlign === 'center' ? 'center' : 'east'], ['font', o.itemFont ?? DEFAULT_ITEM_FONT], ['zpos', String(top + 1)],
  ];
  if (o.color) pairs.push(['fgcolor_override', o.color]);
  nodes.push({ key: 'Items', value: pairs.map(([key, value]) => ({ key, value })) });
  const container = work.panel(LAYOUT, [OWN_KEY]);
  for (const [k, v] of [['xpos', '0'], ['ypos', '0'], ['wide', 'f0'], ['tall', 'f0']]) kvSet(container, k, v);
  const lp = work.panel(OWN_BOX, ['LocalPlayer']);
  for (const [k, v] of [['xpos', '0'], ['ypos', '0'], ['wide', 'f0'], ['tall', 'f0'], ['image', `../${CLEAR_TEXTURE}`]]) kvSet(lp, k, v);
  for (const f of clearTextureFiles()) if (!out.some((g) => g.path === f.path)) out.push(f);
  return true;
}
```

4. `buildHud`, around the existing order:

```ts
  scalePass(work, design);
  const itemsOn = yourItemsPass(work, design, extra);
  reviveAnchorPass(work);
  elementHidePass(work, design, itemsOn ? new Set(['ownHealth']) : undefined);
```

`buildTrees` stays as it is (add one line to its doc comment: `yourItemsPass is download only, like elementHidePass: see its comment.`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src/hud/build.youritems.test.ts web/src/hud/build.test.ts web/src/hud/download.golden.test.ts web/src/hud/weapons.test.ts`
Expected: PASS, golden hashes untouched.

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `npx vitest run` then `npm run typecheck` (both clean).

```bash
git add web/src/hud/build.ts web/src/hud/build.youritems.test.ts
git commit -m "HUD editor: Your items download pass (full-screen own panel, Items Label at the bar)"
```

---

### Task 5: Edits: turning on and off, placing, the look

**Files:**
- Modify: `web/src/hud/edit.ts`
- Test: `web/src/hud/edit.test.ts` (append)

**Interfaces:**
- Consumes: `yourItemsBlocked`, `yourItemsInput`, `yourItemsHome`, `yourItemsLayout`, `yourItemsLimits`, `elementRect` (build.ts); `placeRow`, `itemRowWidth`, `YOUR_ITEMS`, types (youritems.ts); existing `patchWeapons`.
- Produces (exported from `edit.ts`):
  - `setYourItems(d: HudDesign, on: boolean): HudDesign`
  - `setItemsLook(d: HudDesign, p: { itemFont?: ItemFont; itemAlign?: ItemAlign }): HudDesign`
  - `yourItemsHeld(design: HudDesign, askedX: number): boolean`
  - `placeElement(d, 'yourItems', x, y)` and therefore `nudge`, `moveElements`, the X and Y boxes, go through `placeRow`
  - `setSelectionVisible` (Layers eye, Delete, the menu's Hide) routes `yourItems` through `setYourItems`

- [ ] **Step 1: Write the failing tests**

Append to `web/src/hud/edit.test.ts` (add to its imports: `setYourItems, setItemsLook, yourItemsHeld` from `./edit`; `yourItemsLimits` from `./build`; `YOUR_ITEMS, EDGE_MARGIN, itemRowWidth` from `./youritems`; `registerImport, unregisterImport` from `./base`; `sampleHud` from `./importFixtures`; `afterEach` from vitest if missing. The import's own panel file is built inline, as test files do not import each other here):

```ts
describe('Your items', () => {
  const D: HudDesign = structuredClone(DEFAULT_DESIGN);
  const on = () => setYourItems(D, true);
  const sel = { kind: 'elements', ids: [YOUR_ITEMS] } as const;

  it('turns on in one design: shown at its home, the item slots off', () => {
    const d = on();
    expect(d.elements.yourItems).toEqual({ visible: true, x: 797, y: 233 });
    expect(d.weapons).toEqual({ itemSize: 0, itemIcons: false });
  });
  it('keeps the other weapon edits when it turns on', () => {
    const d = setYourItems({ ...D, weapons: { indent: 12, reserveColor: '1 2 3 255' } }, true);
    expect(d.weapons).toEqual({ indent: 12, reserveColor: '1 2 3 255', itemSize: 0, itemIcons: false });
  });
  it('turns on where it was placed before', () => {
    const d = setYourItems({ ...D, elements: { ...D.elements, yourItems: { visible: false, x: 780, y: 100 } } }, true);
    expect(d.elements.yourItems).toEqual({ visible: true, x: 780, y: 100 });
  });
  it('turns off leaving the item slot settings as they are', () => {
    const d = setYourItems(on(), false);
    expect(d.elements.yourItems).toEqual({ visible: false, x: 797, y: 233 });
    expect(d.weapons).toEqual({ itemSize: 0, itemIcons: false });
  });
  it('is what the Layers eye, Delete and the menu\'s Hide do', () => {
    expect(setSelectionVisible(D, sel, true)).toEqual(on());
    expect(hideSelection(on(), sel).elements.yourItems?.visible).toBe(false);
  });

  describe('on an import that places its own items', () => {
    const ID = 'd'.repeat(64);
    afterEach(() => { unregisterImport(ID); });
    it('does nothing', () => {
      const own = baseFile('stock', 'resource/ui/hud/localplayerpanel.res')
        .replace(/\}\s*$/, '\t"Items"\r\n\t{\r\n\t\t"ControlName"\t"Label"\r\n\t\t"fieldName"\t"Items"\r\n\t\t"xpos"\t"26"\r\n\t}\r\n}\r\n');
      registerImport(ID, sampleHud({ 'resource/ui/hud/localplayerpanel.res': own }));
      const d = validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'x' } });
      expect(setYourItems(d, true)).toBe(d);
    });
  });

  it('stops at your health bar\'s edge: a drag, an arrow and a typed X', () => {
    const d = on();
    const start = elementRect(d, YOUR_ITEMS, d.aspect);
    const dragged = moveElements(d, [YOUR_ITEMS], { [YOUR_ITEMS]: start }, -300, 10);
    expect(dragged.elements.yourItems).toMatchObject({ x: 754, y: 243 });
    expect(elementRect(dragged, YOUR_ITEMS, d.aspect).x).toBeGreaterThanOrEqual(754);
    let n = placeElement(d, YOUR_ITEMS, 754, 233);
    for (let i = 0; i < 5; i++) n = nudge(n, YOUR_ITEMS, -1, 0);
    expect(n.elements.yourItems!.x).toBe(754);
    expect(placeElement(d, YOUR_ITEMS, 100, 233).elements.yourItems!.x).toBe(754);
  });
  it('moves one unit per arrow press away from the limit', () => {
    let n = placeElement(on(), YOUR_ITEMS, 770, 233);
    n = nudge(n, YOUR_ITEMS, 1, 0);
    expect(n.elements.yourItems!.x).toBe(771);
    n = nudge(n, YOUR_ITEMS, 0, -1);
    expect(n.elements.yourItems!.y).toBe(232);
  });
  it('stops at the screen edge, and Centre at its right limit', () => {
    const far = placeElement(on(), YOUR_ITEMS, 900, 233);
    const r = elementRect(far, YOUR_ITEMS, far.aspect);
    expect(r.x + r.w).toBeLessThanOrEqual(853 - EDGE_MARGIN + 1e-9);
    const centred = placeElement(setItemsLook(on(), { itemAlign: 'center' }), YOUR_ITEMS, 900, 233);
    const c = elementRect(centred, YOUR_ITEMS, centred.aspect);
    const lines = yourItemsLimits(centred);
    expect(lines).toHaveLength(2);
    expect(c.x + c.w).toBeCloseTo(lines[1].x, 9);
  });
  it('says when the clamp held the row away from where a drag asked for it', () => {
    const d = on();
    expect(yourItemsHeld(d, 700)).toBe(true);
    expect(yourItemsHeld(d, 780)).toBe(false);
    expect(yourItemsHeld(d, 900)).toBe(true);
  });
  it('keeps the right end when the font changes, and the centre for Centre', () => {
    // 770: far enough from Centre's widest centre (778 at medium on stock) that neither end is clamped.
    const d = placeElement(on(), YOUR_ITEMS, 770, 233);
    const r0 = elementRect(d, YOUR_ITEMS, d.aspect);
    const big = setItemsLook(d, { itemFont: 'L4D_Icons_large' });
    const r1 = elementRect(big, YOUR_ITEMS, big.aspect);
    expect(big.elements.yourItems!.itemFont).toBe('L4D_Icons_large');
    expect(r1.w).toBeCloseTo(itemRowWidth(24), 9);
    expect(Math.abs(r1.x + r1.w - (r0.x + r0.w))).toBeLessThanOrEqual(1);
    const c = setItemsLook(d, { itemAlign: 'center' });
    const rc = elementRect(c, YOUR_ITEMS, c.aspect);
    expect(Math.abs(rc.x - r0.x)).toBeLessThanOrEqual(1);
    const cBig = setItemsLook(c, { itemFont: 'L4D_Icons_large' });
    const rcb = elementRect(cBig, YOUR_ITEMS, cBig.aspect);
    expect(Math.abs(rcb.x + rcb.w / 2 - (rc.x + rc.w / 2))).toBeLessThanOrEqual(1);
  });
  it('holds a large row at the screen edge on screen', () => {
    const d = setItemsLook(placeElement(on(), YOUR_ITEMS, 900, 233), { itemFont: 'L4D_Icons_large' });
    const r = elementRect(d, YOUR_ITEMS, d.aspect);
    expect(r.x + r.w).toBeLessThanOrEqual(853 - EDGE_MARGIN + 1e-9);
    expect(r.x).toBeGreaterThanOrEqual(754);
  });
  it('goes off with Reset, leaving the item slot settings', () => {
    const d = resetElement(on(), YOUR_ITEMS);
    expect(d.elements.yourItems).toBeUndefined();
    expect(d.weapons).toEqual({ itemSize: 0, itemIcons: false });
  });
});
```

(`baseFile`, `validateDesign`, `hideSelection`, `resetElement`, `moveElements`, `nudge`, `placeElement`, `setSelectionVisible`, `elementRect` are already imported in `edit.test.ts` or come from the modules named above; add any that are missing to the existing import lines.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/src/hud/edit.test.ts -t "Your items"`
Expected: FAIL, "setYourItems is not a function".

- [ ] **Step 3: Implement**

In `web/src/hud/edit.ts`, add imports:

```ts
import { yourItemsBlocked, yourItemsInput, yourItemsHome, yourItemsLayout } from './build';
import { YOUR_ITEMS, placeRow, itemRowWidth, type ItemFont, type ItemAlign } from './youritems';
```

(merge `yourItemsBlocked, yourItemsInput, yourItemsHome, yourItemsLayout` into the existing `./build` import line.)

In `placeElement`, right after the line that returns `design` for an element that cannot move:

```ts
  if (id === YOUR_ITEMS) return placeYourItems(design, x, y);
```

In `setSelectionVisible`, inside the reduce, as its first line:

```ts
    if (id === YOUR_ITEMS) return setYourItems(d, visible);
```

Add a section after `setFit` at the end of the file:

```ts
// --- Your items (youritems.ts) ---

/**
 * Your items at a drawn (x, y), held at your health bar's edge and the
 * screen's (youritems.ts placeRow), so a drag past the bar stops at it live,
 * as the arrows and a typed X do (spec section 2). The stored numbers are the
 * row's top-left in whole units.
 */
function placeYourItems(design: HudDesign, x: number, y: number): HudDesign {
  const at = placeRow(yourItemsInput(design), { x, y });
  return { ...design, elements: { ...design.elements, [YOUR_ITEMS]: { ...design.elements[YOUR_ITEMS], x: at.x, y: at.y } } };
}

/**
 * Your items on or off (spec section 1), one design in and one out, so a
 * single Undo restores everything it changed. On shows the row where it was
 * placed, or first at its home (build.ts yourItemsHome, held at the bar's
 * edge), and switches the stock item slots off: IconSize 0 and the item
 * pictures cleared. Probe p3 (/home/volence/l4d/hud/probe-your-items/RESULTS.md)
 * showed both are needed: IconSize 0 alone still drew the pickup fly-in's
 * pile of slot art near the weapons for about a second after a pickup. Off
 * only hides the row; the item slot settings stay as they are, since the
 * player may want them, and the Weapons panel brings them back. On a base
 * that blocks the element (an import that places its own items, or one the
 * editor cannot read) turning on returns the design unchanged, ===.
 */
export function setYourItems(d: HudDesign, on: boolean): HudDesign {
  const o = d.elements[YOUR_ITEMS] ?? {};
  if (!on) return { ...d, elements: { ...d.elements, [YOUR_ITEMS]: { ...o, visible: false } } };
  if (yourItemsBlocked(d)) return d;
  const at = o.x !== undefined && o.y !== undefined ? { x: o.x, y: o.y } : placeRow(yourItemsInput(d), yourItemsHome(d));
  return patchWeapons({ ...d, elements: { ...d.elements, [YOUR_ITEMS]: { ...o, visible: true, x: at.x, y: at.y } } }, { itemSize: 0, itemIcons: false });
}

/**
 * Your items' font or alignment, keeping the row's steady end where it is
 * drawn: Right its right end, Centre its centre, so a bigger font grows the
 * row away from that end, the way the game grows it as items come and go.
 * Switching the alignment keeps the row where it is.
 */
export function setItemsLook(d: HudDesign, p: { itemFont?: ItemFont; itemAlign?: ItemAlign }): HudDesign {
  const before = yourItemsLayout(d).row;
  const o = { ...d.elements[YOUR_ITEMS], ...p };
  const next: HudDesign = { ...d, elements: { ...d.elements, [YOUR_ITEMS]: o } };
  const w = itemRowWidth(yourItemsInput(next).tall);
  const x = (o.itemAlign ?? 'right') === 'center' ? before.x + before.w / 2 - w / 2 : before.x + before.w - w;
  return placeYourItems(next, x, before.y);
}

/**
 * Whether a drag's asked-for x for Your items is not where it lands: the
 * clamp held it at a limit. The page then draws no snap guide on that x,
 * which would stand where the row is not.
 */
export function yourItemsHeld(design: HudDesign, askedX: number): boolean {
  return placeRow(yourItemsInput(design), { x: askedX, y: 0 }).x !== Math.round(askedX);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src/hud/edit.test.ts web/src/hud/build.youritems.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add web/src/hud/edit.ts web/src/hud/edit.test.ts
git commit -m "HUD editor: Your items on and off in one edit, held at the bar's edge"
```

---

### Task 6: The preview row and the limit drawing

**Files:**
- Modify: `web/src/hud/mock.ts` (`paintYourItems`, `PAINTERS`, `HudView.limits`, `drawLimits`, `LIMIT_COLOUR`, `drawHud`)
- Create: `web/src/hud/youritems.preview.test.ts`

**Interfaces:**
- Consumes: `drawItems`, `previewOf` (render.ts), `YOUR_ITEMS`, `DEFAULT_ITEM_FONT`, `type LimitLine` (youritems.ts), `setYourItems` (edit.ts, tests only), `yourItemsLimits`, `elementRect` (build.ts, tests only).
- Produces: `export function paintYourItems(ctx, r, design, k, onAsset?, view?)`; `HudView.limits?: LimitLine[]`; `export const LIMIT_COLOUR = '#ffb000'`; `drawHud` draws `view.limits` over the HUD and under the selection chrome.

- [ ] **Step 1: Write the failing tests**

Create `web/src/hud/youritems.preview.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { drawHud, hitTest, paintYourItems, panelBoxes, LIMIT_COLOUR } from './mock';
import { elementRect, yourItemsLimits } from './build';
import { setYourItems, setItemsLook } from './edit';
import { childRects, _setImageFactory, _resetAssetCache, DEFAULT_PREVIEW } from './render';
import { artUrl } from './art';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { YOUR_ITEMS, BAR_EDGE_LABEL, CENTRE_EDGE_LABEL } from './youritems';

/** An image that is "loaded" the moment it is created, so drawImage fires synchronously. */
const instantImage = (url: string) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement;
beforeEach(() => { _resetAssetCache(); _setImageFactory(instantImage); });

/** A 2D context stand-in answering every method, recording drawImage (with the alpha then), fillText, fillRect and paths. */
function proxyCtx() {
  const draws: { src: string; a: number[]; alpha: number }[] = [];
  const texts: string[] = [];
  const fills: number[][] = [];
  const path: (string | number)[][] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '', strokeStyle: '', font: '', canvas: { width: 853, height: 480 } };
  const stack: number[] = [];
  const ctx = new Proxy(state, {
    get: (t, k) => (typeof k === 'string' && k in t ? t[k] : (...a: unknown[]) => {
      if (k === 'save') stack.push(t.globalAlpha as number);
      if (k === 'restore') t.globalAlpha = stack.pop() ?? 1;
      if (k === 'drawImage') draws.push({ src: (a[0] as HTMLImageElement).src, a: a.slice(1) as number[], alpha: t.globalAlpha as number });
      if (k === 'fillText') texts.push(a[0] as string);
      if (k === 'fillRect') fills.push(a as number[]);
      if (k === 'moveTo') path.push(['M', ...(a as number[])]);
      if (k === 'lineTo') path.push(['L', ...(a as number[])]);
      if (k === 'measureText') return { width: 10 };
      if (k === 'getImageData') return { data: new Uint8ClampedArray(4) };
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return { addColorStop() {} };
      return undefined;
    }),
    set: (t, k, v) => { t[k as string] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, draws, texts, fills, path };
}
const ICONS = ['icon/item/medkit', 'icon/item/pills', 'icon/item/pipebomb'].map((n) => artUrl(n));
const D: HudDesign = structuredClone(DEFAULT_DESIGN);

describe('the Your items row in the preview', () => {
  it('draws the full loadout in the row\'s box, one font tall, right-aligned in it', () => {
    const d = setYourItems(D, true);
    const r = elementRect(d, YOUR_ITEMS, d.aspect);
    const { ctx, draws } = proxyCtx();
    paintYourItems(ctx, r, d, 1);
    expect(draws.map((c) => c.src)).toEqual(ICONS);
    expect(draws[0].a[0]).toBeCloseTo(r.x, 9);
    expect(draws[0].a.slice(1)).toEqual([r.y, 18, 18]);
  });
  it('draws it empty while you are down or dead, and the same while crouched', () => {
    const d = setYourItems(D, true);
    const r = elementRect(d, YOUR_ITEMS, d.aspect);
    for (const survivor of ['down', 'dead'] as const) {
      const { ctx, draws } = proxyCtx();
      paintYourItems(ctx, r, d, 1, undefined, { state: { ...DEFAULT_PREVIEW, survivor } });
      expect(draws, survivor).toEqual([]);
    }
    const { ctx, draws } = proxyCtx();
    paintYourItems(ctx, r, d, 1, undefined, { state: { ...DEFAULT_PREVIEW, crouched: true } });
    expect(draws).toHaveLength(3);
  });
  it('takes the colour\'s alpha, as the cards\' Items do', () => {
    const d0 = setYourItems(D, true);
    const d = { ...d0, elements: { ...d0.elements, yourItems: { ...d0.elements.yourItems, color: '255 255 255 128' } } };
    const { ctx, draws } = proxyCtx();
    paintYourItems(ctx, elementRect(d, YOUR_ITEMS, d.aspect), d, 1);
    expect(draws[0].alpha).toBeCloseTo(128 / 255, 6);
  });
  it('is drawn by drawHud only once on, and picked by a click', () => {
    const d = setYourItems(D, true);
    const r = elementRect(d, YOUR_ITEMS, d.aspect);
    const inRow = (c: { a: number[] }) => c.a[0] >= r.x - 0.5 && c.a[0] <= r.x + r.w && Math.abs(c.a[1] - r.y) < 0.5;
    const off = proxyCtx();
    drawHud(off.ctx, 853, 480, D, 'survivor', null);
    expect(off.draws.filter(inRow)).toEqual([]);
    const onDraw = proxyCtx();
    drawHud(onDraw.ctx, 853, 480, d, 'survivor', null);
    expect(onDraw.draws.filter(inRow).map((c) => c.src)).toEqual(ICONS);
    expect(hitTest(d, 'survivor', r.x + r.w / 2, r.y + r.h / 2)).toBe(YOUR_ITEMS);
    expect(hitTest(D, 'survivor', r.x + r.w / 2, r.y + r.h / 2)).not.toBe(YOUR_ITEMS);
  });
  it('leaves your own health card exactly as it draws with the element off', () => {
    const d = setYourItems(D, true);
    expect(panelBoxes(d, 'ownHealth')).toEqual(panelBoxes(D, 'ownHealth'));
    const [box] = panelBoxes(D, 'ownHealth');
    expect(childRects(d, 'ownHealth', box, 1)).toEqual(childRects(D, 'ownHealth', box, 1));
  });
});

describe('the limit while Your items is placed (spec section 2)', () => {
  it('shades everything left of the bar full height and draws a labelled line there', () => {
    const d = setYourItems(D, true);
    const { ctx, fills, path, texts } = proxyCtx();
    drawHud(ctx, 853, 480, d, 'survivor', [YOUR_ITEMS], undefined, { limits: yourItemsLimits(d) });
    expect(fills).toContainEqual([0, 0, 754, 480]);
    expect(path).toContainEqual(['M', 754, 0]);
    expect(path).toContainEqual(['L', 754, 480]);
    expect(texts).toContain(BAR_EDGE_LABEL);
  });
  it('shades right of Centre\'s right-hand limit too', () => {
    const d = setItemsLook(setYourItems(D, true), { itemAlign: 'center' });
    const lines = yourItemsLimits(d);
    const { ctx, fills, texts } = proxyCtx();
    drawHud(ctx, 853, 480, d, 'survivor', [YOUR_ITEMS], undefined, { limits: lines });
    expect(fills).toContainEqual([lines[1].x, 0, 853 - lines[1].x, 480]);
    expect(texts).toContain(CENTRE_EDGE_LABEL);
  });
  it('draws nothing of it without view.limits, as a share or a screenshot draws', () => {
    const d = setYourItems(D, true);
    const { ctx, texts } = proxyCtx();
    drawHud(ctx, 853, 480, d, 'survivor', null);
    expect(texts).not.toContain(BAR_EDGE_LABEL);
  });
  it('is a colour of its own, not the pink of the snap guides', () => {
    expect(LIMIT_COLOUR.toLowerCase()).not.toBe('#ff4fa3');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/src/hud/youritems.preview.test.ts`
Expected: FAIL, "paintYourItems is not exported" (or undefined).

- [ ] **Step 3: Implement**

In `web/src/hud/mock.ts`:

1. Imports: add `drawItems` to the `./render` import list (it already imports `previewOf`), and

```ts
import { YOUR_ITEMS, DEFAULT_ITEM_FONT, type LimitLine } from './youritems';
```

2. `HudView`, after `guides`:

```ts
  /**
   * Your items' limits while it is selected (build.ts yourItemsLimits): the
   * page passes them, nothing else does, so a share, a publish or a close-up
   * image never carries them (spec section 4).
   */
  limits?: LimitLine[];
```

3. The painter, placed after `paintOwnHealth`:

```ts
/**
 * Your items: the game's item glyphs for a full loadout (medkit, pills, pipe
 * bomb) in the row's box, by the teammate cards' own painter (render.ts
 * drawItems: additive ToolBox glyphs, tinted by the colour), so the two rows
 * look alike. The box is exactly a full row, so the glyphs fill it whatever
 * the alignment. Down and Dead draw it empty, as the game empties the Label
 * while you are incapacitated or dead (/home/volence/l4d/hud/probe-own-items/RESULTS.md,
 * "Incapacitated: the Label goes EMPTY"); crouching changes nothing.
 */
export function paintYourItems(ctx: CanvasRenderingContext2D, r: Rect, design: HudDesign, k: number, onAsset?: () => void, view: HudView = {}) {
  const s = previewOf(view.state).survivor;
  if (s === 'down' || s === 'dead') return;
  const o = design.elements[YOUR_ITEMS] ?? {};
  const n: KvNode = { key: 'Items', value: [
    { key: 'font', value: o.itemFont ?? DEFAULT_ITEM_FONT }, { key: 'textAlignment', value: 'east' },
    ...(o.color ? [{ key: 'fgcolor_override', value: o.color }] : []),
  ] };
  drawItems(ctx, design, n, { name: 'Items', kind: 'label', x: r.x, y: r.y, w: r.w, h: r.h, visible: true }, k, { onAsset });
}
```

4. `PAINTERS`: add `[YOUR_ITEMS]: paintYourItems,` after `ownHealth`.

5. Next to `GUIDE`:

```ts
/** Your items' limit: amber, so it never reads as one of the pink snap guides. */
export const LIMIT_COLOUR = '#ffb000';
const LIMIT_SHADE = 'rgba(0,0,0,0.45)';

/**
 * Your items' limits (spec section 2): everything the row cannot reach
 * dimmed, the full screen height, and a solid line at each limit with its
 * label beside it, on the side the row can reach. Editor chrome, drawn from
 * HudView only.
 */
function drawLimits(ctx: CanvasRenderingContext2D, lines: LimitLine[], k: number, pxW: number, pxH: number, d = 1) {
  ctx.save();
  ctx.setLineDash([]);
  for (const l of lines) {
    const x = l.x * k;
    ctx.fillStyle = LIMIT_SHADE;
    if (l.side === 'left') ctx.fillRect(0, 0, x, pxH); else ctx.fillRect(x, 0, pxW - x, pxH);
  }
  ctx.strokeStyle = LIMIT_COLOUR;
  ctx.lineWidth = 2 * d;
  ctx.font = `${11 * d}px sans-serif`;
  setLetterSpacing(ctx, 0);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const l of lines) {
    const x = l.x * k;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, pxH); ctx.stroke();
    const w = ctx.measureText(l.label).width + 8 * d;
    const bx = l.side === 'left' ? x + 4 * d : x - 4 * d - w;
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillRect(bx, 8 * d, w, 14 * d);
    ctx.fillStyle = LIMIT_COLOUR;
    ctx.fillText(l.label, bx + 4 * d, 19 * d);
  }
  ctx.restore();
}
```

6. `drawHud`, directly before `if (view.frames?.length) ...`:

```ts
  // Under the selection chrome, over the HUD: the frame and handles stay readable on the shade.
  if (view.limits?.length) drawLimits(ctx, view.limits, k, pxW, pxH, d);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src/hud/youritems.preview.test.ts web/src/hud/mock.test.ts web/src/hud/render.test.ts web/src/community/publish.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add web/src/hud/mock.ts web/src/hud/youritems.preview.test.ts
git commit -m "HUD editor: Your items preview row and its limit shading"
```

---

### Task 7: The page: Layers, controls, limit while selected, held guides

**Files:**
- Modify: `web/src/routes/hud/LayersPanel.tsx`
- Modify: `web/src/routes/hud/ContextPanel.tsx`
- Modify: `web/src/routes/Hud.tsx`
- Test: `web/src/routes/Hud.test.tsx` (append)

**Interfaces:**
- Consumes: `yourItemsBlocked`, `yourItemsLimits` (build.ts); `setYourItems`, `setItemsLook`, `yourItemsHeld` (edit.ts); `YOUR_ITEMS`, `ITEM_FONTS`, `ITEM_FONT_LABELS`, `DEFAULT_ITEM_FONT`, types (youritems.ts); `HudView.limits` (Task 6).
- Produces: the Layers row (eye through `setSelectionVisible`, a note and no eye when blocked); `ElementControls` for `yourItems` (Visible through `setYourItems`, X and Y through `placeElement`, the note, Icon size, Alignment, Icons colour; the blocked note only when blocked); the limit drawn while `yourItems` is selected; no x guide while the clamp holds a drag.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/routes/Hud.test.tsx` (add imports: `import { LayersPanel } from './hud/LayersPanel';`, `import { ElementControls } from './hud/ContextPanel';`, `import { registerImport } from '../hud/base';` merged into the existing base import):

```tsx
describe('Your items on the page', () => {
  const saved = () => JSON.parse(localStorage.getItem('hud') ?? '{}') as HudDesign;
  const OWN = 'resource/ui/hud/localplayerpanel.res';

  it('turns on from the Layers eye with the item slots, and one Undo takes both back', async () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Your items' }));
    await waitFor(() => expect(saved().elements?.yourItems?.visible).toBe(true));
    expect(saved().weapons).toMatchObject({ itemSize: 0, itemIcons: false });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(saved().elements?.yourItems?.visible).not.toBe(true));
    expect(saved().weapons?.itemSize).toBeUndefined();
    expect(saved().weapons?.itemIcons).toBeUndefined();
  });

  it('shows its controls, and a typed X stops at your health bar\'s edge', () => {
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Your items' }));
    fireEvent.click(screen.getByRole('button', { name: 'Your items' }));
    expect(screen.getByText(/only sit level with or right of your health bar/)).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Icon size' }) as HTMLSelectElement).value).toBe('L4D_Icons_medium');
    expect((screen.getByRole('combobox', { name: 'Alignment' }) as HTMLSelectElement).value).toBe('right');
    const x = screen.getByLabelText('X') as HTMLInputElement;
    expect(x.value).toBe('797');
    fireEvent.input(x, { target: { value: '600' } });
    fireEvent.blur(x);
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('754');
  });

  it('holds a drag at the line: the row stops while the pointer keeps going', async () => {
    const { container } = render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Your items' }));
    const canvas = unitCanvas(container);
    dragFrom(canvas, [821, 242], [500, 250]);
    await waitFor(() => expect(saved().elements?.yourItems).toMatchObject({ x: 754, y: 241 }));
  });

  it('draws the limit only while the row is selected', async () => {
    _resetAssetCache();
    const texts: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const canvas = this;
      return new Proxy({}, {
        get: (_t, k) => {
          if (k === 'canvas') return canvas;
          return (...a: unknown[]) => {
            if (k === 'fillText') texts.push(a[0] as string);
            if (k === 'getImageData') return { data: new Uint8ClampedArray(4) };
            if (k === 'measureText') return { width: 10 };
            if (k === 'createLinearGradient' || k === 'createRadialGradient') return { addColorStop() {} };
            return undefined;
          };
        },
        set: () => true,
      }) as never;
    } as never);
    render(<Hud />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Your items' }));
    await waitFor(() => expect(texts.length).toBeGreaterThan(0));
    expect(texts).not.toContain("Your health bar's edge");
    fireEvent.click(screen.getByRole('button', { name: 'Your items' }));
    await waitFor(() => expect(texts).toContain("Your health bar's edge"));
    texts.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Weapons' }));
    await waitFor(() => expect(texts.length).toBeGreaterThan(0));
    expect(texts).not.toContain("Your health bar's edge");
  });

  describe('on an import that places its own items', () => {
    const ID = 'e'.repeat(64);
    afterEach(() => { unregisterImport(ID); });
    const blockedDesign = () => {
      const own = baseFile('stock', OWN).replace(/\}\s*$/, '\t"Items"\r\n\t{\r\n\t\t"ControlName"\t"Label"\r\n\t\t"fieldName"\t"Items"\r\n\t\t"xpos"\t"26"\r\n\t}\r\n}\r\n');
      registerImport(ID, sampleHud({ [OWN]: own }));
      return validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'x' } });
    };
    it('lists it in Layers with the note and no eye', () => {
      render(<LayersPanel design={blockedDesign()} side="survivor" sel={{ kind: 'none' }} onPick={() => {}} onVisible={() => {}} onAdd={() => {}} onKeyDown={() => {}} />);
      const row = layer('Your items');
      expect(row.getByText('This HUD already places your items itself.')).toBeTruthy();
      expect(row.queryByRole('button', { name: 'Show Your items' })).toBeNull();
    });
    it('offers no controls but the note', () => {
      render(<ElementControls design={blockedDesign()} edit={() => {}} end={() => {}} id="yourItems" />);
      expect(screen.getByText('This HUD already places your items itself.')).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: 'Visible' })).toBeNull();
      expect(screen.queryByLabelText('X')).toBeNull();
      expect(screen.queryByRole('combobox', { name: 'Icon size' })).toBeNull();
    });
  });
});
```

The drag numbers: after turning on, the row is drawn at x 797.43, y 233, 47.57 x 18; the press at (821, 242) is inside it, and the Weapons panel (755..855, 165..325) is bigger, so the press picks the row (smallest area). The drag of -321, +8 asks for x 476.43, y 241: held at 754. `unitCanvas`, `dragFrom` and `layer` are the file's own top-level helpers.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/src/routes/Hud.test.tsx -t "Your items on the page"`
Expected: FAIL (no "Icon size" control; the X box shows the stored number; no limit drawn; the blocked row still has an eye).

- [ ] **Step 3: Implement**

`web/src/routes/hud/LayersPanel.tsx`: import `yourItemsBlocked` with `elementRect`, `panelChild` from `../../hud/build`, and `YOUR_ITEMS` from `../../hud/youritems`. In the element map, before `return (`, add

```tsx
            // Your items on an import that places its own items (or cannot be read): listed with why, no eye.
            const blocked = el.id === YOUR_ITEMS ? yourItemsBlocked(design) : null;
```

and change the top `Row`:

```tsx
                <Row
                  label={el.label} depth={0} active={isIn(sel, target)} hidden={!elementRect(design, el.id, design.aspect).visible}
                  note={blocked ?? undefined}
                  onPick={(shift) => onPick(target, shift)}
                  onEye={!blocked && el.props.includes('visible') && (!el.hideGate || probe(el.hideGate)) ? (v) => onVisible(target, v) : undefined}
                  fold={foldable ? { open, onToggle: () => setFolds((f) => ({ ...f, [el.id]: !open })) } : undefined}
                />
```

`web/src/routes/hud/ContextPanel.tsx`:

1. Imports: add `yourItemsBlocked` to the `../../hud/build` import; add `setYourItems, setItemsLook` to the `../../hud/edit` import; add

```ts
import { YOUR_ITEMS, ITEM_FONTS, ITEM_FONT_LABELS, DEFAULT_ITEM_FONT, type ItemFont, type ItemAlign } from '../../hud/youritems';
```

2. In `ElementControls`, after `const reset = ...`:

```ts
  // Your items on a base that blocks it: only the reason is shown (build.ts yourItemsBlocked).
  const itemsBlocked = id === YOUR_ITEMS ? yourItemsBlocked(design) : null;
```

change `team`, `moves` and `hides`:

```ts
  // The versus panel goes through placeElement too, which keeps it whole on screen; so does Your items, held at the bar's edge.
  const team = !!el.team || fitted || id === 'tabVersus' || id === YOUR_ITEMS;
  // A move or a hide waiting on a probe (the Tab screen's versus panel: TS4, TS7) is not offered.
  const moves = el.move && (!el.moveGate || probe(el.moveGate)) && !itemsBlocked;
  const hides = el.props.includes('visible') && (!el.hideGate || probe(el.hideGate)) && !itemsBlocked;
```

the Visible checkbox's `onChange`:

```tsx
            onChange={(e) => {
              const v = (e.target as HTMLInputElement).checked;
              // Your items turns the item slots off with it, in the same edit (edit.ts setYourItems).
              if (id === YOUR_ITEMS) edit((d) => setYourItems(d, v)); else patch({ visible: v });
            }}
```

the note line:

```tsx
      {el.note && !itemsBlocked && <Note text={el.note} />}
      {itemsBlocked && <Note text={itemsBlocked} />}
```

and after `{id === 'ownMic' && ...}`:

```tsx
      {id === YOUR_ITEMS && !itemsBlocked && <YourItemsControls design={design} edit={edit} end={end} patch={patch} />}
```

3. Add the controls component after `VoteControls` (or next to `NoticeControls`):

```tsx
/**
 * Your items' look (spec section 1): the game's three item icon fonts, which
 * end stays put as items come and go, and the colour (fgcolor_override;
 * unset is the game's white). A font or alignment change keeps that end
 * where it is drawn (edit.ts setItemsLook).
 */
function YourItemsControls({ design, edit, end, patch }: { design: HudDesign; edit: Edit; end: () => void; patch: Patch }) {
  const o = design.elements[YOUR_ITEMS] ?? {};
  const clearColour = () => edit((d) => {
    const { color: _gone, ...rest } = d.elements[YOUR_ITEMS] ?? {};
    return { ...d, elements: { ...d.elements, [YOUR_ITEMS]: rest } };
  });
  return (
    <>
      <label class="hud__row">
        <span>Icon size</span>
        <select
          aria-label="Icon size" value={o.itemFont ?? DEFAULT_ITEM_FONT}
          onChange={(e) => edit((d) => setItemsLook(d, { itemFont: (e.target as HTMLSelectElement).value as ItemFont }))}
        >
          {ITEM_FONTS.map((f) => <option key={f} value={f}>{ITEM_FONT_LABELS[f]}</option>)}
        </select>
        <span />
      </label>
      <label class="hud__row">
        <span>Alignment</span>
        <select
          aria-label="Alignment" value={o.itemAlign ?? 'right'}
          onChange={(e) => edit((d) => setItemsLook(d, { itemAlign: (e.target as HTMLSelectElement).value as ItemAlign }))}
        >
          <option value="right">Right</option>
          <option value="center">Centre</option>
        </select>
        <span />
      </label>
      <p class="muted hud__note">The end that stays put as items come and go.</p>
      <ColourRow label="Icons" value={o.color ?? '255 255 255 255'} end={end} onPick={(c) => patch({ color: c }, 'gesture')} />
      {o.color !== undefined && (
        <button type="button" class="btn btn--ghost btn--sm" aria-label="Icons colour: use the game colour" onClick={clearColour}>
          Use the game colour
        </button>
      )}
    </>
  );
}
```

`web/src/routes/Hud.tsx`:

1. Imports: add `yourItemsLimits` to the `../hud/build` import, `yourItemsHeld` to the `../hud/edit` import, and `import { YOUR_ITEMS } from '../hud/youritems';`.

2. The draw effect's view object, after `guides,`:

```ts
        // Your items' limit, only while it is selected (spec section 2); never in a share or the close-up.
        limits: sel.kind === 'elements' && sel.ids.includes(YOUR_ITEMS) ? yourItemsLimits(design) : undefined,
```

3. In `moveDrag`, the element and card branch at the end becomes:

```ts
    const s = alt ? NO_SNAP : snapMove({ ...start, x: start.x + dux, y: start.y + duy }, sectionTargets(cur, side, moving));
    // Your items held at a limit is not on the x the snap found: no guide there (edit.ts yourItemsHeld).
    const held = d.kind === 'elements' && !!d.starts[YOUR_ITEMS] && yourItemsHeld(cur, d.starts[YOUR_ITEMS].x + dux + s.dx);
    setGuides(held ? s.guides.filter((g) => g.axis !== 'x') : s.guides);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src/routes/Hud.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `npx vitest run` and `npm run typecheck` (both clean; the suite is 7468 plus this feature's tests).

```bash
git add web/src/routes/hud/LayersPanel.tsx web/src/routes/hud/ContextPanel.tsx web/src/routes/Hud.tsx web/src/routes/Hud.test.tsx
git commit -m "HUD editor: Your items in Layers and the side panel, limit shown while selected"
```

---

### Task 8: In-game verification (Stock and Modern, against the preview's pixels)

No repo code changes. Everything this task writes lives in `/home/volence/l4d/hud/probe-your-items/p4/`, outside the repo, like the earlier probes. The owner has a standing OK to launch the game for probes.

**Files:**
- Create: `/home/volence/l4d/hud/probe-your-items/p4/build.mts`, `/home/volence/l4d/hud/probe-your-items/p4/preview.mjs`, `/home/volence/l4d/hud/probe-your-items/p4/measure.py`
- Modify: `/home/volence/l4d/hud/probe-your-items/RESULTS.md` (append a p4 section)

**Interfaces:**
- Consumes: `packHud`, `yourItemsLayout` (build.ts), `setYourItems`, `placeElement` (edit.ts), `DEFAULT_DESIGN` (design.ts), all from the worktree; the harness `./run.sh <vpk> <steps> <outdir>` (`/home/volence/l4d/hud/ingame-harness/README.md`); scenario `/home/volence/l4d/hud/probe-your-items/your-items-p3.steps`.
- Produces: two VPKs from the editor's own code, the game's shots, the preview's canvas pixels, and a pass or fail table.

- [ ] **Step 1: Build the two downloads from the editor's code**

Create `/home/volence/l4d/hud/probe-your-items/p4/build.mts`:

```ts
/**
 * Your items p4 (plan Task 8): the editor's own downloads with the element
 * on, Stock at its home under the weapons, Modern just right of and under
 * the crosshair. Magenta icons so the glyphs are found by colour in the
 * game's shots and in the preview's pixels alike.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const WT = '/home/volence/l4d/pug/.claude/worktrees/your-items';
const OUT = '/home/volence/l4d/hud/probe-your-items/p4';
const { createServer } = await import('/home/volence/l4d/pug/node_modules/vite/dist/node/index.js');
const server = await createServer({
  root: `${WT}/web`, configFile: false, logLevel: 'error', appType: 'custom',
  server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] },
});
const load = (p: string) => server.ssrLoadModule(p);
const { packHud, yourItemsLayout } = await load('/src/hud/build.ts');
const { DEFAULT_DESIGN } = await load('/src/hud/design.ts');
const { setYourItems, placeElement } = await load('/src/hud/edit.ts');
const fonts = {
  regular: new Uint8Array(readFileSync(`${WT}/web/src/hud/base/fonts/RobotoCondensed-Regular.ttf`)),
  bold: new Uint8Array(readFileSync(`${WT}/web/src/hud/base/fonts/RobotoCondensed-Bold.ttf`)),
};
const MAGENTA = '255 0 255 255';
const PX = 1080 / 480;
mkdirSync(OUT, { recursive: true });
const expected: Record<string, unknown> = {};
for (const preset of ['stock', 'modern'] as const) {
  let d = { ...structuredClone(DEFAULT_DESIGN), preset, name: `youritems_p4_${preset}` };
  d = setYourItems(d, true);
  if (preset === 'modern') d = placeElement(d, 'yourItems', 853 / 2 + 20, 240 + 12);
  d = { ...d, elements: { ...d.elements, yourItems: { ...d.elements.yourItems, color: MAGENTA } } };
  writeFileSync(`${OUT}/${preset}.vpk`, packHud(d, { fonts }).bytes);
  writeFileSync(`${OUT}/${preset}.design.json`, JSON.stringify(d));
  const { row, label } = yourItemsLayout(d);
  const px = (b: { x: number; y: number; w: number; h: number }) => ({ x0: b.x * PX, y0: b.y * PX, x1: (b.x + b.w) * PX, y1: (b.y + b.h) * PX });
  expected[preset] = { row: px(row), label: px(label) };
  console.log(preset, JSON.stringify(expected[preset]));
}
writeFileSync(`${OUT}/expected.json`, JSON.stringify(expected, null, 2));
await server.close();
```

Run: `cd /home/volence/l4d/hud/probe-your-items/p4 && /home/volence/l4d/pug/node_modules/.bin/tsx build.mts`
Expected: `stock.vpk`, `modern.vpk`, two `*.design.json`, `expected.json`; the stock row near x0 1794, y0 524 px (797.43 x 2.25, 233 x 2.25).

Check the VPKs parse with the Python reader: `/home/volence/l4d/hud/.venv/bin/python -c "import vpk,sys; [vpk.open(p) for p in sys.argv[1:]]; print('ok')" stock.vpk modern.vpk`

- [ ] **Step 2: Run the game on each**

First: `pgrep -af '[l]eft4dead\.exe'` must print nothing (the game must not already be running). Then, from `/home/volence/l4d/hud/ingame-harness`:

```bash
./run.sh /home/volence/l4d/hud/probe-your-items/p4/stock.vpk /home/volence/l4d/hud/probe-your-items/your-items-p3.steps /home/volence/l4d/hud/probe-your-items/p4/runs/stock
./run.sh /home/volence/l4d/hud/probe-your-items/p4/modern.vpk /home/volence/l4d/hud/probe-your-items/your-items-p3.steps /home/volence/l4d/hud/probe-your-items/p4/runs/modern
```

Expected: exit code 0 for each, and `restore-verify.txt` with only OK lines. Shots land in `runs/<preset>/your-items-p3/` (`0-flyin`, `1-gun`, `2-holding-pills`, `3-pills-used`, `4-crouched`, `5-pipe-thrown`, `6-incapped`, `7-revived`, `8-kit-molotov`). Exit 3 means the restore failed: stop and tell the owner.

- [ ] **Step 3: Read the preview's own pixels**

Start the web dev server from the worktree on a free port, in the background: `cd /home/volence/l4d/pug/.claude/worktrees/your-items && npx vite --port 5199 --strictPort` (wait for "ready").

Create `/home/volence/l4d/hud/probe-your-items/p4/preview.mjs`:

```js
// Reads the editor preview's own canvas pixels (canvas.toDataURL, never a CDP screenshot) for each p4 design.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PORT = 9341;
const BASE = 'http://localhost:5199';
const DIR = '/home/volence/l4d/hud/probe-your-items/p4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn('google-chrome-stable', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/youritems-p4-profile', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });
let ws; let id = 0; const pending = new Map();
const send = (method, params = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))));
};
try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/json/version`); break; } catch { await sleep(250); } }
  const page = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) pending.get(m.id)(m); };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  for (const preset of ['stock', 'modern']) {
    const design = readFileSync(`${DIR}/${preset}.design.json`, 'utf8');
    await send('Page.navigate', { url: `${BASE}/hud` });
    await sleep(2000);
    await send('Runtime.evaluate', { expression: `localStorage.setItem('hud', ${JSON.stringify(design)})` });
    await send('Page.reload');
    await sleep(3000);
    const r = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => { const c = document.querySelector('.hud__stage canvas'); return JSON.stringify({ w: c.width, h: c.height, url: c.toDataURL('image/png') }); })()`,
    });
    const { w, h, url } = JSON.parse(r.result.value);
    writeFileSync(`${DIR}/preview-${preset}.png`, Buffer.from(url.split(',')[1], 'base64'));
    writeFileSync(`${DIR}/preview-${preset}.json`, JSON.stringify({ w, h }));
    console.log(preset, w, h);
  }
} finally { ws?.close(); chrome.kill(); }
```

Run: `node /home/volence/l4d/hud/probe-your-items/p4/preview.mjs`
Expected: two lines with the canvas size, `preview-stock.png` and `preview-modern.png`. Stop the dev server afterwards.

- [ ] **Step 4: Measure and compare**

Create `/home/volence/l4d/hud/probe-your-items/p4/measure.py`:

```python
"""Your items p4: the magenta glyph box in the game's 1920x1080 shots against the preview's, in 1080p pixels."""
import json, sys
from PIL import Image

DIR = '/home/volence/l4d/hud/probe-your-items/p4'
TOL = 4  # pixels at 1080p

def magenta_box(path, win, scale=1.0):
    im = Image.open(path).convert('RGB')
    W, H = im.size
    px = im.load()
    x0 = y0 = 10**9
    x1 = y1 = -1
    lo_x, lo_y = max(0, int(win[0] / scale)), max(0, int(win[1] / scale))
    hi_x, hi_y = min(W, int(win[2] / scale) + 1), min(H, int(win[3] / scale) + 1)
    for y in range(lo_y, hi_y):
        for x in range(lo_x, hi_x):
            r, g, b = px[x, y]
            if r > 150 and b > 150 and g < 110:
                x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x + 1), max(y1, y + 1)
    return None if x1 < 0 else tuple(v * scale for v in (x0, y0, x1, y1))

expected = json.load(open(f'{DIR}/expected.json'))
failed = False
for preset in ('stock', 'modern'):
    e = expected[preset]['row']
    win = (e['x0'] - 60, e['y0'] - 40, e['x1'] + 60, e['y1'] + 40)
    meta = json.load(open(f'{DIR}/preview-{preset}.json'))
    prev = magenta_box(f'{DIR}/preview-{preset}.png', win, 1080 / meta['h'])
    print(preset, 'preview', prev)
    shots = f'{DIR}/runs/{preset}/your-items-p3'
    for shot, full in (('1-gun', True), ('3-pills-used', False), ('4-crouched', False), ('7-revived', False), ('8-kit-molotov', False)):
        got = magenta_box(f'{shots}/{shot}.png', win)
        ok = got is not None and prev is not None and abs(got[2] - prev[2]) <= TOL and abs(got[1] - prev[1]) <= TOL and abs(got[3] - prev[3]) <= TOL
        if full and got and prev: ok = ok and abs(got[0] - prev[0]) <= TOL
        print(f'  {shot:14} game {got}  {"OK" if ok else "FAIL"}')
        failed |= not ok
    empty = magenta_box(f'{shots}/6-incapped.png', win)
    print(f'  6-incapped     game {empty}  {"OK (empty)" if empty is None else "FAIL (not empty)"}')
    failed |= empty is not None
sys.exit(1 if failed else 0)
```

Run: `/home/volence/l4d/hud/.venv/bin/python /home/volence/l4d/hud/probe-your-items/p4/measure.py`
Expected: every line OK and exit 0. The right edge, top and bottom must match in every shot with items (Right alignment keeps the right end); the left edge only in `1-gun`, the one shot with the full loadout the preview draws. `6-incapped` must find no magenta (the game empties the row).

Then look at the shots yourself (Read the PNGs): in `0-flyin` no pile of item slot art near the weapons; in every shot the health card (bar, number, cross, crouch icon in `4-crouched`, down picture in `6-incapped`, bar back in place in `7-revived`) sits where probe p3's shots have it (`/home/volence/l4d/hud/probe-your-items/runs/p3/your-items-p3/`).

- [ ] **Step 5: Record, and hand over to the owner**

Append to `/home/volence/l4d/hud/probe-your-items/RESULTS.md` a `## p4 (2026-09-2x): the editor's own download` section: the two designs (from the `*.design.json`), the VPK sha256s (`sha256sum p4/*.vpk`), the measure.py table, what the shots showed for the fly-in, the card, incap and revive, and any mismatch with its size in pixels. A FAIL is a finding to report, not something to tune the tolerance for. Then tell the owner the two VPKs are ready for their own test (`/home/volence/l4d/hud/probe-your-items/p4/stock.vpk`, `modern.vpk`), which the spec lists as the last step before shipping. Nothing in this task is committed to the repo.

---

## Execution

Recommended: **subagent-driven** (superpowers:subagent-driven-development), as the earlier HUD editor phases ran: an opus implementer per one or two tasks (Tasks 1+2, 3, 4, 5, 6, 7, then 8 alone), a reviewer per range (after 1-2, after 3-4, after 5-7), then one whole-feature review before merging. Tasks 3 and 4 lean on each other's private helpers in `build.ts` and Task 7 on every earlier export, so each implementer needs its task's Interfaces block exactly. Put this in every implementer prompt: "Work only in /home/volence/l4d/pug/.claude/worktrees/your-items. NEVER git stash, never checkout or switch branches, never move HEAD except by your own commits, never touch /home/volence/l4d/pug. git add only the files your task names. No em dashes anywhere."
