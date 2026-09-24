import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { spectateFor } from '../src/spectate.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
let db: DB;
let app: FastifyInstance;
let serverId: number;
let matchId: number;

function liveMatch(server: number): number {
  const id = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (1, 'live', 'dead_air', ?, 'tok')",
  ).run(server).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((p, i) => ins.run(id, p, i < 4 ? 'a' : 'b'));
  db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_farm01_hilltop', datetime('now'))").run(id);
  return id;
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) authedCookie(app, db, id);
  serverId = addServer(db, { name: 'Dallas', host: '203.0.113.5', port: 27015, rconPort: 27015, rconPassword: 'x' });
  matchId = liveMatch(serverId);
});
afterEach(async () => { await app.close(); });

const enableTv = (pw = 'dunged', port = 27020) =>
  db.prepare('UPDATE servers SET tv_enabled = 1, tv_port = ?, tv_password = ? WHERE id = ?').run(port, pw, serverId);

describe('spectateFor', () => {
  it('is null until SourceTV is switched on for that server', () => {
    expect(spectateFor(db, serverId)).toBeNull();
    enableTv();
    expect(spectateFor(db, serverId)).toEqual({ host: '203.0.113.5', port: 27020, password: 'dunged', delay: 0 });
  });

  it('is null for a server with no row, and carries no password when none is set', () => {
    expect(spectateFor(db, 999)).toBeNull();
    db.prepare("UPDATE servers SET tv_enabled = 1, tv_port = 27020, tv_password = '' WHERE id = ?").run(serverId);
    expect(spectateFor(db, serverId)?.password).toBe('');
  });
});

describe('live spectate info', () => {
  it('/api/live carries it publicly once enabled', async () => {
    let live = (await app.inject({ method: 'GET', url: '/api/live' })).json();
    expect(live.matches[0].spectate).toBeNull();
    enableTv();
    live = (await app.inject({ method: 'GET', url: '/api/live' })).json();
    expect(live.matches[0]).toMatchObject({ id: matchId, spectate: { host: '203.0.113.5', port: 27020, password: 'dunged' } });
  });

  it('a rostered player sees it on their own match state too', async () => {
    enableTv();
    const st = (await app.inject({ method: 'GET', url: '/api/state', cookies: authedCookie(app, db, IDS[0]) })).json();
    expect(st.match.spectate).toMatchObject({ port: 27020 });
  });
});

describe('admin sourcetv settings', () => {
  it('an admin sets port, password and enabled; non-admins cannot', async () => {
    const admin = authedCookie(app, db, IDS[0]);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(IDS[0]);
    const user = authedCookie(app, db, IDS[1]);
    expect((await app.inject({ method: 'POST', url: `/api/admin/servers/${serverId}/sourcetv`, cookies: user, payload: { enabled: true } })).statusCode).toBe(403);
    const res = await app.inject({
      method: 'POST', url: `/api/admin/servers/${serverId}/sourcetv`, cookies: admin,
      payload: { enabled: true, port: 27020, password: 'dunged' },
    });
    expect(res.statusCode).toBe(200);
    expect(spectateFor(db, serverId)).toMatchObject({ port: 27020, password: 'dunged' });
    expect((await app.inject({
      method: 'POST', url: `/api/admin/servers/${serverId}/sourcetv`, cookies: admin, payload: { enabled: true, port: 99999 },
    })).statusCode).toBe(400);
    const overview = (await app.inject({ method: 'GET', url: '/api/admin/overview', cookies: admin })).json();
    expect(overview.servers[0]).toMatchObject({ tvEnabled: 1, tvPort: 27020 });
    // The admin overview may carry the SourceTV password (admins only) but never rcon.
    expect(JSON.stringify(overview)).not.toContain('rcon');
  });
});
