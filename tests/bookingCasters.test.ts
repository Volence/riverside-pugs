import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { closeBooking, getBooking, holdBox, markReady, markSetup } from '../src/bookings/bookings.js';
import { castersOf, fullyInvited, inviteCaster, withdrawCaster } from '../src/bookings/casters.js';
import { canViewMatch, viewerFor, visibleMatchesSql } from '../src/matchVisibility.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const P = Array.from({ length: 3 }, (_, i) => `7656119900000045${i}`);
const [CAPT_A, CAPT_B, STRANGER] = P;
const CASTER = '76561199000000460';
const HALF = '76561199000000461';
const ADMIN = '76561199000000462';
const MOD = '76561199000000463';
const START = new Date(Date.now() + 3 * 24 * 3_600_000);
START.setUTCMinutes(0, 0, 0);

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;
let serverId: number;
let bookingId: number;
let gameId: number;

const call = (method: 'GET' | 'POST', url: string, as?: string, payload?: object) =>
  app.inject({ method, url, cookies: as ? cookies[as] : undefined, payload });

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'bookingcasters-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    bookingRcon: async () => { throw new Error('no rcon in route tests'); },
  });
  cookies = {};
  for (const id of [...P, CASTER, HALF, ADMIN, MOD]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare('UPDATE players SET is_caster = 1 WHERE steamid IN (?, ?)').run(CASTER, HALF);
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'map_pool'").run(JSON.stringify(['no_mercy', 'death_toll']));
  for (const n of ['a', 'bb', 'ccc']) {
    const id = addServer(db, { name: n, host: '9.9.9.9', port: 27014 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle', tv_enabled = 1, tv_port = 27120, tv_password = 'servertv' WHERE id = ?").run(id);
  }
  serverId = (db.prepare("SELECT id FROM servers WHERE name = 'ccc'").get() as { id: number }).id;

  const r = await call('POST', '/api/bookings', CAPT_A, { opponent: { steamid: CAPT_B }, startsAt: START.toISOString(), minutes: 90, playlist: ['no_mercy'] });
  expect(r.statusCode).toBe(201);
  bookingId = r.json().id;
  expect((await call('POST', `/api/bookings/${bookingId}/confirm`, CAPT_B)).statusCode).toBe(200);

  // A live game of the booking on its box: neither caster is on its roster.
  gameId = Number(db.prepare(
    `INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, booking_id)
     VALUES (1, 'live', 'no_mercy', ?, ?, 'in_game', 'scrim', 'participants', ?)`,
  ).run(serverId, 'd'.repeat(32), bookingId).lastInsertRowid);
  const mp = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  mp.run(gameId, CAPT_A, 'a');
  mp.run(gameId, CAPT_B, 'b');
});
afterEach(async () => { await app.close(); });

/** Holds, sets up and readies the booking on its box, bypassing the
 *  runner's rcon-driven setup (route tests build no fake box). */
const ready = () => {
  const at = new Date();
  expect(holdBox(db, bookingId, serverId, at)).toBe(true);
  markSetup(db, bookingId, at);
  expect(markReady(db, bookingId, at)).toBe(true);
};
const tvPassword = () => getBooking(db, bookingId)!.tv_password;
const inviteBoth = (caster: string) => {
  expect(inviteCaster(db, { bookingId, by: CAPT_A, caster }).ok).toBe(true);
  expect(inviteCaster(db, { bookingId, by: CAPT_B, caster }).ok).toBe(true);
};
const visibleIds = (who: string): number[] => {
  const { sql, params } = visibleMatchesSql(viewerFor(db, who), 'm');
  return (db.prepare(`SELECT m.id FROM matches m WHERE ${sql} ORDER BY m.id`).all(...params) as { id: number }[]).map((x) => x.id);
};
const seesGame = (who: string) => canViewMatch(db, viewerFor(db, who), gameId) && visibleIds(who).includes(gameId);
const hidesGame = (who: string) => !canViewMatch(db, viewerFor(db, who), gameId) && !visibleIds(who).includes(gameId);

describe('inviting and withdrawing (src/bookings/casters.ts)', () => {
  it('only a manager of a confirmed side can invite, each for their own side', () => {
    expect(inviteCaster(db, { bookingId, by: STRANGER, caster: CASTER })).toEqual({ ok: false, error: 'not_manager' });
    // Staff who manage no side do not invite on a side's behalf.
    expect(inviteCaster(db, { bookingId, by: ADMIN, caster: CASTER })).toEqual({ ok: false, error: 'not_manager' });
    expect(inviteCaster(db, { bookingId, by: CAPT_A, caster: CASTER })).toEqual({ ok: true, value: { side: 'a' } });
    expect(inviteCaster(db, { bookingId, by: CAPT_B, caster: CASTER })).toEqual({ ok: true, value: { side: 'b' } });
    expect(castersOf(db, bookingId)).toEqual([{ steamid: CASTER, name: expect.any(String), a: true, b: true }]);
  });

  it("an unconfirmed side's prospective captain cannot invite", () => {
    db.prepare("UPDATE booking_sides SET confirmed_at = NULL WHERE booking_id = ? AND side = 'b'").run(bookingId);
    expect(inviteCaster(db, { bookingId, by: CAPT_B, caster: CASTER })).toEqual({ ok: false, error: 'not_manager' });
  });

  it('refuses a non-caster, and a caster out of good standing', () => {
    expect(inviteCaster(db, { bookingId, by: CAPT_A, caster: STRANGER })).toEqual({ ok: false, error: 'not_caster' });
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(CASTER);
    expect(inviteCaster(db, { bookingId, by: CAPT_A, caster: CASTER })).toEqual({ ok: false, error: 'not_caster' });
    expect(castersOf(db, bookingId)).toEqual([]);
  });

  it('refuses on a closed booking', () => {
    closeBooking(db, bookingId, 'cancelled', 'test', new Date());
    expect(inviteCaster(db, { bookingId, by: CAPT_A, caster: CASTER })).toEqual({ ok: false, error: 'wrong_state' });
  });

  it("withdraw clears only that side's half, and the row goes with the last half", () => {
    inviteBoth(CASTER);
    expect(withdrawCaster(db, { bookingId, by: CAPT_A, caster: CASTER })).toEqual({ ok: true, value: { side: 'a' } });
    expect(castersOf(db, bookingId)).toEqual([{ steamid: CASTER, name: expect.any(String), a: false, b: true }]);
    expect(withdrawCaster(db, { bookingId, by: CAPT_A, caster: CASTER })).toEqual({ ok: false, error: 'not_person' });
    expect(withdrawCaster(db, { bookingId, by: STRANGER, caster: CASTER })).toEqual({ ok: false, error: 'not_manager' });
    expect(withdrawCaster(db, { bookingId, by: CAPT_B, caster: CASTER }).ok).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM booking_casters').get()).toEqual({ n: 0 });
  });

  it('logs every write as a booking event', () => {
    inviteBoth(CASTER);
    withdrawCaster(db, { bookingId, by: CAPT_A, caster: CASTER });
    const events = db.prepare("SELECT actor, event, detail FROM booking_events WHERE booking_id = ? AND event LIKE 'caster_%' ORDER BY id")
      .all(bookingId) as { actor: string; event: string; detail: string }[];
    expect(events.map((e) => [e.actor, e.event, JSON.parse(e.detail)])).toEqual([
      [CAPT_A, 'caster_invited', { steamid: CASTER, side: 'a' }],
      [CAPT_B, 'caster_invited', { steamid: CASTER, side: 'b' }],
      [CAPT_A, 'caster_withdrawn', { steamid: CASTER, side: 'a' }],
    ]);
  });
});

describe('visibility', () => {
  it('a half-invited caster sees nothing, from either side alone', () => {
    expect(inviteCaster(db, { bookingId, by: CAPT_A, caster: HALF }).ok).toBe(true);
    expect(fullyInvited(db, bookingId, HALF)).toBe(false);
    expect(hidesGame(HALF)).toBe(true);
    withdrawCaster(db, { bookingId, by: CAPT_A, caster: HALF });
    expect(inviteCaster(db, { bookingId, by: CAPT_B, caster: HALF }).ok).toBe(true);
    expect(hidesGame(HALF)).toBe(true);
  });

  it('a fully invited caster sees the game in canViewMatch and visibleMatchesSql', () => {
    expect(hidesGame(CASTER)).toBe(true);
    inviteBoth(CASTER);
    expect(fullyInvited(db, bookingId, CASTER)).toBe(true);
    expect(seesGame(CASTER)).toBe(true);
  });

  it('a caster whose is_caster is cleared, or who is banned, loses access at once', () => {
    inviteBoth(CASTER);
    db.prepare('UPDATE players SET is_caster = 0 WHERE steamid = ?').run(CASTER);
    expect(fullyInvited(db, bookingId, CASTER)).toBe(false);
    expect(hidesGame(CASTER)).toBe(true);
    db.prepare('UPDATE players SET is_caster = 1 WHERE steamid = ?').run(CASTER);
    expect(seesGame(CASTER)).toBe(true);
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(CASTER);
    expect(hidesGame(CASTER)).toBe(true);
  });

  it("an invite on one booking shows nothing of another booking's game", () => {
    inviteBoth(CASTER);
    const other = Number(db.prepare(
      `INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility)
       VALUES (1, 'completed', 'no_mercy', NULL, NULL, 'in_game', 'scrim', 'participants')`,
    ).run().lastInsertRowid);
    expect(canViewMatch(db, viewerFor(db, CASTER), other)).toBe(false);
    expect(visibleIds(CASTER)).not.toContain(other);
  });
});

describe('routes', () => {
  it('fully invited sees the game and its replay timeline over HTTP; half-invited gets 404', async () => {
    db.prepare("UPDATE matches SET state = 'completed', ended_at = '2026-10-01 12:00:00' WHERE id = ?").run(gameId);
    inviteBoth(CASTER);
    expect(inviteCaster(db, { bookingId, by: CAPT_A, caster: HALF }).ok).toBe(true);
    const listed = async (who: string) => ((await call('GET', '/api/matches', who)).json().matches as { id: number }[]).map((m) => m.id);
    expect((await call('GET', `/api/matches/${gameId}`, CASTER)).statusCode).toBe(200);
    expect((await call('GET', `/api/replays/timeline/${gameId}/1/1`, CASTER)).statusCode).toBe(200);
    expect(await listed(CASTER)).toContain(gameId);
    expect((await call('GET', `/api/matches/${gameId}`, HALF)).statusCode).toBe(404);
    expect((await call('GET', `/api/replays/timeline/${gameId}/1/1`, HALF)).statusCode).toBe(404);
    expect(await listed(HALF)).not.toContain(gameId);
  });

  it('GET /api/bookings/casters lists casters in good standing, behind the competitive switch', async () => {
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(HALF);
    const r = await call('GET', '/api/bookings/casters', CAPT_A);
    expect(r.statusCode).toBe(200);
    expect(r.json().casters.map((c: { steamid: string }) => c.steamid)).toEqual([CASTER]);
    db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/bookings/casters', CAPT_A)).statusCode).toBe(404);
  });

  it('invite and withdraw answer the fresh view with each half; refusals carry the reason', async () => {
    const a = await call('POST', `/api/bookings/${bookingId}/casters`, CAPT_A, { steamid: CASTER });
    expect(a.statusCode).toBe(200);
    expect(a.json().casters).toEqual([{ steamid: CASTER, name: expect.any(String), a: true, b: false }]);
    const b = await call('POST', `/api/bookings/${bookingId}/casters`, CAPT_B, { steamid: CASTER });
    expect(b.json().casters[0]).toMatchObject({ a: true, b: true });
    const notCaster = await call('POST', `/api/bookings/${bookingId}/casters`, CAPT_A, { steamid: STRANGER });
    expect(notCaster.statusCode).toBe(400);
    expect(notCaster.json().error).toBe('That player is not a caster.');
    // A stranger is not shown the booking at all.
    expect((await call('POST', `/api/bookings/${bookingId}/casters`, STRANGER, { steamid: CASTER })).statusCode).toBe(404);
    const w = await call('POST', `/api/bookings/${bookingId}/casters/${CASTER}/withdraw`, CAPT_B);
    expect(w.statusCode).toBe(200);
    expect(w.json().casters[0]).toMatchObject({ a: true, b: false });
  });

  it('no booking route ever carries the tv_password, for a side or for staff', async () => {
    ready();
    inviteBoth(CASTER);
    const tv = tvPassword();
    const bodies = [
      await call('GET', `/api/bookings/${bookingId}`, CAPT_A),
      await call('GET', `/api/bookings/${bookingId}`, CAPT_B),
      await call('GET', `/api/bookings/${bookingId}`, ADMIN),
      await call('GET', `/api/bookings/${bookingId}`, MOD),
      await call('GET', '/api/bookings/casters', CAPT_A),
      await call('GET', '/api/bookings/mine', CAPT_A),
      await call('GET', '/api/bookings/options', CAPT_A),
      await call('POST', `/api/bookings/${bookingId}/casters`, CAPT_A, { steamid: HALF }),
      await call('POST', `/api/bookings/${bookingId}/casters/${HALF}/withdraw`, CAPT_A),
    ];
    for (const r of bodies) {
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain(tv);
      expect(r.body).not.toContain('tv_password');
    }
    // A fully invited caster is not shown the booking page at all.
    expect((await call('GET', `/api/bookings/${bookingId}`, CASTER)).statusCode).toBe(404);
  });
});

describe('/api/cast for booked games', () => {
  beforeEach(ready);
  const listed = async (who: string) => (await call('GET', '/api/cast', who)).json().matches as {
    id: number; booked: boolean; connect: unknown; spectate: { host: string; port: number; password: string } | null;
  }[];

  it("lists the game to a fully invited caster with the booking's relay password and no game server line", async () => {
    inviteBoth(CASTER);
    const [m] = await listed(CASTER);
    expect(m).toMatchObject({ id: gameId, booked: true, connect: null, spectate: { host: '9.9.9.9', port: 27120, password: tvPassword() } });
    expect(m.spectate!.password).not.toBe('servertv');
    expect(JSON.stringify(m)).not.toContain(getBooking(db, bookingId)!.password);
  });

  it('lists it to staff without any invite', async () => {
    const [m] = await listed(ADMIN);
    expect(m).toMatchObject({ id: gameId, booked: true, connect: null, spectate: { password: tvPassword() } });
  });

  it('never to a half-invited or uninvited caster', async () => {
    expect(inviteCaster(db, { bookingId, by: CAPT_B, caster: HALF }).ok).toBe(true);
    expect(await listed(HALF)).toEqual([]);
    expect(await listed(CASTER)).toEqual([]);
  });

  it('drops a fully invited caster the moment their flag is cleared or they are banned', async () => {
    inviteBoth(CASTER);
    expect(await listed(CASTER)).toHaveLength(1);
    db.prepare('UPDATE players SET is_caster = 0 WHERE steamid = ?').run(CASTER);
    expect((await call('GET', '/api/cast', CASTER)).statusCode).toBe(403);
    db.prepare('UPDATE players SET is_caster = 1 WHERE steamid = ?').run(CASTER);
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(CASTER);
    expect((await call('GET', '/api/cast', CASTER)).statusCode).toBe(403);
  });
});
