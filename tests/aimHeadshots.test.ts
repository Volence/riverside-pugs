import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  HS_GROUPS, HS_MAX_P, HS_MIN_KILLS, HS_POOL_MIN, binomialTail, groupOf, hsNote, hsShare, pooledRate, recordSiKill,
} from '../src/aimRules.js';

const A = '76561198129925325';
const AUTO = HS_GROUPS.find((g) => g.name === 'auto')!;
const FIXED = () => ({ rate: 0.367, poolKills: 0, pooled: false });
const kills = (weapon: string, n: number, hs: number) =>
  Array.from({ length: n }, (_, i) => ({ weapon, headshot: i < hs ? 1 : 0 }));

describe('binomialTail', () => {
  it('matches known values', () => {
    expect(binomialTail(14, 16, 0.367)).toBeCloseTo(4.1762e-5, 8);
    expect(binomialTail(3, 10, 0.5)).toBeCloseTo(0.9453125, 12);
    expect(binomialTail(10, 10, 0.5)).toBeCloseTo(1 / 1024, 12);
    expect(binomialTail(9, 10, 0.367)).toBeCloseTo(8.0886e-4, 7);
  });

  it('handles the ends', () => {
    expect(binomialTail(0, 5, 0.3)).toBe(1);
    expect(binomialTail(6, 5, 0.3)).toBe(0);
    expect(binomialTail(1, 5, 0)).toBe(0);
    expect(binomialTail(5, 5, 1)).toBe(1);
  });

  it('does not underflow on a long match', () => {
    const p = binomialTail(150, 200, 0.367);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1e-20);
  });
});

describe('weapon groups', () => {
  it('pools smg and pistols as auto, the hunting rifle alone, and nothing else', () => {
    expect(groupOf('smg')?.name).toBe('auto');
    expect(groupOf('pistol')?.name).toBe('auto');
    expect(groupOf('dual_pistols')?.name).toBe('auto');
    expect(groupOf('hunting_rifle')?.name).toBe('rifle');
    // Pump kills never report a headshot; the M16 is in no group (plan gap 1).
    for (const w of ['pumpshotgun', 'autoshotgun', 'rifle', 'hunter_claw', '']) expect(groupOf(w), w).toBeNull();
  });

  // Review Focus 5.
  it('reads a weapon_ prefixed name as the same weapon', () => {
    expect(groupOf('weapon_smg')?.name).toBe('auto');
  });

  it('ships the rifle group off until its rate is measured', () => {
    expect(HS_GROUPS.find((g) => g.name === 'rifle')).toMatchObject({ enabled: false, fallback: null });
  });
});

describe('hsShare', () => {
  it('fires on nepmir\'s match', () => {
    const [r] = hsShare(kills('smg', 16, 14), FIXED);
    expect(r).toMatchObject({ group: 'auto', kills: 16, headshots: 14, rate: 0.367, pooled: false });
    expect(r.p).toBeLessThan(HS_MAX_P);
    expect(hsNote(r)).toBe(
      'auto weapons: 14 of 16 SI kills were headshots, p = 4.2e-5 against 0.367 (fixed until 500 kills are on record, 0 so far)',
    );
  });

  it('needs ten kills in the group', () => {
    expect(HS_MIN_KILLS).toBe(10);
    expect(hsShare(kills('smg', 9, 9), FIXED)).toEqual([]);
    expect(hsShare(kills('smg', 10, 9), FIXED)).toHaveLength(1); // p = 8.1e-4
    expect(hsShare(kills('smg', 10, 8), FIXED)).toEqual([]);     // p = 6.7e-3
  });

  it('counts only the group\'s own kills', () => {
    const mixed = [...kills('smg', 9, 9), ...kills('pumpshotgun', 20, 0), ...kills('rifle', 10, 10)];
    expect(hsShare(mixed, FIXED)).toEqual([]);
  });

  it('never fires the disabled rifle group', () => {
    expect(hsShare(kills('hunting_rifle', 30, 30), FIXED)).toEqual([]);
  });

  it('skips a group with no rate', () => {
    expect(hsShare(kills('smg', 16, 16), () => null)).toEqual([]);
  });
});

describe('pooledRate', () => {
  let db: DB;
  const NOW = new Date('2026-10-17T22:00:00.000Z');
  beforeEach(() => { db = openDb(':memory:'); });
  const add = (matchId: number, weapon: string, n: number, hs: number, at = new Date('2026-10-10T20:00:00.000Z')) => {
    for (let i = 0; i < n; i++) {
      recordSiKill(db, { matchId, serverId: 1, steamid: A, weapon, headshot: i < hs, dist: 400, pre: 5, back: 3, victimClass: 'hunter' }, at);
    }
  };

  it('uses the fallback under 500 kills', () => {
    add(1, 'smg', 499, 100);
    expect(pooledRate(db, AUTO, 999, NOW)).toEqual({ rate: 0.367, poolKills: 499, pooled: false });
  });

  it('pools the trailing 30 days once 500 kills exist', () => {
    expect(HS_POOL_MIN).toBe(500);
    add(1, 'smg', 300, 120);
    add(2, 'weapon_pistol', 200, 80);
    add(3, 'smg', 100, 100, new Date('2026-09-01T00:00:00.000Z')); // too old
    add(4, 'pumpshotgun', 100, 0);                                 // other group
    expect(pooledRate(db, AUTO, 999, NOW)).toEqual({ rate: 0.4, poolKills: 500, pooled: true });
  });

  // Review Focus 5: the judged match is never part of its own pool.
  it('leaves the judged match out', () => {
    add(1, 'smg', 500, 200);
    add(722, 'smg', 16, 14);
    expect(pooledRate(db, AUTO, 722, NOW)).toEqual({ rate: 0.4, poolKills: 500, pooled: true });
    expect(pooledRate(db, AUTO, 1, NOW)).toEqual({ rate: 0.367, poolKills: 16, pooled: false });
  });

  it('has no rate for a group with no fallback and too few kills', () => {
    expect(pooledRate(db, HS_GROUPS.find((g) => g.name === 'rifle')!, 999, NOW)).toBeNull();
  });
});
