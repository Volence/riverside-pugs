import { describe, it, expect } from 'vitest';
import * as R from '../src/events/room.js';
import { recordResultFlow } from '../src/events/flow.js';
import { ADMIN, NOW } from './eventFixture.js';
import { A, B } from './entryFixture.js';
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
