import { describe, it, expect } from 'vitest';
import { barGeometry, clampBarKeys } from './progress';

describe('the use/heal bar geometry (probe Q22)', () => {
  const r = { x: 0, y: 0, w: 200, h: 20 };

  it('draws a border ring less the shadow, a gap, then fill and empty inside it', () => {
    // probe-phase2/b1v2/shots/b1/b1-d.png, Bar 200 x 20 with border 3, gap 3, shadow 1 at 2.25 px a unit:
    // ring x 767 to 1215 and y 595 to 638 of a 767 to 1217, 595 to 640 rect; fill from y 607, 6 + 6 px in.
    const g = barGeometry(r, { border: 3, gap: 3, shadow: 1 }, 0.5);
    expect(g.border).toEqual({ x: 0, y: 0, w: 199, h: 19 });
    expect(g.borderWidth).toBe(3);
    expect(g.fill).toEqual({ x: 6, y: 6, w: 93.5, h: 7 });
    expect(g.empty).toEqual({ x: 99.5, y: 6, w: 93.5, h: 7 });
  });

  it('puts the shadow on the ring\'s right and bottom, pushed out by its thickness', () => {
    // b1-d.png: black at x 1215 to 1217 from y 597, and at y 638 to 640 from x 769 (2 px shadow).
    const g = barGeometry(r, { border: 3, gap: 3, shadow: 1 }, 0.5);
    expect(g.shadow).toEqual([{ x: 199, y: 1, w: 1, h: 19 }, { x: 1, y: 19, w: 199, h: 1 }]);
    expect(barGeometry(r, { border: 3, gap: 3, shadow: 0 }, 0.5).shadow).toEqual([]);
  });

  it('draws no fill and no empty part when border and gap eat the bar, as B1 showed', () => {
    // probe-phase2/b1/shots/crops/bar-d.png: the stock 8-unit bar with border 3 and gap 3 kept only its border.
    const g = barGeometry({ ...r, h: 8 }, { border: 3, gap: 3, shadow: 1 }, 0.5);
    expect([g.fill, g.empty]).toEqual([null, null]);
    expect(g.border).not.toBeNull();
  });

  it('draws no empty part when full, and no fill when empty', () => {
    expect(barGeometry(r, { border: 1, gap: 1, shadow: 1 }, 1).empty).toBeNull();
    expect(barGeometry(r, { border: 1, gap: 1, shadow: 1 }, 0).fill).toBeNull();
  });

  it('clamps so one unit of fill always remains, the gap giving way first', () => {
    expect(clampBarKeys({ border: 3, gap: 3, shadow: 1 }, 8)).toEqual({ border: 3, gap: 0, shadow: 1 });
    expect(clampBarKeys({ border: 5, gap: 2, shadow: 1 }, 8)).toEqual({ border: 3, gap: 0, shadow: 1 });
    expect(clampBarKeys({ border: 1, gap: 1, shadow: 1 }, 8)).toEqual({ border: 1, gap: 1, shadow: 1 });
    for (const keys of [{ border: 3, gap: 3, shadow: 1 }, { border: 9, gap: 9, shadow: 2 }, { border: 0, gap: 7, shadow: 0 }]) {
      const c = clampBarKeys(keys, 8);
      expect(barGeometry({ x: 0, y: 0, w: 200, h: 8 }, c, 0.5).fill!.h).toBeGreaterThanOrEqual(1);
    }
  });
});
