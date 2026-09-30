// tests/matchVisibilityLive.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';
import { getLiveMatches } from '../src/liveView.js';

let db: DB;
let app: FastifyInstance;
let ids: string[];
let outsider: string;
let caster: string;
let priv: number;

beforeEach(async () => {
  db = openDb(':memory:');
  const all = seedPlayers(db, 10);
  ids = all.slice(0, 8);
  outsider = all[8];
  caster = all[9];
  db.prepare('UPDATE players SET is_caster = 1 WHERE steamid = ?').run(caster);
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  const lines = ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));
  priv = seedMatch(db, { endedAt: '2026-09-21 13:00:00', kind: 'scrim', visibility: 'participants', state: 'live', lines });
  db.prepare("INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (?, 1, 1, 'scrim.bin', 10, 10, 10)").run(priv);
});
afterEach(async () => { await app.close(); });

const get = (url: string, who?: string) =>
  app.inject({ method: 'GET', url, cookies: who ? authedCookie(app, db, who) : undefined });

describe('replays and live data respect visibility', () => {
  it('replay routes 404 for outsiders', async () => {
    for (const url of [
      `/api/replays/live/match/${priv}`,
      `/api/replays/match/${priv}/1/1`,
      `/api/replays/timeline/${priv}/1/1`,
    ]) {
      expect((await get(url, outsider)).statusCode, url).toBe(404);
      expect((await get(url)).statusCode, url).toBe(404);
    }
  });

  it('the public live list and the caster list leave the scrim out', async () => {
    expect(getLiveMatches(db).map((m) => m.id)).not.toContain(priv);
    const cast = await get('/api/cast', caster);
    expect(JSON.stringify(cast.json())).not.toContain(`"id":${priv}`);
  });
});
