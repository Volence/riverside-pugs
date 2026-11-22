// tests/castRoom.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { castStudioRoutes } from '../src/routes/castStudio.js';
import { overlayKey } from '../src/cast/key.js';
import { getStudio } from '../src/cast/studio.js';
import { canCastRoom, pickableRooms } from '../src/cast/room.js';
import { SCENES, SCENE_HOTKEYS, SCENE_LABELS } from '../src/cast/types.js';
import { setSetting } from '../src/settings.js';
import * as R from '../src/events/room.js';
import { authedCookie } from './helpers.js';
import { ADMIN } from './eventFixture.js';
import { A, B, OUTSIDER } from './entryFixture.js';
import { TIMERS, fakeBooking, roomFixture, type RoomFixture } from './roomFixture.js';

/** Owner 2026-11-22 (DT2): the tournament room scene for OBS. Casters and
 *  admins (the studio's gate) may follow any published room; it carries the
 *  public room only. */
const SECRET = 'k'.repeat(32);
const CASTER = '76561199000000901';
const PLAYER = OUTSIDER;
let f: RoomFixture;
let app: FastifyInstance;

async function setup(): Promise<void> {
  f = await roomFixture({ startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), now: new Date() });
  setSetting(f.db, 'competitive_enabled', 'everyone');
  R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS });
  app = Fastify();
  await app.register(cookie, { secret: SECRET });
  await app.register(castStudioRoutes, {
    db: f.db,
    config: { cookieSecret: SECRET, publicUrl: 'http://localhost', replayDir: mkdtempSync(join(tmpdir(), 'castroom-')), replayLiveDir: '' },
    store: () => { throw new Error('no community store in this test'); },
  });
  await app.ready();
  for (const s of [CASTER, PLAYER, ADMIN]) authedCookie(app, f.db, s);
  f.db.prepare('UPDATE players SET is_caster = 1 WHERE steamid = ?').run(CASTER);
  f.db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
}
afterEach(async () => { await app?.close(); });

const as = (who: string, method: 'GET' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, payload, cookies: authedCookie(app, f.db, who) });
const feed = (who: string) => app.inject({
  method: 'GET', url: `/api/overlay/feed?k=${encodeURIComponent(overlayKey(SECRET, who, getStudio(f.db, who).keyGen))}`,
});

describe('the room scene', () => {
  it('is a scene with its own letter key, after the run of show', () => {
    expect(SCENES[SCENES.length - 1]).toBe('room');
    expect(SCENE_HOTKEYS.room).toBe('V');
    expect(new Set(Object.values(SCENE_HOTKEYS)).size).toBe(SCENES.length);
    expect(SCENE_LABELS.room).toBe('Tournament room');
  });
});

describe('who may follow a tournament room', () => {
  it('a caster and an admin may; an ordinary player may not', async () => {
    await setup();
    expect(canCastRoom(f.db, CASTER, f.matchId)).toBe(true);
    expect(canCastRoom(f.db, ADMIN, f.matchId)).toBe(true);
    expect(canCastRoom(f.db, PLAYER, f.matchId)).toBe(false);
    expect(pickableRooms(f.db, CASTER)).toEqual([expect.objectContaining({ id: f.matchId, a: 'Rats', b: 'Bats', phase: 'ready', finished: false })]);
    expect(pickableRooms(f.db, PLAYER)).toEqual([]);
    // The studio itself refuses the player outright.
    expect((await as(PLAYER, 'GET', '/api/cast/studio')).statusCode).toBe(403);
    expect((await as(PLAYER, 'PUT', '/api/cast/studio', { roomMatchId: f.matchId })).statusCode).toBe(403);
  });

  it('a caster who loses the role loses the overlay feed at once', async () => {
    await setup();
    expect((await as(CASTER, 'PUT', '/api/cast/studio', { roomMatchId: f.matchId, scene: 'room' })).statusCode).toBe(200);
    expect((await feed(CASTER)).json().room).toMatchObject({ id: f.matchId });
    f.db.prepare('UPDATE players SET is_caster = 0 WHERE steamid = ?').run(CASTER);
    expect((await feed(CASTER)).statusCode).toBe(403);
  });

  it('an unpublished event, an unknown match, or a room past its six hours is not offered', async () => {
    await setup();
    expect(canCastRoom(f.db, CASTER, 999_999)).toBe(false);
    f.db.prepare("UPDATE events SET status = 'draft' WHERE id = ?").run(f.eventId);
    expect(canCastRoom(f.db, CASTER, f.matchId)).toBe(false);
    f.db.prepare("UPDATE events SET status = 'live' WHERE id = ?").run(f.eventId);
    const done = new Date(Date.now() - 7 * 3_600_000).toISOString();
    f.db.prepare("UPDATE event_matches SET status = 'done', finished_at = ? WHERE id = ?").run(done, f.matchId);
    expect(canCastRoom(f.db, CASTER, f.matchId)).toBe(false);
    f.db.prepare('UPDATE event_matches SET finished_at = ? WHERE id = ?').run(new Date().toISOString(), f.matchId);
    expect(pickableRooms(f.db, CASTER)).toEqual([expect.objectContaining({ id: f.matchId, finished: true, phase: 'done' })]);
  });
});

describe('the overlay feed follows a room', () => {
  it('serves the public room to a caster and an admin, never a viewer view', async () => {
    await setup();
    for (const who of [CASTER, ADMIN]) {
      expect((await as(who, 'PUT', '/api/cast/studio', { roomMatchId: f.matchId, scene: 'room' })).json().studio).toMatchObject({ roomMatchId: f.matchId, scene: 'room' });
      const res = await feed(who);
      expect(res.statusCode).toBe(200);
      expect(res.json().room).toMatchObject({ id: f.matchId, eventSlug: f.slug, phase: 'ready', me: null, a: { name: 'Rats' }, b: { name: 'Bats' } });
      expect(res.json().room.server).toBeNull();
    }
    // The panel lists it.
    expect((await as(CASTER, 'GET', '/api/cast/studio')).json().rooms).toEqual([expect.objectContaining({ id: f.matchId })]);
  });

  it('keeps lineups secret until both are locked, as the public room page does', async () => {
    await setup();
    for (const s of [A[0]!, B[0]!]) R.readyUp(f.db, { matchId: f.matchId, steamid: s, timers: TIMERS });
    for (const [s, step, action, campaign] of [[A[0]!, 0, 'first', null], [A[0]!, 1, 'ban', 'dead_air'], [B[0]!, 2, 'survivors', null]] as const) {
      R.actVeto(f.db, { matchId: f.matchId, steamid: s, step, action, campaign, timers: TIMERS });
    }
    R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0]!, steamids: A.slice(0, 4), timers: TIMERS });
    await as(CASTER, 'PUT', '/api/cast/studio', { roomMatchId: f.matchId });
    const room = (await feed(CASTER)).json().room;
    expect(room.lineups).toEqual({ a: null, b: null, aLocked: true, bLocked: false });
    expect(room.log.map((l: { action: string }) => l.action)).toEqual(['first', 'ban', 'survivors']);
    expect(room.pool.find((c: { slug: string }) => c.slug === 'dead_air')).toMatchObject({ state: 'banned', by: 'a' });
  });

  it('with no room picked, follows the room of the followed tournament booking', async () => {
    await setup();
    const booking = fakeBooking(f, new Date());
    f.db.prepare('UPDATE event_matches SET booking_id = ? WHERE id = ?').run(booking, f.matchId);
    expect((await as(CASTER, 'PUT', '/api/cast/studio', { bookingId: booking })).statusCode).toBe(200);
    expect((await feed(CASTER)).json().room).toMatchObject({ id: f.matchId });
  });

  it('drops a room that went off air on the next save instead of refusing the save', async () => {
    await setup();
    await as(CASTER, 'PUT', '/api/cast/studio', { roomMatchId: f.matchId });
    f.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(f.eventId);
    expect((await feed(CASTER)).json().room).toBeNull();
    const r = await as(CASTER, 'PUT', '/api/cast/studio', { roomMatchId: f.matchId, scene: 'brb' });
    expect(r.statusCode).toBe(200);
    expect(r.json().studio).toMatchObject({ roomMatchId: null, scene: 'brb' });
  });
});
