// tests/draftRoomRoutes.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { draftRoomRoutes } from '../src/routes/draftRoom.js';
import { DraftClock } from '../src/events/draftClock.js';
import * as DR from '../src/events/draftRoom.js';
import type { Notifier } from '../src/notify/notify.js';
import { EVENT_ERRORS, type EventError } from '../src/events/validate.js';
import { authedCookie } from './helpers.js';
import { ADMIN } from './eventFixture.js';
import { cutDraft, type DraftFixture } from './draftFixture.js';
import { ALL, BENCH, CAPTAINS, POOL, T0, liveDraft, must } from './draftRoomFixture.js';

const MOD = '76561199000000777';
let f: DraftFixture;
let app: FastifyInstance;
let clock: DraftClock;
let t: number;
const push = vi.fn();
const send = vi.fn(() => 1);

async function build(fx: DraftFixture): Promise<void> {
  f = fx;
  t = T0.getTime();
  push.mockReset();
  send.mockClear();
  clock = new DraftClock({ db: f.db, now: () => t, push });
  app = Fastify();
  await app.register(cookie, { secret: 'x'.repeat(32) });
  await app.register(draftRoomRoutes, { db: f.db, clock, notifier: { send } as unknown as Notifier, publicUrl: 'https://x' });
  await app.ready();
  authedCookie(app, f.db, MOD);
  f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
}
afterEach(async () => { await app?.close(); });
const as = (s: string) => authedCookie(app, f.db, s);
const get = (url: string, who?: string) => app.inject({ method: 'GET', url, cookies: who ? as(who) : undefined });
const post = (url: string, who: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: as(who), payload: body });
const put = (url: string, who: string, body: object) => app.inject({ method: 'PUT', url, cookies: as(who), payload: body });
const room = (p = '') => `/api/events/${f.slug}/draft${p}`;
const desk = (a: string) => `/api/admin/events/${f.eventId}/draft/room/${a}`;
const text = (k: EventError) => ({ error: EVENT_ERRORS[k].text });
const start = () => must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date(t), present: ALL }));

describe('the public room', () => {
  it('serves anyone once the cut is published, and nothing private', async () => {
    await build(liveDraft());
    const res = await get(room());
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v).toMatchObject({ eventId: f.eventId, slug: f.slug, status: 'ready', totalPicks: 15, onClock: null, picks: [], lists: null, notes: null, staff: false });
    expect(v.me).toEqual({ role: null, team: null, onClock: false, list: null, chemistry: null });
    expect(v.order.map((o: { steamid: string }) => o.steamid)).toEqual(CAPTAINS);
    expect(v.pool).toHaveLength(15);
    expect(Object.keys(v.pool[0]).sort()).toEqual(['avatar', 'bestClass', 'form', 'infected', 'name', 'pugs', 'skills', 'sr', 'steamid', 'survivor', 'trend']);
  });

  it('answers 409 before the cut and 404 behind a closed switch', async () => {
    await build(cutDraft({ publish: false }));
    const res = await get(room());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(text('cut_not_published'));
    f.db.prepare("UPDATE settings SET value = 'admins' WHERE key = 'competitive_enabled'").run();
    expect((await get(room())).statusCode).toBe(404);
  });

  it('shows status none, captains only on the board, when staff chose auto-balance', async () => {
    const fx = cutDraft({ balance: true });
    await build(fx);
    const v = (await get(room())).json();
    expect(v.status).toBe('none');
    expect(v.teams.every((t: { players: unknown[] }) => t.players.length === 0)).toBe(true);
  });
});

describe('Start from the desk', () => {
  it('starts the room, pushes it and DMs every captain the room link; a mod cannot', async () => {
    await build(liveDraft());
    expect((await post(desk('start'), MOD)).statusCode).toBe(403);
    const res = await post(desk('start'), ADMIN);
    expect(res.statusCode).toBe(200);
    expect(push).toHaveBeenCalledWith(f.eventId);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(CAPTAINS, 'draft_room_open', expect.objectContaining({
      content: `The live draft for Draft Night has started and you are a captain. If you are not in the room when your turn comes, the site picks for you from your pick list. Join now: https://x/event/${f.slug}/draft`,
    }));
    expect((await get(room())).json().status).toBe('running');
  });

  it('saves settings, and runs pause, resume, undo, delegate and reset, each pushed', async () => {
    await build(liveDraft());
    expect((await post(desk('settings'), ADMIN, { firstPick: 'random', pickSeconds: 999 })).json()).toEqual(text('bad_room_settings'));
    expect((await post(desk('settings'), ADMIN, { firstPick: 'highest_sr', pickSeconds: 60 })).statusCode).toBe(200);
    expect((await post(desk('start'), ADMIN)).statusCode).toBe(200);
    expect((await get(room())).json().order[0].steamid).toBe(CAPTAINS[4]);
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[4]!, player: POOL[0]!, pickNo: 1, now: new Date(t), present: ALL }));
    push.mockReset();
    for (const a of ['pause', 'resume', 'undo']) expect((await post(desk(a), ADMIN)).statusCode, a).toBe(200);
    expect((await post(desk('delegate'), ADMIN, { captain: CAPTAINS[4] })).statusCode).toBe(400);
    expect((await post(desk('delegate'), ADMIN, { captain: CAPTAINS[4], on: true })).json()).toEqual(text('no_delegate'));
    expect((await post(desk('reset'), ADMIN)).statusCode).toBe(200);
    expect(push).toHaveBeenCalledTimes(4);
  });

  it('serves the staff view to a mod', async () => {
    await build(liveDraft());
    const v = (await get(`/api/admin/events/${f.eventId}/draft/room`, MOD)).json();
    expect(v.staff).toBe(true);
    expect(Object.keys(v.lists).sort()).toEqual([...CAPTAINS].sort());
    expect((await get(`/api/admin/events/${f.eventId}/draft/room`, POOL[0])).statusCode).toBe(403);
  });
});

describe('picking', () => {
  it('takes a pick from the captain on the clock and refuses a stale pickNo, the wrong person and a bad body', async () => {
    await build(liveDraft());
    start();
    const ok = await post(room('/pick'), CAPTAINS[0]!, { player: POOL[0], pickNo: 1 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ pickNo: 1, done: false });
    expect(push).toHaveBeenCalledWith(f.eventId);
    expect((await post(room('/pick'), CAPTAINS[0]!, { player: POOL[1], pickNo: 1 })).json()).toEqual(text('pick_moved'));
    expect((await post(room('/pick'), CAPTAINS[0]!, { player: POOL[1], pickNo: 2 })).json()).toEqual(text('not_your_pick'));
    expect((await post(room('/pick'), POOL[5]!, { player: POOL[1], pickNo: 2 })).statusCode).toBe(403);
    expect((await post(room('/pick'), CAPTAINS[1]!, { player: 3, pickNo: 2 })).statusCode).toBe(400);
    expect(clock.present(f.eventId)(CAPTAINS[0]!)).toBe(true);
  });

  it('records heartbeats from captains only', async () => {
    await build(liveDraft());
    expect((await post(room('/heartbeat'), CAPTAINS[2]!)).json()).toEqual({ ok: true });
    expect((await post(room('/heartbeat'), POOL[2]!)).json()).toEqual({ ok: true });
    expect(clock.present(f.eventId)(CAPTAINS[2]!)).toBe(true);
    expect(clock.present(f.eventId)(POOL[2]!)).toBe(false);
  });
});

describe('lists and cards', () => {
  it('saves and reads a captain\'s own list, and refuses anyone else', async () => {
    await build(liveDraft());
    expect((await put(room('/list'), CAPTAINS[0]!, { list: [POOL[2], BENCH] })).json()).toEqual({ list: [POOL[2]] });
    expect((await get(room('/list'), CAPTAINS[0]!)).json()).toEqual({ list: [POOL[2]] });
    expect((await put(room('/list'), POOL[0]!, { list: [] })).json()).toEqual(text('not_a_captain'));
    expect((await get(room('/list'), POOL[0]!)).statusCode).toBe(403);
  });

  it('gives captains and staff every pool card with notes; chemistry only to a captain', async () => {
    await build(liveDraft());
    f.db.prepare('UPDATE draft_signups SET note = ? WHERE event_id = ? AND steamid = ?').run('prefer infected', f.eventId, POOL[1]);
    const mine = (await get(room('/cards'), CAPTAINS[0]!)).json();
    expect(mine.cards).toHaveLength(15);
    expect(mine.notes).toEqual({ [POOL[1]!]: 'prefer infected' });
    expect(Object.keys(mine.chemistry)).toHaveLength(15);
    expect(mine.chemistry[POOL[0]!]).toEqual({ together: 0, wonTogether: 0, against: 0, wonAgainst: 0 });
    const staff = (await get(room('/cards'), MOD)).json();
    expect(staff.chemistry).toBeNull();
    expect(staff.notes).toEqual({ [POOL[1]!]: 'prefer infected' });
    expect((await get(room('/cards'), POOL[0]!)).statusCode).toBe(403);
  });
});
