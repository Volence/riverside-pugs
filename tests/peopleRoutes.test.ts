import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import { addAlias } from '../src/aliases.js';
import { upsertPlayer } from '../src/players.js';

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
  it('are staff only, and a plain player gets nothing', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/people' })).statusCode).toBe(401);
    expect((await get(PLAYER, '/api/admin/people')).statusCode).toBe(403);
    expect((await get(PLAYER, `/api/admin/people/${OTHER}`)).statusCode).toBe(403);
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
    ];
    for (const [url, payload] of refusedPosts) {
      expect((await post(MOD, url, payload)).statusCode, url).toBe(403);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM bans').get() as { n: number }).n).toBe(0);
  });
});
