import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { getPresence, recordPresenceLine } from '../src/presence.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const ADMIN = '76561199000000091';
const PLAYER = '76561199000000092';
const TOKEN = 'a'.repeat(32);
const DROPPED = IDS[2];

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;
let sent: string[];
let answer: string | Error;
let matchId: number;

beforeEach(async () => {
  db = openDb(':memory:');
  sent = [];
  answer = `PUGOK leave steamid=${DROPPED} absent=1 remaining=200 held=1 hold_left=1800`;
  app = await buildServer({
    config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    serverQuery: async (_server, command) => {
      sent.push(command);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  cookies = {};
  for (const id of [...IDS, ADMIN, PLAYER]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  const serverId = addServer(db, { name: 'Dallas', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (1, 'live', 'dead_air', ?, ?)").run(serverId, TOKEN).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((p, i) => ins.run(matchId, p, i < 4 ? 'a' : 'b'));
  recordPresenceLine(db, { kind: 'leave', token: TOKEN, steamid: DROPPED, remaining: 210 });
});
afterEach(async () => { await app.close(); });

const act = (payload: object, as = ADMIN, steamid = DROPPED, id = matchId) =>
  app.inject({ method: 'POST', url: `/api/admin/live/${id}/players/${steamid}/leave`, cookies: cookies[as], payload });
const audit = async () => (await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: cookies[ADMIN] })).json().actions;

describe('POST /api/admin/live/:matchId/players/:steamid/leave', () => {
  it('is admin only, and refuses before it dials anything', async () => {
    expect((await act({ action: 'hold' }, PLAYER)).statusCode).toBe(403);
    expect(sent).toEqual([]);
  });

  it('validates the body', async () => {
    expect((await act({ action: 'pause' })).statusCode).toBe(400);
    expect((await act({ action: 'add' })).statusCode).toBe(400);
    expect((await act({ action: 'add', seconds: 3601 })).statusCode).toBe(400);
    expect(sent).toEqual([]);
  });

  it('404s for an id off the roster and for a match that does not exist', async () => {
    expect((await act({ action: 'hold' }, ADMIN, PLAYER)).statusCode).toBe(404);
    expect((await act({ action: 'hold' }, ADMIN, DROPPED, 9999)).statusCode).toBe(404);
  });

  it('409s for a match that is over', async () => {
    db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(matchId);
    expect((await act({ action: 'hold' })).statusCode).toBe(409);
  });

  it('holds: sends the command, believes the answer, logs it, remembers the plugin is new enough', async () => {
    const res = await act({ action: 'hold' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, state: { absent: true, remaining: 200, held: true, holdLeft: 1800 } });
    expect(sent).toEqual([`sm_pug_leave ${TOKEN} ${DROPPED} hold`]);
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ state: 'dropped', remaining_s: 200, held: 1 });
    expect((db.prepare('SELECT leave_control FROM matches WHERE id = ?').get(matchId) as { leave_control: number }).leave_control).toBe(1);
    expect((await audit())[0]).toMatchObject({ action: 'leave_clock', target: DROPPED, detail: { matchId, action: 'hold', ok: true, remaining: 200, held: true } });
  });

  it('adds five minutes', async () => {
    answer = `PUGOK leave steamid=${DROPPED} absent=1 remaining=510 held=0 hold_left=0`;
    expect((await act({ action: 'add', seconds: 300 })).statusCode).toBe(200);
    expect(sent).toEqual([`sm_pug_leave ${TOKEN} ${DROPPED} add 300`]);
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ remaining_s: 510, held: 0 });
  });

  it('a refusal changes nothing and comes back in the plugin\'s words', async () => {
    answer = 'PUGERR not dropped';
    const res = await act({ action: 'hold' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'refused' });
    expect(res.json().error).toContain('not dropped');
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ remaining_s: 210, held: 0 });
    expect((await audit())[0]).toMatchObject({ action: 'leave_clock', detail: { ok: false, error: 'not dropped' } });
  });

  it('an old plugin is recognised, remembered, and changes nothing', async () => {
    answer = 'Unknown command "sm_pug_leave"';
    const res = await act({ action: 'hold' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'old_plugin' });
    expect(res.json().error).toMatch(/older than 0\.3\.4/);
    expect((db.prepare('SELECT leave_control FROM matches WHERE id = ?').get(matchId) as { leave_control: number }).leave_control).toBe(0);
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ held: 0 });
  });

  it('an unreachable server is a 502 that changes nothing', async () => {
    answer = new Error('rcon connect timeout');
    const res = await act({ action: 'hold' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/could not reach Dallas: rcon connect timeout/);
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ remaining_s: 210, held: 0 });
  });

  it('an answer about somebody else is not believed', async () => {
    answer = `PUGOK leave steamid=${IDS[5]} absent=1 remaining=1 held=1 hold_left=9`;
    expect((await act({ action: 'hold' })).statusCode).toBe(409);
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ remaining_s: 210, held: 0 });
  });
});

describe('GET /api/admin/live', () => {
  it('is admin only', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/live', cookies: cookies[PLAYER] })).statusCode).toBe(403);
  });

  it('shows the dropped player, and shows the hold the moment the plugin confirms it', async () => {
    const get = async () => (await app.inject({ method: 'GET', url: '/api/admin/live', cookies: cookies[ADMIN] })).json();
    const before = await get();
    expect(before.matches).toHaveLength(1);
    expect(before.matches[0].teamA.find((p: { steamid: string }) => p.steamid === DROPPED).status).toMatchObject({ kind: 'dropped', held: false });
    await act({ action: 'hold' });
    const after = await get();
    expect(after.matches[0].teamA.find((p: { steamid: string }) => p.steamid === DROPPED).status).toMatchObject({ kind: 'dropped', held: true, remainingS: 200 });
    expect(after.matches[0].leaveControl).toBe('ok');
  });
});
