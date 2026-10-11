import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { detectionsForPlayer, recordInputBurst, rerunSignatures } from '../src/inputBursts.js';
import { AUTOBHOP_MIN_CHAINED, autobhop, matchDetections, DEFAULT_THRESHOLDS, type SignatureBurst } from '../src/inputStats.js';
import { BELLA_631, WHEEL_600 } from './fixtures/bhopSamples.js';

const A = '76561198030413993';
const hops = (seq: readonly (readonly [number, number])[]): SignatureBurst[] =>
  seq.map(([g, t]) => ({ kind: 'bhop', weapon: '', intervals: [1], groundTicks: g, serverTick: t }));
/** A run of chained hops, 60 ticks apart, with the given ground ticks. */
const chain = (grounds: number[], start = 1000): [number, number][] => grounds.map((g, i) => [g, start + i * 60]);

describe('autobhop', () => {
  // The first confirmed cheater (Aimware, confessed): the signature was
  // calibrated on this match, so it must keep catching it.
  it('catches the confirmed autobhop on its real hops', () => {
    const r = autobhop(hops(BELLA_631));
    expect(r).not.toBeNull();
    expect(r!.chained).toBe(36);
    expect(r!.perfect).toBe(26);
    expect(r!.longestRun).toBe(10);
  });

  // The highest honest share on record is a scroll-wheel jumper at 0.54.
  it('leaves the best honest wheel jumper alone', () => {
    expect(autobhop(hops(WHEEL_600))).toBeNull();
  });

  it('needs enough chained hops before the share means anything', () => {
    expect(autobhop(hops(chain(Array(AUTOBHOP_MIN_CHAINED).fill(0))))).toBeNull(); // 19 links
    expect(autobhop(hops(chain(Array(AUTOBHOP_MIN_CHAINED + 1).fill(0))))).not.toBeNull();
  });

  // Single jumps far apart are not bunnyhopping, however they land.
  it('does not chain hops more than 1.2 s apart', () => {
    const apart: [number, number][] = Array.from({ length: 40 }, (_, i) => [0, 1000 + i * 500]);
    expect(autobhop(hops(apart))).toBeNull();
  });

  // Server ticks restart on a new map: a hop "before" the previous one is a
  // new chain, never a link.
  it('does not link across a map change', () => {
    const map1 = chain(Array(15).fill(0), 90_000);
    const map2 = chain(Array(15).fill(0), 100);
    const r = autobhop(hops([...map1, ...map2]));
    expect(r!.chained).toBe(28); // 14 + 14 links; the jump back in ticks is not one
    expect(r!.longestRun).toBe(14);
  });

  it('reports through matchDetections with a note', () => {
    const d = matchDetections(hops(BELLA_631), DEFAULT_THRESHOLDS).find((x) => x.signature === 'autobhop');
    expect(d?.note).toBe('72% of 36 chained hops on the landing tick, longest run 10');
  });
});

describe('autobhop through storage', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); });
  const store = (seq: readonly (readonly [number, number])[]) => seq.map(([g, t]) => recordInputBurst(db, {
    matchId: 631, serverId: 1, steamid: A, kind: 'bhop', weapon: '', airPresses: 0,
    groundTicks: g, serverTick: t, clientTick: t, intervals: [1], wire: 2, holds: [1],
  }));

  it('creates one row on the hop that completed it, then counts later hops on it', () => {
    const results = store(BELLA_631);
    const fired = results.filter((r) => r.detections.includes('autobhop'));
    expect(fired).toHaveLength(1);
    expect(fired[0].created[0].note).toMatch(/on the landing tick/);
    const rows = detectionsForPlayer(db, A);
    expect(rows).toHaveLength(1);
    expect(rows[0].signature).toBe('autobhop');
    expect(rows[0].hits).toBe(26);
  });

  it('a rebuild from history lands on the same row', () => {
    store(BELLA_631);
    const before = detectionsForPlayer(db, A)[0];
    rerunSignatures(db);
    const after = detectionsForPlayer(db, A)[0];
    expect({ ...after, id: 0 }).toEqual({ ...before, id: 0 });
  });

  it('stores nothing for the honest wheel jumper', () => {
    store(WHEEL_600);
    expect(detectionsForPlayer(db, A)).toHaveLength(0);
  });
});
