import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { completeMatch } from '../src/matchResult.js';
import { recomputeSeasonRatings } from '../src/rating.js';
import { addServer, markLive, serversMissingDlc4 } from '../src/serverPool.js';
import type { Dump } from '../src/dumpParse.js';
import { authedCookie, stubOrchestrator, watchCauselessAborts } from './helpers.js';
import { recordPhase } from '../src/liveView.js';
import { abortMatch } from '../src/admin/matches.js';
import { ServerReleaser } from '../src/serverRelease.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);
const ADMIN = IDS[0];

let db: DB;
let app: FastifyInstance;
let admin: Record<string, string>;

function play(winner: 'a' | 'b', order: string[] = IDS): number {
  const matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'dead_air')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  order.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  const dump: Dump = {
    matchId, maps: [{ map: 'm1', a: winner === 'a' ? 300 : 200, b: winner === 'b' ? 300 : 200 }],
    players: order.map((steamid, i) => ({ steamid, team: i < 4 ? 'a' : 'b', sidmg: 1, sikill: 1, ck: 1, ff: 0, rev: 0 })),
    skillDetect: false, skills: [], winner, totalA: winner === 'a' ? 300 : 200, totalB: winner === 'b' ? 300 : 200,
  };
  completeMatch(db, matchId, dump);
  return matchId;
}

const ratings = () => db.prepare('SELECT player_id, mu, sigma, wins, losses FROM player_ratings ORDER BY player_id').all();
const history = () => db.prepare('SELECT player_id, match_id, mu_before, mu_after FROM rating_history ORDER BY match_id, player_id').all();

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) authedCookie(app, db, id);
  admin = authedCookie(app, db, ADMIN);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
});
afterEach(async () => { await app.close(); });

const post = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, cookies: admin, payload });

describe('recomputeSeasonRatings', () => {
  it('reproduces the incremental ratings exactly', () => {
    play('a');
    play('b', [...IDS].reverse());
    play('a', [IDS[0], IDS[5], IDS[2], IDS[7], IDS[4], IDS[1], IDS[6], IDS[3]]);
    const r = ratings();
    const h = history();
    recomputeSeasonRatings(db, 1);
    expect(ratings()).toEqual(r);
    expect(history()).toEqual(h);
  });
});

describe('admin matches', () => {
  it('overview lists open matches, servers, the queue and recent completed', async () => {
    addServer(db, { name: 's1', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'idle' });
    const done = play('a');
    await app.inject({ method: 'POST', url: '/api/queue/join', cookies: authedCookie(app, db, IDS[3]) });
    const o = (await app.inject({ method: 'GET', url: '/api/admin/overview', cookies: admin })).json();
    expect(o.servers[0]).toMatchObject({ name: 's1', status: 'idle' });
    expect(o.recent[0]).toMatchObject({ id: done });
    expect(o.queue.map((p: { steamid: string }) => p.steamid)).toEqual([IDS[3]]);
    expect(o.open).toEqual([]);
    expect(JSON.stringify(o)).not.toContain('rcon');
  });

  it('overview tells an ordinary open match apart from a booking game by bookingId', async () => {
    const serverId = addServer(db, { name: 's2', host: '1.2.3.5', port: 27016, rconPort: 27016, rconPassword: 'x', status: 'live' });
    const booking = holdForBooking(db, serverId);
    const plain = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'dead_air')").run().lastInsertRowid);
    const booked = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, booking_id) VALUES (1, 'live', 'dead_air', ?, 'tok-o', 'in_game', 'scrim', 'participants', ?)",
    ).run(serverId, booking).lastInsertRowid);
    const o = (await app.inject({ method: 'GET', url: '/api/admin/overview', cookies: admin })).json();
    expect(o.open.find((m: { id: number }) => m.id === plain).bookingId).toBeNull();
    expect(o.open.find((m: { id: number }) => m.id === booked).bookingId).toBe(booking);
  });

  it('overview lists each recent match\'s pauses, for when a team complains about the other side\'s', async () => {
    const token = 'c'.repeat(32);
    const matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'dead_air', ?)").run(token).lastInsertRowid);
    const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
    IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
    recordPhase(db, token, { state: 'paused', team: 'b', limit: 120, leave: false, unready: [] });
    recordPhase(db, token, { state: 'live', team: null, limit: 0, leave: false, unready: [] });
    recordPhase(db, token, { state: 'paused', team: null, limit: 0, leave: true, unready: [] });
    recordPhase(db, token, { state: 'live', team: null, limit: 0, leave: false, unready: [] });
    recordPhase(db, token, { state: 'readyup', team: null, limit: 0, leave: false, unready: [IDS[5]] });
    recordPhase(db, token, { state: 'live', team: null, limit: 0, leave: false, unready: [] });
    const dump: Dump = {
      matchId, maps: [{ map: 'm1', a: 300, b: 200 }],
      players: IDS.map((steamid, i) => ({ steamid, team: i < 4 ? 'a' : 'b', sidmg: 1, sikill: 1, ck: 1, ff: 0, rev: 0 })),
      skillDetect: false, skills: [], winner: 'a', totalA: 300, totalB: 200,
    };
    completeMatch(db, matchId, dump);

    const o = (await app.inject({ method: 'GET', url: '/api/admin/overview', cookies: admin })).json();
    expect(o.recent[0].id).toBe(matchId);
    expect(o.recent[0].pauses).toMatchObject([
      { team: 'b', leave: false, mapOrdinal: 0 },
      { team: null, leave: true, mapOrdinal: 0 },
    ]);
    expect(typeof o.recent[0].pauses[0].seconds).toBe('number');
    // Ready-ups ride along the same way, and the slow-to-ready table covers
    // every completed match so a repeat offender stands out.
    expect(o.recent[0].readyups).toMatchObject([{ lastUnready: [IDS[5]] }]);
    expect(typeof o.recent[0].readyups[0].seconds).toBe('number');
    expect(o.slowToReady).toMatchObject([{ steamid: IDS[5], readyups: 1, timesLast: 1 }]);
    // Capture health moved here from the People queue, beside the servers.
    expect(o.captureHealth).toMatchObject({ bursts: 0, detections: 0, lilacFlags: 0 });
  });

  it('void needs a reason, drops the match, recomputes later ratings, and is audited', async () => {
    const first = play('a');
    play('b');
    const withBoth = ratings();
    expect((await post(`/api/admin/matches/${first}/void`, {})).statusCode).toBe(400);
    expect((await post(`/api/admin/matches/${first}/void`, { reason: 'wrong teams' })).statusCode).toBe(200);
    const m = db.prepare('SELECT state, voided_at, void_reason FROM matches WHERE id = ?').get(first) as { state: string; voided_at: string; void_reason: string };
    expect(m.state).toBe('aborted');
    expect(m.void_reason).toBe('wrong teams');
    expect(m.voided_at).toBeTruthy();
    expect(ratings()).not.toEqual(withBoth);
    expect(history().some((x: any) => x.match_id === first)).toBe(false);
    // Player 0 now has exactly one result: the loss.
    expect(db.prepare('SELECT wins, losses FROM player_ratings WHERE player_id = ?').get(IDS[0])).toEqual({ wins: 0, losses: 1 });
    const audit = (await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: admin })).json();
    expect(audit.actions[0]).toMatchObject({ action: 'void_match', target: String(first) });
  });

  it('only a completed match can be voided', async () => {
    const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'dead_air')").run().lastInsertRowid);
    expect((await post(`/api/admin/matches/${id}/void`, { reason: 'x' })).statusCode).toBe(409);
  });

  it('abort ends an open match, frees its server and clears live scratch', async () => {
    const serverId = addServer(db, { name: 's1', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
    const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (1, 'live', 'dead_air', ?, 'tok')").run(serverId).lastInsertRowid);
    db.prepare("INSERT INTO match_live (match_id, last_seen) VALUES (?, datetime('now'))").run(id);
    expect((await post(`/api/admin/matches/${id}/abort`)).statusCode).toBe(200);
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(id) as { state: string }).state).toBe('aborted');
    expect((db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId) as { status: string }).status).toBe('idle');
    expect(db.prepare('SELECT 1 FROM match_live WHERE match_id = ?').get(id)).toBeUndefined();
    expect((await post(`/api/admin/matches/${id}/abort`)).statusCode).toBe(409);
  });

  it('set a server idle', async () => {
    const serverId = addServer(db, { name: 's1', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'reserved' });
    expect((await post(`/api/admin/servers/${serverId}/idle`)).statusCode).toBe(200);
    expect((db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId) as { status: string }).status).toBe('idle');
  });

  it('Set idle on a box that went down under a booking puts it back: idle, gone_since cleared', async () => {
    const serverId = addServer(db, { name: 's1', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'offline' });
    db.prepare("UPDATE servers SET gone_since = '2026-10-02T20:00:00.000Z' WHERE id = ?").run(serverId);
    expect((await post(`/api/admin/servers/${serverId}/idle`)).statusCode).toBe(200);
    expect(db.prepare('SELECT status, gone_since FROM servers WHERE id = ?').get(serverId)).toEqual({ status: 'idle', gone_since: null });
  });

  it('enable and disable a server, which the overview reports', async () => {
    const serverId = addServer(db, { name: 's1', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const flagOf = async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/overview', cookies: admin });
      return res.json().servers.find((s: { id: number }) => s.id === serverId).enabled;
    };
    expect(await flagOf()).toBe(1);

    expect((await post(`/api/admin/servers/${serverId}/enabled`, { enabled: false })).statusCode).toBe(200);
    expect(await flagOf()).toBe(0);
    // Status is untouched: disabling is about eligibility, not lifecycle.
    expect((db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId) as { status: string }).status).toBe('idle');

    expect((await post(`/api/admin/servers/${serverId}/enabled`, { enabled: true })).statusCode).toBe(200);
    expect(await flagOf()).toBe(1);
  });

  it('rejects a non-boolean enabled and an unknown server', async () => {
    const serverId = addServer(db, { name: 's1', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x' });
    expect((await post(`/api/admin/servers/${serverId}/enabled`, { enabled: 'no' })).statusCode).toBe(400);
    expect((await post('/api/admin/servers/9999/enabled', { enabled: false })).statusCode).toBe(404);
  });

  it('remove a player from the queue', async () => {
    await app.inject({ method: 'POST', url: '/api/queue/join', cookies: authedCookie(app, db, IDS[3]) });
    expect((await post('/api/admin/queue/remove', { steamid: IDS[3] })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/queue' })).json().count).toBe(0);
  });

  it('non-admins are refused', async () => {
    const user = authedCookie(app, db, IDS[5]);
    for (const url of ['/api/admin/matches/1/void', '/api/admin/matches/1/abort', '/api/admin/servers/1/idle', '/api/admin/servers/1/enabled', '/api/admin/servers/dlc4-check', '/api/admin/queue/remove']) {
      expect((await app.inject({ method: 'POST', url, cookies: user, payload: {} })).statusCode, url).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/admin/overview', cookies: user })).statusCode).toBe(403);
  });
});

// A separate app per test here, not the shared one from the outer beforeEach,
// because the probe has to be injected at buildServer time (same reasoning
// as installTargets in tests/campaignRoutes.test.ts): a real probe would mean
// dialing an actual box.
describe('admin servers dlc4-check', () => {
  it('probes every server and records the result', async () => {
    const db2 = openDb(':memory:');
    const hasIt: Record<string, boolean> = { Dallas: true, Chicago: false };
    const app2 = await buildServer({
      config: loadConfig({}), db: db2, orchestrator: stubOrchestrator(),
      serverCleaner: async () => {}, serverExec: async () => {},
      dlc4Probe: async (s) => hasIt[s.name] ?? false,
    });
    const adminCookie = authedCookie(app2, db2, ADMIN);
    db2.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    const dallasId = addServer(db2, { name: 'Dallas', host: '1.1.1.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    const chicagoId = addServer(db2, { name: 'Chicago', host: '2.2.2.2', port: 27015, rconPort: 27015, rconPassword: 'x' });

    const res = await app2.inject({ method: 'POST', url: '/api/admin/servers/dlc4-check', cookies: adminCookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([
      { id: dallasId, name: 'Dallas', hasDlc4: true },
      { id: chicagoId, name: 'Chicago', hasDlc4: false },
    ]);
    // Persisted, so the pool gate (which reads serversMissingDlc4 straight
    // from the servers table) sees the same answer without re-probing.
    expect(serversMissingDlc4(db2)).toEqual(['Chicago']);
    const audit = (await app2.inject({ method: 'GET', url: '/api/admin/audit', cookies: adminCookie })).json();
    expect(audit.actions[0]).toMatchObject({ action: 'server_dlc4_check', target: 'all' });
    await app2.close();
  });

  it('refuses a non-admin', async () => {
    const db2 = openDb(':memory:');
    const app2 = await buildServer({
      config: loadConfig({}), db: db2, orchestrator: stubOrchestrator(),
      serverCleaner: async () => {}, serverExec: async () => {},
    });
    const res = await app2.inject({ method: 'POST', url: '/api/admin/servers/dlc4-check' });
    expect(res.statusCode).toBe(401);
    await app2.close();
  });
});

describe('the aborted list', () => {
  it('indexes matches that ended with no result, and names the leaver', async () => {
    const mid = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, ended_at) VALUES (1, 'aborted', 'no_mercy', datetime('now'))",
    ).run().lastInsertRowid);
    db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(mid, IDS[1], 'a');
    db.prepare("INSERT INTO bans (player_id, created_by, reason, created_at) VALUES (?, 'system', ?, datetime('now'))")
      .run(IDS[1], `Abandoned match #${mid}`);
    // A voided match is stored as 'aborted' too, and belongs to the other list.
    const voided = play('a');
    db.prepare("UPDATE matches SET state = 'aborted', voided_at = datetime('now'), void_reason = 'alt' WHERE id = ?").run(voided);

    const body = (await app.inject({ method: 'GET', url: '/api/admin/overview', cookies: admin })).json();
    expect(body.aborted).toHaveLength(1);
    expect(body.aborted[0]).toMatchObject({ id: mid, campaign: 'no_mercy', abandonedBy: 'p001' });
    expect(body.voided.map((v: { id: number }) => v.id)).toEqual([voided]);
  });
});

describe('admin abort teardown', () => {
  it('releases the box with a teardown', async () => {
    const db = openDb(':memory:');
    const serverId = addServer(db, { name: 's', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    markLive(db, serverId);
    const mid = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, server_id, token) VALUES (1, 'live', 'no_mercy', ?, ?)",
    ).run(serverId, 'b'.repeat(32)).lastInsertRowid);
    const seen: boolean[] = [];
    const releaser = new ServerReleaser(db, async (_s, _t, opts) => { seen.push(opts.teardown); });
    const causeless = watchCauselessAborts(db);
    expect(abortMatch(db, releaser, mid)).toEqual({ ok: true });
    expect(causeless()).toEqual([]);
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([true]);
  });

  it('keeps the record instead of wiping it', () => {
    const db = openDb(':memory:');
    const mid = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, token) VALUES (1, 'live', 'no_mercy', ?)",
    ).run('c'.repeat(32)).lastInsertRowid);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'm1', datetime('now'))").run(mid);
    db.prepare("INSERT INTO match_live_maps (match_id, map, ordinal, team_a_score, team_b_score) VALUES (?, 'm0', 0, 120, 90)").run(mid);

    abortMatch(db, new ServerReleaser(db, async () => {}), mid);

    expect(db.prepare('SELECT ordinal, map FROM match_maps WHERE match_id = ? ORDER BY ordinal').all(mid))
      .toEqual([{ ordinal: 0, map: 'm0' }, { ordinal: 1, map: 'm1' }]);
    expect(db.prepare('SELECT team_a_score AS a, team_b_score AS b FROM matches WHERE id = ?').get(mid))
      .toEqual({ a: 120, b: 90 });
  });
});

/** A booking holding the box, straight into the table: only the hold matters here. */
function holdForBooking(db: DB, serverId: number): number {
  return Number(db.prepare(
    `INSERT INTO bookings (purpose, starts_at, ends_at, state, server_id, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
     VALUES ('scrim', '2026-10-01T20:00:00.000Z', '2026-10-01T22:00:00.000Z', 'active', ?, 'pw', 'tvpw', 'pug_match', '{}', '["no_mercy"]', ?, '2026-10-01T19:00:00.000Z')`,
  ).run(serverId, ADMIN).lastInsertRowid);
}

describe('booking games and booked boxes (plan 4b final review)', () => {
  it('abortMatch on a booking game marks it aborted and tells the runner, without a release', async () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, 'admin', 'active')").run(ADMIN);
    const serverId = addServer(db, { name: 's', host: '10.0.0.1', port: 27015, rconPort: 27015, rconPassword: 'x' });
    markLive(db, serverId);
    const booking = holdForBooking(db, serverId);
    const mid = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, booking_id) VALUES (1, 'live', 'no_mercy', ?, 'tok-b', 'in_game', 'scrim', 'participants', ?)",
    ).run(serverId, booking).lastInsertRowid);
    const restarts: unknown[] = [];
    const releaser = new ServerReleaser(db, async (...a) => { restarts.push(a); });
    const told: [number, string][] = [];
    const causeless = watchCauselessAborts(db);
    expect(abortMatch(db, releaser, mid, [], (m, t) => { told.push([m, t]); })).toEqual({ ok: true, bookingContinues: true });
    expect(causeless()).toEqual([]);
    await new Promise((r) => setImmediate(r));
    expect(db.prepare('SELECT state, abort_cause FROM matches WHERE id = ?').get(mid)).toEqual({ state: 'aborted', abort_cause: 'admin' });
    expect(db.prepare('SELECT ended_at IS NOT NULL AS ended FROM matches WHERE id = ?').get(mid)).toEqual({ ended: 1 });
    expect(told).toEqual([[mid, 'tok-b']]);
    expect(restarts).toEqual([]);
    expect(db.prepare('SELECT ended_at FROM bookings WHERE id = ?').get(booking)).toEqual({ ended_at: null });
  });

  it('the abort route says the booking continues, and calls the runner wired in server.ts', async () => {
    const serverId = addServer(db, { name: 's1', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
    const booking = holdForBooking(db, serverId);
    const id = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, booking_id) VALUES (1, 'live', 'dead_air', ?, 'tok-r', 'in_game', 'scrim', 'participants', ?)",
    ).run(serverId, booking).lastInsertRowid);
    // Its own app with a fake booking rcon, so the runner's sm_pug_abort is seen and never dials 1.2.3.4.
    const sent: string[] = [];
    const app2 = await buildServer({
      config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
      bookingRcon: async (_server, cmds) => { sent.push(...cmds); return cmds.map(() => ''); },
    });
    try {
      const res = await app2.inject({ method: 'POST', url: `/api/admin/matches/${id}/abort`, cookies: authedCookie(app2, db, ADMIN), payload: {} });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, message: expect.stringContaining('the booking continues') });
      await new Promise((r) => setImmediate(r));
      expect(sent).toEqual(['sm_pug_abort tok-r']);
    } finally {
      await app2.close();
    }
    expect(db.prepare('SELECT state FROM matches WHERE id = ?').get(id)).toEqual({ state: 'aborted' });
    expect(db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId)).toEqual({ status: 'live' });
  });

  it('Set idle on a box a booking holds is refused, and changes nothing', async () => {
    const serverId = addServer(db, { name: 's1', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'live' });
    holdForBooking(db, serverId);
    const res = await post(`/api/admin/servers/${serverId}/idle`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'held by a booking; end the booking instead' });
    expect(db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId)).toEqual({ status: 'live' });
  });
});

// Its own bare app: the waiting-match wake-up is wired to a real releaser and
// a real pending list here, the way server.ts wires them, so the test sees
// the same path a live re-enable takes rather than a spy on the route.
describe('re-enabling a server wakes a match waiting for one', () => {
  it('drains the pending list on enable, and not on disable', async () => {
    const Fastify = (await import('fastify')).default;
    const cookie = (await import('@fastify/cookie')).default;
    const { adminRoutes } = await import('../src/routes/admin.js');
    const { PendingMatches } = await import('../src/pendingMatches.js');
    const db2 = openDb(':memory:');
    const releaser = new ServerReleaser(db2, async () => {});
    const setups: number[] = [];
    const pending = new PendingMatches(db2, async (id) => { setups.push(id); });
    releaser.onFreed(() => pending.drain());
    const bare = Fastify();
    await bare.register(cookie, { secret: loadConfig({}).cookieSecret });
    await bare.register(adminRoutes, {
      db: db2, matchmaker: {} as never, releaser, broadcast: () => {}, adminSteamIds: [],
    });
    await bare.ready();
    try {
      const who = authedCookie(bare, db2, ADMIN);
      db2.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
      const serverId = addServer(db2, { name: 's1', host: '1.2.3.4', port: 27015, rconPort: 27015, rconPassword: 'x', status: 'idle' });
      db2.prepare('UPDATE servers SET enabled = 0 WHERE id = ?').run(serverId);
      const waiting = Number(db2.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'configuring', 'dead_air')").run().lastInsertRowid);
      pending.add(waiting);

      const set = (enabled: boolean) => bare.inject({ method: 'POST', url: `/api/admin/servers/${serverId}/enabled`, cookies: who, payload: { enabled } });
      expect((await set(false)).statusCode).toBe(200);
      expect(setups).toEqual([]);
      expect((await set(true)).statusCode).toBe(200);
      expect(setups).toEqual([waiting]);
    } finally {
      await bare.close();
    }
  });
});
