import { describe, it, expect, vi } from 'vitest';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import { RoomClock, dueRooms, higherSide } from '../src/events/roomClock.js';
import type { Notifier } from '../src/notify/notify.js';
import { ADMIN, NOW } from './eventFixture.js';
import { A, B } from './entryFixture.js';
import { TIMERS, roomFixture, type RoomFixture } from './roomFixture.js';
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
