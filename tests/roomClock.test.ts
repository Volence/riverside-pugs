import { describe, it, expect, vi } from 'vitest';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import { RoomClock, dueRooms, higherSide } from '../src/events/roomClock.js';
import type { Notifier } from '../src/notify/notify.js';
import { NOW } from './eventFixture.js';
import { A, B } from './entryFixture.js';
import { TIMERS, roomFixture, type RoomFixture } from './roomFixture.js';
import { SE, playFixture } from './playFixture.js';

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
    expect(send).toHaveBeenCalledWith(expect.arrayContaining([A[0], B[0]]), 'event_match_forfeit', expect.anything());
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
});
