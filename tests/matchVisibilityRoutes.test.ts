// tests/matchVisibilityRoutes.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';

let db: DB;
let app: FastifyInstance;
let ids: string[];
let outsider: string;
let priv: number;
let pub: number;

beforeEach(async () => {
  db = openDb(':memory:');
  const all = seedPlayers(db, 9);
  ids = all.slice(0, 8);
  outsider = all[8];
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  const lines = ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));
  pub = seedMatch(db, { endedAt: '2026-09-21 12:00:00', lines });
  priv = seedMatch(db, { endedAt: '2026-09-21 13:00:00', kind: 'scrim', visibility: 'participants', lines });
});
afterEach(async () => { await app.close(); });

const get = (url: string, who?: string) =>
  app.inject({ method: 'GET', url, cookies: who ? authedCookie(app, db, who) : undefined });

describe('match routes respect visibility', () => {
  it('lists the private scrim only to its players', async () => {
    const listed = async (who?: string) => ((await get('/api/matches', who)).json().matches as { id: number }[]).map((m) => m.id);
    expect(await listed()).toEqual([pub]);
    expect(await listed(outsider)).toEqual([pub]);
    expect(await listed(ids[0])).toEqual([priv, pub]);
  });

  it('answers a private scrim like a missing match for outsiders', async () => {
    const missing = await get('/api/matches/999999');
    for (const who of [undefined, outsider]) {
      const r = await get(`/api/matches/${priv}`, who);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual(missing.json());
    }
    expect((await get(`/api/matches/${priv}`, ids[0])).statusCode).toBe(200);
  });

  it('gates the ongoing stub and demos too', async () => {
    db.prepare("UPDATE matches SET state = 'live' WHERE id = ?").run(priv);
    expect((await get(`/api/matches/${priv}`, outsider)).statusCode).toBe(404);
    expect((await get(`/api/matches/${priv}/demos/1`, outsider)).statusCode).toBe(404);
  });
});
