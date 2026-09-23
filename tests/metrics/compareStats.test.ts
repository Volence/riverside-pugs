import { describe, expect, it } from 'vitest';
import {
  benjaminiHochberg, bootstrapDiff, mapWeights, matchesNeeded, mulberry32, quantile,
  sharedMaps, verdictOf, weightedValue, type MatchSample,
} from '../../src/metrics/compare/stats.js';

const m = (entries: [string, number, number][]): MatchSample =>
  new Map(entries.map(([map, num, den]) => [map, { num, den }]));

describe('compare statistics', () => {
  it('mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(1), b = mulberry32(1);
    const xs = Array.from({ length: 5 }, () => a());
    expect(xs).toEqual(Array.from({ length: 5 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('quantile interpolates linearly', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
  });

  it('splits shared and excluded maps', () => {
    const a = [m([['x', 1, 2], ['y', 1, 2]])];
    const b = [m([['y', 1, 2], ['z', 1, 2]])];
    expect(sharedMaps(a, b)).toEqual({ shared: ['y'], excluded: ['x', 'z'] });
  });

  it('weights maps by side A denominator and reweights side B to that mix', () => {
    const a = [m([['x', 1, 1]]), m([['x', 1, 1]]), m([['y', 0, 1]]), m([['y', 0, 1]]), m([['y', 0, 1]]), m([['y', 0, 1]])];
    const b = [m([['x', 3, 4]]), m([['y', 1, 4]])];
    const w = mapWeights(a, ['x', 'y']);
    expect(w.get('x')).toBeCloseTo(2 / 6);
    expect(w.get('y')).toBeCloseTo(4 / 6);
    expect(weightedValue(a, w)).toBeCloseTo(2 / 6);
    expect(weightedValue(b, w)).toBeCloseTo((2 / 6) * 0.75 + (4 / 6) * 0.25);
  });

  it('weightedValue renormalizes over maps present and is null with none', () => {
    const w = new Map([['x', 0.5], ['y', 0.5]]);
    expect(weightedValue([m([['x', 1, 2]])], w)).toBeCloseTo(0.5);
    expect(weightedValue([], w)).toBeNull();
  });

  it('bootstrap finds a clear difference and not a null one', () => {
    const hi = Array.from({ length: 40 }, () => m([['x', 8, 10]]));
    const lo = Array.from({ length: 40 }, () => m([['x', 2, 10]]));
    const w = new Map([['x', 1]]);
    const clear = bootstrapDiff(lo, hi, w, 500, mulberry32(7))!;
    expect(clear.lo).toBeGreaterThan(0);
    expect(clear.p).toBeLessThan(0.01);
    const mixed = Array.from({ length: 40 }, (_, i) => m([['x', i % 2 ? 8 : 2, 10]]));
    const none = bootstrapDiff(mixed, mixed, w, 500, mulberry32(7))!;
    expect(none.lo).toBeLessThan(0);
    expect(none.hi).toBeGreaterThan(0);
    expect(none.p).toBeGreaterThan(0.2);
  });

  it('bootstrap is null when a side is empty', () => {
    expect(bootstrapDiff([], [m([['x', 1, 1]])], new Map([['x', 1]]), 10, mulberry32(1))).toBeNull();
  });

  it('Benjamini-Hochberg at 10%', () => {
    expect(benjaminiHochberg([0.01, 0.04, 0.2, null], 0.1)).toEqual([true, true, false, false]);
    expect(benjaminiHochberg([0.08, 0.09, 0.5], 0.1)).toEqual([false, false, false]);
  });

  it('matches needed scales with (z * se / diff)^2', () => {
    expect(matchesNeeded(0.1, 0.1, 20)).toBe(Math.ceil(20 * (1.96 ** 2) - 20));
    expect(matchesNeeded(0, 0.1, 20)).toBeNull();
    expect(matchesNeeded(1, 0.01, 20)).toBe(0);
  });

  it('verdicts follow the thresholds', () => {
    expect(verdictOf({ hasData: false, significant: true, nA: 50, nB: 50 })).toBe('no_data');
    expect(verdictOf({ hasData: true, significant: true, nA: 10, nB: 12 })).toBe('real');
    expect(verdictOf({ hasData: true, significant: true, nA: 9, nB: 50 })).toBe('too_early');
    expect(verdictOf({ hasData: true, significant: false, nA: 30, nB: 31 })).toBe('noise');
    expect(verdictOf({ hasData: true, significant: false, nA: 29, nB: 60 })).toBe('too_early');
  });
});
