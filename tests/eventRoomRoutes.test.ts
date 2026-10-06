import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import * as E from '../src/events/events.js';
import { RoomClock } from '../src/events/roomClock.js';
import { SeriesEngine } from '../src/events/series.js';
import { ADMIN, must, stageBody } from './eventFixture.js';
import { A, B, OUTSIDER } from './entryFixture.js';
import { TIMERS, driveToBooking, roomFixture, type RoomFixture } from './roomFixture.js';
import { createTournamentBooking, getBooking } from '../src/bookings/bookings.js';
import { EVENT_ERRORS } from '../src/events/validate.js';

let f: RoomFixture;
let app: FastifyInstance;
const cookies: Record<string, Record<string, string>> = {};
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeEach(async () => {
  f = await roomFixture({ startsAt: days(9), now: new Date() });
  app = await buildServer({
    config: { ...loadConfig({}), communityDir: mkdtempSync(join(tmpdir(), 'rooms-')) }, db: f.db, orchestrator: stubOrchestrator(),
    serverCleaner: async () => {}, serverExec: async () => {},
  });
  for (const s of [...A, ...B, OUTSIDER, ADMIN]) cookies[s] = authedCookie(app, f.db, s);
});
afterEach(async () => { vi.restoreAllMocks(); await app.close(); });

const get = (url: string, as?: string) => app.inject({ method: 'GET', url, cookies: as ? cookies[as] : undefined });
const post = (url: string, as: string, body: object = {}) => app.inject({ method: 'POST', url, cookies: cookies[as], payload: body });
const room = () => `/api/events/${f.slug}/matches/${f.matchId}`;

describe('match room over HTTP', () => {
  it('reads a room signed out, and 404s a match of another event or an unknown id', async () => {
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS });
    const res = await get(room());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: f.matchId, phase: 'ready', me: null });
    expect((await get(`/api/events/${f.slug}/matches/999999`)).statusCode).toBe(404);
  });

  it('runs ready, veto and lineup through the routes, refusing with sentences', async () => {
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS });
    expect((await post(`${room()}/ready`, OUTSIDER)).json()).toEqual({ error: 'Only the team captain or a co-captain can do that.' });
    expect((await post(`${room()}/ready`, A[0])).statusCode).toBe(200);
    expect((await post(`${room()}/ready`, B[0])).statusCode).toBe(200);
    expect((await post(`${room()}/veto`, B[0], { step: 0, action: 'first' })).json()).toEqual({ error: 'It is the other team\'s turn.' });
    expect((await post(`${room()}/veto`, A[0], { step: 0, action: 'first' })).statusCode).toBe(200);
    expect((await post(`${room()}/veto`, A[0], { step: 1, action: 'ban', campaign: 'dead_air' })).statusCode).toBe(200);
    expect((await post(`${room()}/veto`, B[0], { step: 2, action: 'survivors' })).statusCode).toBe(200);
    expect((await post(`${room()}/lineup`, A[0], { steamids: [A[0], A[1], A[2], A[3]] })).statusCode).toBe(200);
    const mid = (await get(room(), B[1])).json();
    expect(mid.lineups).toEqual({ a: null, b: null, aLocked: true, bLocked: false });
    expect((await post(`${room()}/lineup`, B[0], { steamids: B.slice(0, 4) })).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('booking');
  });

  it('reads and saves preferences for the team\'s managers only', async () => {
    const url = `/api/events/${f.slug}/entries/${f.entryA}/prefs`;
    expect((await get(url, A[3])).statusCode).toBe(403);
    expect((await get(url, B[0])).statusCode).toBe(403);
    expect((await get(url, A[1])).json()).toMatchObject({ entryId: f.entryA, side: null });
    expect((await post(url, A[1], { defaultFour: null, side: 'infected', campaigns: { [String(f.stageId)]: ['dead_air'] } })).statusCode).toBe(200);
    expect((await get(url, ADMIN)).json()).toMatchObject({ side: 'infected' });
  });
});

describe('admin room tools', () => {
  it('opens, holds and resets a room, admin only', async () => {
    const base = `/api/admin/events/${f.eventId}/matches/${f.matchId}`;
    expect((await post(`${base}/open-room`, A[0])).statusCode).toBe(403);
    expect((await post(`${base}/open-room`, ADMIN)).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('veto');
    expect((await post(`${base}/hold`, ADMIN, { reason: ' x ' })).statusCode).toBe(400);
    expect((await post(`${base}/hold`, ADMIN, { reason: 'Server trouble' })).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'admin_hold', hold_reason: 'Server trouble' });
    expect((await post(`${base}/reset-room`, ADMIN)).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('waiting');
    const log = f.db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'event_room%' OR action = 'event_hold' ORDER BY id").all();
    expect(log).toEqual([{ action: 'event_room_open' }, { action: 'event_hold' }, { action: 'event_room_reset' }]);
  });
});

describe('final review: rooms follow results, disqualifications and cancels', () => {
  const MOD = '76561199000000711';
  const base = () => `/api/admin/events/${f.eventId}/matches/${f.matchId}`;
  const open = () => R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS });

  it('404s a match id asked for under another event', async () => {
    open();
    const other = must(E.createEvent(f.db, { by: ADMIN, fields: { name: 'Other Cup', startsAt: days(9), entryKind: 'team' } }));
    must(E.addStage(f.db, { eventId: other.id, by: ADMIN, stage: stageBody(f.db, { advanceCount: null }) }));
    must(E.publishEvent(f.db, { eventId: other.id, by: ADMIN }));
    expect((await get(`/api/events/${other.slug}`)).statusCode).toBe(200);
    expect((await get(`/api/events/${other.slug}/matches/${f.matchId}`)).statusCode).toBe(404);
    expect((await get(room())).statusCode).toBe(200);
  });

  it('answers 403 to a mod on the admin room tools', async () => {
    cookies[MOD] = authedCookie(app, f.db, MOD);
    f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    for (const action of ['open-room', 'reset-room', 'hold']) {
      expect((await post(`${base()}/${action}`, MOD, { reason: 'Server trouble' })).statusCode, action).toBe(403);
    }
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('waiting');
  });

  it('pushes the room when an admin result closes it', async () => {
    open();
    const push = vi.spyOn(RoomClock.prototype, 'pushChange');
    expect((await post(`${base()}/result`, ADMIN, { winner: 'a', scoreA: 9, scoreB: 1 })).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('done');
    expect(push).toHaveBeenCalledWith(f.matchId);
  });

  it('pushes every room a disqualification closed', async () => {
    open();
    const push = vi.spyOn(RoomClock.prototype, 'pushChange');
    const res = await post(`/api/admin/events/${f.eventId}/entries/${f.entryB}/disqualify`, ADMIN, { reason: 'Broke the rules' });
    expect(res.statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('forfeit');
    expect(push).toHaveBeenCalledWith(f.matchId);
  });

  it('resets and pushes every open room when the event is cancelled', async () => {
    open();
    const push = vi.spyOn(RoomClock.prototype, 'pushChange');
    expect((await post(`/api/admin/events/${f.eventId}/cancel`, ADMIN, { reason: 'Called off' })).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'waiting', deadline: null, room_opened_at: null });
    const reset = f.db.prepare("SELECT actor FROM event_log WHERE action = 'room_reset'").all();
    expect(reset).toEqual([{ actor: ADMIN }]);
    expect(push).toHaveBeenCalledWith(f.matchId);
  });
});

describe('confirm, dispute and reset over HTTP (plan T3b)', () => {
  const booked = () => {
    driveToBooking(f);
    const r = createTournamentBooking(f.db, {
      region: 'na', campaign: 'no_mercy', rulesJson: '{}', rulesetId: null, gameConfig: 'standard', createdBy: ADMIN,
      sides: [{ teamId: null, captain: A[0]!, players: A.slice(0, 4), spectators: [] }, { teamId: null, captain: B[0]!, players: B.slice(0, 4), spectators: [] }],
    });
    if (!r.ok) throw new Error(r.error);
    if (!R.attachBooking(f.db, { matchId: f.matchId, bookingId: r.value.id }).ok) throw new Error('attach');
    return r.value.id;
  };

  it('confirms and disputes in the window, for managers only', async () => {
    booked();
    R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15 });
    R.startLive(f.db, { matchId: f.matchId });
    expect((await post(`${room()}/confirm`, A[0])).json()).toEqual({ error: 'This match is not in its confirm window.' });
    // startConfirm needs the series over (T3b Task 2 ruling): game 1 is seeded as played.
    f.db.prepare('UPDATE event_games SET score_a = 400, score_b = 300 WHERE event_match_id = ?').run(f.matchId);
    expect(R.startConfirm(f.db, { matchId: f.matchId, timers: TIMERS }).ok).toBe(true);
    expect((await post(`${room()}/confirm`, OUTSIDER)).statusCode).toBe(403);
    expect((await post(`${room()}/confirm`, A[1])).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.confirm_a_at).not.toBeNull();
    expect((await post(`${room()}/dispute`, B[0], { reason: 'no' })).json()).toEqual({ error: expect.stringContaining('A reason is') });
    expect((await post(`${room()}/dispute`, B[0], { reason: 'Rats had five on map 2' })).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'admin_hold', hold_reason: 'dispute', dispute_side: 'b' });
    expect((await get(room(), OUTSIDER)).json().dispute).toMatchObject({ side: 'b', reason: 'Rats had five on map 2' });
  });

  it('resets a booked room through the engine, cancelling the booking', async () => {
    const bookingId = booked();
    expect((await post(`/api/admin/events/${f.eventId}/matches/${f.matchId}/reset-room`, ADMIN)).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'waiting', booking_id: null });
    expect(getBooking(f.db, bookingId)).toMatchObject({ state: 'cancelled', end_reason: 'staff' });
  });

  it('cancelling the event resets a live booked room through the engine, cancelling its booking', async () => {
    const bookingId = booked();
    R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15 });
    R.startLive(f.db, { matchId: f.matchId });
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('live');
    expect((await post(`/api/admin/events/${f.eventId}/cancel`, ADMIN, { reason: 'Called off' })).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'waiting', booking_id: null });
    expect(['cancelled', 'ending']).toContain(getBooking(f.db, bookingId)!.state);
  });

  it('answers 200 for a committed pick on a live match even when the engine throws after it', async () => {
    booked();
    f.db.prepare("UPDATE event_matches SET status = 'live' WHERE id = ?").run(f.matchId);
    const act = vi.spyOn(R, 'actVeto').mockReturnValue({ ok: true, value: P.getMatch(f.db, f.matchId)! });
    const after = vi.spyOn(SeriesEngine.prototype, 'afterPick').mockImplementation(() => { throw new Error('boom'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(`${room()}/veto`, A[0]!, { step: 3, action: 'pick', campaign: 'no_mercy' });
    expect(res.statusCode).toBe(200);
    expect(act).toHaveBeenCalled();
    expect(after).toHaveBeenCalledWith(f.matchId);
    expect(err.mock.calls.some((c) => String(c[0]).includes('after the pick'))).toBe(true);
  });
});

describe('the desk tools (plan T3c)', () => {
  const MOD = '76561199000000711';
  const base = () => `/api/admin/events/${f.eventId}/matches/${f.matchId}`;
  const audit = () => (f.db.prepare("SELECT action FROM admin_actions WHERE action LIKE 'event_%' ORDER BY id").all() as { action: string }[]).map((a) => a.action);
  beforeEach(() => {
    cookies[MOD] = authedCookie(app, f.db, MOD);
    f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
  });

  it('acts for a team: ready, a veto step and a lineup, each audited and logged as the admin', async () => {
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS });
    expect((await post(`${base()}/act`, ADMIN, { kind: 'ready', side: 'c' })).statusCode).toBe(400);
    expect((await post(`${base()}/act`, ADMIN, { kind: 'ready', side: 'a' })).statusCode).toBe(200);
    expect((await post(`${base()}/act`, ADMIN, { kind: 'ready', side: 'b' })).statusCode).toBe(200);
    expect((await post(`${base()}/act`, ADMIN, { kind: 'veto', side: 'b', step: 0, action: 'first' })).json()).toEqual({ error: EVENT_ERRORS.not_your_turn.text });
    expect((await post(`${base()}/act`, ADMIN, { kind: 'veto', side: 'a', step: 0, action: 'first' })).statusCode).toBe(200);
    expect((await post(`${base()}/act`, ADMIN, { kind: 'veto', side: 'a', step: 1, action: 'ban', campaign: 'dead_air' })).statusCode).toBe(200);
    expect((await post(`${base()}/act`, ADMIN, { kind: 'veto', side: 'b', step: 2, action: 'survivors' })).statusCode).toBe(200);
    expect((await post(`${base()}/act`, ADMIN, { kind: 'lineup', side: 'a', steamids: A.slice(0, 4) })).statusCode).toBe(200);
    expect((await post(`${base()}/act`, ADMIN, { kind: 'lineup', side: 'b', steamids: B.slice(0, 4) })).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('booking');
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE actor = ? AND action IN ('room_ready','veto_action','lineup_locked')").get(ADMIN)).toEqual({ n: 7 });
    expect(audit().filter((a) => a === 'event_act_for_team')).toHaveLength(7);
    expect((await post(`${base()}/act`, MOD, { kind: 'ready', side: 'a' })).statusCode).toBe(403);
  });

  it('shows the hold reason, the dispute and the freeze to the desk only, and reopens, extends, releases and freezes through the routes', async () => {
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS });
    for (const s of [A[0], B[0]]) await post(`${room()}/ready`, s);
    expect((await post(`${base()}/hold`, ADMIN, { reason: 'Checking something' })).statusCode).toBe(200);
    const play = (await get(`/api/admin/events/${f.eventId}/play`, MOD)).json();
    const row = play.stages[0].rounds[0].matches.find((m: { id: number }) => m.id === f.matchId);
    expect(row.desk).toMatchObject({ holdReason: 'Checking something', holdFrom: 'veto', dispute: null, frozen: false, liveGame: null, subs: { a: 0, b: 0 } });
    const pub = (await get(`/api/events/${f.slug}`)).json();
    expect(pub.play[0].rounds[0].matches[0].desk).toBeUndefined();
    expect((await post(`${base()}/release-hold`, ADMIN)).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('veto');
    expect((await post(`${base()}/release-hold`, ADMIN)).json()).toEqual({ error: EVENT_ERRORS.not_held.text });
    await post(`${room()}/veto`, A[0], { step: 0, action: 'first' });
    expect((await post(`${base()}/reopen-veto`, ADMIN)).statusCode).toBe(200);
    expect(R.vetoActions(f.db, f.matchId)).toEqual([]);
    expect((await post(`${base()}/extend-grace`, ADMIN, { minutes: 5 })).json()).toEqual({ error: EVENT_ERRORS.not_connect_phase.text });
    expect((await post(`${base()}/freeze`, ADMIN)).json()).toEqual({ error: EVENT_ERRORS.not_live_phase.text });
    expect((await post(`${base()}/move-server`, ADMIN)).json()).toEqual({ error: EVENT_ERRORS.not_live_phase.text });
    expect((await post(`${base()}/replay-chapter`, ADMIN, { ordinal: 0 })).json()).toEqual({ error: EVENT_ERRORS.not_live_phase.text });
    expect(audit()).toEqual(['event_hold', 'event_hold_release', 'event_veto_reopen']);
    for (const action of ['act', 'reopen-veto', 'replay-chapter', 'move-server', 'extend-grace', 'release-hold', 'freeze', 'unfreeze']) {
      expect((await post(`${base()}/${action}`, MOD, { kind: 'ready', side: 'a', ordinal: 0, minutes: 5 })).statusCode, action).toBe(403);
    }
  });
});
