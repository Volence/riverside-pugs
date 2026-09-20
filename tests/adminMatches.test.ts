import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { completeMatch } from '../src/matchResult.js';
import { recomputeSeasonRatings } from '../src/rating.js';
import { addServer, markLive, serversMissingDlc4 } from '../src/serverPool.js';
import type { Dump } from '../src/dumpParse.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
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
    expect(abortMatch(db, releaser, mid)).toEqual({ ok: true });
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([true]);
  });
});
