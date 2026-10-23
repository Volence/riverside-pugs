import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { freezeWeek } from '../src/weeklyStore.js';
import { playerWeek, playerWeekHistory } from '../src/weeklyPlayer.js';
import { stubOrchestrator } from './helpers.js';
import { seedMatch, seedPlayers } from './weeklyFixtures.js';

let db: DB; let P: string[];
const W = '2026-09-28';
const skeetsOf = (pw: ReturnType<typeof playerWeek>) => pw.stats.find((s) => s.key === 'skeets')!;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-30T12:00:00Z'), toFake: ['Date'] });
  db = openDb(':memory:');
  P = seedPlayers(db, 4);
  // P0: 5 games, 3 skeets each (15). P1: 5 games, 4 each (20, leader).
  // P2: 2 games, 10 each (20 total, ties P1, but under the minimum for averages).
  for (let i = 0; i < 5; i++) {
    seedMatch(db, { endedAt: `2026-09-29 0${i}:00:00`, lines: [
      { id: P[0], team: 'a', stats: { skeets: 3 } },
      { id: P[1], team: 'b', stats: { skeets: 4 } },
      ...(i < 2 ? [{ id: P[2], team: 'a' as const, stats: { skeets: 10 } }] : []),
    ] });
  }
});
afterEach(() => vi.useRealTimers());

describe('playerWeek', () => {
  it('ranks the average among qualified players and the total among everyone, with the gap to the leader', () => {
    const s = skeetsOf(playerWeek(db, W, P[0]));
    expect(s.avg).toEqual({ value: 3, rank: 2, of: 2, leader: 4, gap: 1 });
    // Totals: P1 20, P2 20, P0 15 -> third of three, five behind.
    expect(s.total).toEqual({ value: 15, rank: 3, of: 3, leader: 20, gap: 5 });
  });

  it('ties share a rank and the leader reads a gap of zero', () => {
    const t1 = skeetsOf(playerWeek(db, W, P[1])).total!;
    const t2 = skeetsOf(playerWeek(db, W, P[2])).total!;
    expect([t1.rank, t2.rank]).toEqual([1, 1]);
    expect(t1.gap).toBe(0);
    expect(skeetsOf(playerWeek(db, W, P[1])).avg).toMatchObject({ rank: 1, gap: 0 });
  });

  it('under the minimum the average is shown but not ranked', () => {
    const pw = playerWeek(db, W, P[2]);
    expect(pw).toMatchObject({ games: 2, minGames: 5, qualifies: false, players: 3 });
    expect(skeetsOf(pw).avg).toMatchObject({ value: 10, rank: null, of: 2, leader: 4, gap: 0 });
  });

  it('a player with no games that week gets empty stats, not zeros ranked last', () => {
    const pw = playerWeek(db, W, P[3]);
    expect(pw.games).toBe(0);
    expect(skeetsOf(pw)).toMatchObject({ avg: null, total: null });
  });

  it('tournament and voided games stay out', () => {
    seedMatch(db, { endedAt: '2026-09-29 09:00:00', kind: 'tournament', lines: [{ id: P[0], team: 'a', stats: { skeets: 99 } }] });
    seedMatch(db, { endedAt: '2026-09-29 10:00:00', voided: true, lines: [{ id: P[0], team: 'a', stats: { skeets: 99 } }] });
    expect(skeetsOf(playerWeek(db, W, P[0])).total!.value).toBe(15);
  });
});

describe('playerWeekHistory', () => {
  it('groups by the Monday-noon week and lists frozen awards won, not shame', () => {
    seedMatch(db, { endedAt: '2026-09-22 10:00:00', lines: [{ id: P[0], team: 'a', fixed: { si_damage: 500, ff_dealt: 90 }, stats: { skeets: 2 } }] });
    // Monday 11:00 UTC is still the week before (the week turns at noon).
    seedMatch(db, { endedAt: '2026-09-28 11:00:00', lines: [{ id: P[0], team: 'a', stats: { skeets: 1 } }] });
    freezeWeek(db, '2026-09-21');
    const rows = playerWeekHistory(db, P[0]);
    expect(rows.map((r) => [r.week, r.games, r.skeets, r.live])).toEqual([[W, 5, 15, true], ['2026-09-21', 2, 3, false]]);
    expect(rows[1].siDamage).toBe(500);
    expect(rows[1].awards.some((a) => a.key === 'skeets' && a.kind === 'total')).toBe(true);
    expect(rows[1].awards.some((a) => a.key === 'friendly_fire')).toBe(false);
    expect(rows[0].awards).toEqual([]);
  });
});

describe('weekly player routes', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildServer({
      config: loadConfig({}), db, orchestrator: stubOrchestrator(),
      verifyLogin: async () => '', fetchPersona: async () => ({ name: 'x', avatar: null }), serverExec: async () => {},
    });
  });
  afterEach(async () => { await app.close(); });

  it('serves the current week by default, a given week on request, and refuses junk', async () => {
    const r = await app.inject({ url: `/api/weekly/player/${P[0]}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ week: W, games: 5 });
    expect((await app.inject({ url: `/api/weekly/player/${P[0]}?week=2026-09-21` })).json()).toMatchObject({ week: '2026-09-21', games: 0 });
    expect((await app.inject({ url: `/api/weekly/player/${P[0]}?week=2026-09-22` })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/weekly/player/nope' })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/weekly/player/${P[0]}/history` })).json().weeks[0]).toMatchObject({ week: W, games: 5 });
  });
});
