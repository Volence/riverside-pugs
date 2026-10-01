import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { addServer } from '../src/serverPool.js';
import { cancelBooking, confirmBooking, createBooking, holdBox, markReady, markSetup } from '../src/bookings/bookings.js';
import { bookingRoutes } from '../src/routes/bookings.js';
import type { BookingRunner } from '../src/bookings/runner.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const P = Array.from({ length: 4 }, (_, i) => `7656119900000030${i}`);
const ADMIN = '76561199000000390';
const MOD = '76561199000000391';
const START = new Date(Date.now() + 3 * 24 * 3_600_000);
START.setUTCMinutes(0, 0, 0);

let db: DB;
let app: FastifyInstance;
let cookies: Record<string, Record<string, string>>;

beforeEach(async () => {
  db = openDb(':memory:');
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'bookingroutes-')) },
    db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {},
    bookingRcon: async () => { throw new Error('no rcon in route tests'); },
  });
  cookies = {};
  for (const id of [...P, ADMIN, MOD]) cookies[id] = authedCookie(app, db, id);
  db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  db.prepare("UPDATE settings SET value = 'everyone' WHERE key = 'competitive_enabled'").run();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'map_pool'").run(JSON.stringify(['no_mercy', 'death_toll']));
  for (const n of ['a', 'bb', 'ccc']) {
    const id = addServer(db, { name: n, host: 'h', port: 27014 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
  }
});
afterEach(async () => { await app.close(); });

const call = (method: 'GET' | 'POST', url: string, as?: string, payload?: object) =>
  app.inject({ method, url, cookies: as ? cookies[as] : undefined, payload });
const create = async (as = P[0], opponent: object = { steamid: P[1] }) => {
  const r = await call('POST', '/api/bookings', as, { opponent, startsAt: START.toISOString(), minutes: 90, playlist: ['no_mercy'] });
  expect(r.statusCode).toBe(201);
  return r.json().id as number;
};

describe('the switch', () => {
  it('off hides every route from players; admins-only lets admins through', async () => {
    db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/bookings/mine', P[0])).statusCode).toBe(404);
    expect((await call('GET', '/api/bookings/mine')).statusCode).toBe(404);
    db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect((await call('GET', '/api/bookings/mine', ADMIN)).statusCode).toBe(200);
    expect((await call('GET', '/api/bookings/mine', P[0])).statusCode).toBe(404);
    expect((await call('GET', '/api/bookings/options')).statusCode).toBe(404);
  });

  it('staff in good standing open a booking page under admins and under off', async () => {
    const id = await create();
    for (const mode of ['admins', 'off']) {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'competitive_enabled'").run(mode);
      expect((await call('GET', `/api/bookings/${id}`, MOD)).statusCode).toBe(200);
      expect((await call('GET', `/api/bookings/${id}`, ADMIN)).statusCode).toBe(200);
      expect((await call('GET', `/api/bookings/${id}`, P[1])).statusCode).toBe(404);
    }
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(MOD);
    expect((await call('GET', `/api/bookings/${id}`, MOD)).statusCode).toBe(404);
  });
});

describe('booking flow', () => {
  it('options list the pool with typical lengths and the limits', async () => {
    const r = (await call('GET', '/api/bookings/options', P[0])).json();
    expect(r.campaigns.map((c: { slug: string }) => c.slug)).toEqual(['no_mercy', 'death_toll']);
    expect(r.campaigns[0].minutes).toBe(60);
    expect(r.limits).toEqual({ daysAhead: 14, playlistMax: 4 });
    expect(r.estimate).toEqual({ perCampaign: { no_mercy: 60, death_toll: 60 }, base: 15, slack: 10, step: 30, min: 60 });
    expect(r.rulesets.map((x: { name: string }) => x.name)).toContain('Casual Scrim');
    expect(r.rulesets.find((x: { name: string }) => x.name === 'Casual Scrim').summary)
      .toBe('Unlimited pauses · non-picker picks sides · 15 min no-show grace');
  });

  it('create, view, confirm, cancel', async () => {
    const id = await create();
    expect((await call('GET', `/api/bookings/${id}`, P[2])).statusCode).toBe(404);
    const v = (await call('GET', `/api/bookings/${id}`, P[1])).json();
    expect(v.viewer).toMatchObject({ side: 'b', invited: true });
    const refused = await call('POST', `/api/bookings/${id}/confirm`, P[2]);
    expect(refused.statusCode).toBe(404);
    const confirmed = await call('POST', `/api/bookings/${id}/confirm`, P[1]);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().sides[1].confirmed).toBe(true);
    const mine = (await call('GET', '/api/bookings/mine', P[1])).json();
    expect(mine.open.map((b: { id: number }) => b.id)).toEqual([id]);
    const cancelled = await call('POST', `/api/bookings/${id}/cancel`, P[1], { reason: 'cannot make it' });
    expect(cancelled.json()).toMatchObject({ state: 'cancelled', cancel: { side: 'b', reason: 'cannot make it' } });
  });

  it('people: add, accept, remove', async () => {
    const id = await create();
    await call('POST', `/api/bookings/${id}/confirm`, P[1]);
    const added = await call('POST', `/api/bookings/${id}/people`, P[0], { side: 'a', steamid: P[2], role: 'ringer' });
    expect(added.statusCode).toBe(200);
    expect((await call('POST', `/api/bookings/${id}/accept`, P[2])).statusCode).toBe(200);
    const removed = await call('POST', `/api/bookings/${id}/people/${P[2]}/remove`, P[0]);
    expect(removed.json().sides[0].people.map((p: { steamid: string }) => p.steamid)).toEqual([P[0]]);
  });

  it('notification preferences', async () => {
    const r = await call('POST', '/api/bookings/prefs', P[0], { type: 'booking_ready', enabled: false });
    expect(r.json().prefs.find((p: { type: string }) => p.type === 'booking_ready').enabled).toBe(false);
    expect((await call('POST', '/api/bookings/prefs', P[0], { type: 'nope', enabled: false })).statusCode).toBe(400);
  });
});

describe('the viewer\'s own pickup record (plan 2)', () => {
  it('/api/bookings/mine carries the record only for a captain with a pickup booking', async () => {
    expect((await call('GET', '/api/bookings/mine', P[0])).json().record).toBeUndefined();
    await create();
    expect((await call('GET', '/api/bookings/mine', P[0])).json().record).toEqual({ shown: 0, booked: 0, noShows: 0, lateCancels: 0, excused: 0 });
    // Side b's pickup captain has a pickup booking side too.
    expect((await call('GET', '/api/bookings/mine', P[1])).json().record).toBeDefined();
    expect((await call('GET', '/api/bookings/mine', P[2])).json().record).toBeUndefined();
  });

  it('says whether the record is public, so the page can word who sees it', async () => {
    await create();
    expect((await call('GET', '/api/bookings/mine', P[0])).json().recordPublic).toBe(false);
    db.prepare("UPDATE settings SET value = 'on' WHERE key = 'scrim_reliability_public'").run();
    expect((await call('GET', '/api/bookings/mine', P[0])).json().recordPublic).toBe(true);
    expect((await call('GET', '/api/bookings/mine', P[2])).json().recordPublic).toBeUndefined();
  });
});

describe('staff', () => {
  it('lists bookings for staff only, and a staff cancel is audited and counts against nobody', async () => {
    const id = await create();
    expect((await call('GET', '/api/admin/bookings', P[0])).statusCode).toBe(403);
    const list = (await call('GET', '/api/admin/bookings', MOD)).json();
    expect(list.bookings.map((b: { id: number }) => b.id)).toEqual([id]);
    expect((await call('POST', `/api/admin/bookings/${id}/cancel`, MOD, { reason: 'test' })).statusCode).toBe(200);
    expect(db.prepare('SELECT state, cancel_side FROM bookings WHERE id = ?').get(id)).toEqual({ state: 'cancelled', cancel_side: null });
    expect(db.prepare("SELECT action FROM admin_actions WHERE action = 'booking_cancel'").all()).toHaveLength(1);
  });
});

describe('next and stay (plan 4b, Task 7)', () => {
  /** Holds, sets up and readies a booking on server `a`, bypassing the
   *  runner's own rcon-driven setup (route tests build no fake box). */
  const ready = (id: number) => {
    const serverId = (db.prepare("SELECT id FROM servers WHERE name = 'a'").get() as { id: number }).id;
    const at = new Date();
    expect(holdBox(db, id, serverId, at)).toBe(true);
    markSetup(db, id, at);
    expect(markReady(db, id, at)).toBe(true);
  };

  it('a manager of a confirmed side can pick the next campaign or stay; a stranger gets 404', async () => {
    const r = await call('POST', '/api/bookings', P[0], {
      opponent: { steamid: P[1] }, startsAt: START.toISOString(), minutes: 90, playlist: ['no_mercy', 'death_toll'],
    });
    const id = r.json().id as number;
    await call('POST', `/api/bookings/${id}/confirm`, P[1]);
    ready(id);
    expect((await call('POST', `/api/bookings/${id}/next`, P[2])).statusCode).toBe(404);
    // Loading starts at once: by the time the route answers, the playlist has
    // already moved to death_toll's position (plan 4b, runner.chooseNext).
    const next = await call('POST', `/api/bookings/${id}/next`, P[0], { campaign: 'death_toll' });
    expect(next.statusCode).toBe(200);
    expect(next.json().state).toBe('ready');
    expect(db.prepare('SELECT playlist_pos, next_campaign FROM bookings WHERE id = ?').get(id))
      .toEqual({ playlist_pos: 1, next_campaign: null });
    const stay = await call('POST', `/api/bookings/${id}/stay`, P[1]);
    expect(stay.statusCode).toBe(200);
  });

  it('+1 campaign through the extend path: a named campaign is appended, staff may add one too', async () => {
    const id = await create();
    await call('POST', `/api/bookings/${id}/confirm`, P[1]);
    ready(id);
    const before = Date.parse((db.prepare('SELECT ends_at FROM bookings WHERE id = ?').get(id) as { ends_at: string }).ends_at);
    const bad = await call('POST', `/api/bookings/${id}/extend`, P[0], { campaign: 'the_sacrifice' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('Pick a campaign from the map pool.');
    const added = await call('POST', `/api/bookings/${id}/extend`, P[0], { campaign: 'death_toll' });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ gamesAllowed: 2, gamesPlayed: 0, closeAt: null, playlist: [{ slug: 'no_mercy' }, { slug: 'death_toll' }] });
    expect(Date.parse(added.json().endsAt)).toBe(before + 90 * 60_000);
    expect((await call('POST', `/api/admin/bookings/${id}/extend`, MOD, {})).statusCode).toBe(200);
    expect(db.prepare('SELECT games_allowed FROM bookings WHERE id = ?').get(id)).toEqual({ games_allowed: 3 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE booking_id = ? AND event = 'campaign_added'").get(id)).toEqual({ n: 2 });
  });

  it('refuses with the runner\'s own text when the caller does not manage a confirmed side', async () => {
    const id = await create();
    await call('POST', `/api/bookings/${id}/confirm`, P[1]);
    ready(id);
    const added = await call('POST', `/api/bookings/${id}/people`, P[0], { side: 'a', steamid: P[2], role: 'player' });
    expect(added.statusCode).toBe(200);
    expect((await call('POST', `/api/bookings/${id}/accept`, P[2])).statusCode).toBe(200);
    const next = await call('POST', `/api/bookings/${id}/next`, P[2], { campaign: 'death_toll' });
    expect(next.statusCode).toBe(409);
    expect(next.json().error).toBe('Only a captain or co-captain of that side can do that.');
    const stay = await call('POST', `/api/bookings/${id}/stay`, P[2]);
    expect(stay.statusCode).toBe(409);
    expect(stay.json().error).toBe('Only a captain or co-captain of that side can do that.');
  });

  it('a staff caller acting outside their own side is audited; one managing a side is not', async () => {
    const id = await create();
    await call('POST', `/api/bookings/${id}/confirm`, P[1]);
    ready(id);
    const next = await call('POST', `/api/bookings/${id}/next`, ADMIN, { campaign: 'death_toll' });
    expect(next.statusCode).toBe(200);
    expect(db.prepare("SELECT admin_id, action, target, detail FROM admin_actions WHERE action = 'booking_next'").all())
      .toEqual([{ admin_id: ADMIN, action: 'booking_next', target: String(id), detail: JSON.stringify({ campaign: 'death_toll' }) }]);
    const stay = await call('POST', `/api/bookings/${id}/stay`, ADMIN);
    expect(stay.statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'booking_stay'").get()).toEqual({ n: 1 });
    // The side-a captain (P[0]) also happens to be an admin here? No: P[0]
    // manages side a and is not staff, so acting as themselves never audits.
    expect((await call('POST', `/api/bookings/${id}/stay`, P[0])).statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'booking_stay'").get()).toEqual({ n: 1 });
  });

  it('a confirm still answers 200 even when allocate() throws', async () => {
    const id = await create();
    const stubRunner = {
      onConfirmed: () => {},
      allocate: () => { throw new Error('no idle box'); },
    } as unknown as BookingRunner;
    const bare = Fastify();
    await bare.register(cookie, { secret: 'x'.repeat(32) });
    await bare.register(bookingRoutes, { db, runner: stubRunner });
    await bare.ready();
    const as1 = authedCookie(bare, db, P[1]);
    const r = await bare.inject({ method: 'POST', url: `/api/bookings/${id}/confirm`, cookies: as1 });
    expect(r.statusCode).toBe(200);
    expect(r.json().sides[1].confirmed).toBe(true);
    await bare.close();
  });

  it('answers 503 for next and stay when no runner is wired (routes built bare)', async () => {
    const id = await create();
    await call('POST', `/api/bookings/${id}/confirm`, P[1]);
    const bare = Fastify();
    await bare.register(cookie, { secret: 'x'.repeat(32) });
    await bare.register(bookingRoutes, { db, runner: null });
    await bare.ready();
    const as0 = authedCookie(bare, db, P[0]);
    expect((await bare.inject({ method: 'POST', url: `/api/bookings/${id}/next`, cookies: as0 })).statusCode).toBe(503);
    expect((await bare.inject({ method: 'POST', url: `/api/bookings/${id}/stay`, cookies: as0 })).statusCode).toBe(503);
    await bare.close();
  });
});

describe('excusing a late cancel', () => {
  /** A confirmed booking side a cancelled an hour before the start. */
  const lateCancelled = async () => {
    const id = await create();
    await call('POST', `/api/bookings/${id}/confirm`, P[1]);
    const r = cancelBooking(db, { bookingId: id, by: P[0], now: new Date(START.getTime() - 3_600_000) });
    expect(r.ok).toBe(true);
    return id;
  };

  it('the other side excuses it and gets the fresh view; the cancelling side and strangers cannot', async () => {
    const id = await lateCancelled();
    const own = await call('POST', `/api/bookings/${id}/excuse`, P[0]);
    expect(own.statusCode).toBe(403);
    expect((await call('POST', `/api/bookings/${id}/excuse`, P[2])).statusCode).toBe(404);
    const before = (await call('GET', `/api/bookings/${id}`, P[1])).json();
    expect(before.sides[0]).toMatchObject({ lateCancel: true, excused: false, canExcuse: true });
    expect('record' in before.sides[0]).toBe(false);
    expect(before.sides[1].record).toBeDefined();
    const r = await call('POST', `/api/bookings/${id}/excuse`, P[1], { note: 'no hard feelings' });
    expect(r.statusCode).toBe(200);
    expect(r.json().sides[0]).toMatchObject({ lateCancel: true, excused: true, canExcuse: false });
    const again = await call('POST', `/api/bookings/${id}/excuse`, P[1]);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('That is already excused.');
  });

  it('staff excuse a side with a reason; players get 403 and the action is audited', async () => {
    const id = await lateCancelled();
    expect((await call('POST', `/api/admin/bookings/${id}/excuse`, P[1], { side: 'a' })).statusCode).toBe(403);
    expect((await call('POST', `/api/admin/bookings/${id}/excuse`, MOD, { side: 'b' })).statusCode).toBe(409);
    const r = await call('POST', `/api/admin/bookings/${id}/excuse`, MOD, { side: 'a', note: 'their server crashed' });
    expect(r.statusCode).toBe(200);
    expect(r.json().sides[0]).toMatchObject({ lateCancel: true, excused: true });
    expect(r.json().sides[0].record).toBeDefined();
    expect(db.prepare('SELECT excuse_note, excused_by FROM booking_sides WHERE booking_id = ? AND side = ?').get(id, 'a'))
      .toEqual({ excuse_note: 'their server crashed', excused_by: MOD });
    expect(db.prepare("SELECT action FROM admin_actions WHERE action = 'booking_excuse'").all()).toHaveLength(1);
  });
});

describe('private reviews (plan 2, Task 4)', () => {
  /** A confirmed scrim that closed (as ended) just now, by the real clock,
   *  since the routes have no clock of their own. */
  const endedNow = async () => {
    const id = await create();
    expect((await call('POST', `/api/bookings/${id}/confirm`, P[1])).statusCode).toBe(200);
    const t = new Date().toISOString();
    db.prepare("UPDATE bookings SET state = 'ended', end_reason = 'time', ending_at = ?, ended_at = ? WHERE id = ?").run(t, t, id);
    return id;
  };

  it('a side manager reviews and edits; the answer carries only their own review, and the other side never sees it', async () => {
    const id = await endedNow();
    expect((await call('POST', `/api/bookings/${id}/review`, P[2], { thumbs: 1, tags: [] })).statusCode).toBe(404);
    const bad = await call('POST', `/api/bookings/${id}/review`, P[0], { thumbs: 0, tags: [] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('A review is a thumbs up or down, with tags from the list, each once.');
    const r = await call('POST', `/api/bookings/${id}/review`, P[0], { thumbs: -1, tags: ['toxic', 'left_early'] });
    expect(r.statusCode).toBe(200);
    expect(r.json().review).toEqual({ open: true, mine: { thumbs: -1, tags: ['toxic', 'left_early'] } });
    expect(r.json().reviews).toBeUndefined();
    const edit = await call('POST', `/api/bookings/${id}/review`, P[0], { thumbs: 1, tags: ['toxic'] });
    expect(edit.json().review.mine).toEqual({ thumbs: 1, tags: ['toxic'] });
    // The reviewed side: its own (empty) review slot, and nothing of the other.
    const other = await call('GET', `/api/bookings/${id}`, P[1]);
    expect(other.json().review).toEqual({ open: true, mine: null });
    expect(other.json().reviews).toBeUndefined();
    expect(other.body).not.toContain('toxic');
    // Staff see both sides' rows.
    const staff = (await call('GET', `/api/bookings/${id}`, MOD)).json();
    expect(staff.reviews).toEqual([expect.objectContaining({ side: 'a', reviewer: P[0], thumbs: 1, tags: ['toxic'] })]);
  });

  it('a booking that has not closed refuses with wrong_state', async () => {
    const id = await create();
    await call('POST', `/api/bookings/${id}/confirm`, P[1]);
    const r = await call('POST', `/api/bookings/${id}/review`, P[0], { thumbs: 1, tags: [] });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('The booking is past that point.');
  });

  it('the admin Bookings list flags a toxic side for staff only', async () => {
    const listed = await create();
    // Three earlier scrims against P[1], each tagged toxic by side a.
    const nowMs = Date.now();
    for (let k = 1; k <= 3; k++) {
      const start = new Date(START.getTime() + k * 24 * 3_600_000);
      const r = createBooking(db, { by: P[0], opponent: { steamid: P[1] }, startsAt: start.toISOString(), minutes: 60, playlist: ['no_mercy'], now: new Date(nowMs) });
      if (!r.ok) throw new Error(r.error);
      confirmBooking(db, { bookingId: r.value.id, by: P[1], now: new Date(nowMs) });
      const t = new Date(nowMs).toISOString();
      db.prepare("UPDATE bookings SET state = 'ended', end_reason = 'time', ending_at = ?, ended_at = ? WHERE id = ?").run(t, t, r.value.id);
      db.prepare("INSERT INTO scrim_reviews (booking_id, by_side, reviewer, thumbs, tags_json, created_at, updated_at) VALUES (?, 'a', ?, -1, '[\"toxic\"]', ?, ?)")
        .run(r.value.id, P[0], t, t);
    }
    expect((await call('GET', '/api/admin/bookings', P[0])).statusCode).toBe(403);
    expect((await call('GET', '/api/admin/bookings')).statusCode).toBe(401);
    const list = (await call('GET', '/api/admin/bookings', MOD)).json().bookings as { id: number; toxic: { a: boolean; b: boolean } }[];
    expect(list.find((b) => b.id === listed)!.toxic).toEqual({ a: false, b: true });
    // Nothing a player can reach carries the flag.
    const own = await call('GET', `/api/bookings/${listed}`, P[1]);
    expect(own.body).not.toContain('toxic');
  });
});
