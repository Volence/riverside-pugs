import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const A = '76561198000000201';
const B = '76561198000000202';
let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverExec: async () => {} });
});

const post = (url: string, cookies: Record<string, string>, payload?: object) =>
  app.inject({ method: 'POST', url, cookies, payload });

describe('duo routes', () => {
  it('refuses before Season 1', async () => {
    const ca = authedCookie(app, db, A);
    authedCookie(app, db, B);
    const res = await post('/api/duo/invite', ca, { steamid: B });
    expect(res.statusCode).toBe(409);
  });

  it('invite, accept, show in state, end', async () => {
    db.prepare('UPDATE seasons SET ranks = 1').run();
    const ca = authedCookie(app, db, A);
    const cb = authedCookie(app, db, B);
    const inv = await post('/api/duo/invite', ca, { steamid: B });
    expect(inv.statusCode).toBe(200);
    const id = inv.json().inviteId;
    expect((await post(`/api/duo/invites/${id}/accept`, cb)).statusCode).toBe(200);
    const st = await app.inject({ method: 'GET', url: '/api/state', cookies: ca });
    expect(st.json().duo.partner.steamid).toBe(B);
    expect((await post('/api/duo/end', cb)).statusCode).toBe(200);
  });

  it('rejects a bad steamid and a bad invite id', async () => {
    db.prepare('UPDATE seasons SET ranks = 1').run();
    const ca = authedCookie(app, db, A);
    expect((await post('/api/duo/invite', ca, { steamid: 'nope' })).statusCode).toBe(400);
    expect((await post('/api/duo/invites/abc/accept', ca)).statusCode).toBe(400);
  });

  it('needs a signed-in player', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/duo/end' })).statusCode).toBe(401);
  });
});

describe('staff duo blocks (owner 2026-11-03)', () => {
  const STAFF = '76561198000000209';
  const audit = () => db.prepare('SELECT admin_id, action, target, detail FROM admin_actions ORDER BY id').all();

  it('blocks a player in a duo: the duo ends, accepting is refused, and both are audited', async () => {
    db.prepare('UPDATE seasons SET ranks = 1').run();
    const ca = authedCookie(app, db, A);
    const cb = authedCookie(app, db, B);
    const staff = authedCookie(app, db, STAFF);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(STAFF);
    const id = (await post('/api/duo/invite', ca, { steamid: B })).json().inviteId;
    expect((await post(`/api/duo/invites/${id}/accept`, cb)).statusCode).toBe(200);

    const blocked = await post(`/api/admin/players/${A}/duo-block`, staff, { reason: 'duo griefing', minutes: 1440 });
    expect(blocked.statusCode).toBe(200);
    expect(db.prepare('SELECT ended_by FROM duos').get()).toEqual({ ended_by: STAFF });
    expect((await app.inject({ method: 'GET', url: '/api/state', cookies: cb })).json().duo.partner).toBeNull();

    // B asks A again: neutral to B. A asks B: told about their own block.
    const toA = await post('/api/duo/invite', cb, { steamid: A });
    expect(toA.json()).toEqual({ error: 'that player cannot duo right now' });
    const fromA = await post('/api/duo/invite', ca, { steamid: B });
    expect(fromA.json().error).toMatch(/^you are blocked from duo queue until \d{4}-\d\d-\d\d \d\d:\d\d UTC$/);

    // An invite left over from before the block cannot be accepted by A.
    const old = Number(db.prepare("INSERT INTO duo_invites (from_id, to_id, source, created_at) VALUES (?, ?, 'site', ?)")
      .run(B, A, new Date().toISOString()).lastInsertRowid);
    expect((await post(`/api/duo/invites/${old}/accept`, ca)).json().error).toMatch(/^you are blocked from duo queue/);

    expect((await post(`/api/admin/players/${A}/duo-unblock`, staff)).statusCode).toBe(200);
    // Lifted: the same invite goes through.
    expect((await post(`/api/duo/invites/${old}/accept`, ca)).statusCode).toBe(200);
    expect((await post(`/api/admin/players/${A}/duo-unblock`, staff)).statusCode).toBe(409);

    expect(audit()).toEqual([
      { admin_id: STAFF, action: 'duo_block', target: A, detail: JSON.stringify({ reason: 'duo griefing', minutes: 1440 }) },
      { admin_id: STAFF, action: 'duo_unblock', target: A, detail: '{}' },
    ]);
  });

  it('shows the active block on the player file', async () => {
    authedCookie(app, db, A);
    const staff = authedCookie(app, db, STAFF);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(STAFF);
    await post(`/api/admin/players/${A}/duo-block`, staff, { reason: 'duo griefing' });
    const f = (await app.inject({ method: 'GET', url: `/api/admin/people/${A}`, cookies: staff })).json();
    expect(f.sections.standing.duoBlock).toMatchObject({ reason: 'duo griefing', expiresAt: null, createdBy: STAFF });
  });

  it('refuses anyone but an admin, and a block with no reason', async () => {
    authedCookie(app, db, A);
    const cb = authedCookie(app, db, B);
    const staff = authedCookie(app, db, STAFF);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(STAFF);
    expect((await post(`/api/admin/players/${A}/duo-block`, cb, { reason: 'x' })).statusCode).toBe(403);
    expect((await post(`/api/admin/players/${A}/duo-unblock`, cb)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/admin/players/${A}/duo-block`, payload: { reason: 'x' } })).statusCode).toBe(401);
    expect((await post(`/api/admin/players/${A}/duo-block`, staff, { reason: ' ' })).statusCode).toBe(400);
    expect((await post(`/api/admin/players/${A}/duo-block`, staff, { reason: 'x', minutes: 0 })).statusCode).toBe(400);
    expect(audit()).toEqual([]);
  });
});

describe('match page roster', () => {
  it('names each duo member partner and null for everyone else', async () => {
    const C = '76561198000000203';
    for (const id of [A, B, C]) db.prepare("INSERT INTO players (steamid, name) VALUES (?, ?)").run(id, id.slice(-3));
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, winner) VALUES (1, 1, 'completed', 'no_mercy', 'a')").run();
    const mp = db.prepare('INSERT INTO match_players (match_id, player_id, team, duo_partner, duo_bonus) VALUES (1, ?, ?, ?, ?)');
    mp.run(A, 'a', B, 0.5);
    mp.run(B, 'a', A, 0.5);
    mp.run(C, 'b', null, null);
    const res = await app.inject({ method: 'GET', url: '/api/matches/1' });
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(res.json().players.map((p: { steamid: string; duoPartner: string | null }) => [p.steamid, p.duoPartner]));
    expect(byId).toEqual({ [A]: B, [B]: A, [C]: null });
  });
});
