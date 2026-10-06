import { describe, it, expect, vi, afterEach } from 'vitest';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import { RoomClock, dueRooms, dueWindowRooms, higherSide } from '../src/events/roomClock.js';
import * as S from '../src/events/schedule.js';
import type { Notifier } from '../src/notify/notify.js';
import { ADMIN, NOW } from './eventFixture.js';
import { A, B } from './entryFixture.js';
import { POOL7, TIMERS, roomFixture, windowFixture, type RoomFixture } from './roomFixture.js';
import { MIN, driveLoserPicks, seriesFixture, type SeriesFixture } from './seriesFixture.js';
import { presetConfig } from '../src/events/vetoConfig.js';
import { RR, SE, SWISS, playFixture } from './playFixture.js';
import { autoAction } from '../src/events/veto.js';
import * as E from '../src/events/events.js';
import { recordResultFlow, stageTable } from '../src/events/flow.js';

const at = (min: number) => NOW.getTime() + min * 60_000;
const clockAt = (f: RoomFixture, ms: { t: number }) => {
  const send = vi.fn(() => 1);
  const push = vi.fn();
  const clock = new RoomClock({ db: f.db, notifier: { send } as unknown as Notifier, publicUrl: 'https://x', push, now: () => ms.t, seed: () => 5 });
  return { clock, send, push };
};
const match = (f: RoomFixture) => P.getMatch(f.db, f.matchId)!;

describe('RoomClock: opening rooms', () => {
  it('opens a waiting rolling match, DMs both rosters, and pushes', async () => {
    const f = await roomFixture();
    const t = { t: at(0) };
    const { clock, send, push } = clockAt(f, t);
    await clock.tick();
    expect(match(f)).toMatchObject({ status: 'veto', room_higher: 'a', room_seed: 5 });
    expect(send).toHaveBeenCalledWith(expect.arrayContaining([A[0], A[4], B[0], B[3]]), 'event_match_room', expect.anything());
    expect(push).toHaveBeenCalledWith(f.matchId);
  });

  it('does not open a window stage, or a match whose not_before is still ahead', async () => {
    const f = await roomFixture();
    f.db.prepare("UPDATE event_stages SET scheduling = 'window' WHERE id = ?").run(f.stageId);
    expect(dueRooms(f.db, new Date(at(0)))).toEqual([]);
    f.db.prepare("UPDATE event_stages SET scheduling = 'rolling' WHERE id = ?").run(f.stageId);
    f.db.prepare('UPDATE event_matches SET not_before = ? WHERE id = ?').run(new Date(at(30)).toISOString(), f.matchId);
    expect(dueRooms(f.db, new Date(at(0)))).toEqual([]);
    expect(dueRooms(f.db, new Date(at(30))).map((m) => m.id)).toEqual([f.matchId]);
  });

  it('opens only each team\'s earliest match, one room per team at a time', async () => {
    const f = playFixture({ stages: [{ type: 'round_robin', config: { groups: 1 }, advanceCount: null }], entries: 4 });
    const { startEventFlow } = await import('../src/events/flow.js');
    await startEventFlow(f.db, { eventId: f.eventId, by: null, now: new Date(at(0)) });
    const due = dueRooms(f.db, new Date(at(0)));
    const teams = due.flatMap((m) => [m.entry_a, m.entry_b]);
    expect(new Set(teams).size).toBe(teams.length);
    expect(due.every((m) => m.round === 1)).toBe(true);
  });

  it('picks the higher seed by stage seed in a bracket, by standing in a table stage', async () => {
    const f = playFixture({ stages: [SE()], entries: 4 });
    const { startEventFlow } = await import('../src/events/flow.js');
    await startEventFlow(f.db, { eventId: f.eventId, by: null, now: new Date(at(0)) });
    const first = P.matchesOf(f.db, f.stages[0]!).find((m) => m.status === 'waiting')!;
    const seedA = f.entries.indexOf(first.entry_a!);
    const seedB = f.entries.indexOf(first.entry_b!);
    expect(higherSide(f.db, first)).toBe(seedA < seedB ? 'a' : 'b');
  });

  it('picks the better standing over the stage seed in a round robin once results are in', async () => {
    const f = playFixture({ stages: [RR(1, null)], entries: 4 });
    const { startEventFlow } = await import('../src/events/flow.js');
    await startEventFlow(f.db, { eventId: f.eventId, by: null, now: new Date(at(0)) });
    const seed = (id: number) => f.entries.indexOf(id);
    // The worse seed of a round 1 match wins it.
    const r1 = P.matchesOf(f.db, f.stages[0]!).find((m) => m.round === 1)!;
    const winner = seed(r1.entry_a!) > seed(r1.entry_b!) ? 'a' : 'b';
    const w = winner === 'a' ? r1.entry_a! : r1.entry_b!;
    const l = winner === 'a' ? r1.entry_b! : r1.entry_a!;
    const done = await recordResultFlow(f.db, { eventId: f.eventId, matchId: r1.id, by: ADMIN, result: { winner, scoreA: winner === 'a' ? 9 : 1, scoreB: winner === 'a' ? 1 : 9 }, now: new Date(at(0)) });
    expect(done.ok).toBe(true);
    // A later match of the winner against a better seed that has not lost.
    const later = P.matchesOf(f.db, f.stages[0]!).find((m) => m.round > 1 && [m.entry_a, m.entry_b].includes(w)
      && [m.entry_a, m.entry_b].every((id) => id !== l) && seed(m.entry_a === w ? m.entry_b! : m.entry_a!) < seed(w))!;
    expect(later).toBeDefined();
    const rank = new Map(stageTable(f.db, E.getStage(f.db, f.stages[0]!)!).map((r) => [r.entryId, r.rank]));
    expect(rank.get(w)!).toBeLessThan(rank.get(later.entry_a === w ? later.entry_b! : later.entry_a!)!);
    expect(higherSide(f.db, later)).toBe(later.entry_a === w ? 'a' : 'b');
  });
});

describe('RoomClock: deadlines', () => {
  it('forfeits the team that did not ready up, and tells both rosters', async () => {
    const f = await roomFixture();
    const t = { t: at(0) };
    const { clock, send } = clockAt(f, t);
    await clock.tick();
    R.readyUp(f.db, { matchId: f.matchId, steamid: B[0], timers: TIMERS, now: new Date(at(1)) });
    t.t = at(10);
    await clock.tick();
    expect(match(f)).toMatchObject({ status: 'forfeit', winner_entry: f.entryB, result_source: 'forfeit' });
    expect(send).toHaveBeenCalledWith(expect.arrayContaining([A[0], B[0]]), 'event_match_forfeit', expect.objectContaining({
      content: expect.stringMatching(/is a forfeit win for Bats: Rats did not press Ready in the match room in time\.$/),
    }));
  });

  it('holds a match nobody readied up for', async () => {
    const f = await roomFixture();
    const t = { t: at(0) };
    const { clock } = clockAt(f, t);
    await clock.tick();
    t.t = at(10);
    await clock.tick();
    expect(match(f)).toMatchObject({ status: 'admin_hold', hold_reason: 'nobody_ready' });
  });

  it('acts for a team that ran out of time on a veto step, from its saved order', async () => {
    const f = await roomFixture();
    R.savePrefs(f.db, { entryId: f.entryA, by: A[0], staff: false, prefs: { defaultFour: null, side: null, campaigns: { [String(f.stageId)]: ['dead_air', 'no_mercy'] } }, now: new Date(at(0)) });
    const t = { t: at(0) };
    const { clock } = clockAt(f, t);
    await clock.tick();
    R.readyUp(f.db, { matchId: f.matchId, steamid: A[0], timers: TIMERS, now: new Date(at(1)) });
    R.readyUp(f.db, { matchId: f.matchId, steamid: B[0], timers: TIMERS, now: new Date(at(1)) });
    t.t = at(2);
    await clock.tick(); // order step: goes first
    t.t = at(3);
    await clock.tick(); // a bans its least wanted: no_mercy
    const rows = f.db.prepare('SELECT action, campaign, auto FROM event_vetoes ORDER BY step').all();
    expect(rows).toEqual([{ action: 'first', campaign: null, auto: 1 }, { action: 'ban', campaign: 'no_mercy', auto: 1 }]);
  });

  it('locks a default four for a team that ran out of time on its lineup, and holds a team that is short', async () => {
    const f = await roomFixture();
    R.savePrefs(f.db, { entryId: f.entryA, by: A[0], staff: false, prefs: { defaultFour: [A[1], A[2], A[3], A[4]], side: null, campaigns: {} }, now: new Date(at(0)) });
    const t = { t: at(0) };
    const { clock } = clockAt(f, t);
    await clock.tick();
    R.readyUp(f.db, { matchId: f.matchId, steamid: A[0], timers: TIMERS, now: new Date(at(1)) });
    R.readyUp(f.db, { matchId: f.matchId, steamid: B[0], timers: TIMERS, now: new Date(at(1)) });
    for (const min of [2, 3, 4]) { t.t = at(min); await clock.tick(); }
    expect(match(f).status).toBe('lineup');
    // Bats lose a starter from the roster: three left, no subs.
    f.db.prepare("UPDATE event_entry_players SET removed_at = 'x' WHERE entry_id = ? AND steamid = ?").run(f.entryB, B[3]);
    t.t = at(20);
    await clock.tick();
    expect(R.lineupsOf(f.db, f.matchId).map((l) => JSON.parse(l.steamids))).toEqual([[A[1], A[2], A[3], A[4]]]);
    expect(match(f)).toMatchObject({ status: 'admin_hold', hold_reason: 'lineup_short' });
  });

  it('re-reads each overdue match before acting, so a step a captain took meanwhile is not followed by a second clock action (fix round 1)', async () => {
    // Two rooms in one event: X is overdue on its ready check (a forfeit,
    // which awaits the event chain), Y is overdue on a veto step. While X is
    // being forfeited, Y's team takes the overdue step itself, which resets
    // Y's deadline into the future: the clock must not then act Y's next step
    // from its stale snapshot.
    const f = playFixture({ stages: [SWISS(3, null)], entries: 4 });
    const { startEventFlow } = await import('../src/events/flow.js');
    await startEventFlow(f.db, { eventId: f.eventId, by: null, now: new Date(at(0)) });
    const holder = { y: 0 };
    const t = { t: at(0) };
    const clock = new RoomClock({
      db: f.db, now: () => t.t, seed: () => 5,
      push: (id) => {
        if (id === holder.y || P.getMatch(f.db, id)!.status !== 'forfeit') return;
        const y = P.getMatch(f.db, holder.y)!;
        const st = R.roomState(f.db, y);
        const a = autoAction(st, E.stageSettingsOf(E.getStage(f.db, y.stage_id)!).campaignPool, { campaigns: [], side: null });
        const r = R.actVeto(f.db, { matchId: y.id, steamid: null, step: st.used, action: a.action, campaign: a.campaign, timers: TIMERS, now: new Date(t.t) });
        expect(r.ok).toBe(true);
      },
    });
    await clock.tick();
    const [x, y] = P.matchesOf(f.db, f.stages[0]!).filter((m) => m.status === 'veto');
    expect(x && y).toBeTruthy();
    holder.y = y!.id;
    f.db.prepare('UPDATE event_matches SET ready_a_at = ?, ready_b_at = NULL, deadline = ? WHERE id = ?').run(new Date(at(1)).toISOString(), new Date(at(5)).toISOString(), x!.id);
    f.db.prepare('UPDATE event_matches SET ready_a_at = ?, ready_b_at = ?, deadline = ? WHERE id = ?').run(new Date(at(1)).toISOString(), new Date(at(1)).toISOString(), new Date(at(6)).toISOString(), y!.id);
    t.t = at(7);
    await clock.tick();
    expect(P.getMatch(f.db, x!.id)!.status).toBe('forfeit');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM event_vetoes WHERE event_match_id = ?').get(y!.id)).toEqual({ n: 1 });
    expect(P.getMatch(f.db, y!.id)!.deadline).toBe(new Date(at(8)).toISOString());
  });

  it('gives overdue deadlines their full length on resume, so downtime acts for nobody', async () => {
    const f = await roomFixture();
    const t = { t: at(0) };
    const { clock } = clockAt(f, t);
    await clock.tick();
    t.t = at(60);
    clock.resume();
    expect(match(f).deadline).toBe(new Date(at(70)).toISOString());
    await clock.tick();
    expect(match(f).status).toBe('veto');
  });

  it('leaves an open room of a cancelled event alone: no action, no hold, no push, no resume (final review)', async () => {
    const f = await roomFixture();
    const t = { t: at(0) };
    const { clock, push } = clockAt(f, t);
    await clock.tick();
    expect(match(f).status).toBe('veto');
    const c = E.cancelEvent(f.db, { eventId: f.eventId, by: ADMIN, reason: 'Called off', now: new Date(at(1)) });
    expect(c.ok).toBe(true);
    push.mockClear();
    const before = match(f);
    t.t = at(60);
    clock.resume();
    await clock.tick();
    expect(match(f)).toEqual(before);
    expect(push).not.toHaveBeenCalled();
    expect(dueRooms(f.db, new Date(at(60)))).toEqual([]);
    expect(R.holdMatch(f.db, { matchId: f.matchId, by: ADMIN, reason: 'x', now: new Date(at(60)) })).toEqual({ ok: false, error: 'not_live' });
  });
});

describe('RoomClock with the series (plan T3b)', () => {
  let f: SeriesFixture;
  afterEach(() => { vi.restoreAllMocks(); f?.close(); });

  it('resumes an overdue pick step with its full length, leaves a connect deadline alone, and acts on the pick when it passes', async () => {
    f = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: driveLoserPicks });
    await f.tick();
    const connectDeadline = f.match().deadline;
    expect(f.match().status).toBe('connect');
    f.t.t += 60 * MIN;
    f.clock.resume();
    expect(f.match().deadline).toBe(connectDeadline);
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 100, b: 500 }]);
    expect(R.roomState(f.db, f.match()).next).toEqual({ kind: 'pick', by: 'b', game: 2 });
    f.t.t += 10 * MIN;
    f.clock.resume();
    expect(f.match().deadline).toBe(new Date(f.t.t + 60_000).toISOString());
    await f.clock.tick();
    expect(R.roomState(f.db, f.match()).next).toEqual({ kind: 'pick', by: 'b', game: 2 });
    f.t.t += MIN;
    await f.clock.tick();
    expect(f.gameOf(2)).toMatchObject({ picked_by: f.entryB });
    expect(f.db.prepare('SELECT auto FROM event_vetoes ORDER BY step DESC LIMIT 1').pluck().get()).toBe(1);
  });

  it('resumes an overdue confirm window, then records the result when it passes', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 100, b: 500 }]);
    expect(f.match().status).toBe('confirming');
    f.t.t += 40 * MIN;
    f.clock.resume();
    expect(f.match().deadline).toBe(new Date(f.t.t + 15 * MIN).toISOString());
    await f.clock.tick();
    expect(f.match().status).toBe('confirming');
    f.t.t += 15 * MIN;
    await f.clock.tick();
    expect(f.match()).toMatchObject({ status: 'done', result_source: 'auto', winner_entry: f.entryA });
  });

  it('finalize says whether it changed the match; the clock pushes only on a change and logs a refused result once (Task 7 review)', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 100, b: 500 }]);
    expect(await f.series.finalize(f.matchId, new Date(f.t.t))).toBe(false);
    f.t.t += 15 * MIN;
    const finalize = vi.spyOn(f.series, 'finalize').mockResolvedValue(false);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.pushes.length = 0;
    await f.clock.tick();
    await f.clock.tick();
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(f.pushes).not.toContain(f.matchId);
    expect(err.mock.calls.filter((c) => String(c[0]).includes('confirm window passed'))).toHaveLength(1);
    finalize.mockRestore();
    err.mockRestore();
    expect(await f.series.finalize(f.matchId, new Date(f.t.t))).toBe(true);
    expect(f.match().status).toBe('done');
    expect(await f.series.finalize(f.matchId, new Date(f.t.t))).toBe(false);
  });

  it('forgets a refusal once the match leaves the overdue state another way (T3b final review)', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 100, b: 500 }]);
    f.t.t += 15 * MIN;
    const finalize = vi.spyOn(f.series, 'finalize').mockResolvedValue(false);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await f.clock.tick();
      // Staff hold it (not through the clock), then it is back in an overdue confirm window.
      expect(R.holdMatch(f.db, { matchId: f.matchId, by: null, reason: 'look', now: new Date(f.t.t) }).ok).toBe(true);
      await f.clock.tick();
      f.db.prepare("UPDATE event_matches SET status = 'confirming', deadline = ? WHERE id = ?").run(new Date(f.t.t - MIN).toISOString(), f.matchId);
      await f.clock.tick();
      expect(err.mock.calls.filter((c) => String(c[0]).includes('confirm window passed'))).toHaveLength(2);
    } finally {
      finalize.mockRestore();
      err.mockRestore();
    }
  });

  it('checks a timed-out pick\'s result before handing it to the engine, and logs a refusal once (Task 7 review)', async () => {
    f = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: driveLoserPicks });
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 100, b: 500 }]);
    expect(R.roomState(f.db, f.match()).next).toEqual({ kind: 'pick', by: 'b', game: 2 });
    f.t.t += 2 * MIN;
    const act = vi.spyOn(R, 'actVeto').mockReturnValue({ ok: false, error: 'step_taken' });
    const afterPick = vi.spyOn(f.series, 'afterPick');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.pushes.length = 0;
    await f.clock.tick();
    await f.clock.tick();
    expect(act).toHaveBeenCalledTimes(2);
    expect(afterPick).not.toHaveBeenCalled();
    expect(f.pushes).not.toContain(f.matchId);
    expect(err.mock.calls.filter((c) => String(c[0]).includes('was refused (step_taken)'))).toHaveLength(1);
    act.mockRestore();
    err.mockRestore();
    await f.clock.tick();
    expect(f.gameOf(2)).toMatchObject({ picked_by: f.entryB });
    expect(afterPick).toHaveBeenCalledWith(f.matchId);
    expect(f.pushes).toContain(f.matchId);
  });

  it('still pushes a timed-out pick when the engine throws after it (Task 8 review)', async () => {
    f = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: driveLoserPicks });
    await f.tick();
    const g1 = f.gameOf(1);
    f.goLive(g1.match_id!);
    f.endGame(g1.match_id!, [{ map: 'm1', a: 100, b: 500 }]);
    f.t.t += 2 * MIN;
    vi.spyOn(f.series, 'afterPick').mockImplementation(() => { throw new Error('boom'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.pushes.length = 0;
    await f.clock.tick();
    expect(f.gameOf(2)).toMatchObject({ picked_by: f.entryB });
    expect(f.pushes).toContain(f.matchId);
    expect(err.mock.calls.some((c) => String(c[0]).includes('after the timed-out pick failed'))).toBe(true);
    err.mockRestore();
  });

  it('books through the series engine on its own tick, with no separate series tick', async () => {
    f = await seriesFixture();
    expect(f.match()).toMatchObject({ status: 'booking', booking_id: null });
    await f.clock.tick();
    expect(f.match().booking_id).not.toBeNull();
  });
});

describe('RoomClock: window stages (plan T4)', () => {
  const H = 60;
  const hours = (h: number) => at(h * H);

  it('opens a scheduled room at the lead before its time, not before, and DMs the rosters', async () => {
    const f = await windowFixture();
    f.db.prepare("UPDATE event_matches SET scheduled_at = ?, schedule_source = 'default' WHERE id = ?").run(new Date(hours(2)).toISOString(), f.matchId);
    const t = { t: hours(2) - 21 * 60_000 };
    const { clock, send, push } = clockAt(f, t);
    await clock.tick();
    expect(match(f).status).toBe('waiting');
    t.t = hours(2) - 20 * 60_000;
    await clock.tick();
    expect(match(f)).toMatchObject({ status: 'veto', room_seed: 5 });
    expect(send).toHaveBeenCalledWith(expect.arrayContaining([A[0], B[0]]), 'event_match_room', expect.anything());
    expect(push).toHaveBeenCalledWith(f.matchId);
    expect(dueWindowRooms(f.db, new Date(t.t), 20 * 60_000)).toEqual([]);
  });

  it('does not open a window match with no time, and respects the busy rule but not the earliest-match rule', async () => {
    const f = await windowFixture();
    expect(dueWindowRooms(f.db, new Date(hours(48)), 20 * 60_000)).toEqual([]);
    f.db.prepare("UPDATE event_matches SET scheduled_at = ?, schedule_source = 'default' WHERE id = ?").run(new Date(hours(1)).toISOString(), f.matchId);
    // A second, later-round match of Rats already in a room makes Rats busy (test setup only).
    const other = Number(f.db.prepare(
      `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, entry_a, entry_b, status, created_at) VALUES (?, ?, 1, 2, 1, ?, ?, 'veto', ?)`,
    ).run(f.eventId, f.stageId, f.entryA, f.entryB, NOW.toISOString()).lastInsertRowid);
    expect(dueWindowRooms(f.db, new Date(hours(1)), 20 * 60_000)).toEqual([]);
    f.db.prepare("UPDATE event_matches SET status = 'done' WHERE id = ?").run(other);
    expect(dueWindowRooms(f.db, new Date(hours(1)), 20 * 60_000).map((m) => m.id)).toEqual([f.matchId]);
  });

  it('auto-accepts a due proposal and opens the room at its time, reminding first when the lock is far off', async () => {
    const f = await windowFixture();
    f.db.prepare("UPDATE settings SET value = '48' WHERE key = 'reschedule_autoaccept_hours'").run();
    const rules = S.scheduleRules(f.db);
    expect(rules).toEqual({ autoAcceptHours: 48, leadMinutes: 20 });
    const p = S.proposeTime(f.db, { matchId: f.matchId, by: A[0], time: new Date(hours(100)).toISOString(), rules, now: NOW });
    expect(p.ok).toBe(true);
    const t = { t: hours(24) };
    const { clock, send, push } = clockAt(f, t);
    await clock.tick();
    expect(send).toHaveBeenCalledWith([B[0]], 'event_reschedule', expect.objectContaining({ content: expect.stringContaining('locks') }));
    expect(send).not.toHaveBeenCalledWith(expect.arrayContaining([A[0]]), 'event_reschedule', expect.anything());
    expect(S.openProposal(f.db, f.matchId)!.reminded_at).toBe(new Date(hours(24)).toISOString());
    t.t = hours(48);
    await clock.tick();
    expect(match(f)).toMatchObject({ scheduled_at: new Date(hours(100)).toISOString(), schedule_source: 'agreed', status: 'waiting' });
    expect(send).toHaveBeenCalledWith(expect.arrayContaining([A[0], A[4], B[0], B[3]]), 'event_match_time', expect.anything());
    expect(push).toHaveBeenCalledWith(f.matchId);
    t.t = hours(100) - 20 * 60_000;
    await clock.tick();
    expect(match(f).status).toBe('veto');
  });

  it('expires a proposal whose time passed with no answer, and pushes', async () => {
    const f = await windowFixture();
    const p = S.proposeTime(f.db, { matchId: f.matchId, by: A[0], time: new Date(hours(30)).toISOString(), rules: S.scheduleRules(f.db), now: NOW });
    expect(p.ok && p.value.auto_accept_at).toBeNull();
    const t = { t: hours(30) };
    const { clock, push } = clockAt(f, t);
    await clock.tick();
    expect(S.openProposal(f.db, f.matchId)).toBeUndefined();
    expect(S.proposalsOf(f.db, f.matchId)[0]!.status).toBe('expired');
    expect(push).toHaveBeenCalledWith(f.matchId);
    expect(match(f).status).toBe('waiting');
  });

  it('at the window end forfeits the silent side, else holds the match for staff', async () => {
    const f = await windowFixture({ to: new Date(hours(48)) });
    S.proposeTime(f.db, { matchId: f.matchId, by: B[0], time: new Date(hours(30)).toISOString(), rules: S.scheduleRules(f.db), now: NOW });
    const t = { t: hours(48) };
    const { clock, send } = clockAt(f, t);
    await clock.tick();
    expect(match(f)).toMatchObject({ status: 'forfeit', winner_entry: f.entryB, result_source: 'forfeit' });
    expect(S.proposalsOf(f.db, f.matchId)[0]!.status).toBe('expired');
    expect(send).toHaveBeenCalledWith(expect.arrayContaining([A[0], B[0]]), 'event_match_forfeit', expect.objectContaining({ content: expect.stringContaining('window') }));

    const g = await windowFixture({ to: new Date(hours(48)) });
    const alerts: string[] = [];
    const { subscribeAdminEvents } = await import('../src/adminFeed.js');
    const off = subscribeAdminEvents((e) => { if (e.kind === 'problem') alerts.push(e.text); });
    try {
      const { clock: c2 } = clockAt(g, { t: hours(48) });
      await c2.tick();
      expect(match(g)).toMatchObject({ status: 'admin_hold', hold_reason: 'window_expired', hold_from: 'waiting' });
      expect(alerts.some((x) => /window/.test(x))).toBe(true);
      await c2.tick();
      expect(match(g).status).toBe('admin_hold');
      expect(alerts.filter((x) => /window/.test(x))).toHaveLength(1);
    } finally { off(); }
  });
});
