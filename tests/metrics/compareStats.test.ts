import { describe, expect, it } from 'vitest';
import {
  benjaminiHochberg, bootstrapDiff, inverseNormalCdf, mapWeights, matchesNeeded, mulberry32, quantile,
  sharedMaps, verdictOf, weightedDiff, weightedValue, type MatchSample,
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

  it('bootstrap floors p at 1 / (reps + 1)', () => {
    const hi = Array.from({ length: 40 }, () => m([['x', 8, 10]]));
    const lo = Array.from({ length: 40 }, () => m([['x', 2, 10]]));
    const w = new Map([['x', 1]]);
    const reps = 50;
    const r = bootstrapDiff(lo, hi, w, reps, mulberry32(7))!;
    expect(r.p).toBeGreaterThanOrEqual(1 / (reps + 1));
  });

  it('weightedDiff only uses maps present on both sides, paired per replicate', () => {
    const w = new Map([['x', 0.5], ['y', 0.5]]);
    const a = [m([['x', 1, 2], ['y', 2, 4]])];
    const b = [m([['x', 3, 4]])];
    // y is absent from b, so only x counts: weight renormalizes to 1 on x alone.
    expect(weightedDiff(a, b, w)).toBeCloseTo(0.75 - 0.5);
    expect(weightedDiff(a, [], w)).toBeNull();
  });

  it('bootstrap does not over-reject under the null when one side is map-sparse', () => {
    // Regression for the map-mix bias: weightedValue used to renormalize each
    // side's resample separately, so when side B has few matches per map, a
    // map could drop out of B's resample but not A's, biasing the diff even
    // though every map has the same rate on both sides (a true null). Mirrors
    // the reviewer's sim2/sim3 scripts: A has 60 matches evenly split over 12
    // maps, B has 30 matches concentrated on one map (19) with 1 each on the
    // other 11, so B is far more likely to drop a map from a resample than A.
    const SIMS = 150;
    const REPS = 300;
    const rate = (i: number) => (i === 0 ? 0.9 : 0.2);
    const binom = (n: number, p: number, rand: () => number) => {
      let k = 0;
      for (let i = 0; i < n; i++) if (rand() < p) k++;
      return k;
    };
    let rejections = 0;
    for (let s = 0; s < SIMS; s++) {
      const gen = mulberry32(1000 + s);
      const a: MatchSample[] = Array.from({ length: 60 }, (_, k) => {
        const i = k % 12;
        return m([[`m${i}`, binom(8, rate(i), gen), 8]]);
      });
      const b: MatchSample[] = [];
      for (let k = 0; k < 30; k++) {
        const i = k < 19 ? 0 : k - 18;
        b.push(m([[`m${i}`, binom(8, rate(i), gen), 8]]));
      }
      const { shared } = sharedMaps(a, b);
      const w = mapWeights(a, shared);
      const r = bootstrapDiff(a, b, w, REPS, mulberry32(2000 + s))!;
      if (r.p < 0.05) rejections++;
    }
    expect(rejections / SIMS).toBeLessThan(0.12);
  });

  it('Benjamini-Hochberg at 10%', () => {
    expect(benjaminiHochberg([0.01, 0.04, 0.2, null], 0.1)).toEqual([true, true, false, false]);
    expect(benjaminiHochberg([0.08, 0.09, 0.5], 0.1)).toEqual([false, false, false]);
  });

  it('matches needed pays down only the target variance seA has not already used', () => {
    // diff is zero: no interval will ever exclude it.
    expect(matchesNeeded(0, 0.1, 0.05, 20)).toBeNull();
    // seA alone already meets the target variance: more B matches cannot help.
    expect(matchesNeeded(0.1, 0.1, 0.05, 20)).toBeNull();
    // normal case: seA leaves headroom, B needs many more matches to fill it.
    expect(matchesNeeded(0.1, 0.02, 0.15, 20)).toBe(185);
    // B already has more than enough matches for its share: sample size is
    // not what holds the row back, so there is no estimate (not a floor of 1).
    expect(matchesNeeded(1, 0.01, 0.01, 20)).toBeNull();
    // A stricter z (a BH cutoff below 5%) needs more matches than 1.96 does.
    expect(matchesNeeded(0.1, 0.02, 0.15, 20, 3)).toBeGreaterThan(185);
    // Clears 95% (so 1.96 has nothing to add) but not a z of 3.02.
    expect(matchesNeeded(0.1, 0.02, 0.04, 18)).toBeNull();
    expect(matchesNeeded(0.1, 0.02, 0.04, 18, 3.0233)).toBe(24);
  });

  it('inverse normal CDF matches known quantiles in the centre and both tails', () => {
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 9);
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.959964, 5);
    expect(inverseNormalCdf(0.025)).toBeCloseTo(-1.959964, 5);
    expect(inverseNormalCdf(0.99875)).toBeCloseTo(3.023341, 5);
    expect(inverseNormalCdf(0.01)).toBeCloseTo(-2.326348, 5);
    expect(inverseNormalCdf(1 - 1e-6)).toBeCloseTo(4.753424, 4);
    expect(() => inverseNormalCdf(0)).toThrow(RangeError);
    expect(() => inverseNormalCdf(1)).toThrow(RangeError);
  });

  it('verdicts follow the thresholds', () => {
    expect(verdictOf({ hasData: false, significant: true, nA: 50, nB: 50 })).toBe('no_data');
    expect(verdictOf({ hasData: true, significant: true, nA: 10, nB: 12 })).toBe('real');
    expect(verdictOf({ hasData: true, significant: true, nA: 9, nB: 50 })).toBe('too_early');
    expect(verdictOf({ hasData: true, significant: false, nA: 30, nB: 31 })).toBe('noise');
    expect(verdictOf({ hasData: true, significant: false, nA: 29, nB: 60 })).toBe('too_early');
  });
});
