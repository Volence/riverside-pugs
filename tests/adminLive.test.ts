import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { getPresence, recordPresenceLine } from '../src/presence.js';
import { serverPasswordFor } from '../src/matchToken.js';
import { setSetting } from '../src/settings.js';
import { AdminFeedPoster } from '../src/discord/adminFeedPoster.js';
import { FakeTransport } from './fakes/fakeTransport.js';
import { adminRoutes } from '../src/routes/admin.js';
import type { Matchmaker } from '../src/matchmaker.js';
import type { ServerReleaser } from '../src/serverRelease.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const ADMIN = '76561199000000091';
const PLAYER = '76561199000000092';
/** Staff, but not an admin: tickets are theirs, the live board is not. */
const MOD = '76561199000000093';
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
  for (const id of [...IDS, ADMIN, PLAYER, MOD]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1, is_admin = 0 WHERE steamid = ?').run(MOD);
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

  it('a command that cannot even be built is not reported as a box being down', async () => {
    // leaveCommand asserts its arguments, and a throw from it means one of our
    // own tables holds something that must never become a console line. Built
    // inside the try it came back as "could not reach Dallas" with a 502,
    // which sends an admin to look at a box that was never dialled. Outside it
    // the app's own error handler answers 500 and puts the real message in the
    // server log, which is where a bug in our tables belongs.
    db.prepare("UPDATE matches SET token = 'not-a-token' WHERE id = ?").run(matchId);
    const res = await act({ action: 'hold' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).not.toMatch(/could not reach/);
    expect(sent).toEqual([]);
  });

  it('releases and ends through the same route, in the plugin\'s own words', async () => {
    answer = `PUGOK leave steamid=${DROPPED} absent=1 remaining=200 held=0 hold_left=0`;
    expect((await act({ action: 'release' })).statusCode).toBe(200);
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ remaining_s: 200, held: 0 });

    answer = `PUGOK leave steamid=${DROPPED} absent=1 remaining=0 held=0 hold_left=0`;
    expect((await act({ action: 'end' })).statusCode).toBe(200);
    expect(sent).toEqual([
      `sm_pug_leave ${TOKEN} ${DROPPED} release`,
      `sm_pug_leave ${TOKEN} ${DROPPED} end`,
    ]);
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ remaining_s: 0 });
    expect((await audit()).map((a: { detail: { action: string } }) => a.detail.action)).toEqual(['end', 'release']);
  });

  it('409s while the match has no server yet', async () => {
    db.prepare("UPDATE matches SET state = 'configuring', server_id = NULL WHERE id = ?").run(matchId);
    const res = await act({ action: 'hold' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/no server yet/);
    expect(sent).toEqual([]);
  });

  it('a moderator is not an admin here: refused by both routes, and nothing is dialled', async () => {
    // is_mod opens tickets, not the board that can end a ranked match.
    expect((await act({ action: 'hold' }, MOD)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/live', cookies: cookies[MOD] })).statusCode).toBe(403);
    expect(sent).toEqual([]);
  });

  it('says so plainly where no server query is wired up at all', async () => {
    // buildServer always supplies one, so this is the shape of an install
    // that registers the admin routes without it: the route must answer 503
    // rather than throw on an undefined.
    const bare = Fastify();
    await bare.register(cookie, { secret: loadConfig({}).cookieSecret });
    await bare.register(adminRoutes, {
      db, matchmaker: {} as unknown as Matchmaker, releaser: {} as unknown as ServerReleaser,
      broadcast: () => {}, adminSteamIds: [],
    });
    await bare.ready();
    try {
      const res = await bare.inject({
        method: 'POST', url: `/api/admin/live/${matchId}/players/${DROPPED}/leave`,
        cookies: authedCookie(bare, db, ADMIN), payload: { action: 'hold' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatch(/not available here/);
    } finally {
      await bare.close();
    }
  });

  it('an answer about somebody else is not believed', async () => {
    answer = `PUGOK leave steamid=${IDS[5]} absent=1 remaining=1 held=1 hold_left=9`;
    expect((await act({ action: 'hold' })).statusCode).toBe(409);
    expect(getPresence(db, matchId, DROPPED)).toMatchObject({ remaining_s: 210, held: 0 });
  });
});

describe('a failure never carries the match secret out of the process', () => {
  let transport: FakeTransport;
  let feed: AdminFeedPoster;
  beforeEach(() => {
    setSetting(db, 'discord_admin_channel_id', 'admins');
    transport = new FakeTransport();
    feed = new AdminFeedPoster({ db, transport, publicUrl: 'https://pug.test' });
    feed.start();
  });
  afterEach(() => feed.stop());

  it('redacts the token, which is the live match\'s server password, from the reply, the audit row and the feed', async () => {
    // RconClient.exec names the command it gave up on, and that command
    // carries the match token: `rcon exec timeout: sm_pug_leave <token> ...`.
    answer = new Error(`rcon exec timeout: sm_pug_leave ${TOKEN} ${DROPPED} hold`);
    const res = await act({ action: 'hold' });
    await feed.idle();

    const detail = (db.prepare('SELECT detail FROM admin_actions ORDER BY id DESC LIMIT 1').get() as { detail: string }).detail;
    const posted = JSON.stringify(transport.messages.map((m) => m.payload));
    expect(res.statusCode).toBe(502);
    for (const seen of [res.body, detail, posted]) {
      expect(seen).not.toContain(TOKEN);
      expect(seen).not.toContain(serverPasswordFor(TOKEN));
    }
    // Still says what happened, on all three.
    expect(res.json().error).toContain('could not reach Dallas: rcon exec timeout');
    expect(detail).toContain('rcon exec timeout');
    expect(posted).toContain('rcon exec timeout');
  });

  it('redacts it from an unexpected console answer as well', async () => {
    answer = `L 09/21/2026 - 20:00:00: rcon from "1.2.3.4:51000": command "sm_pug_leave ${TOKEN} ${DROPPED} hold"`;
    const res = await act({ action: 'hold' });
    await feed.idle();
    const detail = (db.prepare('SELECT detail FROM admin_actions ORDER BY id DESC LIMIT 1').get() as { detail: string }).detail;
    expect(res.statusCode).toBe(409);
    for (const seen of [res.body, detail, JSON.stringify(transport.messages.map((m) => m.payload))]) {
      expect(seen).not.toContain(TOKEN);
      expect(seen).not.toContain(serverPasswordFor(TOKEN));
    }
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
