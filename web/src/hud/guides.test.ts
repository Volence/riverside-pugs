import { describe, it, expect } from 'vitest';
import { snapMove, snapEdges, unionBox, SNAP_UNITS } from './guides';

const SCREEN = { x: 0, y: 0, w: 853, h: 480 };

describe('snapMove', () => {
  it('snaps a near edge, a far edge or a centre to the screen within 4 units', () => {
    expect(snapMove({ x: 3, y: 100, w: 100, h: 20 }, [SCREEN]).dx).toBe(-3);
    expect(snapMove({ x: 750, y: 100, w: 100, h: 20 }, [SCREEN]).dx).toBe(3);
    expect(snapMove({ x: 375, y: 100, w: 100, h: 20 }, [SCREEN]).dx).toBe(1.5);
    expect(snapMove({ x: 2, y: 231, w: 20, h: 20 }, [SCREEN])).toMatchObject({ dx: -2, dy: -1 });
  });

  it('leaves a box more than 4 units from everything alone', () => {
    expect(SNAP_UNITS).toBe(4);
    expect(snapMove({ x: 200, y: 100, w: 100, h: 20 }, [SCREEN])).toEqual({ dx: 0, dy: 0, guides: [] });
    expect(snapMove({ x: 5, y: 100, w: 100, h: 20 }, [SCREEN]).dx).toBe(0);
  });

  it("snaps to another box's edges and returns the guide spanning both", () => {
    const got = snapMove({ x: 100, y: 10, w: 50, h: 50 }, [{ x: 152, y: 200, w: 40, h: 40 }]);
    expect(got).toEqual({ dx: 2, dy: 0, guides: [{ axis: 'x', at: 152, from: 10, to: 240 }] });
  });

  it('prefers the nearest candidate', () => {
    expect(snapMove({ x: 10, y: 0, w: 10, h: 10 }, [{ x: 11, y: 500, w: 2, h: 1 }]).dx).toBe(1);
  });

  it('draws a guide for an exact alignment too', () => {
    const got = snapMove({ x: 0, y: 100, w: 100, h: 20 }, [SCREEN]);
    expect(got.dx).toBe(0);
    expect(got.guides).toContainEqual({ axis: 'x', at: 0, from: 0, to: 480 });
  });
});

describe('snapEdges', () => {
  it('snaps only the edges the handle moves', () => {
    const target = { x: 112, y: 300, w: 10, h: 10 };
    expect(snapEdges({ x: 10, y: 10, w: 100, h: 50 }, 'e', [target])).toEqual({
      dx: 2, dy: 0, guides: [{ axis: 'x', at: 112, from: 10, to: 310 }],
    });
    expect(snapEdges({ x: 10, y: 10, w: 100, h: 50 }, 'w', [target])).toEqual({ dx: 0, dy: 0, guides: [] });
    expect(snapEdges({ x: 10, y: 3, w: 100, h: 50 }, 'n', [SCREEN]).dy).toBe(-3);
    expect(snapEdges({ x: 10, y: 3, w: 100, h: 50 }, 's', [SCREEN]).dy).toBe(0);
  });
});

describe('unionBox', () => {
  it('bounds every box, or is null for none', () => {
    expect(unionBox([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 10 }])).toEqual({ x: 0, y: 0, w: 30, h: 15 });
    expect(unionBox([])).toBeNull();
  });
});
