// tests/draftRoom.test.ts
import { describe, it, expect } from 'vitest';
import * as D from '../src/events/drafts.js';
import * as DR from '../src/events/draftRoom.js';
import { snakeSlots } from '../src/events/draftRules.js';
import { ADMIN } from './eventFixture.js';
import { cutDraft, rate, type DraftFixture } from './draftFixture.js';
import { ALL, BENCH, CAPTAINS, NONE, POOL, T0, at, drive, err, liveDraft, must, startedDraft } from './draftRoomFixture.js';

const state = (f: DraftFixture) => DR.roomState(f.db, f.eventId)!;
const signup = (f: DraftFixture, s: string) => D.signupOf(f.db, f.eventId, s)!;
const iso = (d: Date) => d.toISOString();
const logs = (f: DraftFixture, action: string) =>
  (f.db.prepare('SELECT actor, detail FROM event_log WHERE action = ? ORDER BY id').all(action) as { actor: string | null; detail: string }[])
    .map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }));
const logCount = (f: DraftFixture) => (f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
const roomRows = (f: DraftFixture) => JSON.stringify([
  f.db.prepare('SELECT * FROM draft_rooms').all(),
  f.db.prepare('SELECT * FROM draft_picks ORDER BY id').all(),
  f.db.prepare('SELECT id, draft_team FROM draft_signups ORDER BY id').all(),
  logCount(f),
]);
/** A saved list, written directly: savePickList arrives in Task 4. */
const setList = (f: DraftFixture, captain: string, list: string[]) => f.db.prepare(
  "INSERT OR REPLACE INTO draft_pick_lists (event_id, captain_steamid, list_json, updated_at) VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z')",
).run(f.eventId, captain, JSON.stringify(list));
const start = (f: DraftFixture, present = ALL, rand?: (n: number) => number) =>
  DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0, present, rand });

describe('starting the room', () => {
  it('orders round 1 lowest SR first, starts a full clock and logs the order', () => {
    const f = liveDraft();
    expect(must(start(f))).toEqual({ order: CAPTAINS });
    const st = state(f);
    expect(st.room.status).toBe('running');
    expect(st.room.started_at).toBe(iso(T0));
    expect(st.room.deadline_at).toBe(iso(at(75)));
    expect(st.next).toEqual({ pickNo: 1, round: 1, captain: CAPTAINS[0] });
    expect(st.picker).toBe(CAPTAINS[0]);
    expect(st.available.map((s) => s.steamid)).toEqual(POOL);
    expect(logs(f, 'draft_room_started')).toEqual([{ actor: ADMIN, order: CAPTAINS, firstPick: 'lowest_sr', pickSeconds: 75 }]);
  });

  it('follows the first-pick setting and the pick clock', () => {
    const f = liveDraft();
    must(D.setRoomSettings(f.db, { eventId: f.eventId, settings: { firstPick: 'highest_sr', pickSeconds: 60 }, actor: ADMIN, now: T0 }));
    must(start(f));
    expect(state(f).order).toEqual([...CAPTAINS].reverse());
    expect(state(f).room.deadline_at).toBe(iso(at(60)));
    expect(state(f).room.pick_seconds).toBe(60);

    const g = liveDraft();
    must(D.setRoomSettings(g.db, { eventId: g.eventId, settings: { firstPick: 'random', pickSeconds: 75 }, actor: ADMIN, now: T0 }));
    // rand always 0 rotates signup order left by one (see tests/draftRoomRules.test.ts).
    expect(must(start(g, ALL, () => 0)).order).toEqual([...CAPTAINS.slice(1), CAPTAINS[0]]);
  });

  it('gives an absent first captain 5 seconds', () => {
    const f = liveDraft();
    must(start(f, NONE));
    expect(state(f).room.deadline_at).toBe(iso(at(5)));
  });

  it('refuses outside live mode, a second start and a changed pool, writing nothing', () => {
    const auto = cutDraft();
    expect(err(DR.startRoom(auto.db, { eventId: auto.eventId, actor: ADMIN, now: T0, present: ALL }))).toBe('not_live_mode');
    const f = startedDraft();
    expect(err(start(f))).toBe('room_not_ready');
    const g = liveDraft();
    g.db.prepare("UPDATE draft_signups SET role = 'bench' WHERE event_id = ? AND steamid = ?").run(g.eventId, POOL[0]);
    const before = roomRows(g);
    expect(err(start(g))).toBe('teams_changed');
    expect(roomRows(g)).toBe(before);
    expect(DR.roomOf(g.db, g.eventId)).toBeNull();
  });
});

describe('picks', () => {
  it('puts the player on the captain\'s team and opens the next pick with a full clock', () => {
    const f = startedDraft();
    const r = must(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: POOL[14]!, pickNo: 1, now: at(10), present: ALL }));
    expect(r).toEqual({ pickNo: 1, captain: CAPTAINS[0], steamid: POOL[14], auto: false, last: null, done: false });
    expect(signup(f, POOL[14]!).draft_team).toBe(signup(f, CAPTAINS[0]!).id);
    const st = state(f);
    expect(st.next).toEqual({ pickNo: 2, round: 1, captain: CAPTAINS[1] });
    expect(st.room.deadline_at).toBe(iso(at(85)));
    expect(st.picks).toEqual([expect.objectContaining({ pick_no: 1, round: 1, captain_steamid: CAPTAINS[0], steamid: POOL[14], auto: 0, at: iso(at(10)), undone_at: null })]);
    expect(logs(f, 'draft_pick')).toEqual([{ actor: CAPTAINS[0], ...r }]);
  });

  it('refuses the wrong picker, a player outside the pool and a taken player, writing nothing', () => {
    const f = startedDraft();
    const pick = (who: string, player: string, pickNo = state(f).next!.pickNo) =>
      DR.makePick(f.db, { eventId: f.eventId, steamid: who, player, pickNo, now: at(10), present: ALL });
    const before = roomRows(f);
    expect(err(pick(CAPTAINS[1]!, POOL[0]!))).toBe('not_your_pick');
    expect(err(pick(CAPTAINS[0]!, BENCH))).toBe('not_available');
    expect(err(pick(CAPTAINS[0]!, CAPTAINS[3]!))).toBe('not_available');
    expect(roomRows(f)).toBe(before);
    must(pick(CAPTAINS[0]!, POOL[0]!));
    expect(err(pick(CAPTAINS[1]!, POOL[0]!))).toBe('not_available');
  });

  it('refuses a pick while the room is not running', () => {
    const f = liveDraft();
    expect(err(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: POOL[0]!, pickNo: 1, now: at(1), present: ALL }))).toBe('room_not_running');
  });

  it('runs the snake: forward in odd rounds, back in even ones', () => {
    const f = startedDraft();
    drive(f, 14);
    expect(state(f).picks.map((p) => p.captain_steamid)).toEqual(snakeSlots(CAPTAINS).map((s) => s.captain));
  });

  it('Review Focus 1: a second click at a snake turn does not take a second player', () => {
    const f = startedDraft();
    drive(f, 4);
    const turn = CAPTAINS[4]!; // last of round 1 and first of round 2
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: turn, player: POOL[10]!, pickNo: 5, now: at(20), present: ALL }));
    expect(err(DR.makePick(f.db, { eventId: f.eventId, steamid: turn, player: POOL[11]!, pickNo: 5, now: at(20), present: ALL }))).toBe('pick_moved');
    expect(state(f).picks.filter((p) => p.captain_steamid === turn)).toHaveLength(1);
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: turn, player: POOL[11]!, pickNo: 6, now: at(21), present: ALL }));
    expect(state(f).picks.filter((p) => p.captain_steamid === turn)).toHaveLength(2);
  });

  it('makes the last pick at once, flagged auto, and finishes the room in one log row', () => {
    const f = startedDraft();
    drive(f, 13);
    const st = state(f);
    expect(st.available).toHaveLength(2);
    const before = logCount(f);
    const r = must(DR.makePick(f.db, { eventId: f.eventId, steamid: st.picker!, player: st.available[0]!.steamid, pickNo: 14, now: at(30), present: ALL }));
    expect(r.last).toEqual({ pickNo: 15, steamid: st.available[1]!.steamid });
    expect(r.done).toBe(true);
    expect(logCount(f)).toBe(before + 1);
    const done = state(f);
    expect(done.room).toMatchObject({ status: 'done', deadline_at: null, finished_at: iso(at(30)) });
    expect(done.next).toBeNull();
    expect(done.picks.at(-1)).toMatchObject({ pick_no: 15, auto: 1, captain_steamid: CAPTAINS[4] });
    const teams = D.draftTeamsOf(f.db, f.eventId)!;
    expect(teams.map((t) => t.players.length)).toEqual([3, 3, 3, 3, 3]);
  });

  it('gives an absent next picker 5 seconds', () => {
    const f = startedDraft();
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: POOL[0]!, pickNo: 1, now: at(3), present: (s) => s !== CAPTAINS[1] }));
    expect(state(f).room.deadline_at).toBe(iso(at(8)));
  });
});

describe('auto picks', () => {
  it('waits for the deadline and writes nothing before it', () => {
    const f = startedDraft();
    const before = roomRows(f);
    expect(err(DR.autoPickDue(f.db, { eventId: f.eventId, now: at(74), present: ALL }))).toBe('not_due');
    expect(roomRows(f)).toBe(before);
  });

  it('takes the highest SR free player with no list, ties by signup order, flagged auto with no actor', () => {
    const f = startedDraft();
    const r = must(DR.autoPickDue(f.db, { eventId: f.eventId, now: at(75), present: ALL }));
    expect(r).toMatchObject({ pickNo: 1, captain: CAPTAINS[0], steamid: POOL[14], auto: true });
    expect(state(f).picks[0]).toMatchObject({ auto: 1 });
    expect(logs(f, 'draft_pick')[0]!.actor).toBeNull();

    const g = startedDraft();
    rate(g.db, POOL[12]!, 2000);
    rate(g.db, POOL[13]!, 2000);
    expect(must(DR.autoPickDue(g.db, { eventId: g.eventId, now: at(75), present: ALL })).steamid).toBe(POOL[12]);
  });

  it('Review Focus 5: follows the captain\'s list, skipping players who are taken or not in the pool', () => {
    const f = startedDraft();
    setList(f, CAPTAINS[1]!, [BENCH, 'nobody', POOL[2]!, POOL[7]!, POOL[5]!]);
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: POOL[2]!, pickNo: 1, now: at(1), present: ALL }));
    expect(must(DR.autoPickDue(f.db, { eventId: f.eventId, now: at(80), present: ALL })).steamid).toBe(POOL[7]);
  });

  it('Review Focus 2: the deadline auto-pick and a late click never both land', () => {
    const f = startedDraft();
    must(DR.autoPickDue(f.db, { eventId: f.eventId, now: at(75), present: ALL }));
    expect(err(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: POOL[0]!, pickNo: 1, now: at(75), present: ALL }))).toBe('pick_moved');
    expect(state(f).picks).toHaveLength(1);

    const g = startedDraft();
    must(DR.makePick(g.db, { eventId: g.eventId, steamid: CAPTAINS[0]!, player: POOL[0]!, pickNo: 1, now: at(75), present: ALL }));
    expect(err(DR.autoPickDue(g.db, { eventId: g.eventId, now: at(75), present: ALL }))).toBe('not_due');
    expect(state(g).picks).toHaveLength(1);
    // The database backstop: a second live pick for slot 1 cannot exist.
    expect(() => g.db.prepare("INSERT INTO draft_picks (event_id, round, pick_no, captain_steamid, steamid, auto, at) VALUES (?, 1, 1, ?, ?, 0, 'x')")
      .run(g.eventId, CAPTAINS[0], POOL[1])).toThrow(/UNIQUE/);
  });

  it('refuses teams_changed, writing nothing, when the pool shrank and no player is left for a slot', () => {
    // An account merge is the only way the pool shrinks mid-draft; a withdrawn signup stands in for it.
    const gone = (f: DraftFixture, s: string) =>
      f.db.prepare("UPDATE draft_signups SET withdrawn_at = '2026-10-01T00:00:00.000Z' WHERE event_id = ? AND steamid = ?").run(f.eventId, s);
    const f = startedDraft();
    drive(f, 13);
    for (const s of state(f).available) gone(f, s.steamid);
    const before = roomRows(f);
    expect(err(DR.autoPickDue(f.db, { eventId: f.eventId, now: at(500), present: ALL }))).toBe('teams_changed');
    expect(roomRows(f)).toBe(before);

    // One player left for two open slots: the pick cannot be followed by the forced final pick.
    const g = startedDraft();
    drive(g, 13);
    gone(g, state(g).available[0]!.steamid);
    const st = state(g);
    const rows = roomRows(g);
    expect(err(DR.makePick(g.db, { eventId: g.eventId, steamid: st.picker!, player: st.available[0]!.steamid, pickNo: st.next!.pickNo, now: at(20), present: ALL }))).toBe('teams_changed');
    expect(err(DR.autoPickDue(g.db, { eventId: g.eventId, now: at(500), present: ALL }))).toBe('teams_changed');
    expect(roomRows(g)).toBe(rows);
  });
});
