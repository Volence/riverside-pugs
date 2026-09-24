import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { addAlias } from '../src/aliases.js';
import { upsertPlayer } from '../src/players.js';
import { banPlayer } from '../src/admin/players.js';

const IDS = Array.from({ length: 6 }, (_, i) => `7656119900000000${i}`);
const [PLAYER, OTHER, MOD, MOD2, ADMIN, OWNER] = IDS;
/** Merged second accounts: of an ordinary player, of an admin, of the
 *  moderator doing the asking. */
const ALTS = ['76561199000000010', '76561199000000011', '76561199000000012'];
let db: DB;
let app: FastifyInstance;
const cookie: Record<string, Record<string, string>> = {};

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({ config: loadConfig({ ADMIN_STEAMIDS: OWNER }), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  for (const id of IDS) cookie[id] = authedCookie(app, db, id);
  for (const id of ALTS) upsertPlayer(db, { steamid: id, name: `alt${id.slice(-2)}`, avatar: null }, []);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid IN (?, ?)').run(MOD, MOD2);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(ADMIN, OWNER);
});
afterEach(async () => { await app.close(); });

const get = (as: string, url: string) => app.inject({ method: 'GET', url, cookies: cookie[as] });
const post = (as: string, url: string, payload: object = {}) =>
  app.inject({ method: 'POST', url, cookies: cookie[as], payload });

const flag = (steamid: string, at: string) =>
  db.prepare(
    `INSERT INTO integrity_flags (match_id, server_id, steamid, source, kind, severity, detail, at)
     VALUES (NULL, 1, ?, 'lilac', 'aimbot', 'suspected', '', ?)`,
  ).run(steamid, at);

describe('the People routes', () => {
  // Every route, not the two that happened to be written down: a desk is only
  // as closed as its least guarded door, and these are added to one at a time.
  const ROUTES = (): [string, string, object][] => [
    ['GET', '/api/admin/people', {}],
    ['GET', '/api/admin/people/review', {}],
    ['GET', '/api/admin/people/bans', {}],
    ['GET', `/api/admin/people/${OTHER}`, {}],
    ['POST', `/api/admin/people/${OTHER}/notes`, { text: 'x' }],
    ['POST', `/api/admin/people/${OTHER}/looked-at`, {}],
    ['GET', '/api/admin/people/chat/1', {}],
  ];

  it('are staff only, on every one of them, signed in or not', async () => {
    for (const [method, url, payload] of ROUTES()) {
      const anon = await app.inject({ method: method as 'GET', url, payload });
      expect(anon.statusCode, `anonymous ${url}`).toBe(401);
      const asPlayer = method === 'GET' ? await get(PLAYER, url) : await post(PLAYER, url, payload);
      expect(asPlayer.statusCode, `a plain player on ${url}`).toBe(403);
    }
  });

  // Staff flags are not standing. A moderator who is banned, or who never
  // got through the gate, is refused whatever the flag still says.
  it('refuse a moderator who is banned or not active, on every one of them', async () => {
    banPlayer(db, MOD, ADMIN, 'throwing', null);
    // A ban bumps the session epoch, so their own cookie is already dead.
    expect((await get(MOD, '/api/admin/people')).statusCode).toBe(401);
    // Signed in again afterwards, so what refuses them below is standing
    // rather than a stale cookie: the flag is still is_mod = 1.
    cookie[MOD] = authedCookie(app, db, MOD);
    db.prepare("UPDATE players SET status = 'invited' WHERE steamid = ?").run(MOD2);

    for (const [method, url, payload] of ROUTES()) {
      for (const who of [MOD, MOD2]) {
        const res = method === 'GET' ? await get(who, url) : await post(who, url, payload);
        expect(res.statusCode, `${who} on ${url}`).toBe(403);
      }
    }
  });

  it('lists only the files the viewer could open', async () => {
    const asAdmin = (await get(ADMIN, '/api/admin/people')).json();
    expect(asAdmin.players.map((p: { steamid: string }) => p.steamid)).toContain(MOD);
    const asMod = (await get(MOD, '/api/admin/people')).json();
    const ids = asMod.players.map((p: { steamid: string }) => p.steamid);
    expect(ids).toContain(PLAYER);
    expect(ids).not.toContain(MOD);
    expect(ids).not.toContain(MOD2);
    expect(ids).not.toContain(ADMIN);
    expect((await get(MOD, `/api/admin/people?q=${PLAYER}`)).json().players).toHaveLength(1);
  });

  it('serves a file, and answers 404 rather than 403 for one the viewer may not open', async () => {
    const file = (await get(MOD, `/api/admin/people/${PLAYER}`)).json();
    expect(file.header.steamid).toBe(PLAYER);
    expect(file.actions).toEqual(['note', 'looked_at', 'open_ticket']);
    expect(file.sections.identity).toBeTruthy();

    for (const target of [MOD, MOD2, ADMIN]) {
      const res = await get(MOD, `/api/admin/people/${target}`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'no such player' });
    }
    expect((await get(ADMIN, `/api/admin/people/${MOD}`)).statusCode).toBe(200);
    expect((await get(ADMIN, '/api/admin/people/76561199000000999')).statusCode).toBe(404);
  });

  it('a moderator writes a note and marks a file looked at, both audited', async () => {
    flag(PLAYER, new Date().toISOString());
    expect((await get(MOD, '/api/admin/people/review')).json().players.map((p: { steamid: string }) => p.steamid))
      .toEqual([PLAYER]);

    expect((await post(MOD, `/api/admin/people/${PLAYER}/notes`, { text: '' })).statusCode).toBe(400);
    expect((await post(MOD, `/api/admin/people/${PLAYER}/notes`, { text: 'had a word' })).statusCode).toBe(200);
    expect((await post(MOD, `/api/admin/people/${PLAYER}/looked-at`, { note: 'nothing there' })).statusCode).toBe(200);

    expect((await get(MOD, '/api/admin/people/review')).json().players).toEqual([]);
    const file = (await get(MOD, `/api/admin/people/${PLAYER}`)).json();
    expect(file.lastReview.note).toBe('nothing there');
    expect(file.sections.notes[0].text).toBe('had a word');

    const audit = (await get(OWNER, '/api/admin/audit')).json();
    expect(audit.actions.map((a: { action: string }) => a.action)).toEqual(['looked_at', 'note']);
    expect(audit.actions[0]).toMatchObject({ adminId: MOD, target: PLAYER });
  });

  // Every GET resolves aliases, so a merged alt's id opens the main file.
  // The POSTs used to act on the raw id, which wrote a note onto an account
  // nobody reads and left the same id refusing nothing at all.
  it('acts on the main account when a merged alt is named, under the same rule as the GET', async () => {
    const [altOfPlayer, altOfAdmin, altOfMod] = ALTS;
    addAlias(db, { steamid: altOfPlayer, canonical: PLAYER, by: 'test' });
    addAlias(db, { steamid: altOfAdmin, canonical: ADMIN, by: 'test' });
    addAlias(db, { steamid: altOfMod, canonical: MOD, by: 'test' });

    expect((await post(MOD, `/api/admin/people/${altOfPlayer}/notes`, { text: 'same person' })).statusCode).toBe(200);
    expect((await post(MOD, `/api/admin/people/${altOfPlayer}/looked-at`, {})).statusCode).toBe(200);
    const file = (await get(MOD, `/api/admin/people/${PLAYER}`)).json();
    expect(file.sections.notes[0].text).toBe('same person');
    expect(file.lastReview).not.toBeNull();
    const audit = (await get(OWNER, '/api/admin/audit')).json();
    expect(audit.actions.every((a: { target: string }) => a.target === PLAYER)).toBe(true);

    for (const alt of [altOfAdmin, altOfMod]) {
      expect((await post(MOD, `/api/admin/people/${alt}/notes`, { text: 'x' })).statusCode, alt).toBe(404);
      expect((await post(MOD, `/api/admin/people/${alt}/looked-at`, {})).statusCode, alt).toBe(404);
      expect((await get(MOD, `/api/admin/people/${alt}`)).statusCode, alt).toBe(404);
    }
  });

  it('refuses a note or a review on a file the viewer may not open, as a 404', async () => {
    expect((await post(MOD, `/api/admin/people/${ADMIN}/notes`, { text: 'x' })).statusCode).toBe(404);
    expect((await post(MOD, `/api/admin/people/${MOD}/looked-at`, {})).statusCode).toBe(404);
    expect((db.prepare('SELECT COUNT(*) AS n FROM player_notes').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM player_reviews').get() as { n: number }).n).toBe(0);
  });

  it('serves the review list with capture health, and the ban list with its filters', async () => {
    const review = (await get(ADMIN, '/api/admin/people/review')).json();
    expect(review.health).toMatchObject({ bursts: 0, detections: 0, lilacFlags: 0 });
    // The second list rides on the same request: nothing is measured here, so
    // it is empty, but the page must not have to ask twice to find that out.
    expect(review.measured).toEqual([]);

    await post(ADMIN, `/api/admin/players/${PLAYER}/ban`, { reason: 'throwing', minutes: 1440 });
    const bans = (await get(MOD, '/api/admin/people/bans?filter=active')).json().bans;
    expect(bans).toHaveLength(1);
    expect(bans[0]).toMatchObject({ steamid: PLAYER, reason: 'throwing', length: '1 day', canOpen: true });
    expect((await get(MOD, '/api/admin/people/bans?filter=expired')).json().bans).toEqual([]);
    expect((await get(MOD, '/api/admin/people/bans?q=nobody')).json().bans).toEqual([]);
  });
});

describe('the admin-only routes the file calls', () => {
  it('still refuse a moderator, every one of them, and still answer an admin', async () => {
    const refusedGets = [
      '/api/admin/players',
      `/api/admin/players/${PLAYER}`,
      '/api/admin/integrity',
      `/api/admin/integrity/${PLAYER}`,
      '/api/bans',
    ];
    for (const url of refusedGets) {
      expect((await get(MOD, url)).statusCode, url).toBe(403);
      expect((await get(ADMIN, url)).statusCode, url).toBe(200);
    }
    const refusedPosts: [string, object][] = [
      [`/api/admin/players/${PLAYER}/ban`, { reason: 'x', minutes: 60 }],
      [`/api/admin/players/${PLAYER}/unban`, {}],
      [`/api/admin/players/${PLAYER}/activate`, {}],
      [`/api/admin/players/${PLAYER}/admin`, { isAdmin: true }],
      [`/api/admin/players/${PLAYER}/mod`, { isMod: true }],
      [`/api/admin/players/${PLAYER}/sign-out`, {}],
      [`/api/admin/players/${PLAYER}/unlink-discord`, {}],
      [`/api/admin/players/${PLAYER}/merge`, { into: OTHER, dryRun: true }],
      [`/api/admin/players/${PLAYER}/unalias`, {}],
      [`/api/admin/players/${PLAYER}/clear-penalties`, {}],
      [`/api/admin/players/${PLAYER}/steam-refresh`, {}],
      [`/api/admin/players/${PLAYER}/notes`, { text: 'x' }],
      // The file offers this one behind the admin-only `review_round` action,
      // and it is the only mutation the file makes outside /api/admin/players.
      ['/api/admin/integrity/1/1/1/0/review', { state: 'reviewed', note: '' }],
    ];
    for (const [url, payload] of refusedPosts) {
      expect((await post(MOD, url, payload)).statusCode, url).toBe(403);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM bans').get() as { n: number }).n).toBe(0);
  });
});

describe('the staff chat log of a match', () => {
  const match = (state: string) => Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, ?, 'dead_air')").run(state).lastInsertRowid,
  );
  const say = (matchId: number, seq: number, map: number, half: number, tMs: number, steamid: string, team: string, message: string) =>
    db.prepare(
      `INSERT INTO match_chat (match_id, seq, map_ordinal, half, t_ms, steamid, team, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(matchId, seq, map, half, tMs, steamid, team, message);

  it('gives staff every line in order, including those said outside a round', async () => {
    const id = match('completed');
    say(id, 3, 0, 1, 5000, PLAYER, 'a', 'nice');
    say(id, 1, 0, -1, -1, OTHER, 'b', 'ready up');
    say(id, 7, 0, 1, -1, PLAYER, 'a', 'gg that round');
    for (const who of [MOD, ADMIN]) {
      const res = await get(who, `/api/admin/people/chat/${id}`);
      expect(res.statusCode).toBe(200);
      const lines = res.json().lines;
      expect(lines.map((l: { message: string }) => l.message)).toEqual(['ready up', 'nice', 'gg that round']);
      expect(lines[0]).toMatchObject({ steamid: OTHER, team: 'b', mapOrdinal: 0, half: -1, tMs: -1 });
      expect(lines[1].name).toBeTruthy();
    }
  });

  // A moderator can be playing. Serving a live match's chat would hand them
  // the other team's messages as they are typed.
  it('refuses a match that is still being played', async () => {
    for (const state of ['live', 'configuring']) {
      const id = match(state);
      say(id, 1, 0, 1, 100, PLAYER, 'a', 'rush left');
      expect((await get(ADMIN, `/api/admin/people/chat/${id}`)).statusCode, state).toBe(404);
    }
    expect((await get(ADMIN, '/api/admin/people/chat/999')).statusCode).toBe(404);
  });

  it('names the merged account behind an alt\'s lines', async () => {
    const id = match('completed');
    addAlias(db, { steamid: ALTS[0], canonical: PLAYER, by: ADMIN });
    say(id, 1, 0, 1, 10, ALTS[0], 'a', 'from the alt');
    expect((await get(ADMIN, `/api/admin/people/chat/${id}`)).json().lines[0]).toMatchObject({ steamid: ALTS[0], player: PLAYER });
  });

  it('serves a cancelled match too, since that is often where the trouble was', async () => {
    const id = match('aborted');
    say(id, 1, 0, -1, -1, PLAYER, 'a', 'im leaving');
    expect((await get(MOD, `/api/admin/people/chat/${id}`)).json().lines).toHaveLength(1);
  });
});
