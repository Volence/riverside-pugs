import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { computeRecap } from '../src/weeklyRecap.js';
import { seedMatch, seedPlayers } from './weeklyFixtures.js';

let db: DB; let P: string[];
beforeEach(() => { db = openDb(':memory:'); P = seedPlayers(db, 8); });
const W = '2026-09-21';

describe('computeRecap', () => {
  it('an empty week is all zeros and nulls, not a crash', () => {
    expect(computeRecap(db, W)).toEqual({
      matches: 0, players: 0, peakConcurrent: 0, busiestDay: null, highlights: [], mostQuads: null,
      totals: [
        { key: 'crowns', label: 'witch crowns', value: 0, leader: null },
        { key: 'skeets', label: 'skeets', value: 0, leader: null },
        { key: 'common_kills', label: 'common infected', value: 0, leader: null },
      ],
      streaks: [], iron: [], closest: null,
    });
  });

  it('headline numbers, peak overlap and busiest day', () => {
    seedMatch(db, { wentLiveAt: '2026-09-22 20:00:00', endedAt: '2026-09-22 21:00:00', lines: [{ id: P[0], team: 'a' }, { id: P[1], team: 'b' }] });
    seedMatch(db, { wentLiveAt: '2026-09-22 20:30:00', endedAt: '2026-09-22 21:30:00', lines: [{ id: P[2], team: 'a' }] });
    seedMatch(db, { wentLiveAt: '2026-09-23 20:00:00', endedAt: '2026-09-23 21:00:00', lines: [{ id: P[0], team: 'a' }] });
    const r = computeRecap(db, W);
    expect([r.matches, r.players, r.peakConcurrent]).toEqual([3, 3, 2]);
    expect(r.busiestDay).toEqual({ date: '2026-09-22', matches: 2 });
  });

  it('busiest day follows the session, not the UTC calendar: a Friday night that ends past midnight still counts as Friday', () => {
    seedMatch(db, { endedAt: '2026-09-26 03:00:00', lines: [{ id: P[0], team: 'a' }] });
    seedMatch(db, { endedAt: '2026-09-26 04:00:00', lines: [{ id: P[1], team: 'a' }] });
    expect(computeRecap(db, W).busiestDay).toEqual({ date: '2026-09-25', matches: 2 });
  });

  it('best single game names the match; quads count once per team, not per player', () => {
    const m1 = seedMatch(db, { endedAt: '2026-09-22 21:00:00', lines: [
      { id: P[0], team: 'a', stats: { skeets: 12, quad_caps: 2 } },
      { id: P[1], team: 'a', stats: { quad_caps: 2 } },
      { id: P[2], team: 'b', stats: { quad_caps: 1 } },
    ] });
    seedMatch(db, { endedAt: '2026-09-23 21:00:00', lines: [{ id: P[3], team: 'a', stats: { skeets: 4 } }] });
    const r = computeRecap(db, W);
    expect(r.highlights.find((h) => h.key === 'skeets')).toMatchObject({ player: { steamid: P[0] }, value: 12, matchId: m1 });
    expect(r.mostQuads).toEqual({ matchId: m1, quads: 3 });
    expect(r.totals.find((t) => t.key === 'skeets')).toMatchObject({ value: 16, leader: { steamid: P[0], value: 12 } });
  });

  it('streaks need the minimum decided games; iron lists the top count and the runner-up', () => {
    for (let i = 0; i < 6; i++) {
      seedMatch(db, { endedAt: `2026-09-24 1${i}:00:00`, winner: i < 5 ? 'a' : 'b', lines: [
        { id: P[0], team: 'a' }, { id: P[1], team: 'a' }, ...(i < 4 ? [{ id: P[2], team: 'a' as const }] : []),
      ] });
    }
    const r = computeRecap(db, W);
    expect(r.streaks.map((s) => [s.steamid, s.w, s.l])).toEqual([[P[0], 5, 1], [P[1], 5, 1]]);
    expect(r.iron.map((x) => [x.steamid, x.games])).toEqual([[P[0], 6], [P[1], 6], [P[2], 4]]);
  });

  it('closest game is the smallest margin', () => {
    seedMatch(db, { endedAt: '2026-09-22 21:00:00', a: 500, b: 300, lines: [{ id: P[0], team: 'a' }] });
    const m = seedMatch(db, { endedAt: '2026-09-23 21:00:00', a: 177, b: 178, campaign: 'death_toll', lines: [{ id: P[0], team: 'a' }] });
    expect(computeRecap(db, W).closest).toMatchObject({ matchId: m, a: 177, b: 178 });
  });
});
