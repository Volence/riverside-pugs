// tests/draftRoomPrivacy.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { draftRoomRoutes } from '../src/routes/draftRoom.js';
import { DraftClock } from '../src/events/draftClock.js';
import * as DR from '../src/events/draftRoom.js';
import { authedCookie } from './helpers.js';
import { ADMIN } from './eventFixture.js';
import type { DraftFixture } from './draftFixture.js';
import { ALL, BENCH, CAPTAINS, POOL, T0, at, drive, liveDraft, must } from './draftRoomFixture.js';

/** Spec, Testing: chemistry, captains' lists, signup notes and the fairness
 *  readout never appear in any response for a viewer who is not staff, not
 *  the organizer and not the owning captain (Ruling 14). */
const NOTE = 'secret note 7731';
const MOD = '76561199000000777';
const ORG = '76561199000000778';
const LIST_A = [POOL[9]!, POOL[8]!];
const LIST_B = [POOL[3]!];
let f: DraftFixture;
let app: FastifyInstance;

async function setup(): Promise<void> {
  f = liveDraft();
  f.db.prepare('UPDATE draft_signups SET note = ? WHERE event_id = ? AND steamid = ?').run(NOTE, f.eventId, POOL[4]);
  must(DR.savePickList(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, list: LIST_A, now: T0 }));
  must(DR.savePickList(f.db, { eventId: f.eventId, steamid: CAPTAINS[1]!, list: LIST_B, now: T0 }));
  must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0, present: ALL }));
  drive(f, 1);
  app = Fastify();
  await app.register(cookie, { secret: 'x'.repeat(32) });
  await app.register(draftRoomRoutes, { db: f.db, clock: new DraftClock({ db: f.db, now: () => at(5).getTime() }) });
  await app.ready();
  authedCookie(app, f.db, MOD);
  f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  authedCookie(app, f.db, ORG);
  f.db.prepare('UPDATE events SET organizer_steamid = ? WHERE id = ?').run(ORG, f.eventId);
}
afterEach(async () => { await app?.close(); });
const get = (url: string, who: string | null) => app.inject({ method: 'GET', url, cookies: who ? authedCookie(app, f.db, who) : undefined });
const FAIRNESS = ['avgSr', 'totalSr', 'spread', 'winA', 'forecasts'];

describe('draft room privacy', () => {
  it('shows a plain viewer, a pool player and the bench no list, note, chemistry or fairness', async () => {
    await setup();
    for (const who of [null, POOL[0]!, BENCH, POOL[5]!]) {
      const res = await get(`/api/events/${f.slug}/draft`, who);
      expect(res.statusCode, String(who)).toBe(200);
      const body = res.body;
      const v = res.json();
      expect(body).not.toContain(NOTE);
      expect(body).not.toContain('"together"');
      expect(body).not.toContain(JSON.stringify(LIST_A));
      expect(body).not.toContain(JSON.stringify(LIST_B));
      for (const k of FAIRNESS) expect(body).not.toContain(`"${k}"`);
      expect(v.lists).toBeNull();
      expect(v.notes).toBeNull();
      expect(v.me).toMatchObject({ list: null, chemistry: null });
      if (who) {
        expect((await get(`/api/events/${f.slug}/draft/cards`, who)).statusCode).toBe(403);
        expect((await get(`/api/events/${f.slug}/draft/list`, who)).statusCode).toBe(403);
        expect((await get(`/api/admin/events/${f.eventId}/draft/room`, who)).statusCode).toBe(403);
      }
    }
  });

  it('shows a captain their own list and chemistry, never another captain\'s list', async () => {
    await setup();
    const res = await get(`/api/events/${f.slug}/draft`, CAPTAINS[1]!);
    const v = res.json();
    expect(v.me.list).toEqual(LIST_B);
    expect(Object.keys(v.me.chemistry)).toHaveLength(15);
    expect(v.lists).toBeNull();
    expect(res.body).not.toContain(JSON.stringify(LIST_A));
    expect(v.notes).toEqual({ [POOL[4]!]: NOTE });
    for (const k of FAIRNESS) expect(res.body).not.toContain(`"${k}"`);
  });

  it('shows staff and the organizer every list, and the notes', async () => {
    await setup();
    for (const who of [MOD, ORG]) {
      const v = (await get(`/api/events/${f.slug}/draft`, who)).json();
      expect(v.lists).toEqual({ [CAPTAINS[0]!]: LIST_A, [CAPTAINS[1]!]: LIST_B, [CAPTAINS[2]!]: [], [CAPTAINS[3]!]: [], [CAPTAINS[4]!]: [] });
      expect(v.notes).toEqual({ [POOL[4]!]: NOTE });
      expect(v.me.chemistry).toBeNull();
    }
  });

  it('gives a delegate notes, role, team and chemistry, but never a pick list', async () => {
    await setup();
    const { delegate } = must(DR.setDelegate(f.db, { eventId: f.eventId, actor: ADMIN, now: T0, captain: CAPTAINS[0]!, on: true }));
    const res = await get(`/api/events/${f.slug}/draft`, delegate!);
    const v = res.json();
    expect(v.me).toMatchObject({ role: 'delegate', team: CAPTAINS[0], list: null });
    expect(Object.keys(v.me.chemistry)).toHaveLength(14);
    expect(v.me.chemistry[delegate!]).toBeUndefined();
    expect(v.notes).toEqual({ [POOL[4]!]: NOTE });
    expect(v.lists).toBeNull();
    expect(res.body).not.toContain(JSON.stringify(LIST_A));
    expect((await get(`/api/events/${f.slug}/draft/list`, delegate!)).statusCode).toBe(403);
  });
});
