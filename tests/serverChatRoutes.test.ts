import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { recordSay } from '../src/serverChat.js';
import { Hub } from '../src/ws.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 3 }, (_, i) => `7656119900000000${i}`);
const [MOD, PLAYER, TARGET] = IDS;
let db: DB;
let app: FastifyInstance;
let sid: number;
let sent: string[];
let rconReply: string;
let rconFails: boolean;
let hub: Hub;
let heard: Record<string, string[]>;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  sent = [];
  rconReply = '';
  rconFails = false;
  hub = new Hub();
  heard = {};
  for (const id of IDS) {
    heard[id] = [];
    hub.add({ readyState: 1, send: (m: string) => heard[id].push(JSON.parse(m).event) }, id);
  }
  app = await buildServer({
    hub,
    config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    chatRcon: async (_s, cmds) => { sent.push(...cmds); if (rconFails) throw new Error('rcon connect timeout'); return [rconReply]; },
  });
  for (const id of IDS) cookie[id] = authedCookie(app, db, id);
  db.prepare("UPDATE players SET is_mod = 1, name = 'Mod Person' WHERE steamid = ?").run(MOD);
  db.prepare("UPDATE players SET name = 'Target' WHERE steamid = ?").run(TARGET);
  sid = Number(db.prepare(
    "INSERT INTO servers (name, host, port, rcon_port, rcon_password, tv_port, tv_enabled) VALUES ('Dallas', '1.2.3.4', 27015, 27015, 'x', 27020, 1)",
  ).run().lastInsertRowid);
});
afterEach(async () => { await app.close(); });

const get = (as: string | null, url: string) => app.inject({ method: 'GET', url, cookies: as ? cookie[as] : undefined });
const send = (as: string, body: unknown) => app.inject({ method: 'POST', url: `/api/mod/chat/${sid}`, cookies: cookie[as], payload: body as object });

describe('server chat routes', () => {
  it('are staff only', async () => {
    expect((await get(null, '/api/mod/chat/servers')).statusCode).toBe(401);
    expect((await get(PLAYER, '/api/mod/chat/servers')).statusCode).toBe(403);
    expect((await get(PLAYER, `/api/mod/chat/${sid}`)).statusCode).toBe(403);
    expect((await send(PLAYER, { to: 'all', message: 'x' })).statusCode).toBe(403);
    expect(sent).toEqual([]);
  });

  it('a banned moderator is refused', async () => {
    db.prepare("INSERT INTO bans (player_id, created_by, reason, created_at) VALUES (?, 'system', 'x', datetime('now'))").run(MOD);
    expect((await get(MOD, '/api/mod/chat/servers')).statusCode).toBe(403);
  });

  it('lists servers and lines', async () => {
    recordSay(db, sid, { steamid: PLAYER, team: 2, scope: 'team', message: 'rush' });
    const servers = (await get(MOD, '/api/mod/chat/servers')).json();
    expect(servers.servers).toEqual([{ id: sid, name: 'Dallas', state: expect.any(String), lastAt: expect.any(Number) }]);
    const body = (await get(MOD, `/api/mod/chat/${sid}`)).json();
    expect(body.server).toEqual({ id: sid, name: 'Dallas' });
    expect(body.lines[0]).toMatchObject({ kind: 'say', steamid: PLAYER, team: 2, scope: 'team', message: 'rush', to: null });
  });

  it('404s an unknown server', async () => {
    expect((await get(MOD, '/api/mod/chat/999')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/mod/chat/999', cookies: cookie[MOD], payload: { to: 'all', message: 'x' } })).statusCode).toBe(404);
  });

  it('sends a whisper signed with the site name, cleaned', async () => {
    const r = await send(MOD, { to: 'player', steamid: TARGET, message: 'hi"; quit' });
    expect(r.statusCode).toBe(200);
    expect(sent).toEqual([`sm_pug_staffsay ${TARGET} "Mod Person" "hi quit" ${r.json().id}`]);
    const line = (await get(MOD, `/api/mod/chat/${sid}`)).json().lines[0];
    expect(line).toMatchObject({ kind: 'staff_out', name: 'Mod Person', to: { kind: 'player', value: TARGET, name: 'Target' } });
  });

  it('refuses a bad body', async () => {
    expect((await send(MOD, { to: 'all', message: ' ; ' })).statusCode).toBe(400);
    expect((await send(MOD, { to: 'team', team: 4, message: 'x' })).statusCode).toBe(400);
    expect((await send(MOD, { to: 'player', steamid: '123', message: 'x' })).statusCode).toBe(400);
    expect((await send(MOD, { to: 'everyone', message: 'x' })).statusCode).toBe(400);
    expect(sent).toEqual([]);
  });

  it('rate limits at 5 per 10 s', async () => {
    for (let i = 0; i < 5; i++) expect((await send(MOD, { to: 'all', message: `m${i}` })).statusCode).toBe(200);
    const r = await send(MOD, { to: 'all', message: 'too many' });
    expect(r.statusCode).toBe(429);
    expect(sent).toHaveLength(5);
  });

  it('502s with the reason on an old plugin', async () => {
    rconReply = 'Unknown command "sm_pug_staffsay"';
    const r = await send(MOD, { to: 'all', message: 'x' });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe('This server needs pug-match 0.3.16 to send.');
  });

  it('tells every staff drawer after a send, once, and only staff', async () => {
    const other = IDS[2];
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(other);
    expect((await send(MOD, { to: 'all', message: 'one' })).statusCode).toBe(200);
    expect(heard[MOD].filter((e) => e === 'server_chat')).toHaveLength(1);
    expect(heard[other].filter((e) => e === 'server_chat')).toHaveLength(1);
    expect(heard[PLAYER].filter((e) => e === 'server_chat')).toHaveLength(0);
  });

  it('tells staff drawers after a failed send too', async () => {
    rconReply = 'Unknown command "sm_pug_staffsay"';
    expect((await send(MOD, { to: 'all', message: 'x' })).statusCode).toBe(502);
    expect(heard[MOD].filter((e) => e === 'server_chat')).toHaveLength(1);
  });

  it('does not notify for a refused send', async () => {
    expect((await send(MOD, { to: 'all', message: ' ; ' })).statusCode).toBe(400);
    expect(heard[MOD].filter((e) => e === 'server_chat')).toHaveLength(0);
  });

  describe('players on the server now', () => {
    const STATUS = `hostname: Dallas
# userid name uniqueid connected ping loss state rate adr
#  2 1 "Mal" STEAM_1:1:35074132 01:12 33 0 active 128000 192.168.4.85:27005
# 3 "Bill" BOT active
#  3 2 "lan" STEAM_ID_LAN 00:04 5 0 active 30000 loopback
# 11 5 "a "quoted" name" STEAM_1:0:7 1:02:03 120 4 spawning 30000 10.1.1.1:27005
#end`;
    const players = (as: string | null, id: number | string = sid) => get(as, `/api/mod/chat/${id}/players`);

    it('is staff only', async () => {
      expect((await players(null)).statusCode).toBe(401);
      expect((await players(PLAYER)).statusCode).toBe(403);
      expect(sent).toEqual([]);
    });

    it('404s an unknown server without calling rcon', async () => {
      expect((await players(MOD, 999)).statusCode).toBe(404);
      expect(sent).toEqual([]);
    });

    it('reads humans with a SteamID64 from status', async () => {
      rconReply = STATUS;
      const r = await players(MOD);
      expect(r.statusCode).toBe(200);
      expect(sent).toEqual(['status']);
      expect(r.json()).toEqual({ players: [
        { steamid: '76561198030413993', name: 'Mal' },
        { steamid: '76561197960265742', name: 'a "quoted" name' },
      ] });
    });

    it('502s when the server cannot be reached', async () => {
      rconFails = true;
      const r = await players(MOD);
      expect(r.statusCode).toBe(502);
      expect(r.json()).toEqual({ error: 'Could not reach the server.' });
    });
  });
});
