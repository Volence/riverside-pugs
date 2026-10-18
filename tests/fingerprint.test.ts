import { describe, it, expect } from 'vitest';
import {
  BINS, FALLBACK_THRESHOLD, addBurst, classLabel, classOf, distance, fingerprintOf, holdTotal, matchPersons,
  medianHold, percentile, personThreshold, pooled, tvDistance, without, type FieldEntry, type PersonModel,
} from '../src/fingerprint.js';
import { encodeIntervals } from '../src/inputStats.js';
import { HUNTER, POUNCE, SMOKER, fpOf, spread } from './fingerprintFixtures.js';

describe('press classes', () => {
  it('keys fire and pounce on the three infected claws, either weapon spelling', () => {
    expect(classOf('fire', 'weapon_hunter_claw')).toBe(HUNTER);
    expect(classOf('pounce', 'hunter_claw')).toBe(POUNCE);
    expect(classOf('fire', 'weapon_boomer_claw')).toBe('fire:weapon_boomer_claw');
    expect(classOf('bhop', '')).toBeNull();
    expect(classOf('fire', 'weapon_smg')).toBeNull();
    expect(classLabel(HUNTER)).toBe('hunter claw');
    expect(classLabel(POUNCE)).toBe('hunter air attack');
  });
});

describe('histograms', () => {
  it('drops 1-tick and over-20-tick holds', () => {
    const fp = {};
    addBurst(fp, { kind: 'fire', weapon: 'weapon_hunter_claw', holds: encodeIntervals([1, 1, 2, 20, 21, 30]) });
    expect(holdTotal(fp)).toBe(2);
    const counts = (fp as Record<string, number[]>)[HUNTER];
    expect(counts).toHaveLength(BINS);
    expect(counts[0]).toBe(1); // 2 ticks
    expect(counts[BINS - 1]).toBe(1); // 20 ticks
  });

  it('skips rows with no holds, corrupt holds or a non-base class', () => {
    const fp = fingerprintOf([
      { kind: 'fire', weapon: 'weapon_hunter_claw', holds: null },
      { kind: 'fire', weapon: 'weapon_hunter_claw', holds: '\u0001' },
      { kind: 'fire', weapon: 'weapon_pistol', holds: encodeIntervals([8, 8]) },
    ]);
    expect(holdTotal(fp)).toBe(0);
  });

  it('pools and subtracts', () => {
    const a = fpOf({ [HUNTER]: spread(10, 20) });
    const b = fpOf({ [HUNTER]: spread(12, 20), [SMOKER]: spread(9, 8) });
    const both = pooled([a, b]);
    expect(holdTotal(both)).toBe(48);
    expect(holdTotal(without(both, b))).toBe(20);
  });
});

describe('distance', () => {
  it('total variation: 0 for the same shape, 1 for disjoint, 0.5 for half', () => {
    const at = (bin: number, n: number) => { const c = Array(BINS).fill(0); c[bin] = n; return c; };
    expect(tvDistance(at(5, 10), at(5, 40))).toBe(0);
    expect(tvDistance(at(5, 10), at(9, 10))).toBe(1);
    const half = Array(BINS).fill(0); half[5] = 5; half[9] = 5;
    expect(tvDistance(at(5, 10), half)).toBeCloseTo(0.5);
  });

  it('is the mean over shared classes', () => {
    const cand = fpOf({ [HUNTER]: spread(10, 20), [POUNCE]: spread(10, 20) });
    const ref = fpOf({ [HUNTER]: spread(10, 40), [POUNCE]: spread(16, 40) });
    expect(distance(cand, ref)).toBeCloseTo(0.5);
  });

  it('needs 15 candidate and 30 reference holds in at least two classes', () => {
    const ref = fpOf({ [HUNTER]: spread(10, 30), [POUNCE]: spread(10, 30) });
    expect(distance(fpOf({ [HUNTER]: spread(10, 15), [POUNCE]: spread(10, 15) }), ref)).not.toBeNull();
    expect(distance(fpOf({ [HUNTER]: spread(10, 15), [POUNCE]: spread(10, 14) }), ref)).toBeNull();
    const thin = fpOf({ [HUNTER]: spread(10, 30), [POUNCE]: spread(10, 29) });
    expect(distance(fpOf({ [HUNTER]: spread(10, 15), [POUNCE]: spread(10, 15) }), thin)).toBeNull();
  });
});

describe('medians and percentiles', () => {
  it('median hold in ticks, lower median on an even count', () => {
    expect(medianHold(fpOf({ [HUNTER]: [3, 5, 5, 9] })[HUNTER])).toBe(5);
    expect(medianHold(fpOf({ [HUNTER]: [4, 6] })[HUNTER])).toBe(4);
    expect(medianHold(undefined)).toBeNull();
  });

  it('nearest-rank percentile', () => {
    expect(percentile([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], 0.9)).toBeCloseTo(0.9);
    expect(percentile([0.3], 0.9)).toBe(0.3);
  });
});

describe('per-person threshold', () => {
  const match = (peak: number, n = 60) => fpOf({ [HUNTER]: spread(peak, n), [POUNCE]: spread(peak, n) });

  it('falls back to 0.25 under three usable member-matches', () => {
    expect(personThreshold([])).toBe(FALLBACK_THRESHOLD);
    expect(personThreshold([match(10), match(10)])).toBe(FALLBACK_THRESHOLD);
    // 98 holds each: under the 100-hold floor, so none is usable.
    expect(personThreshold([match(10, 49), match(10, 49), match(10, 49)])).toBe(FALLBACK_THRESHOLD);
  });

  it('is the 90th percentile of each match against the person without it', () => {
    const ms = [match(10), match(10), match(12)];
    const all = pooled(ms);
    const loo = ms.map((m) => distance(m, without(all, m))!);
    expect(personThreshold(ms)).toBe(percentile(loo, 0.9));
    expect(personThreshold([match(10), match(10), match(10)])).toBe(0);
  });
});

describe('matchPersons', () => {
  const big = (peak: number) => fpOf({ [HUNTER]: spread(peak, 80), [POUNCE]: spread(peak, 80) });
  const honest: FieldEntry[] = [5, 6, 7, 14, 15, 16].map((p, i) => ({ subject: `steam:h${i}`, fp: big(p) }));
  const person = (pooledPeak: number, threshold = 0.25): PersonModel =>
    ({ id: 1, label: 'dethisa', members: ['A', 'B'], pooled: big(pooledPeak), threshold });

  it('ranks the person first and matches under its threshold', () => {
    const p = person(10);
    const field = [...honest, { subject: 'steam:A', fp: big(10) }, { subject: 'steam:B', fp: big(10) }, { subject: 'person:1', fp: p.pooled }];
    const [hit] = matchPersons(big(10), 'CAND', field, [p]);
    expect(hit).toMatchObject({ personId: 1, distance: 0, rank: 1, matched: true, membersInTop10: 2, nearestMember: 'A' });
  });

  it('needs 150 base holds before it says anything', () => {
    const thin = fpOf({ [HUNTER]: spread(10, 74), [POUNCE]: spread(10, 75) });
    expect(matchPersons(thin, 'CAND', honest, [person(10)])).toEqual([]);
  });

  it('does not match a person past their threshold', () => {
    const [hit] = matchPersons(big(10), 'CAND', honest, [person(16)]);
    expect(hit.matched).toBe(false);
  });

  it('does not match outside the top 5 even under the threshold', () => {
    const twins: FieldEntry[] = [0, 1, 2, 3, 4].map((i) => ({ subject: `steam:t${i}`, fp: big(10) }));
    const [hit] = matchPersons(big(10), 'CAND', [...honest, ...twins], [person(11, 0.9)]);
    expect(hit.rank).toBe(6);
    expect(hit.matched).toBe(false);
  });

  it('takes the person\'s own accounts and the candidate out of the field', () => {
    const p = person(11, 0.9);
    const field = [...honest, { subject: 'steam:A', fp: big(10) }, { subject: 'steam:CAND', fp: big(10) }];
    const [hit] = matchPersons(big(10), 'CAND', field, [p]);
    expect(hit.rank).toBe(1);
    expect(hit.nearestMember).toBe('A');
  });
});
