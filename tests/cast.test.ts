import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { serverPasswordFor } from '../src/matchToken.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const ADMIN = '76561199000000091';
const PLAYER = '76561199000000092';
const MOD = '76561199000000093';
const CASTER = '76561199000000094';
const TOKEN = 'c'.repeat(32);

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;
let serverId: number;
let matchId: number;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
  });
  cookies = {};
  for (const id of [...IDS, ADMIN, PLAYER, MOD, CASTER]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1, is_admin = 0 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_caster = 1, is_admin = 0 WHERE steamid = ?').run(CASTER);
  serverId = addServer(db, { name: 'Dallas', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
  db.prepare("UPDATE servers SET tv_enabled = 1, tv_port = 27020, tv_password = '' WHERE id = ?").run(serverId);
  matchId = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, server_id, token, origin) VALUES (1, 'live', 'dead_air', ?, ?, 'queue')",
  ).run(serverId, TOKEN).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((p, i) => ins.run(matchId, p, i < 4 ? 'a' : 'b'));
});
afterEach(async () => { await app.close(); });

const list = (as?: string) => app.inject({ method: 'GET', url: '/api/cast', cookies: as ? cookies[as] : undefined });
const views = () => db.prepare("SELECT admin_id, target FROM admin_actions WHERE action = 'cast_connect'").all();

describe('GET /api/cast', () => {
  it('refuses anyone signed out, and players and moderators without the flag', async () => {
    expect((await list()).statusCode).toBe(401);
    expect((await list(PLAYER)).statusCode).toBe(403);
    expect((await list(MOD)).statusCode).toBe(403);
    expect(views()).toEqual([]);
  });

  it('refuses a caster who is banned', async () => {
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(CASTER);
    expect((await list(CASTER)).statusCode).toBe(403);
  });

  it('gives a caster the game server connect line of a live queue match', async () => {
    const res = await list(CASTER);
    expect(res.statusCode).toBe(200);
    const [m] = res.json().matches;
    expect(m).toMatchObject({
      id: matchId,
      campaign: 'dead_air',
      serverName: 'Dallas',
      connect: { host: '1.2.3.4', port: 27015, password: serverPasswordFor(TOKEN) },
      spectate: { host: '1.2.3.4', port: 27020 },
    });
    expect(m.teamA).toHaveLength(4);
    expect(m.teamB).toHaveLength(4);
  });

  it('admins see it too', async () => {
    expect((await list(ADMIN)).json().matches).toHaveLength(1);
  });

  it('carries no password for a match started in game, which runs on the box password', async () => {
    db.prepare("UPDATE matches SET origin = 'in_game' WHERE id = ?").run(matchId);
    const [m] = (await list(CASTER)).json().matches;
    expect(m.connect).toBeNull();
    expect(m.serverName).toBe('Dallas');
  });

  it('lists only live matches', async () => {
    db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(matchId);
    expect((await list(CASTER)).json().matches).toEqual([]);
    expect(views()).toEqual([]);
  });

  it('records who saw which match password, once per match', async () => {
    await list(CASTER);
    await list(CASTER);
    await list(ADMIN);
    expect(views()).toEqual([
      { admin_id: CASTER, target: String(matchId) },
      { admin_id: ADMIN, target: String(matchId) },
    ]);
  });
});

describe('POST /api/admin/players/:steamid/caster', () => {
  const set = (isCaster: unknown, as = ADMIN) =>
    app.inject({ method: 'POST', url: `/api/admin/players/${PLAYER}/caster`, cookies: cookies[as], payload: { isCaster } });

  it('is admin only', async () => {
    expect((await set(true, MOD)).statusCode).toBe(403);
    expect((await set(true, CASTER)).statusCode).toBe(403);
  });

  it('validates the body', async () => {
    expect((await set('yes')).statusCode).toBe(400);
  });

  it('grants and removes the flag, logged, and /api/me reports it', async () => {
    expect((await set(true)).statusCode).toBe(200);
    expect((await list(PLAYER)).statusCode).toBe(401); // the change signed them out
    cookies[PLAYER] = authedCookie(app, db, PLAYER);
    expect((await app.inject({ method: 'GET', url: '/api/me', cookies: cookies[PLAYER] })).json().isCaster).toBe(true);
    expect((await list(PLAYER)).statusCode).toBe(200);

    expect((await set(false)).statusCode).toBe(200);
    cookies[PLAYER] = authedCookie(app, db, PLAYER);
    expect((await list(PLAYER)).statusCode).toBe(403);
    const logged = db.prepare("SELECT detail FROM admin_actions WHERE action = 'set_caster' ORDER BY id").all() as { detail: string }[];
    expect(logged.map((r) => JSON.parse(r.detail))).toEqual([{ isCaster: true }, { isCaster: false }]);
  });
});
