import { describe, it, expect } from 'vitest';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import { recordResultFlow } from '../src/events/flow.js';
import { ADMIN, NOW } from './eventFixture.js';
import { A, B } from './entryFixture.js';
import { playFixture, SWISS } from './playFixture.js';
import { presetConfig } from '../src/events/vetoConfig.js';
import { POOL7, TIMERS, fakeBooking, fakeMatch, roomFixture, type RoomFixture } from './roomFixture.js';

const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
const open = (f: RoomFixture, now = NOW) => ok(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now }));
const lastAction = (f: RoomFixture) => (f.db.prepare('SELECT action, actor FROM event_log ORDER BY id DESC LIMIT 1').get() as { action: string; actor: string | null });

describe('openRoom', () => {
  it('moves a waiting match to the ready phase with a deadline, the higher seed and the coin seed', async () => {
    const f = await roomFixture();
    const m = open(f);
    expect(m).toMatchObject({ status: 'veto', room_higher: 'a', room_seed: 0, ready_a_at: null, ready_b_at: null, deadline: at(10).toISOString() });
    expect(lastAction(f)).toEqual({ action: 'room_opened', actor: null });
  });

  it('refuses a match that is not waiting, and a team already in another open room', async () => {
    const f = await roomFixture();
    open(f);
    expect(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW })).toEqual({ ok: false, error: 'wrong_status' });
    expect(R.busyEntries(f.db, f.eventId)).toEqual(new Set([f.entryA, f.entryB]));
  });

  it('refuses entry_busy for a match that shares a team with one whose room is already open', () => {
    const g = playFixture({ stages: [SWISS(2, null)], entries: 4 });
    const [e1, e2, e3, e4] = g.entries as [number, number, number, number];
    ok(P.startEvent(g.db, {
      eventId: g.eventId, by: ADMIN, now: NOW,
      plan: { stageId: g.stages[0]!, entrants: g.entries, bracket: null, rounds: [{ round: 1, pairs: [[e1, e2], [e3, e4]], bye: null }] },
    }));
    const [match1] = P.matchesOf(g.db, g.stages[0]!);
    // A second waiting match, built by hand, that shares entry e1 with match1 (test setup only).
    const at = NOW.toISOString();
    const match3Id = Number(g.db.prepare(
      `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, entry_a, entry_b, status, winner_entry, created_at, finished_at)
       VALUES (?, ?, 1, 1, 3, ?, ?, 'waiting', NULL, ?, NULL)`,
    ).run(g.eventId, g.stages[0]!, e1, e4, at).lastInsertRowid);
    ok(R.openRoom(g.db, { matchId: match1!.id, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
    expect(R.openRoom(g.db, { matchId: match3Id, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW })).toEqual({ ok: false, error: 'entry_busy' });
  });
});

describe('readyUp', () => {
  it('takes a captain or co-captain of either team, and starts the veto once both are ready', async () => {
    const f = await roomFixture();
    open(f);
    expect(R.readyUp(f.db, { matchId: f.matchId, steamid: A[3]!, timers: TIMERS, now: at(1) })).toEqual({ ok: false, error: 'not_manager' });
    const m1 = ok(R.readyUp(f.db, { matchId: f.matchId, steamid: A[1]!, timers: TIMERS, now: at(1) }));
    expect(m1.ready_a_at).toBe(at(1).toISOString());
    expect(m1.deadline).toBe(at(10).toISOString());
    expect(R.readyUp(f.db, { matchId: f.matchId, steamid: A[0]!, timers: TIMERS, now: at(2) })).toEqual({ ok: false, error: 'already_ready' });
    const m2 = ok(R.readyUp(f.db, { matchId: f.matchId, steamid: B[0]!, timers: TIMERS, now: at(3) }));
    // The default veto (ban to one) asks the higher seed first: a 60 s step.
    expect(m2).toMatchObject({ status: 'veto', deadline: new Date(at(3).getTime() + 60_000).toISOString() });
    expect(lastAction(f)).toEqual({ action: 'room_ready', actor: B[0] });
  });

  it('refuses a Ready at or after the deadline', async () => {
    const f = await roomFixture();
    open(f);
    expect(R.readyUp(f.db, { matchId: f.matchId, steamid: A[0]!, timers: TIMERS, now: at(10) })).toEqual({ ok: false, error: 'room_closed' });
  });

  it('goes straight to lineups when the veto has no step for a person', async () => {
    const f = await roomFixture({ pool: ['no_mercy'], veto: { games: 1, banTo: 1, firstBan: 'coin', firstPick: 'higher', laterPicks: 'alternate', lateBans: 0, sides: 'coin' } });
    open(f);
    R.readyUp(f.db, { matchId: f.matchId, steamid: A[0]!, timers: TIMERS, now: at(1) });
    const m = ok(R.readyUp(f.db, { matchId: f.matchId, steamid: B[0]!, timers: TIMERS, now: at(1) }));
    expect(m).toMatchObject({ status: 'lineup', deadline: at(6).toISOString() });
    expect(R.gamesOf(f.db, f.matchId)).toEqual([expect.objectContaining({ ordinal: 1, campaign: 'no_mercy', picked_by: null, first_survivors: f.entryA })]);
  });
});

describe('holdMatch and resetRoom', () => {
  it('holds an open room with a reason, and a reset takes it back to waiting with nothing left behind', async () => {
    const f = await roomFixture();
    open(f);
    expect(ok(R.holdMatch(f.db, { matchId: f.matchId, by: null, reason: 'nobody_ready', now: at(10) }))).toMatchObject({ status: 'admin_hold', hold_reason: 'nobody_ready', deadline: null });
    const m = ok(R.resetRoom(f.db, { matchId: f.matchId, by: ADMIN, now: at(11) }));
    expect(m).toMatchObject({ status: 'waiting', room_opened_at: null, room_higher: null, ready_a_at: null, deadline: null, hold_reason: null });
    expect(lastAction(f)).toEqual({ action: 'room_reset', actor: ADMIN });
    expect(R.resetRoom(f.db, { matchId: f.matchId, by: ADMIN, now: at(12) })).toEqual({ ok: false, error: 'wrong_status' });
  });
});

describe('resumeDeadline', () => {
  it('gives an overdue deadline its full length again from now, and leaves a future one alone', async () => {
    const f = await roomFixture();
    open(f);
    expect(ok(R.resumeDeadline(f.db, { matchId: f.matchId, timers: TIMERS, now: at(30) })).deadline).toBe(at(40).toISOString());
    expect(R.resumeDeadline(f.db, { matchId: f.matchId, timers: TIMERS, now: at(31) })).toEqual({ ok: false, error: 'changed' });
  });
});

const bothReady = (f: RoomFixture) => {
  open(f);
  ok(R.readyUp(f.db, { matchId: f.matchId, steamid: A[0], timers: TIMERS, now: at(1) }));
  ok(R.readyUp(f.db, { matchId: f.matchId, steamid: B[0], timers: TIMERS, now: at(1) }));
};
const veto = (f: RoomFixture, steamid: string | null, step: number, action: string, campaign: string | null = null, min = 2) =>
  R.actVeto(f.db, { matchId: f.matchId, steamid, step, action, campaign, timers: TIMERS, now: at(min) });

describe('actVeto', () => {
  it('runs a ban to one between the managers of each team and moves to lineups', async () => {
    const f = await roomFixture();
    bothReady(f);
    expect(veto(f, B[0], 0, 'first')).toEqual({ ok: false, error: 'not_your_turn' });
    ok(veto(f, A[1], 0, 'first'));
    expect(veto(f, A[0], 0, 'first')).toEqual({ ok: false, error: 'step_taken' });
    expect(veto(f, A[0], 1, 'ban', 'nowhere')).toEqual({ ok: false, error: 'bad_veto_action' });
    ok(veto(f, A[0], 1, 'ban', 'dead_air'));
    // Bats did not make the last ban, so Bats chooses sides on no_mercy.
    const m = ok(veto(f, B[0], 2, 'infected', null, 3));
    expect(m).toMatchObject({ status: 'lineup', deadline: at(8).toISOString() });
    expect(R.gamesOf(f.db, f.matchId)).toEqual([expect.objectContaining({ ordinal: 1, campaign: 'no_mercy', picked_by: null, side_by: f.entryB, first_survivors: f.entryA })]);
    const rows = f.db.prepare('SELECT step, side, entry_id, action, campaign, by_steamid, auto FROM event_vetoes ORDER BY step').all();
    expect(rows).toEqual([
      { step: 0, side: 'a', entry_id: f.entryA, action: 'first', campaign: null, by_steamid: A[1], auto: 0 },
      { step: 1, side: 'a', entry_id: f.entryA, action: 'ban', campaign: 'dead_air', by_steamid: A[0], auto: 0 },
      { step: 2, side: 'b', entry_id: f.entryB, action: 'infected', campaign: null, by_steamid: B[0], auto: 0 },
    ]);
  });

  it('acts for the team whose turn it is when the clock passes no steamid, marked auto', async () => {
    const f = await roomFixture();
    bothReady(f);
    ok(veto(f, null, 0, 'first'));
    expect(f.db.prepare('SELECT side, auto, by_steamid FROM event_vetoes').get()).toEqual({ side: 'a', auto: 1, by_steamid: null });
  });

  it('refuses before both teams are ready', async () => {
    const f = await roomFixture();
    open(f);
    expect(veto(f, A[0], 0, 'first')).toEqual({ ok: false, error: 'not_veto_phase' });
  });
});

describe('lockLineup', () => {
  const toLineups = async () => {
    const f = await roomFixture();
    bothReady(f);
    ok(veto(f, A[0], 0, 'first'));
    ok(veto(f, A[0], 1, 'ban', 'dead_air'));
    ok(veto(f, B[0], 2, 'survivors'));
    return f;
  };

  it('locks four from the starters and subs, hides nothing from the writer, and waits for the server once both are in', async () => {
    const f = await toLineups();
    expect(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0], steamids: [A[0], A[1], A[2]], timers: TIMERS, now: at(4) })).toEqual({ ok: false, error: 'bad_lineup' });
    expect(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0], steamids: [A[0], A[1], A[2], A[5]], timers: TIMERS, now: at(4) })).toEqual({ ok: false, error: 'bad_lineup' });
    expect(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0], steamids: [A[0], A[0], A[1], A[2]], timers: TIMERS, now: at(4) })).toEqual({ ok: false, error: 'bad_lineup' });
    ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0], steamids: [A[1], A[2], A[3], A[4]], timers: TIMERS, now: at(4) }));
    expect(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[1], steamids: [A[0], A[1], A[2], A[3]], timers: TIMERS, now: at(4) })).toEqual({ ok: false, error: 'lineup_locked' });
    const m = ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: null, side: 'b', steamids: B.slice(0, 4), timers: TIMERS, now: at(5) }));
    expect(m).toMatchObject({ status: 'booking', deadline: null });
    const log = f.db.prepare("SELECT detail FROM event_log WHERE action = 'lineup_locked' ORDER BY id").all() as { detail: string }[];
    // The audit row never names the players (Global Constraints: lineups are secret).
    expect(log.map((l) => JSON.parse(l.detail))).toEqual([{ matchId: f.matchId, side: 'a', auto: false }, { matchId: f.matchId, side: 'b', auto: true }]);
  });
});

describe('autoFour', () => {
  const playable = ['s1', 's2', 's3', 's4', 'sub1'];
  it('takes the default four, else the last four, else the roster order, skipping any that left the roster', () => {
    expect(R.autoFour({ defaultFour: ['s2', 's3', 's4', 'sub1'], lastFour: null, playable })).toEqual(['s2', 's3', 's4', 'sub1']);
    expect(R.autoFour({ defaultFour: ['s2', 's3', 's4', 'gone'], lastFour: ['s1', 's2', 's3', 'sub1'], playable })).toEqual(['s1', 's2', 's3', 'sub1']);
    expect(R.autoFour({ defaultFour: ['gone', 's2', 's3', 's4'], lastFour: ['gone', 's1', 's2', 's3'], playable })).toEqual(['s1', 's2', 's3', 's4']);
    expect(R.autoFour({ defaultFour: null, lastFour: null, playable: ['s1', 's2'] })).toEqual(['s1', 's2']);
  });
});

describe('savePrefs', () => {
  it('saves a default four, a side and a campaign order for a stage, for the team\'s managers only', async () => {
    const f = await roomFixture();
    const prefs = { defaultFour: [A[1], A[2], A[3], A[4]], side: 'infected', campaigns: { [String(f.stageId)]: ['dead_air', 'no_mercy'] } };
    expect(R.savePrefs(f.db, { entryId: f.entryA, by: A[3], staff: false, prefs, now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    ok(R.savePrefs(f.db, { entryId: f.entryA, by: A[1], staff: false, prefs, now: NOW }));
    expect(R.entryPrefs(f.db, f.entryA)).toEqual({ defaultFour: [A[1], A[2], A[3], A[4]], side: 'infected' });
    expect(R.campaignPrefs(f.db, f.entryA, f.stageId)).toEqual(['dead_air', 'no_mercy']);
    ok(R.savePrefs(f.db, { entryId: f.entryA, by: ADMIN, staff: true, prefs: { defaultFour: null, side: null, campaigns: {} }, now: NOW }));
    expect(R.entryPrefs(f.db, f.entryA)).toEqual({ defaultFour: null, side: null });
    expect(R.campaignPrefs(f.db, f.entryA, f.stageId)).toEqual(['dead_air', 'no_mercy']);
  });

  it('refuses a coach in the four, a campaign outside the pool, a repeat, or another event\'s stage', async () => {
    const f = await roomFixture();
    const save = (prefs: object) => R.savePrefs(f.db, { entryId: f.entryA, by: A[0], staff: false, prefs, now: NOW });
    expect(save({ defaultFour: [A[0], A[1], A[2], 'nobody'], side: null, campaigns: {} })).toEqual({ ok: false, error: 'bad_prefs' });
    expect(save({ defaultFour: null, side: 'left', campaigns: {} })).toEqual({ ok: false, error: 'bad_prefs' });
    expect(save({ defaultFour: null, side: null, campaigns: { [String(f.stageId)]: ['dead_air', 'dead_air'] } })).toEqual({ ok: false, error: 'bad_prefs' });
    expect(save({ defaultFour: null, side: null, campaigns: { [String(f.stageId)]: ['swamp_fever_nope'] } })).toEqual({ ok: false, error: 'bad_prefs' });
    expect(save({ defaultFour: null, side: null, campaigns: { 99999: ['dead_air'] } })).toEqual({ ok: false, error: 'bad_prefs' });
  });
});

describe('results and the room (play.ts)', () => {
  it('takes an admin result from any room state as a first result, not a correction', async () => {
    const f = await roomFixture();
    open(f);
    const r = await recordResultFlow(f.db, { eventId: f.eventId, matchId: f.matchId, by: ADMIN, result: { winner: 'a', scoreA: 900, scoreB: 400 }, now: at(5) });
    expect(r.ok && r.value).toMatchObject({ status: 'done', result_source: 'admin', deadline: null });
    const log = f.db.prepare("SELECT detail FROM event_log WHERE action = 'result_recorded'").get() as { detail: string };
    expect(JSON.parse(log.detail).correction).toBe(false);
  });
});

/** Ban to one, both lineups locked: status booking, game 1 no_mercy, Rats survive first. */
const toBooking = async (f?: RoomFixture) => {
  f ??= await roomFixture();
  bothReady(f);
  ok(veto(f, A[0], 0, 'first'));
  ok(veto(f, A[0], 1, 'ban', 'dead_air'));
  ok(veto(f, B[0], 2, 'survivors'));
  ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0], steamids: A.slice(0, 4), timers: TIMERS, now: at(4) }));
  ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: B[0], steamids: B.slice(0, 4), timers: TIMERS, now: at(4) }));
  return f;
};
const game = (f: RoomFixture, ordinal: number) => R.gamesOf(f.db, f.matchId).find((g) => g.ordinal === ordinal)!;
const toLive = async () => {
  const f = await toBooking();
  ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
  ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
  ok(R.startLive(f.db, { matchId: f.matchId, now: at(6) }));
  return f;
};
/** Game 1 played and recorded (Rats 900 to 400): the Bo1 is over, so the confirm window may open. */
const playGame1 = (f: RoomFixture) => {
  ok(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId: fakeMatch(f), now: at(7) }));
  ok(R.recordGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, scoreA: 900, scoreB: 400, forfeit: null, now: at(50) }));
};

describe('series writer (plan T3b)', () => {
  it('walks booking, connect, live, a recorded game and the confirm window, one log row each', async () => {
    const f = await toBooking();
    const bookingId = fakeBooking(f, at(5));
    expect(ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId, now: at(5) }))).toMatchObject({ status: 'booking', booking_id: bookingId, booked_at: at(5).toISOString() });
    expect(lastAction(f)).toEqual({ action: 'match_booked', actor: null });
    expect(R.matchOfBooking(f.db, bookingId)?.id).toBe(f.matchId);
    expect(R.lineupFour(f.db, f.matchId, f.entryB)).toEqual(B.slice(0, 4));
    expect(ok(R.noteServerAlert(f.db, { matchId: f.matchId, now: at(15) })).server_alerted_at).toBe(at(15).toISOString());
    expect(R.noteServerAlert(f.db, { matchId: f.matchId, now: at(16) })).toEqual({ ok: false, error: 'changed' });
    expect(ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(20) }))).toMatchObject({ status: 'connect', deadline: at(35).toISOString() });
    expect(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(20) })).toEqual({ ok: false, error: 'wrong_status' });
    const gameMatchId = fakeMatch(f);
    expect(ok(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId, now: at(21) })).status).toBe('connect');
    expect(game(f, 1).match_id).toBe(gameMatchId);
    expect(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId: fakeMatch(f), now: at(21) })).toEqual({ ok: false, error: 'changed' });
    expect(ok(R.startLive(f.db, { matchId: f.matchId, now: at(25) }))).toMatchObject({ status: 'live', deadline: null });
    expect(R.startLive(f.db, { matchId: f.matchId, now: at(25) })).toEqual({ ok: false, error: 'not_connect_phase' });
    ok(R.recordGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, scoreA: 400, scoreB: 900, forfeit: null, now: at(60) }));
    expect(game(f, 1)).toMatchObject({ score_a: 400, score_b: 900, forfeit_side: null, winner: f.entryB, ended_at: at(60).toISOString() });
    expect(R.recordGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, scoreA: 1, scoreB: 0, forfeit: null, now: at(61) })).toEqual({ ok: false, error: 'changed' });
    expect(R.seriesGames(f.db, P.getMatch(f.db, f.matchId)!)).toEqual([{ id: game(f, 1).id, ordinal: 1, tiebreakOf: null, scoreA: 400, scoreB: 900, forfeit: null, started: true }]);
    expect(ok(R.startConfirm(f.db, { matchId: f.matchId, timers: TIMERS, now: at(61) }))).toMatchObject({ status: 'confirming', deadline: at(76).toISOString() });
    expect(R.confirmResult(f.db, { matchId: f.matchId, steamid: A[3], now: at(62) })).toEqual({ ok: false, error: 'not_manager' });
    expect(ok(R.confirmResult(f.db, { matchId: f.matchId, steamid: A[1], now: at(62) })).confirm_a_at).toBe(at(62).toISOString());
    expect(R.confirmResult(f.db, { matchId: f.matchId, steamid: A[0], now: at(63) })).toEqual({ ok: false, error: 'already_confirmed' });
    expect(lastAction(f)).toEqual({ action: 'result_confirmed', actor: A[1] });
  });

  it('records a forfeited game (a !gg) with its side, no scores needed, the other side winning', async () => {
    const f = await toLive();
    ok(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId: fakeMatch(f), now: at(7) }));
    expect(R.recordGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, scoreA: 100, scoreB: null, forfeit: null, now: at(30) })).toEqual({ ok: false, error: 'bad_request' });
    ok(R.recordGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, scoreA: null, scoreB: null, forfeit: 'a', now: at(30) }));
    expect(game(f, 1)).toMatchObject({ score_a: null, score_b: null, forfeit_side: 'a', winner: f.entryB, ended_at: at(30).toISOString() });
    expect(R.seriesGames(f.db, P.getMatch(f.db, f.matchId)!)[0]).toMatchObject({ scoreA: null, scoreB: null, forfeit: 'a' });
    expect(R.recordGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, scoreA: null, scoreB: null, forfeit: 'b', now: at(31) })).toEqual({ ok: false, error: 'changed' });
    // A tied game stores no winner.
    const f2 = await toLive();
    ok(R.linkGame(f2.db, { matchId: f2.matchId, gameId: game(f2, 1).id, gameMatchId: fakeMatch(f2), now: at(7) }));
    ok(R.recordGame(f2.db, { matchId: f2.matchId, gameId: game(f2, 1).id, scoreA: 500, scoreB: 500, forfeit: null, now: at(30) }));
    expect(game(f2, 1)).toMatchObject({ score_a: 500, score_b: 500, winner: null });
  });

  it('files a dispute with a reason, from a manager, before the deadline, and nowhere else', async () => {
    const f = await toLive();
    expect(R.disputeMatch(f.db, { matchId: f.matchId, steamid: B[0], reason: 'They had five', now: at(7) })).toEqual({ ok: false, error: 'not_confirm_phase' });
    playGame1(f);
    ok(R.startConfirm(f.db, { matchId: f.matchId, timers: TIMERS, now: at(60) }));
    expect(R.disputeMatch(f.db, { matchId: f.matchId, steamid: B[0], reason: 'no', now: at(61) })).toEqual({ ok: false, error: 'bad_reason' });
    expect(R.disputeMatch(f.db, { matchId: f.matchId, steamid: B[2], reason: 'They had five', now: at(61) })).toEqual({ ok: false, error: 'not_manager' });
    expect(R.disputeMatch(f.db, { matchId: f.matchId, steamid: B[0], reason: 'They had five', now: at(75) })).toEqual({ ok: false, error: 'confirm_closed' });
    const m = ok(R.disputeMatch(f.db, { matchId: f.matchId, steamid: B[0], reason: 'They had five on map 3', now: at(70) }));
    expect(m).toMatchObject({ status: 'admin_hold', hold_reason: 'dispute', dispute_side: 'b', dispute_by: B[0], dispute_reason: 'They had five on map 3', disputed_at: at(70).toISOString(), deadline: null });
    expect(lastAction(f)).toEqual({ action: 'match_disputed', actor: B[0] });
  });

  it('opens the confirm window only once the series is over', async () => {
    const f = await toLive();
    expect(R.startConfirm(f.db, { matchId: f.matchId, timers: TIMERS, now: at(30) })).toEqual({ ok: false, error: 'changed' });
    ok(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId: fakeMatch(f), now: at(7) }));
    // A tied game is not a result: a tiebreak comes first.
    ok(R.recordGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, scoreA: 500, scoreB: 500, forfeit: null, now: at(50) }));
    expect(R.startConfirm(f.db, { matchId: f.matchId, timers: TIMERS, now: at(51) })).toEqual({ ok: false, error: 'changed' });
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('live');
    const g = await toLive();
    playGame1(g);
    expect(ok(R.startConfirm(g.db, { matchId: g.matchId, timers: TIMERS, now: at(60) })).status).toBe('confirming');
  });

  it('adds a tiebreak game under its series game with the replayed map and the sides, nine at most', async () => {
    const f = await toLive();
    const g1 = game(f, 1);
    const tb = ok(R.addTiebreak(f.db, { matchId: f.matchId, ofGameId: g1.id, map: 'l4d_vs_hospital04_interior', firstSurvivors: 'a', now: at(50) }));
    expect(tb).toMatchObject({ ordinal: 11, campaign: 'no_mercy', tiebreak_of: g1.id, map: 'l4d_vs_hospital04_interior', first_survivors: f.entryA, picked_by: null, side_by: null, match_id: null });
    const tb2 = ok(R.addTiebreak(f.db, { matchId: f.matchId, ofGameId: g1.id, map: 'l4d_vs_hospital04_interior', firstSurvivors: 'b', now: at(90) }));
    expect(tb2.ordinal).toBe(12);
    expect(R.addTiebreak(f.db, { matchId: f.matchId, ofGameId: 999, map: 'x', firstSurvivors: 'a', now: at(91) })).toEqual({ ok: false, error: 'game_not_found' });
    expect(R.addTiebreak(f.db, { matchId: f.matchId, ofGameId: tb.id, map: 'x', firstSurvivors: 'a', now: at(91) })).toEqual({ ok: false, error: 'game_not_found' });
    for (let k = 3; k <= 9; k++) ok(R.addTiebreak(f.db, { matchId: f.matchId, ofGameId: g1.id, map: 'm', firstSurvivors: 'a', now: at(91) }));
    expect(game(f, 19).tiebreak_of).toBe(g1.id);
    expect(R.addTiebreak(f.db, { matchId: f.matchId, ofGameId: g1.id, map: 'm', firstSurvivors: 'a', now: at(92) })).toEqual({ ok: false, error: 'changed' });
  });

  it('runs the loser\'s pick and the side choice on a live match, then clears the deadline', async () => {
    const f = await roomFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7) });
    bothReady(f);
    const opening: [string, number, string, string | null][] = [[A[0], 0, 'first', null], [A[0], 1, 'ban', POOL7[0]!], [B[0], 2, 'ban', POOL7[1]!], [A[0], 3, 'ban', POOL7[2]!], [B[0], 4, 'ban', POOL7[3]!], [A[0], 5, 'pick', POOL7[5]!], [B[0], 6, 'survivors', null]];
    for (const [who, step, action, campaign] of opening) ok(veto(f, who, step, action, campaign));
    ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: A[0], steamids: A.slice(0, 4), timers: TIMERS, now: at(4) }));
    ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: B[0], steamids: B.slice(0, 4), timers: TIMERS, now: at(4) }));
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    ok(R.startLive(f.db, { matchId: f.matchId, now: at(6) }));
    ok(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId: fakeMatch(f), now: at(6) }));
    // Before game 1 has a result the engine is waiting, and a pick is refused.
    expect(veto(f, A[0], 7, 'pick', POOL7[4]!)).toEqual({ ok: false, error: 'step_taken' });
    expect(R.openPick(f.db, { matchId: f.matchId, timers: TIMERS, now: at(30) })).toEqual({ ok: false, error: 'changed' });
    ok(R.recordGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, scoreA: 300, scoreB: 700, forfeit: null, now: at(60) }));
    const st = R.roomState(f.db, P.getMatch(f.db, f.matchId)!);
    expect(st.next).toEqual({ kind: 'pick', by: 'a', game: 2 });
    expect(ok(R.openPick(f.db, { matchId: f.matchId, timers: TIMERS, now: at(60) }))).toMatchObject({ status: 'live', deadline: new Date(at(60).getTime() + 60_000).toISOString() });
    // A pick already open is not opened again.
    expect(R.openPick(f.db, { matchId: f.matchId, timers: TIMERS, now: at(60) })).toEqual({ ok: false, error: 'changed' });
    expect(veto(f, B[0], 7, 'pick', POOL7[4]!, 61)).toEqual({ ok: false, error: 'not_your_turn' });
    const picked = ok(veto(f, A[0], 7, 'pick', POOL7[4]!, 61));
    expect(picked).toMatchObject({ status: 'live', deadline: new Date(at(61).getTime() + 60_000).toISOString() });
    const sided = ok(veto(f, B[0], 8, 'infected', null, 62));
    expect(sided).toMatchObject({ status: 'live', deadline: null });
    expect(game(f, 2)).toMatchObject({ campaign: POOL7[4], picked_by: f.entryA, side_by: f.entryB, first_survivors: f.entryA, match_id: null });
  });

  it('holds and resets a booked room only once its booking is ending', async () => {
    const f = await toBooking();
    const bookingId = fakeBooking(f, at(5));
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId, now: at(5) }));
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    expect(ok(R.holdMatch(f.db, { matchId: f.matchId, by: null, reason: 'no_show_both', now: at(20) })).status).toBe('admin_hold');
    expect(R.resetRoom(f.db, { matchId: f.matchId, by: ADMIN, now: at(21) })).toEqual({ ok: false, error: 'booking_open' });
    f.db.prepare('UPDATE bookings SET ending_at = ? WHERE id = ?').run(at(21).toISOString(), bookingId);
    const m = ok(R.resetRoom(f.db, { matchId: f.matchId, by: ADMIN, now: at(22) }));
    expect(m).toMatchObject({ status: 'waiting', booking_id: null, booked_at: null, confirm_a_at: null, dispute_reason: null });
    expect(R.gamesOf(f.db, f.matchId)).toEqual([]);
  });

  it('holds a live match and a confirm window', async () => {
    const f = await toLive();
    expect(ok(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'crash', now: at(20) })).status).toBe('admin_hold');
    const g = await toLive();
    playGame1(g);
    ok(R.startConfirm(g.db, { matchId: g.matchId, timers: TIMERS, now: at(60) }));
    expect(ok(R.holdMatch(g.db, { matchId: g.matchId, by: ADMIN, reason: 'look', now: at(61) }))).toMatchObject({ status: 'admin_hold', deadline: null });
  });

  it('resumes a live pick step and a confirm window, and leaves a connect deadline alone', async () => {
    const f = await toBooking();
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    expect(R.resumeDeadline(f.db, { matchId: f.matchId, timers: TIMERS, now: at(60) })).toEqual({ ok: false, error: 'changed' });
    ok(R.startLive(f.db, { matchId: f.matchId, now: at(6) }));
    f.db.prepare('UPDATE event_matches SET deadline = ? WHERE id = ?').run(at(7).toISOString(), f.matchId);
    expect(ok(R.resumeDeadline(f.db, { matchId: f.matchId, timers: TIMERS, now: at(60) })).deadline).toBe(new Date(at(60).getTime() + 60_000).toISOString());
    playGame1(f);
    ok(R.startConfirm(f.db, { matchId: f.matchId, timers: TIMERS, now: at(61) }));
    expect(ok(R.resumeDeadline(f.db, { matchId: f.matchId, timers: TIMERS, now: at(120) })).deadline).toBe(at(135).toISOString());
  });
});

describe('staff act for a team (plan T3c)', () => {
  it('readies, takes the veto step and locks a lineup as a team, logged as the admin and never automatic', async () => {
    const f = await roomFixture();
    open(f);
    expect(R.readyUp(f.db, { matchId: f.matchId, steamid: null, timers: TIMERS, now: at(1) })).toEqual({ ok: false, error: 'bad_request' });
    ok(R.readyUp(f.db, { matchId: f.matchId, steamid: null, staff: { by: ADMIN, side: 'a' }, timers: TIMERS, now: at(1) }));
    expect(lastAction(f)).toEqual({ action: 'room_ready', actor: ADMIN });
    ok(R.readyUp(f.db, { matchId: f.matchId, steamid: B[0]!, timers: TIMERS, now: at(1) }));
    expect(R.actVeto(f.db, { matchId: f.matchId, steamid: null, staff: { by: ADMIN, side: 'b' }, step: 0, action: 'first', campaign: null, timers: TIMERS, now: at(2) })).toEqual({ ok: false, error: 'not_your_turn' });
    ok(R.actVeto(f.db, { matchId: f.matchId, steamid: null, staff: { by: ADMIN, side: 'a' }, step: 0, action: 'first', campaign: null, timers: TIMERS, now: at(2) }));
    expect(f.db.prepare('SELECT by_steamid, auto FROM event_vetoes WHERE event_match_id = ? AND step = 0').get(f.matchId)).toEqual({ by_steamid: ADMIN, auto: 0 });
    ok(R.actVeto(f.db, { matchId: f.matchId, steamid: A[0]!, step: 1, action: 'ban', campaign: 'dead_air', timers: TIMERS, now: at(2) }));
    ok(R.actVeto(f.db, { matchId: f.matchId, steamid: B[0]!, step: 2, action: 'survivors', campaign: null, timers: TIMERS, now: at(2) }));
    const m = ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: null, staff: { by: ADMIN, side: 'b' }, steamids: B.slice(0, 4), timers: TIMERS, now: at(4) }));
    expect(m.status).toBe('lineup');
    expect(R.lineupsOf(f.db, f.matchId).map((l) => [l.entry_id, l.locked_by, l.auto])).toEqual([[f.entryB, ADMIN, 0]]);
    expect(lastAction(f)).toEqual({ action: 'lineup_locked', actor: ADMIN });
  });
});

describe('subs (plan T3c)', () => {
  const live = async () => {
    const f = await toBooking();
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    ok(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId: fakeMatch(f), now: at(6) }));
    ok(R.startLive(f.db, { matchId: f.matchId, now: at(7) }));
    return f;
  };
  it('swaps a locked player for a registered member of the entry, counted per side against the limit', async () => {
    const f = await live();
    const sub = (by: string, outId: string, inId: string, limit = 2) => R.subPlayer(f.db, { matchId: f.matchId, by, outId, inId, limit, gameId: game(f, 1).id, now: at(20) });
    expect(sub(B[0]!, A[3]!, A[4]!)).toEqual({ ok: false, error: 'not_manager' });
    expect(sub(A[0]!, A[4]!, A[3]!)).toEqual({ ok: false, error: 'not_in_lineup' });
    expect(sub(A[0]!, A[3]!, B[4]!)).toEqual({ ok: false, error: 'sub_not_member' });
    expect(sub(A[0]!, A[3]!, A[2]!)).toEqual({ ok: false, error: 'sub_not_member' });
    expect(sub(A[0]!, A[3]!, A[4]!, 0)).toEqual({ ok: false, error: 'sub_limit' });
    const r = ok(sub(A[1]!, A[3]!, A[4]!));
    expect(r).toMatchObject({ side: 'a', entryId: f.entryA, four: [A[0], A[1], A[2], A[4]], used: 1 });
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], A[4]]);
    expect(lastAction(f)).toEqual({ action: 'player_subbed', actor: A[1] });
    expect(R.subsUsed(f.db, P.getMatch(f.db, f.matchId)!, 'a')).toBe(1);
    expect(R.subsUsed(f.db, P.getMatch(f.db, f.matchId)!, 'b')).toBe(0);
    // The replaced player is a registered member: they may come back as a sub, within the limit.
    expect(sub(A[0]!, A[4]!, A[3]!, 1)).toEqual({ ok: false, error: 'sub_limit' });
    expect(ok(sub(A[0]!, A[4]!, A[3]!, 2)).used).toBe(2);
  });

  it('freezes and unfreezes a live match once each way, from a call or staff', async () => {
    const f = await live();
    expect(R.setAdminPause(f.db, { matchId: f.matchId, on: false, by: null, cause: 'staff', now: at(8) })).toEqual({ ok: false, error: 'not_frozen' });
    const m = ok(R.setAdminPause(f.db, { matchId: f.matchId, on: true, by: A[2]!, cause: 'call', now: at(8) }));
    expect(m).toMatchObject({ admin_pause_at: at(8).toISOString(), admin_pause_by: A[2] });
    expect(lastAction(f)).toEqual({ action: 'match_frozen', actor: A[2] });
    expect(R.setAdminPause(f.db, { matchId: f.matchId, on: true, by: ADMIN, cause: 'staff', now: at(9) })).toEqual({ ok: false, error: 'already_frozen' });
    expect(ok(R.setAdminPause(f.db, { matchId: f.matchId, on: false, by: ADMIN, cause: 'staff', now: at(9) })).admin_pause_at).toBeNull();
    expect(lastAction(f)).toEqual({ action: 'match_unfrozen', actor: ADMIN });
  });
});

describe('desk tools on the room (plan T3c)', () => {
  it('extends the grace to connect by whole minutes from the later of now and the deadline', async () => {
    const f = await toBooking();
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
    expect(R.extendGrace(f.db, { matchId: f.matchId, by: ADMIN, minutes: 5, now: at(5) })).toEqual({ ok: false, error: 'not_connect_phase' });
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    for (const bad of [0, 61, 2.5, '5', null]) expect(R.extendGrace(f.db, { matchId: f.matchId, by: ADMIN, minutes: bad, now: at(6) })).toEqual({ ok: false, error: 'bad_minutes' });
    expect(ok(R.extendGrace(f.db, { matchId: f.matchId, by: ADMIN, minutes: 5, now: at(6) })).deadline).toBe(at(25).toISOString());
    expect(ok(R.extendGrace(f.db, { matchId: f.matchId, by: ADMIN, minutes: 10, now: at(40) })).deadline).toBe(at(50).toISOString());
    expect(lastAction(f)).toEqual({ action: 'grace_extended', actor: ADMIN });
  });

  it('remembers where a hold came from and releases it there with a fresh deadline', async () => {
    const f = await roomFixture();
    open(f);
    ok(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: at(3) }));
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'admin_hold', hold_from: 'veto' });
    expect(R.extendGrace(f.db, { matchId: f.matchId, by: ADMIN, minutes: 5, now: at(4) })).toEqual({ ok: false, error: 'not_connect_phase' });
    const back = ok(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(30) }));
    expect(back).toMatchObject({ status: 'veto', hold_reason: null, hold_from: null, deadline: at(40).toISOString() });
    expect(lastAction(f)).toEqual({ action: 'hold_released', actor: ADMIN });
    expect(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(31) })).toEqual({ ok: false, error: 'not_held' });
    // A veto step: the step length again (the room is open already, so ready up by hand).
    for (const steamid of [A[0]!, B[0]!]) ok(R.readyUp(f.db, { matchId: f.matchId, steamid, timers: TIMERS, now: at(31) }));
    ok(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: at(35) }));
    expect(ok(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(36) })).deadline).toBe(new Date(at(36).getTime() + 60_000).toISOString());
    // A hold whose origin is unknown is not releasable.
    ok(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: at(37) }));
    f.db.prepare('UPDATE event_matches SET hold_from = NULL WHERE id = ?').run(f.matchId);
    expect(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(38) })).toEqual({ ok: false, error: 'hold_not_releasable' });
  });

  it('releases a connect hold to a fresh grace only while the booking runs, and a dispute hold back to a fresh confirm window', async () => {
    const f = await toBooking();
    const bookingId = fakeBooking(f, at(5));
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId, now: at(5) }));
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    ok(R.holdMatch(f.db, { matchId: f.matchId, by: null, reason: 'no_show_both', now: at(20) }));
    // fakeBooking rows are 'scheduled': not running.
    expect(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(21) })).toEqual({ ok: false, error: 'hold_not_releasable' });
    f.db.prepare("UPDATE bookings SET state = 'active' WHERE id = ?").run(bookingId);
    expect(ok(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 10, now: at(21) }))).toMatchObject({ status: 'connect', deadline: at(31).toISOString() });
    ok(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId: fakeMatch(f), now: at(22) }));
    ok(R.startLive(f.db, { matchId: f.matchId, now: at(23) }));
    ok(R.recordGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, scoreA: 400, scoreB: 900, forfeit: null, now: at(60) }));
    ok(R.startConfirm(f.db, { matchId: f.matchId, timers: TIMERS, now: at(61) }));
    ok(R.disputeMatch(f.db, { matchId: f.matchId, steamid: A[0]!, reason: 'They had five', now: at(62) }));
    expect(P.getMatch(f.db, f.matchId)).toMatchObject({ status: 'admin_hold', hold_reason: 'dispute', hold_from: 'confirming', dispute_side: 'a' });
    const back = ok(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(70) }));
    expect(back).toMatchObject({ status: 'confirming', deadline: at(85).toISOString(), dispute_side: null, dispute_reason: null, hold_from: null });
    const row = f.db.prepare("SELECT detail FROM event_log WHERE action = 'hold_released' ORDER BY id DESC LIMIT 1").get() as { detail: string };
    expect(JSON.parse(row.detail)).toMatchObject({ to: 'confirming', reason: 'dispute', dispute: { side: 'a', by: A[0], reason: 'They had five' } });
  });

  it('reopens the veto before any game started, keeping both ready, and refuses once a game was pushed', async () => {
    const f = await roomFixture();
    bothReady(f);
    ok(veto(f, A[0]!, 0, 'first'));
    ok(veto(f, A[0]!, 1, 'ban', 'dead_air'));
    const m = ok(R.reopenVeto(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, now: at(5) }));
    expect(m).toMatchObject({ status: 'veto', deadline: new Date(at(5).getTime() + 60_000).toISOString() });
    expect(m.ready_a_at).not.toBeNull();
    expect(R.vetoActions(f.db, f.matchId)).toEqual([]);
    expect(R.gamesOf(f.db, f.matchId)).toEqual([]);
    expect(lastAction(f)).toEqual({ action: 'veto_reopened', actor: ADMIN });
    // From a hold taken in the lineup phase too.
    ok(veto(f, A[0]!, 0, 'first', null, 6));
    ok(veto(f, A[0]!, 1, 'ban', 'dead_air', 6));
    ok(veto(f, B[0]!, 2, 'survivors', null, 6));
    ok(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: at(7) }));
    expect(ok(R.reopenVeto(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, now: at(8) })).status).toBe('veto');
    // A pushed game closes the door.
    const g = await toBooking();
    ok(R.attachBooking(g.db, { matchId: g.matchId, bookingId: fakeBooking(g, at(5)), now: at(5) }));
    expect(R.reopenVeto(g.db, { matchId: g.matchId, by: ADMIN, timers: TIMERS, now: at(6) })).toEqual({ ok: false, error: 'booking_open' });
    g.db.prepare("UPDATE bookings SET ending_at = ?").run(at(6).toISOString());
    ok(R.linkGame(g.db, { matchId: g.matchId, gameId: game(g, 1).id, gameMatchId: fakeMatch(g), now: at(6) }));
    expect(R.reopenVeto(g.db, { matchId: g.matchId, by: ADMIN, timers: TIMERS, now: at(7) })).toEqual({ ok: false, error: 'game_started' });
  });

  it('notes a replay and a move with one log row each', async () => {
    const f = await toBooking();
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    expect(R.noteReplay(f.db, { matchId: f.matchId, by: ADMIN, gameId: game(f, 1).id, ordinal: 1, map: 'l4d_vs_hospital02_subway', now: at(6) })).toEqual({ ok: false, error: 'not_live_phase' });
    expect(ok(R.noteMove(f.db, { matchId: f.matchId, by: ADMIN, fromServerId: 3, now: at(6) })).status).toBe('connect');
    expect(lastAction(f)).toEqual({ action: 'server_moved', actor: ADMIN });
    ok(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId: fakeMatch(f), now: at(6) }));
    ok(R.startLive(f.db, { matchId: f.matchId, now: at(7) }));
    ok(R.noteReplay(f.db, { matchId: f.matchId, by: ADMIN, gameId: game(f, 1).id, ordinal: 1, map: 'l4d_vs_hospital02_subway', now: at(8) }));
    expect(lastAction(f)).toEqual({ action: 'chapter_replayed', actor: ADMIN });
  });
});

describe('fix round 1 (plan T3c Task 2)', () => {
  it('records the box freeze during a hold taken from a box phase, and refuses one on a hold taken in veto', async () => {
    const f = await toBooking();
    ok(R.attachBooking(f.db, { matchId: f.matchId, bookingId: fakeBooking(f, at(5)), now: at(5) }));
    ok(R.startConnect(f.db, { matchId: f.matchId, graceMinutes: 15, now: at(5) }));
    ok(R.linkGame(f.db, { matchId: f.matchId, gameId: game(f, 1).id, gameMatchId: fakeMatch(f), now: at(6) }));
    ok(R.startLive(f.db, { matchId: f.matchId, now: at(7) }));
    ok(R.setAdminPause(f.db, { matchId: f.matchId, on: true, by: ADMIN, cause: 'staff', now: at(8) }));
    ok(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: at(9) }));
    const n = () => (f.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'match_unfrozen'").get() as { n: number }).n;
    const off = ok(R.setAdminPause(f.db, { matchId: f.matchId, on: false, by: ADMIN, cause: 'staff', now: at(10) }));
    expect(off).toMatchObject({ status: 'admin_hold', admin_pause_at: null, admin_pause_by: null });
    expect(n()).toBe(1);
    const on = ok(R.setAdminPause(f.db, { matchId: f.matchId, on: true, by: A[0]!, cause: 'call', now: at(11) }));
    expect(on).toMatchObject({ status: 'admin_hold', admin_pause_at: at(11).toISOString(), admin_pause_by: A[0] });
    expect(lastAction(f)).toEqual({ action: 'match_frozen', actor: A[0] });

    const g = await roomFixture();
    open(g);
    ok(R.holdMatch(g.db, { matchId: g.matchId, by: ADMIN, reason: 'Checking', now: at(3) }));
    expect(R.setAdminPause(g.db, { matchId: g.matchId, on: true, by: ADMIN, cause: 'staff', now: at(4) })).toEqual({ ok: false, error: 'not_live_phase' });
  });

  it('releases a veto hold with both ready and no step left for a person straight on to lineups', async () => {
    const f = await roomFixture({ pool: ['no_mercy'], veto: { games: 1, banTo: 1, firstBan: 'coin', firstPick: 'higher', laterPicks: 'alternate', lateBans: 0, sides: 'coin' } });
    open(f);
    ok(R.readyUp(f.db, { matchId: f.matchId, steamid: A[0]!, timers: TIMERS, now: at(1) }));
    ok(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'Checking', now: at(2) }));
    // Test setup: team b's ready landed with the hold (both ready, nothing for a person to do).
    f.db.prepare('UPDATE event_matches SET ready_b_at = ? WHERE id = ?').run(at(2).toISOString(), f.matchId);
    const m = ok(R.releaseHold(f.db, { matchId: f.matchId, by: ADMIN, timers: TIMERS, graceMinutes: 15, now: at(10) }));
    expect(m).toMatchObject({ status: 'lineup', deadline: at(15).toISOString(), hold_from: null });
    expect(R.gamesOf(f.db, f.matchId)).toEqual([expect.objectContaining({ ordinal: 1, campaign: 'no_mercy' })]);
    expect(lastAction(f)).toEqual({ action: 'hold_released', actor: ADMIN });
  });
});
