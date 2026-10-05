import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { addServer } from '../src/serverPool.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { recordBalanceSighting } from '../src/balancePatches.js';

const ADMIN = '76561198000000009';

describe('balance admin API', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, token) VALUES (1, 1, 'live', 'x', ?)").run('d'.repeat(32));
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'a')").run();
    addServer(db, { name: 'dallas', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    addServer(db, { name: 'chicago', host: '10.0.0.2', port: 27015, rconPort: 27015, rconPassword: 'x' });
    recordBalanceSighting(db, { matchId: 1, serverId: 1, half: 1, inventory: { 'c:a': '1' }, versionless: [] });
    recordBalanceSighting(db, { matchId: 1, serverId: 2, half: 1, inventory: { 'c:a': '2' }, versionless: [] });
  });

  async function app() {
    const a = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    const cookies = await authedCookie(a, db, ADMIN);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return { a, cookies };
  }

  it('lists patches in time order with numbers and round counts', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/patches', cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { patches: { number: number; source: string; rounds: number }[] };
    expect(body.patches.map((p) => p.number)).toEqual([1, 2]);
    expect(body.patches[1].rounds).toBe(1); // the round was retagged by the second sighting
  });

  it('shows drift between servers', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/drift', cookies });
    const body = res.json() as { servers: { name: string; differsFrom: { name: string; diff: string }[] }[] };
    const chicago = body.servers.find((s) => s.name === 'chicago')!;
    expect(chicago.differsFrom[0]).toEqual({ name: 'dallas', diff: 'c:a 1 -> 2' });
  });

  it('renames a patch and marks it reviewed, audited', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/admin/balance/patches/1', cookies, payload: { name: 'Tank 7500', reviewed: true } });
    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT name, reviewed FROM balance_patches WHERE id = 1').get()).toEqual({ name: 'Tank 7500', reviewed: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'edit_patch'").get()).toEqual({ n: 1 });
  });

  it('reports survival by look per campaign over the asked window, admin only', async () => {
    const { a, cookies } = await app();
    const m = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, server_id, created_at) VALUES (1, 'live', 'death_toll', 1, datetime('now'))").run().lastInsertRowid);
    const now = Date.now();
    db.prepare('INSERT INTO map_looks (server_id, at, title, preset, layers, match_id) VALUES (1, ?, ?, ?, NULL, ?)').run(now - 60_000, 'Storm', 'storm', m);
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, reliable, started_at, survivors_alive) VALUES (?, 0, 1, 'a', 300, 1, datetime('now'), 2)").run(m);
    db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(m);
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/looks?days=7', cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      days: 7,
      rows: [{ campaign: 'death_toll', title: 'Storm', matches: 1, rounds: 1, avgScore: 300, finishRate: 1, avgAlive: 2 }],
    });
    // A silly window falls back to the default, a huge one is capped.
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/looks?days=abc', cookies })).json().days).toBe(30);
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/looks?days=9999', cookies })).json().days).toBe(365);
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/looks' })).statusCode).toBe(401);
  });

  it('refuses a non-admin', async () => {
    const a = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    const cookies = await authedCookie(a, db, '76561198000000010');
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/patches', cookies });
    expect(res.statusCode).toBe(403);
  });
});
