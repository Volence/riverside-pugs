import { describe, expect, it } from 'vitest';
import { rolling, trendGeometry } from './charts';

describe('chart geometry', () => {
  it('rolling mean over a trailing window', () => {
    expect(rolling([1, 2, 3, 4], 2)).toEqual([1, 1.5, 2.5, 3.5]);
  });
  it('maps time to x and value to an upward y', () => {
    const g = trendGeometry([{ t: 0, v: 0 }, { t: 10, v: 1 }], 100, 50, 5)!;
    expect(g.x(0)).toBe(0);
    expect(g.x(10)).toBe(100);
    expect(g.y(1)).toBeLessThan(g.y(0));
  });
  it('is null with fewer than two points and centres a flat series', () => {
    expect(trendGeometry([{ t: 0, v: 1 }], 100, 50)).toBeNull();
    const g = trendGeometry([{ t: 0, v: 1 }, { t: 1, v: 1 }], 100, 50)!;
    expect(g.y(1)).toBe(25);
  });
});
