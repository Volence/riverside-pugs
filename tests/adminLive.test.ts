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

  it('a moderator reads the board and can use the abandon clock', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/live', cookies: cookies[MOD] })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/overview', cookies: cookies[MOD] })).statusCode).toBe(200);
    expect((await act({ action: 'hold' }, MOD)).statusCode).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('a moderator may remove from the queue, abort and void, and the audit names them', async () => {
    const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, cookies: cookies[MOD], payload });
    expect((await post('/api/admin/queue/remove', { steamid: IDS[0] })).statusCode).toBe(200);
    const audit = db.prepare("SELECT admin_id FROM admin_actions WHERE action = 'queue_remove'").get() as { admin_id: string };
    expect(audit.admin_id).toBe(MOD);
    // abort and void answer with their own business errors for this fixture;
    // what matters is that the guard let a moderator through (not 401/403).
    expect([401, 403]).not.toContain((await post(`/api/admin/matches/${matchId}/abort`)).statusCode);
    expect([401, 403]).not.toContain((await post(`/api/admin/matches/${matchId}/void`, { reason: 'test' })).statusCode);
  });

  it('server controls stay admin only', async () => {
    const serverId = (db.prepare('SELECT id FROM servers LIMIT 1').get() as { id: number }).id;
    const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, cookies: cookies[MOD], payload });
    for (const [url, body] of [
      [`/api/admin/servers/${serverId}/enabled`, { enabled: false }],
      [`/api/admin/servers/${serverId}/idle`, undefined],
      [`/api/admin/servers/${serverId}/restart-after-match`, { on: true }],
      [`/api/admin/servers/${serverId}/move`, { dir: 'down' }],
      [`/api/admin/servers/${serverId}/log-secret`, undefined],
      [`/api/admin/servers/${serverId}/log-auth`, { mode: 'off' }],
      [`/api/admin/servers/${serverId}/sourcetv`, { enabled: true }],
      ['/api/admin/servers/dlc4-check', undefined],
      ['/api/admin/servers/admins-sync', undefined],
    ] as [string, object | undefined][]) {
      expect((await post(url, body)).statusCode, url).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/admin/settings', cookies: cookies[MOD] })).statusCode).toBe(403);
  });

  it('an admin reorders servers and the overview lists them in pick order', async () => {
    const first = (db.prepare('SELECT id FROM servers LIMIT 1').get() as { id: number }).id;
    const second = addServer(db, { name: 'Chicago', host: '5.6.7.8', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const move = (id: number, dir: string) =>
      app.inject({ method: 'POST', url: `/api/admin/servers/${id}/move`, cookies: cookies[ADMIN], payload: { dir } });
    const order = async () => ((await app.inject({ method: 'GET', url: '/api/admin/overview', cookies: cookies[ADMIN] })).json()
      .servers as { id: number }[]).map((s) => s.id);
    expect(await order()).toEqual([first, second]);
    expect((await move(second, 'up')).statusCode).toBe(200);
    expect(await order()).toEqual([second, first]);
    expect((await move(second, 'up')).statusCode).toBe(409);
    expect((await move(second, 'sideways')).statusCode).toBe(400);
    expect((await audit()).some((a: { action: string }) => a.action === 'server_move')).toBe(true);
  });

  it('staff see the ping table, a player does not', async () => {
    const get = (who: string) => app.inject({ method: 'GET', url: '/api/admin/people/pings', cookies: cookies[who] });
    const res = await get(MOD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hosts: [], players: [], pickByPing: false });
    expect((await get(PLAYER)).statusCode).toBe(403);
  });

  it('a plain player is still refused the board', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/live', cookies: cookies[PLAYER] })).statusCode).toBe(403);
    expect((await act({ action: 'hold' }, PLAYER)).statusCode).toBe(403);
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

  it('says which booking a game belongs to, null for a PUG', async () => {
    const get = async () => (await app.inject({ method: 'GET', url: '/api/admin/live', cookies: cookies[ADMIN] })).json();
    expect((await get()).matches[0].bookingId).toBeNull();
    const booking = Number(db.prepare(
      `INSERT INTO bookings (purpose, starts_at, ends_at, state, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
       VALUES ('scrim', '2026-10-01T20:00:00.000Z', '2026-10-01T22:00:00.000Z', 'active', 'pw', 'tvpw', 'pug_match', '{}', '["no_mercy"]', ?, '2026-10-01T19:00:00.000Z')`,
    ).run(ADMIN).lastInsertRowid);
    db.prepare('UPDATE matches SET booking_id = ? WHERE id = ?').run(booking, matchId);
    expect((await get()).matches[0].bookingId).toBe(booking);
  });
});

describe('POST /api/admin/live/:matchId/noshow-extend', () => {
  const extend = (as = ADMIN, id = matchId) =>
    app.inject({ method: 'POST', url: `/api/admin/live/${id}/noshow-extend`, cookies: cookies[as] });
  const board = async () => (await app.inject({ method: 'GET', url: '/api/admin/live', cookies: cookies[ADMIN] })).json().matches[0];
  beforeEach(() => {
    // Went live two minutes ago; three of eight are in, five never connected.
    db.prepare("UPDATE matches SET went_live_at = datetime('now', '-2 minutes') WHERE id = ?").run(matchId);
    for (const p of IDS.slice(0, 3)) db.prepare("UPDATE match_players SET connected_at = datetime('now') WHERE match_id = ? AND player_id = ?").run(matchId, p);
    setSetting(db, 'noshow_minutes', '7');
  });

  it('is staff only, and a moderator may use it', async () => {
    expect((await extend(PLAYER)).statusCode).toBe(403);
    expect((await extend(MOD)).statusCode).toBe(200);
  });

  it('moves the whole match\'s deadline five minutes, audited, and the board counts down to the new one', async () => {
    const before = await board();
    const nc = before.teamB.find((p: { status: { kind: string } }) => p.status.kind === 'never_connected');
    expect(nc.status.deadlineS).toBeGreaterThan(4 * 60);
    expect(nc.status.deadlineS).toBeLessThanOrEqual(5 * 60);
    expect(before.noShow).toMatchObject({ extraMinutes: 0, canExtend: true });

    const res = await extend();
    expect(res.json()).toEqual({ ok: true, extraMinutes: 5 });
    const after = await board();
    const nc2 = after.teamB.find((p: { status: { kind: string } }) => p.status.kind === 'never_connected');
    expect(nc2.status.deadlineS).toBeGreaterThan(9 * 60);
    expect((await audit())[0]).toMatchObject({ action: 'noshow_extend', target: String(matchId), detail: { extraMinutes: 5 } });
  });

  it('stops at thirty minutes in total', async () => {
    for (let i = 0; i < 6; i++) expect((await extend()).statusCode).toBe(200);
    const res = await extend();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/30 minutes/);
  });

  it('refuses once a round has been played, or when everyone has connected', async () => {
    db.prepare("UPDATE match_players SET connected_at = datetime('now') WHERE match_id = ?").run(matchId);
    expect((await extend()).statusCode).toBe(409);
    db.prepare("UPDATE match_players SET connected_at = NULL WHERE match_id = ? AND player_id = ?").run(matchId, IDS[7]);
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (?, 0, 1, 'a')").run(matchId);
    expect((await extend()).statusCode).toBe(409);
  });

  it('refuses once enough have connected that the no-show rule cannot fire, and the board says so', async () => {
    // Six of eight in, the default noshow_min_connected: two still missing,
    // but the rule is off, so five more minutes would move nothing.
    for (const p of IDS.slice(3, 6)) db.prepare("UPDATE match_players SET connected_at = datetime('now') WHERE match_id = ? AND player_id = ?").run(matchId, p);
    expect((await board()).noShow).toMatchObject({ deadlineS: null, canExtend: false });
    const res = await extend();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/enough players have connected/);
  });
});

describe('POST /api/admin/queue/cancel-pop', () => {
  const cancel = (payload: object, as = ADMIN) =>
    app.inject({ method: 'POST', url: '/api/admin/queue/cancel-pop', cookies: cookies[as], payload });
  const LOBBY = Array.from({ length: 8 }, (_, i) => `7656119900000010${i}`);
  beforeEach(async () => {
    // The live match's roster is busy, so a fresh eight fill the pop.
    for (const id of LOBBY) cookies[id] = authedCookie(app, db, id);
    for (const id of LOBBY) await app.inject({ method: 'POST', url: '/api/queue/join', cookies: cookies[id] });
  });

  it('is staff only', async () => {
    expect((await cancel({}, PLAYER)).statusCode).toBe(403);
  });

  it('cancels the pop, leaves the excluded out, requeues the rest, and shows the pop on the overview first', async () => {
    const overview = (await app.inject({ method: 'GET', url: '/api/admin/overview', cookies: cookies[MOD] })).json();
    expect(overview.lobbies).toHaveLength(1);
    expect(overview.lobbies[0]).toMatchObject({ phase: 'ready_check' });
    expect(overview.lobbies[0].players).toHaveLength(8);

    const res = await cancel({ exclude: [LOBBY[4]] }, MOD);
    expect(res.statusCode).toBe(200);
    expect(res.json().excluded).toEqual([LOBBY[4]]);
    const q = (await app.inject({ method: 'GET', url: '/api/queue' })).json();
    expect(q.count).toBe(7);
    expect(q.players.map((p: { steamid: string }) => p.steamid)).not.toContain(LOBBY[4]);
    expect((await audit())[0]).toMatchObject({ action: 'cancel_pop', detail: { requeued: 7, excluded: [LOBBY[4]] } });
  });

  it('409s with nothing to cancel, and 400s on a bad body', async () => {
    expect((await cancel({ exclude: 'x' })).statusCode).toBe(400);
    expect((await cancel({ exclude: [LOBBY[0], LOBBY[1]] })).statusCode).toBe(200);
    expect((await cancel({})).statusCode).toBe(409);
  });
});

describe('aborting from the admin panel', () => {
  const abort = (payload: object = {}, id = matchId) =>
    app.inject({ method: 'POST', url: `/api/admin/matches/${id}/abort`, cookies: cookies[ADMIN], payload });
  const noShows = () => (db.prepare("SELECT COUNT(*) AS n FROM penalties WHERE kind = 'no_show' AND cleared_at IS NULL").get() as { n: number }).n;

  it('tells every player and puts them back at the front of the queue', async () => {
    expect((await abort()).statusCode).toBe(200);
    // Eight back at the front is a full queue, so they are straight into a
    // fresh ready check together.
    const state = (await app.inject({ method: 'GET', url: '/api/state', cookies: cookies[IDS[0]] })).json();
    expect(state.lobby).toMatchObject({ phase: 'ready_check' });
    expect(state.lobby.players).toHaveLength(8);
    expect(state.abortNotice).toMatchObject({ matchId, cause: 'admin', role: 'innocent', requeued: true });
    // Dismissed, it stays gone across a reload.
    await app.inject({ method: 'POST', url: '/api/match/dismiss-abort-notice', cookies: cookies[IDS[0]] });
    expect((await app.inject({ method: 'GET', url: '/api/state', cookies: cookies[IDS[0]] })).json().abortNotice).toBeNull();
  });

  // Requeueing all eight at the front re-pops the same lobby at once, with the
  // player staff are about to ban in it. Ticked players are told but stay out.
  it('leaves out whoever staff tick, tells them anyway, and requeues the rest', async () => {
    const overview = (await app.inject({ method: 'GET', url: '/api/admin/overview', cookies: cookies[ADMIN] })).json();
    expect(overview.open[0].roster).toHaveLength(8);
    expect(overview.open[0].roster[0]).toEqual({ steamid: expect.any(String), name: expect.any(String) });
    const res = await abort({ leaveOut: [IDS[3]] });
    expect(res.json()).toEqual({ ok: true });
    const q = (await app.inject({ method: 'GET', url: '/api/queue' })).json();
    expect(q.count).toBe(7);
    expect(q.players.map((p: { steamid: string }) => p.steamid)).not.toContain(IDS[3]);
    const left = (await app.inject({ method: 'GET', url: '/api/state', cookies: cookies[IDS[3]] })).json();
    expect(left.abortNotice).toMatchObject({ matchId, cause: 'admin', role: 'innocent', requeued: false });
    expect((await audit())[0]).toMatchObject({ action: 'abort_match', detail: { leftOut: [IDS[3]] } });
  });

  it('400s on a bad leave-out list, before it aborts anything', async () => {
    expect((await abort({ leaveOut: 'x' })).statusCode).toBe(400);
    expect((await abort({ leaveOut: [1] })).statusCode).toBe(400);
    expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId)).toEqual({ state: 'live' });
  });

  // Only the no-show reaper hands out no-shows, and it does so as it aborts,
  // so a match an admin can still abort has none of its own: the abort does
  // not touch penalties, and the Aborted list's button clears them after.
  it('leaves penalties alone, and clears an aborted match\'s no-shows after the fact', async () => {
    const other = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'aborted', 'dead_air')").run().lastInsertRowid);
    const pen = db.prepare("INSERT INTO penalties (player_id, kind, match_id, created_at) VALUES (?, 'no_show', ?, ?)");
    pen.run(IDS[7], other, new Date().toISOString());
    expect((await abort({ clearNoShows: true })).json()).toEqual({ ok: true });
    expect(noShows()).toBe(1);
    expect((await audit())[0]).toMatchObject({ action: 'abort_match', detail: { leftOut: [] } });
    const res = await app.inject({ method: 'POST', url: `/api/admin/matches/${other}/clear-noshows`, cookies: cookies[MOD] });
    expect(res.json()).toEqual({ ok: true, cleared: [IDS[7]] });
    expect(noShows()).toBe(0);
  });

  it('clears one penalty from a player file, and only that one', async () => {
    const pen = db.prepare("INSERT INTO penalties (player_id, kind, match_id, created_at) VALUES (?, ?, NULL, ?)");
    const a = Number(pen.run(IDS[1], 'no_show', new Date().toISOString()).lastInsertRowid);
    pen.run(IDS[1], 'ready_fail', new Date().toISOString());
    const clear = (who: string, id: number) =>
      app.inject({ method: 'POST', url: `/api/admin/players/${who}/penalties/${id}/clear`, cookies: cookies[ADMIN] });
    expect((await clear(IDS[2], a)).statusCode).toBe(404);
    expect((await clear(IDS[1], a)).statusCode).toBe(200);
    expect((await clear(IDS[1], a)).statusCode).toBe(404);
    expect(db.prepare('SELECT kind FROM penalties WHERE player_id = ? AND cleared_at IS NULL').all(IDS[1])).toEqual([{ kind: 'ready_fail' }]);
    expect((await audit())[0]).toMatchObject({ action: 'clear_penalty', target: IDS[1], detail: { penaltyId: a } });
  });
});
