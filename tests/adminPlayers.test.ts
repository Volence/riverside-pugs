import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { getPlayer, linkDiscord } from '../src/players.js';
import { liftExpiredBans, banMessage } from '../src/admin/players.js';
import { recordSignonDrop, markEntered } from '../src/signonDrops.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const ADMIN = '76561198000000001';
const P2 = '76561198000000002';
const P3 = '76561198000000003';

let db: DB;
let app: FastifyInstance;
let admin: Record<string, string>;
let user: Record<string, string>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  admin = authedCookie(app, db, ADMIN);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  user = authedCookie(app, db, P2);
  authedCookie(app, db, P3);
});
afterEach(async () => { await app.close(); });

const post = (url: string, cookies: Record<string, string>, payload: object = {}) =>
  app.inject({ method: 'POST', url, cookies, payload });
const get = (url: string, cookies: Record<string, string>) => app.inject({ method: 'GET', url, cookies });

describe('admin guard', () => {
  it('every admin route refuses a non-admin and an anonymous caller', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/admin/players'], ['GET', `/api/admin/players/${P3}`], ['POST', `/api/admin/players/${P3}/ban`],
      ['POST', `/api/admin/players/${P3}/unban`], ['POST', `/api/admin/players/${P3}/activate`],
      ['POST', `/api/admin/players/${P3}/admin`], ['POST', `/api/admin/players/${P3}/unlink-discord`],
      ['POST', `/api/admin/players/${P3}/notes`], ['POST', `/api/admin/players/${P3}/clear-penalties`], ['GET', '/api/admin/audit'],
    ];
    for (const [method, url] of routes) {
      expect((await app.inject({ method: method as 'GET', url, cookies: user, payload: method === 'POST' ? {} : undefined })).statusCode, url).toBe(403);
      expect((await app.inject({ method: method as 'GET', url, payload: method === 'POST' ? {} : undefined })).statusCode, url).toBe(401);
    }
  });
});

describe('admin players', () => {
  it('lists and searches players by name, steamid and discord name', async () => {
    linkDiscord(db, P3, '333', 'carol_discord');
    const all = (await get('/api/admin/players', admin)).json();
    expect(all.players.map((p: { steamid: string }) => p.steamid).sort()).toEqual([ADMIN, P2, P3].sort());
    const byDiscord = (await get('/api/admin/players?q=carol', admin)).json();
    expect(byDiscord.players.map((p: { steamid: string }) => p.steamid)).toEqual([P3]);
    const byId = (await get(`/api/admin/players?q=${P2}`, admin)).json();
    expect(byId.players.map((p: { steamid: string }) => p.steamid)).toEqual([P2]);
  });

  it('ban needs a reason, sets status, removes from queue, and is audited', async () => {
    await post('/api/queue/join', user);
    expect((await post(`/api/admin/players/${P2}/ban`, admin, {})).statusCode).toBe(400);
    const res = await post(`/api/admin/players/${P2}/ban`, admin, { reason: 'griefing', minutes: 60 });
    expect(res.statusCode).toBe(200);
    expect(getPlayer(db, P2)?.status).toBe('banned');
    expect((await get('/api/queue', user)).json().count).toBe(0);
    const detail = (await get(`/api/admin/players/${P2}`, admin)).json();
    expect(detail.activeBan).toMatchObject({ reason: 'griefing' });
    expect(detail.activeBan.expiresAt).toBeTruthy();
    const audit = (await get('/api/admin/audit', admin)).json();
    expect(audit.actions[0]).toMatchObject({ action: 'ban', target: P2, adminId: ADMIN });
  });

  it('a ban pulls the player out of a ready check, not only out of the queue', async () => {
    const others = Array.from({ length: 7 }, (_, i) => `7656119800000010${i}`);
    for (const id of others) await post('/api/queue/join', authedCookie(app, db, id));
    await post('/api/queue/join', user);
    expect((await get('/api/state', user)).json().lobby).not.toBeNull();
    await post(`/api/admin/players/${P2}/ban`, admin, { reason: 'griefing' });
    const seat = (await get('/api/state', authedCookie(app, db, others[0]))).json();
    expect(seat.lobby).toBeNull();
    expect(seat.queue.count).toBe(7);
    expect(seat.queue.players.map((p: { steamid: string }) => p.steamid)).not.toContain(P2);
  });

  it('you cannot ban yourself or remove your own admin', async () => {
    expect((await post(`/api/admin/players/${ADMIN}/ban`, admin, { reason: 'x' })).statusCode).toBe(400);
    expect((await post(`/api/admin/players/${ADMIN}/admin`, admin, { isAdmin: false })).statusCode).toBe(400);
  });

  it('unban lifts the ban and reactivates', async () => {
    await post(`/api/admin/players/${P2}/ban`, admin, { reason: 'x' });
    await post(`/api/admin/players/${P2}/unban`, admin);
    expect(getPlayer(db, P2)?.status).toBe('active');
    expect((await get(`/api/admin/players/${P2}`, admin)).json().activeBan).toBeNull();
  });

  it('expired bans are lifted by the sweep, permanent ones are not', async () => {
    await post(`/api/admin/players/${P2}/ban`, admin, { reason: 'x', minutes: 5 });
    await post(`/api/admin/players/${P3}/ban`, admin, { reason: 'y' });
    liftExpiredBans(db, new Date(Date.now() + 10 * 60 * 1000));
    expect(getPlayer(db, P2)?.status).toBe('active');
    expect(getPlayer(db, P3)?.status).toBe('banned');
  });

  it('banMessage carries the reason and, for a timed ban, when it ends', async () => {
    await post(`/api/admin/players/${P2}/ban`, admin, { reason: 'toxic', minutes: 60 });
    expect(banMessage(db, P2)).toMatch(/toxic/);
    expect(banMessage(db, P2)).toMatch(/<t:\d+:R>/);
  });

  it('activate, grant admin, unlink discord and notes', async () => {
    db.prepare("UPDATE players SET status = 'invited' WHERE steamid = ?").run(P3);
    await post(`/api/admin/players/${P3}/activate`, admin);
    expect(getPlayer(db, P3)?.status).toBe('active');
    await post(`/api/admin/players/${P3}/admin`, admin, { isAdmin: true });
    expect(getPlayer(db, P3)?.is_admin).toBe(1);
    linkDiscord(db, P3, '333', 'c');
    await post(`/api/admin/players/${P3}/unlink-discord`, admin);
    expect(getPlayer(db, P3)?.discord_id).toBeNull();
    expect((await post(`/api/admin/players/${P3}/notes`, admin, { text: '' })).statusCode).toBe(400);
    await post(`/api/admin/players/${P3}/notes`, admin, { text: 'smurf of bob?' });
    const detail = (await get(`/api/admin/players/${P3}`, admin)).json();
    expect(detail.notes[0]).toMatchObject({ text: 'smurf of bob?', authorId: ADMIN });
    const actions = (await get('/api/admin/audit', admin)).json().actions.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['activate', 'set_admin', 'unlink_discord', 'note']));
  });

  it('shows penalties and clears them', async () => {
    const { recordPenalty } = await import('../src/penalties.js');
    recordPenalty(db, P2, 'no_show', null);
    let d = (await get(`/api/admin/players/${P2}`, admin)).json();
    expect(d.penalties).toHaveLength(1);
    expect(d.timeout).toBeTruthy();
    expect((await get('/api/admin/players', admin)).json().players.find((p: { steamid: string }) => p.steamid === P2).offenses).toBe(1);
    await post(`/api/admin/players/${P2}/clear-penalties`, admin);
    d = (await get(`/api/admin/players/${P2}`, admin)).json();
    expect(d.timeout).toBeNull();
  });

  it('reports connect drops with the count, the last time and the rows', async () => {
    const empty = (await get(`/api/admin/players/${P2}`, admin)).json();
    expect(empty.signonDrops).toEqual({ count: 0, lastAt: null, rows: [] });

    recordSignonDrop(db, { steamid: P2, name: 'p002 in game', secs: 12, forced: 651 }, new Date('2026-09-19T20:00:00.000Z'));
    markEntered(db, P2, new Date('2026-09-19T20:03:00.000Z'));
    recordSignonDrop(db, { steamid: P2, name: 'p002 in game', secs: -1, forced: 651 }, new Date('2026-09-19T21:00:00.000Z'));
    recordSignonDrop(db, { steamid: P3, name: 'someone else', secs: 5, forced: 651 }, new Date('2026-09-19T21:30:00.000Z'));

    const detail = (await get(`/api/admin/players/${P2}`, admin)).json();
    expect(detail.signonDrops.count).toBe(2);
    expect(detail.signonDrops.lastAt).toBe('2026-09-19T21:00:00.000Z');
    expect(detail.signonDrops.rows).toEqual([
      { id: 2, name: 'p002 in game', secsConnected: -1, forcedCount: 651, at: '2026-09-19T21:00:00.000Z', enteredAfterAt: null },
      { id: 1, name: 'p002 in game', secsConnected: 12, forcedCount: 651, at: '2026-09-19T20:00:00.000Z', enteredAfterAt: '2026-09-19T20:03:00.000Z' },
    ]);
  });

  it('activate does not unban', async () => {
    await post(`/api/admin/players/${P2}/ban`, admin, { reason: 'x' });
    expect((await post(`/api/admin/players/${P2}/activate`, admin)).statusCode).toBe(409);
  });

  it('/api/me says isAdmin for the admin', async () => {
    expect((await get('/api/me', admin)).json().isAdmin).toBe(true);
  });
});

describe('admin merge', () => {
  it('previews a merge without changing anything', async () => {
    const res = await post(`/api/admin/players/${P3}/merge`, admin, { into: P2, dryRun: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().plan.into).toBe(P2);
    expect(getPlayer(db, P3)).toBeTruthy();
  });

  it('merges, leaves an alias, and writes an audit entry', async () => {
    const res = await post(`/api/admin/players/${P3}/merge`, admin, { into: P2 });
    expect(res.statusCode).toBe(200);
    expect(getPlayer(db, P3)).toBeUndefined();

    const detail = (await get(`/api/admin/players/${P2}`, admin)).json();
    expect(detail.aliases.map((a: any) => a.steamid)).toEqual([P3]);

    const audit = (await get('/api/admin/audit', admin)).json();
    expect(audit.actions.some((r: any) => r.action === 'merge_player' && r.target === P3)).toBe(true);
  });

  it('refuses a merge into an account that does not exist, or into itself', async () => {
    expect((await post(`/api/admin/players/${P3}/merge`, admin, { into: '76561199999999999' })).statusCode).toBe(400);
    expect((await post(`/api/admin/players/${P3}/merge`, admin, { into: P3 })).statusCode).toBe(400);
    expect((await post(`/api/admin/players/${P3}/merge`, admin, {})).statusCode).toBe(400);
    expect(getPlayer(db, P3)).toBeTruthy();
  });

  it('un-merges: removing the alias frees the id to be its own account again', async () => {
    await post(`/api/admin/players/${P3}/merge`, admin, { into: P2 });
    const res = await post(`/api/admin/players/${P3}/unalias`, admin);
    expect(res.statusCode).toBe(200);
    expect((await get(`/api/admin/players/${P2}`, admin)).json().aliases).toEqual([]);
  });

  it('separating an alias from a banned account lifts the engine ban that alias was carrying', async () => {
    const { subscribeBanChanges } = await import('../src/banEvents.js');
    await post(`/api/admin/players/${P3}/merge`, admin, { into: P2 });
    await post(`/api/admin/players/${P2}/ban`, admin, { reason: 'griefing' });
    const seen: unknown[] = [];
    const off = subscribeBanChanges((e) => seen.push(e));
    try {
      await post(`/api/admin/players/${P3}/unalias`, admin);
    } finally {
      off();
    }
    // Only the freed id. The main is still banned and stays banned.
    expect(seen).toEqual([{ kind: 'unban', steamid: P3 }]);
  });

  it('is admin-only, like every other action here', async () => {
    expect((await post(`/api/admin/players/${P3}/merge`, user, { into: P2 })).statusCode).toBe(403);
    expect((await post(`/api/admin/players/${P3}/unalias`, user)).statusCode).toBe(403);
  });
});
