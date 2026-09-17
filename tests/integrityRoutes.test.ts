import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { ANALYZER_VERSION } from '../src/integrity/store.js';

const ADMIN = '76561198000000009';
const SUS = '76561198000000001';
const CLEAN = '76561198000000002';
let db: DB;
let app: FastifyInstance;
let adminCookie: Record<string, string>;
let userCookie: Record<string, string>;

const metrics = (fidMax: number, occZ: number | null) =>
  JSON.stringify({ fidMax, fidP95: fidMax / 2, occZ, teamRank: 1, teamGap: occZ, eligiblePairs: 200 });

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {} });
  adminCookie = authedCookie(app, db, ADMIN);
  userCookie = authedCookie(app, db, CLEAN);
  authedCookie(app, db, SUS);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'farm')").run();
  const ins = db.prepare(
    `INSERT INTO integrity_rounds (match_id, ordinal, half, slot, steamid, analyzer_version, metrics, computed_at)
     VALUES (1, 1, 1, ?, ?, ?, ?, datetime('now'))`,
  );
  ins.run(0, SUS, ANALYZER_VERSION, metrics(0.95, 4.2));
  ins.run(1, CLEAN, ANALYZER_VERSION, metrics(0.2, 0.1));
  db.prepare(
    `INSERT INTO integrity_clips (match_id, ordinal, half, slot, steamid, start_ms, end_ms, kind, score, detail, analyzer_version)
     VALUES (1, 1, 1, 0, ?, 12000, 14000, 'ghost_track', 0.95, '{"ghostSlot":4}', ?)`,
  ).run(SUS, ANALYZER_VERSION);
});
afterEach(async () => { await app.close(); });

describe('GET /api/admin/integrity', () => {
  it('refuses a non-admin', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/admin/integrity', cookies: userCookie });
    expect(r.statusCode).toBe(403);
  });

  it('returns players ranked by composite', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/admin/integrity', cookies: adminCookie });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { players: { steamid: string; composite: number }[] };
    expect(body.players[0].steamid).toBe(SUS);
    expect(body.players[0].composite).toBeGreaterThan(body.players[1].composite);
  });
});

describe('GET /api/admin/integrity/:steamid', () => {
  it('returns that player rounds and clips', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/admin/integrity/${SUS}`, cookies: adminCookie });
    const body = r.json() as { rounds: unknown[]; clips: { startMs: number }[] };
    expect(body.rounds).toHaveLength(1);
    expect(body.clips[0].startMs).toBe(12000);
  });
});

describe('POST review', () => {
  it('records the state, the note and an audit entry', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/integrity/1/1/1/0/review', cookies: adminCookie,
      payload: { state: 'dismissed', note: 'heard the spawn' },
    });
    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT state, note FROM integrity_reviews').get()).toEqual({ state: 'dismissed', note: 'heard the spawn' });
    expect(db.prepare("SELECT COUNT(*) c FROM admin_actions WHERE action = 'integrity_review'").get()).toEqual({ c: 1 });
  });

  it('rejects a state outside the allowed set', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/integrity/1/1/1/0/review', cookies: adminCookie,
      payload: { state: 'banned', note: '' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('refuses a non-admin', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/admin/integrity/1/1/1/0/review', cookies: userCookie,
      payload: { state: 'reviewed', note: '' },
    });
    expect(r.statusCode).toBe(403);
  });
});
