import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 9 }, (_, i) => `7656119900000000${i}`);
const ADMIN = IDS[8];
let db: DB;
let app: FastifyInstance;
let matchId: number;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) cookie[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, ended_at) VALUES (1, 'completed', 'dead_air', datetime('now', '-2 hours'))").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.slice(0, 8).forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
});
afterEach(async () => { await app.close(); });

const report = (as: string, payload: object, id = matchId) =>
  app.inject({ method: 'POST', url: `/api/matches/${id}/reports`, cookies: cookie[as], payload });

describe('player reports', () => {
  it('a roster member can report another roster member once', async () => {
    const r = await report(IDS[0], { targetId: IDS[5], category: 'griefing', text: 'kept teamkilling' });
    expect(r.statusCode).toBe(200);
    expect((await report(IDS[0], { targetId: IDS[5], category: 'toxicity', text: 'again' })).statusCode).toBe(409);
    const elig = (await app.inject({ method: 'GET', url: `/api/matches/${matchId}/report-eligibility`, cookies: cookie[IDS[0]] })).json();
    expect(elig.canReport).toBe(true);
    expect(elig.targets.find((t: { steamid: string }) => t.steamid === IDS[5]).alreadyReported).toBe(true);
    expect(elig.targets.some((t: { steamid: string }) => t.steamid === IDS[0])).toBe(false);
  });

  it('refuses self, non-roster targets, non-roster reporters, bad categories and long text', async () => {
    expect((await report(IDS[0], { targetId: IDS[0], category: 'afk', text: '' })).statusCode).toBe(400);
    expect((await report(IDS[0], { targetId: ADMIN, category: 'afk', text: '' })).statusCode).toBe(400);
    expect((await report(ADMIN, { targetId: IDS[1], category: 'afk', text: '' })).statusCode).toBe(403);
    expect((await report(IDS[0], { targetId: IDS[1], category: 'rude', text: '' })).statusCode).toBe(400);
    expect((await report(IDS[0], { targetId: IDS[1], category: 'other', text: 'x'.repeat(1001) })).statusCode).toBe(400);
  });

  it('closes 48 hours after the match ended', async () => {
    db.prepare("UPDATE matches SET ended_at = datetime('now', '-49 hours') WHERE id = ?").run(matchId);
    expect((await report(IDS[0], { targetId: IDS[5], category: 'afk', text: '' })).statusCode).toBe(403);
    const elig = (await app.inject({ method: 'GET', url: `/api/matches/${matchId}/report-eligibility`, cookies: cookie[IDS[0]] })).json();
    expect(elig.canReport).toBe(false);
  });

  it('needs a session', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/matches/${matchId}/reports`, payload: {} })).statusCode).toBe(401);
  });

  it('admins list, resolve and dismiss, audited; the reporter is visible only to admins', async () => {
    await report(IDS[0], { targetId: IDS[5], category: 'cheating', text: 'wallhack?' });
    const list = (await app.inject({ method: 'GET', url: '/api/admin/reports', cookies: cookie[ADMIN] })).json();
    expect(list.reports[0]).toMatchObject({ targetId: IDS[5], reporterId: IDS[0], category: 'cheating', status: 'open', matchId });
    const id = list.reports[0].id;
    expect((await app.inject({ method: 'POST', url: `/api/admin/reports/${id}/resolve`, cookies: cookie[ADMIN], payload: { status: 'nope' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/admin/reports/${id}/resolve`, cookies: cookie[ADMIN], payload: { status: 'resolved', note: 'warned' } })).statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/api/admin/reports?status=resolved', cookies: cookie[ADMIN] })).json();
    expect(after.reports[0]).toMatchObject({ status: 'resolved', resolutionNote: 'warned', resolvedBy: ADMIN });
    const audit = (await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: cookie[ADMIN] })).json();
    expect(audit.actions[0]).toMatchObject({ action: 'resolve_report', target: String(id) });
    expect((await app.inject({ method: 'GET', url: '/api/admin/reports', cookies: cookie[IDS[1]] })).statusCode).toBe(403);
  });
});
