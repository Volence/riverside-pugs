import { describe, it, expect } from 'vitest';
import {
  ITEM_ROW, itemRowWidth, rowLayout, rowXRange, placeRow, rowLimitLines, EDGE_MARGIN, LABEL_PAD, BAR_EDGE_LABEL, CENTRE_EDGE_LABEL,
  ITEM_FONTS, ITEM_FONT_TALL, DEFAULT_ITEM_FONT, type RowInput,
} from './youritems';
import { ITEM_ROW as RENDER_ITEM_ROW } from './render';
import { ICON_ADVANCE, ICON_SPACE } from './iconMetrics';

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
