import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { freezeWeek } from '../src/weeklyStore.js';
import { stubOrchestrator } from './helpers.js';
import { seedMatch, seedPlayers } from './weeklyFixtures.js';

let db: DB; let app: FastifyInstance; let P: string[];
beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-09-30T12:00:00Z'), toFake: ['Date'] });
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(),
    verifyLogin: async () => '', fetchPersona: async () => ({ name: 'x', avatar: null }), serverExec: async () => {},
  });
  P = seedPlayers(db, 2);
  for (let i = 0; i < 5; i++) seedMatch(db, { endedAt: `2026-09-22 1${i}:00:00`, lines: [{ id: P[0], team: 'a', stats: { skeets: 3 } }] });
  seedMatch(db, { endedAt: '2026-09-29 10:00:00', lines: [{ id: P[1], team: 'a', stats: { skeets: 7 } }] });
});
afterEach(async () => { vi.useRealTimers(); await app.close(); });

describe('weekly routes', () => {
  it('current week is computed live and public', async () => {
    const r = await app.inject({ url: '/api/weekly' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ week: '2026-09-28', live: true, minGames: 5 });
    expect(r.json().awards.find((a: { key: string; kind: string }) => a.key === 'skeets' && a.kind === 'total').winners[0].steamid).toBe(P[1]);
  });

  it('past weeks come from the frozen rows, unfrozen ones 404, junk 400', async () => {
    expect((await app.inject({ url: '/api/weekly?week=2026-09-21' })).statusCode).toBe(404);
    freezeWeek(db, '2026-09-21');
    const r = await app.inject({ url: '/api/weekly?week=2026-09-21' });
    expect(r.json()).toMatchObject({ week: '2026-09-21', live: false, recap: { matches: 5 } });
    expect((await app.inject({ url: '/api/weekly?week=nope' })).statusCode).toBe(400);
    // Calendar-invalid but shape-matching dates must 400, not 500.
    expect((await app.inject({ url: '/api/weekly?week=2026-13-01' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/weekly?week=2026-01-32' })).statusCode).toBe(400);
    // A valid calendar date that isn't a Monday is not a canonical week id.
    expect((await app.inject({ url: '/api/weekly?week=2026-09-22' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/weekly/weeks' })).json()).toEqual({ current: '2026-09-28', weeks: ['2026-09-21'] });
  });

  it('the profile lists weekly awards', async () => {
    freezeWeek(db, '2026-09-21');
    const r = await app.inject({ url: `/api/players/${P[0]}` });
    expect(r.json().weeklyAwards.find((a: { award: string }) => a.award === 'skeets')).toMatchObject({ count: 1, weeks: ['2026-09-21'] });
  });
});
