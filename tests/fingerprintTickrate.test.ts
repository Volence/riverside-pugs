import { describe, it, expect, beforeEach } from 'vitest';
import {
  BINS, HOLD_MAX, HOLD_MIN, addBurst, addHolds, distance, holdTotal, matchPersons, medianHold,
  type FieldEntry, type Fingerprint, type PersonModel,
} from '../src/fingerprint.js';
import { FINGERPRINT_BINNING, fingerprintWorld, playerFingerprint } from '../src/fingerprintData.js';
import { openDb, type DB } from '../src/db.js';
import { encodeIntervals } from '../src/inputStats.js';
import { rng } from './inputSim.js';
import { HUNTER, POUNCE, SMOKER, endedMatch, handHolds, playMatch } from './fingerprintFixtures.js';

/**
 * Fingerprints at 128 tick: bins are 10 ms, so a hand reads the same whatever
 * rate its bursts were recorded at, and 100 tick bins exactly as it always did.
 */

const CLASSES = [HUNTER, POUNCE, SMOKER];
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** One player: a median hold per class, in ms. */
function handFp(seed: number, rate: number, medians: readonly number[], n = 300): Fingerprint {
  const fp: Fingerprint = {};
  CLASSES.forEach((cls, i) => addHolds(fp, cls, handHolds(seed * 10 + i, rate, n, medians[i]), rate));
  return fp;
}

/** The binning before rate-aware bins: every reading as a 100 tick tick. */
function tickBinned(seed: number, rate: number, medians: readonly number[], n = 300): Fingerprint {
  const fp: Fingerprint = {};
  CLASSES.forEach((cls, i) => addHolds(fp, cls, handHolds(seed * 10 + i, rate, n, medians[i]).map((h) => Math.min(h, 30))));
  return fp;
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const A = [95, 110, 130];
const B = [110, 125, 145];

describe('100 tick is unchanged', () => {
  it('bins every 100 tick hold whole, in its own tick, as the tick bins did', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = rng(seed);
      const holds = Array.from({ length: 257 }, () => 1 + Math.floor(r() * 30));
      const want = new Array<number>(BINS).fill(0);
      for (const h of holds) if (h >= HOLD_MIN && h <= HOLD_MAX) want[h - HOLD_MIN] += 1;
      for (const tickrate of [undefined, null, 100]) {
        const fp: Fingerprint = {};
        addBurst(fp, { kind: 'fire', weapon: 'weapon_hunter_claw', holds: encodeIntervals(holds), tickrate });
        expect(fp[HUNTER]).toEqual(want);
      }
    }
  });
});

describe('a 128 tick hold', () => {
  const at128 = (holds: number[]): number[] => {
    const fp: Fingerprint = {};
    addHolds(fp, HUNTER, holds, 128);
    return fp[HUNTER] ?? new Array<number>(BINS).fill(0);
  };

  it('spreads over the 10 ms bins its 7.8 ms window covers', () => {
    // 11 ticks = 82.03 to 89.84 ms: 80 ms bin (75 to 85) and 90 ms bin.
    const c = at128([11]);
    expect(c[8 - HOLD_MIN]).toBeCloseTo(2.97 / 7.8125, 2);
    expect(c[9 - HOLD_MIN]).toBeCloseTo(4.84 / 7.8125, 2);
    expect(holdTotal({ [HUNTER]: c })).toBeCloseTo(1);
  });

  it('weighs one in all from 3 to 25 ticks (19.5 to 199 ms)', () => {
    for (let h = 3; h <= 25; h++) expect(holdTotal({ [HUNTER]: at128([h]) })).toBeCloseTo(1);
  });

  it('drops what is under 15 or over 205 ms, a one-tick hold and the cap', () => {
    expect(holdTotal({ [HUNTER]: at128([2]) })).toBeCloseTo((19.53 - 15) / 7.8125, 2);
    expect(holdTotal({ [HUNTER]: at128([26]) })).toBeCloseTo((205 - 199.22) / 7.8125, 2);
    expect(holdTotal({ [HUNTER]: at128([1, 27, 37, 38]) })).toBe(0);
  });

  it('is read at the 128 tick cap, so a hold past 30 does not drop the burst', () => {
    const holds = encodeIntervals([10, 35, 12]);
    const fp: Fingerprint = {};
    addBurst(fp, { kind: 'fire', weapon: 'weapon_hunter_claw', holds, tickrate: 128 });
    expect(holdTotal(fp)).toBeCloseTo(2);
    // Read as 100 tick, 35 is past the cap and the string is refused.
    const old: Fingerprint = {};
    addBurst(old, { kind: 'fire', weapon: 'weapon_hunter_claw', holds, tickrate: null });
    expect(holdTotal(old)).toBe(0);
  });

  it('medians fractional counts at the bin where the count first reaches half', () => {
    expect(medianHold([0.4, 0.4, 0.4])).toBe(HOLD_MIN + 1);
    expect(medianHold([0, 0.2, 0.9])).toBe(HOLD_MIN + 2);
  });
});

describe('the same hand at 100 and at 128 tick', () => {
  it('is as close to its 100 tick history as another 100 tick sample of it', () => {
    const d100 = SEEDS.map((s) => distance(handFp(s, 100, A), handFp(s + 100, 100, A))!);
    const d128 = SEEDS.map((s) => distance(handFp(s + 200, 128, A), handFp(s + 100, 100, A))!);
    expect(mean(d128)).toBeLessThanOrEqual(mean(d100) * 1.1);
    for (let i = 0; i < SEEDS.length; i++) expect(d128[i]).toBeLessThan(d100[i] + 0.05);
    // Binned as ticks it would have read 28% long and looked like someone else.
    const dTicks = SEEDS.map((s) => distance(tickBinned(s + 200, 128, A), handFp(s + 100, 100, A))!);
    expect(mean(dTicks)).toBeGreaterThan(2 * mean(d100));
  });

  it('keeps two different hands as far apart as at 100 tick', () => {
    const gap100 = SEEDS.map((s) => {
      const ref = handFp(s + 100, 100, A), other = handFp(s + 300, 100, B), cand = handFp(s, 100, A);
      return distance(cand, other)! - distance(cand, ref)!;
    });
    const gap128 = SEEDS.map((s) => {
      const ref = handFp(s + 100, 100, A), other = handFp(s + 300, 100, B), cand = handFp(s + 200, 128, A);
      return distance(cand, other)! - distance(cand, ref)!;
    });
    for (const g of gap128) expect(g).toBeGreaterThan(0);
    expect(mean(gap128)).toBeGreaterThanOrEqual(0.8 * mean(gap100));
  });

  it('finds a person from a 128 tick account as often as from a 100 tick one', () => {
    const hands = [[80, 95, 115], B, [125, 140, 160], [100, 100, 100], [90, 120, 150]];
    const firsts = { 100: 0, 128: 0 };
    const seeds = Array.from({ length: 16 }, (_, i) => i + 1);
    for (const s of seeds) {
      const field: FieldEntry[] = hands.map((m, i) => ({ subject: `steam:h${i}`, fp: handFp(s * 7 + i, 100, m) }));
      const pooled = handFp(s + 100, 100, A);
      const person: PersonModel = { id: 1, label: 'p', members: ['M'], pooled, threshold: 0.25 };
      field.push({ subject: 'steam:M', fp: pooled }, { subject: 'person:1', fp: pooled });
      for (const rate of [100, 128] as const) {
        // A first match's worth: 100 holds a class.
        const [hit] = matchPersons(handFp(s + 200, rate, A, 100), 'CAND', field, [person]);
        if (hit.rank === 1) firsts[rate] += 1;
        expect(hit.rank).toBeLessThanOrEqual(2);
      }
    }
    expect(firsts[100]).toBeGreaterThanOrEqual(12);
    expect(firsts[128]).toBeGreaterThanOrEqual(firsts[100] - 1);
  });
});

describe('stored 128 tick bursts', () => {
  const P = '76561198000000001';
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    endedMatch(db, 1);
  });

  it('are read at the rate their row carries', () => {
    db.prepare(
      `INSERT INTO input_bursts (match_id, server_id, steamid, kind, weapon, n, ground_ticks, air_presses, server_tick, client_tick, intervals, at, wire, holds, tickrate)
       VALUES (1, 1, ?, 'fire', 'weapon_hunter_claw', 2, 0, 0, 1, 1, ?, '2026-10-20T16:00:00.000Z', 2, ?, 128)`,
    ).run(P, encodeIntervals([20, 20]), encodeIntervals([12, 36, 14]));
    expect(holdTotal(playerFingerprint(db, P))).toBeCloseTo(2);
  });

  it('a cache row from the tick bins is rebuilt whatever its date', () => {
    playMatch(db, P, 1, 10, 80, '2026-10-17T10:00:00.000Z');
    db.prepare("INSERT INTO fingerprint_cache (subject, classes_json, holds, built_at) VALUES (?, '{}', 0, '2026-10-18T00:00:00.000Z')")
      .run(`steam:${P}`);
    const w = fingerprintWorld(db, new Date('2026-10-20T00:00:00Z'));
    expect(w.rebuilt).toBe(1);
    expect(db.prepare('SELECT binning, holds FROM fingerprint_cache WHERE subject = ?').get(`steam:${P}`))
      .toEqual({ binning: FINGERPRINT_BINNING, holds: 160 });
    expect(fingerprintWorld(db, new Date('2026-10-20T00:05:00Z')).rebuilt).toBe(0);
  });
});
