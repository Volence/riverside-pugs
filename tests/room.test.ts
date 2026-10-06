import { describe, it, expect } from 'vitest';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import { recordResultFlow } from '../src/events/flow.js';
import { ADMIN, NOW } from './eventFixture.js';
import { A, B } from './entryFixture.js';
import { playFixture, SWISS } from './playFixture.js';
import { TIMERS, roomFixture, type RoomFixture } from './roomFixture.js';

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
