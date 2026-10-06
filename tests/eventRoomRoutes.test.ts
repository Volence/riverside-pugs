import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { Notifier } from '../src/notify/notify.js';
import { eventRoutes } from '../src/routes/events.js';
import { adminEventRoutes } from '../src/routes/adminEvents.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { authedCookie, stubOrchestrator } from './helpers.js';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import * as E from '../src/events/events.js';
import * as S from '../src/events/schedule.js';
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

  it('rules on a technical pause from the desk, shows the ledger to the desk with names and to the public without reasons (plan T5)', async () => {
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS });
    // A technical pause as R.noteTech writes it during a game (test setup only: noteTech itself needs a box phase).
    E.logEvent(f.db, f.eventId, A[0]!, 'tech_pause', new Date().toISOString(),
      { matchId: f.matchId, gameMatchId: 0, techId: 1_791_000_000, side: 'a', cause: 'call', by: A[0], reason: 'router', used: 0, budget: 300 });
    const pauseId = R.techPausesOf(f.db, P.getMatch(f.db, f.matchId)!)[0]!.id;
    expect((await post(`${base()}/tech-penalty`, MOD, { pauseId, penalty: 'warning' })).statusCode).toBe(403);
    expect((await post(`${base()}/tech-penalty`, ADMIN, { pauseId: 999_999, penalty: 'warning' })).json()).toEqual({ error: EVENT_ERRORS.pause_not_found.text });
    expect((await post(`${base()}/tech-penalty`, ADMIN, { pauseId, penalty: 'ban' })).json()).toEqual({ error: EVENT_ERRORS.bad_penalty.text });
    expect((await post(`${base()}/tech-penalty`, ADMIN, { pauseId, penalty: 'forfeit' })).json()).toEqual({ error: EVENT_ERRORS.no_live_game.text });
    expect((await post(`${base()}/tech-penalty`, ADMIN, { pauseId, penalty: 'warning', note: 'once' })).statusCode).toBe(200);
    expect((await post(`${base()}/tech-penalty`, ADMIN, { pauseId, penalty: 'warning' })).json()).toEqual({ error: EVENT_ERRORS.already_penalized.text });
    expect(audit().filter((a) => a === 'event_tech_penalty')).toHaveLength(1);
    const play = (await get(`/api/admin/events/${f.eventId}/play`, MOD)).json();
    const row = play.stages[0].rounds[0].matches.find((m: { id: number }) => m.id === f.matchId);
    expect(row.desk.pauses).toEqual([expect.objectContaining({ id: pauseId, side: 'a', cause: 'call', reason: 'router', penalty: 'warning', penaltyNote: 'once', live: false, flagged: false })]);
    expect((await get(room())).json().pauses).toEqual([expect.objectContaining({ id: pauseId, side: 'a', reason: null, penalty: 'warning', flagNote: null })]);
    expect((await get(room(), A[1])).json().pauses[0].reason).toBe('router');
    expect((await get(room(), B[1])).json().pauses[0].reason).toBe('router');
    expect((await get(room(), OUTSIDER)).json().pauses[0].reason).toBeNull();
  });

  it('shows a pause the box never closed as ended when its game ended (final review)', async () => {
    R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS });
    const gameMatchId = Number(f.db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'dead_air')").run().lastInsertRowid);
    const endedAt = '2026-10-07T21:30:00.000Z';
    f.db.prepare("INSERT INTO event_games (event_match_id, ordinal, campaign, match_id, created_at, ended_at) VALUES (?, 1, 'dead_air', ?, ?, ?)")
      .run(f.matchId, gameMatchId, '2026-10-07T20:00:00.000Z', endedAt);
    E.logEvent(f.db, f.eventId, A[0]!, 'tech_pause', '2026-10-07T21:20:00.000Z',
      { matchId: f.matchId, gameMatchId, techId: 1_791_000_000, side: 'a', cause: 'call', by: A[0], reason: 'router', used: 0, budget: 300 });
    E.logEvent(f.db, f.eventId, B[0]!, 'tech_pause', '2026-10-07T21:25:00.000Z',
      { matchId: f.matchId, gameMatchId: 0, techId: 1_791_000_100, side: 'b', cause: 'call', by: B[0], reason: 'mouse', used: 0, budget: 300 });
    const pauses = (await get(room())).json().pauses as { side: string; endedAt: string | null }[];
    expect(pauses.find((p) => p.side === 'a')!.endedAt).toBe(endedAt);
    // A pause of a game still running (or not recorded yet) stays open.
    expect(pauses.find((p) => p.side === 'b')!.endedAt).toBeNull();
  });
});

describe('reschedules over HTTP (plan T4)', () => {
  const MOD = '76561199000000711';
  const toWindow = () => {
    f.db.prepare("UPDATE event_stages SET scheduling = 'window' WHERE id = ?").run(f.stageId);
    f.db.prepare('UPDATE event_matches SET window_start = ?, window_end = ? WHERE id = ?').run(days(0), days(7), f.matchId);
  };
  const scheduleLogs = () => (f.db.prepare("SELECT action FROM event_log WHERE action IN ('schedule_set', 'schedule_applied') ORDER BY id").all() as { action: string }[]).map((r) => r.action);

  it('proposes, counters, withdraws and answers through the routes, with the sentences', async () => {
    toWindow();
    const time = days(3);
    const t4 = days(4);
    const t5 = days(5);
    expect((await post(`${room()}/propose`, OUTSIDER, { time })).json()).toEqual({ error: EVENT_ERRORS.not_manager.text });
    expect((await post(`${room()}/propose`, A[0], { time: 'soon' })).json()).toEqual({ error: EVENT_ERRORS.bad_time.text });
    expect((await post(`${room()}/propose`, A[0], { time, note: 'after work' })).statusCode).toBe(200);
    expect((await post(`${room()}/propose`, B[0], { time })).json()).toEqual({ error: EVENT_ERRORS.proposal_open.text });
    expect((await get(room(), B[0])).json().schedule).toMatchObject({ proposal: { side: 'a', note: 'after work' }, canAnswer: true });
    // The open proposal is public like the veto log; outsiders never get the buttons.
    expect((await get(room())).json().schedule).toMatchObject({ proposal: { side: 'a' }, canPropose: false, canAnswer: false, canWithdraw: false });
    expect((await post(`${room()}/respond`, A[0], { accept: true })).json()).toEqual({ error: EVENT_ERRORS.own_proposal.text });
    expect((await post(`${room()}/withdraw`, B[0])).json()).toEqual({ error: EVENT_ERRORS.not_your_proposal.text });
    expect((await post(`${room()}/counter`, B[0], { time: t4 })).statusCode).toBe(200);
    expect(S.proposalsOf(f.db, f.matchId).map((p) => [p.side, p.status])).toEqual([['a', 'countered'], ['b', 'open']]);
    expect((await post(`${room()}/withdraw`, B[0])).statusCode).toBe(200);
    expect((await post(`${room()}/respond`, A[0], { accept: true })).json()).toEqual({ error: EVENT_ERRORS.no_proposal.text });
    expect((await post(`${room()}/propose`, B[0], { time: t5 })).statusCode).toBe(200);
    expect((await post(`${room()}/respond`, A[1], { accept: 'yes' })).statusCode).toBe(400);
    expect((await post(`${room()}/respond`, A[1], { accept: true })).statusCode).toBe(200);
    const v = (await get(room())).json();
    expect(v.schedule).toMatchObject({ scheduledAt: t5, source: 'agreed', proposal: null });
    expect(v.schedule.log).toHaveLength(3);
  });

  it('shows a proposal note only to the two rosters and staff; times and the log stay public (final review)', async () => {
    toWindow();
    const [t3, t4] = [days(3), days(4)];
    expect((await post(`${room()}/propose`, A[0], { time: t3, note: 'after work' })).statusCode).toBe(200);
    expect((await post(`${room()}/counter`, B[0], { time: t4, note: 'late shift' })).statusCode).toBe(200);
    for (const who of [A[2], B[2], ADMIN]) {
      const s = (await get(room(), who)).json().schedule;
      expect(s.proposal, who).toMatchObject({ time: t4, note: 'late shift' });
      expect(s.log[0], who).toMatchObject({ time: t3, note: 'after work' });
    }
    for (const who of [OUTSIDER, undefined]) {
      const s = (await get(room(), who)).json().schedule;
      expect(s.proposal).toMatchObject({ side: 'b', time: t4 });
      expect(s.proposal).not.toHaveProperty('note');
      expect(s.log[0]).toMatchObject({ side: 'a', time: t3, status: 'countered' });
      expect(s.log[0]).not.toHaveProperty('note');
    }
  });

  it('the desk\'s Open room closes an open proposal as room_opened (final review)', async () => {
    toWindow();
    expect((await post(`${room()}/propose`, A[0], { time: days(3) })).statusCode).toBe(200);
    expect((await post(`/api/admin/events/${f.eventId}/matches/${f.matchId}/open-room`, ADMIN)).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('veto');
    expect(S.proposalsOf(f.db, f.matchId).map((p) => p.status)).toEqual(['expired']);
    const row = f.db.prepare("SELECT detail FROM event_log WHERE action = 'reschedule_expired'").get() as { detail: string };
    expect(JSON.parse(row.detail)).toMatchObject({ reason: 'room_opened' });
  });

  it('refuses every reschedule route on a rolling stage, signed out, and behind the closed switch', async () => {
    for (const action of ['propose', 'respond', 'counter', 'withdraw']) {
      expect((await post(`${room()}/${action}`, A[0], { time: days(3), accept: true })).json(), action).toEqual({ error: EVENT_ERRORS.not_schedulable.text });
      // Signed out has no competitive access, so allowedActive answers the closed switch's 404 (as on every room write).
      expect((await app.inject({ method: 'POST', url: `${room()}/${action}`, payload: { time: days(3) } })).statusCode, action).toBe(404);
    }
    toWindow();
    f.db.prepare("UPDATE settings SET value = 'off' WHERE key = 'competitive_enabled'").run();
    expect((await post(`${room()}/propose`, A[0], { time: days(3) })).statusCode).toBe(404);
    expect(S.proposalsOf(f.db, f.matchId)).toEqual([]);
  });

  it('staff set a time and the round schedule from the desk, admin only, with audit rows', async () => {
    toWindow();
    cookies[MOD] = authedCookie(app, f.db, MOD);
    f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    const base = `/api/admin/events/${f.eventId}`;
    const t2 = days(2);
    const t3 = days(3);
    const t7 = days(7);
    const t0 = P.getMatch(f.db, f.matchId)!.window_start!;
    expect((await post(`${base}/matches/${f.matchId}/set-time`, A[0], { time: t2 })).statusCode).toBe(403);
    expect((await post(`${base}/matches/${f.matchId}/set-time`, MOD, { time: t2 })).statusCode).toBe(403);
    expect((await post(`${base}/matches/${f.matchId}/set-time`, ADMIN, { time: 'x' })).json()).toEqual({ error: EVENT_ERRORS.bad_time.text });
    expect((await post(`${base}/matches/${f.matchId}/set-time`, ADMIN, { time: t2 })).statusCode).toBe(200);
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ scheduled_at: t2, schedule_source: 'staff' });
    const rounds = [{ round: 1, at: t3, from: t0, to: t7 }];
    expect((await post(`${base}/stages/${f.stageId}/schedule`, A[0], { rounds })).statusCode).toBe(403);
    expect((await post(`${base}/stages/${f.stageId}/schedule`, MOD, { rounds })).statusCode).toBe(403);
    expect((await post(`${base}/stages/${f.stageId}/schedule`, ADMIN, { rounds: 'x' })).json()).toEqual({ error: EVENT_ERRORS.bad_schedule.text });
    // A refused schedule never reaches applySchedule.
    expect(scheduleLogs()).toEqual([]);
    expect((await post(`${base}/stages/${f.stageId}/schedule`, ADMIN, { rounds })).json()).toEqual({ stamped: 1 });
    expect(E.scheduleOf(E.getStage(f.db, f.stageId)!)).toEqual([{ round: 1, at: t3, from: t0, to: t7 }]);
    expect(scheduleLogs()).toEqual(['schedule_set', 'schedule_applied']);
    // Applied at once on a live stage: the window follows; the staff-set time is kept.
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ scheduled_at: t2, schedule_source: 'staff', window_end: t7 });
    expect(f.db.prepare("SELECT action FROM admin_actions WHERE action IN ('event_match_time', 'event_schedule_set') ORDER BY id").all())
      .toEqual([{ action: 'event_match_time' }, { action: 'event_schedule_set' }]);
    expect((await post(`${base}/stages/999/schedule`, ADMIN, { rounds })).statusCode).toBe(404);
    expect((await post(`${base}/matches/999999/set-time`, ADMIN, { time: t2 })).statusCode).toBe(404);
  });

  it('sets and applies a stage schedule in one transaction: a fault applying it keeps neither', async () => {
    toWindow();
    const t0 = P.getMatch(f.db, f.matchId)!.window_start!;
    f.db.exec("CREATE TRIGGER fail_apply BEFORE INSERT ON event_log WHEN NEW.action = 'schedule_applied' BEGIN SELECT RAISE(ABORT, 'apply failed'); END");
    const res = await post(`/api/admin/events/${f.eventId}/stages/${f.stageId}/schedule`, ADMIN, { rounds: [{ round: 1, at: days(3), from: t0, to: days(6) }] });
    expect(res.statusCode).toBe(500);
    expect(E.getStage(f.db, f.stageId)!.schedule_json).toBeNull();
    expect(scheduleLogs()).toEqual([]);
    expect(P.getMatch(f.db, f.matchId)!.window_end).not.toBe(null);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'event_schedule_set'").get()).toEqual({ n: 0 });
  });
});

describe('reschedule DMs and pushes (plan T4 Ruling 11)', () => {
  let bare: FastifyInstance;
  let send: ReturnType<typeof vi.fn>;
  let pushChange: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    f.db.prepare("UPDATE event_stages SET scheduling = 'window' WHERE id = ?").run(f.stageId);
    f.db.prepare('UPDATE event_matches SET window_start = ?, window_end = ? WHERE id = ?').run(days(0), days(7), f.matchId);
    send = vi.fn(() => 1);
    pushChange = vi.fn();
    bare = Fastify();
    await bare.register(cookie, { secret: 'x'.repeat(32) });
    const opts = { db: f.db, store: () => { throw new Error('no store'); }, notifier: { send } as unknown as Notifier, publicUrl: 'https://x', rooms: { pushChange } as unknown as RoomClock };
    await bare.register(eventRoutes, opts);
    await bare.register(adminEventRoutes, opts);
    await bare.ready();
  });
  afterEach(async () => { await bare.close(); });
  const bpost = (url: string, as: string, body: object = {}) => bare.inject({ method: 'POST', url, cookies: authedCookie(bare, f.db, as), payload: body });
  const calls = () => send.mock.calls.map(([to, type, payload]) => ({ to: [...(to as string[])].sort(), type: type as string, content: (payload as { content: string }).content }));
  const mgrsA = [A[0]!, A[1]!].sort();
  const mgrsB = [B[0]!];
  /** Both rosters as rosterA and rosterB build them (A[5] is not on Rats' roster). */
  const rosters = [...A.slice(0, 5), ...B.slice(0, 4)].sort();

  it('tells the side that must act next, both sides of a withdrawal, and both rosters of a locked time', async () => {
    expect((await bpost(`${room()}/propose`, A[0], { time: days(3) })).statusCode).toBe(200);
    expect((await bpost(`${room()}/counter`, B[0], { time: days(4) })).statusCode).toBe(200);
    expect((await bpost(`${room()}/withdraw`, B[0])).statusCode).toBe(200);
    expect((await bpost(`${room()}/propose`, A[0], { time: days(3) })).statusCode).toBe(200);
    expect((await bpost(`${room()}/respond`, B[0], { accept: false })).statusCode).toBe(200);
    expect((await bpost(`${room()}/propose`, B[0], { time: days(5) })).statusCode).toBe(200);
    expect((await bpost(`${room()}/respond`, A[1], { accept: true })).statusCode).toBe(200);
    const c = calls();
    expect(c.map((x) => [x.type, x.to])).toEqual([
      ['event_reschedule', mgrsB],
      ['event_reschedule', mgrsA],
      ['event_reschedule', [...mgrsB, ...mgrsA].sort()],
      ['event_reschedule', mgrsB],
      ['event_reschedule', mgrsA],
      ['event_reschedule', mgrsA],
      ['event_match_time', rosters],
    ]);
    expect(pushChange.mock.calls).toEqual(Array(7).fill([f.matchId]));
    // A refusal sends nothing and pushes nothing.
    expect((await bpost(`${room()}/withdraw`, A[0])).statusCode).toBe(409);
    expect(send).toHaveBeenCalledTimes(7);
    expect(pushChange).toHaveBeenCalledTimes(7);
  });

  it('a staff time tells both rosters as staff set, and a stage schedule pushes every waiting match', async () => {
    expect((await bpost(`/api/admin/events/${f.eventId}/matches/${f.matchId}/set-time`, ADMIN, { time: days(2) })).statusCode).toBe(200);
    const c = calls();
    expect(c.map((x) => x.type)).toEqual(['event_match_time']);
    expect(c[0]!.to).toEqual(rosters);
    expect(c[0]!.content).toMatch(/staff set/i);
    expect(pushChange.mock.calls).toEqual([[f.matchId]]);
    const t0 = P.getMatch(f.db, f.matchId)!.window_start!;
    expect((await bpost(`/api/admin/events/${f.eventId}/stages/${f.stageId}/schedule`, ADMIN, { rounds: [{ round: 1, at: days(3), from: t0, to: days(6) }] })).statusCode).toBe(200);
    const waiting = P.matchesOf(f.db, f.stageId).filter((m) => m.status === 'waiting').map((m) => [m.id]);
    expect(waiting.length).toBeGreaterThan(0);
    expect(pushChange.mock.calls.slice(1)).toEqual(waiting);
  });
});
