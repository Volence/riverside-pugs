// tests/draftRoomControls.test.ts
import { describe, it, expect } from 'vitest';
import * as D from '../src/events/drafts.js';
import * as DR from '../src/events/draftRoom.js';
import * as N from '../src/events/entries.js';
import { ADMIN } from './eventFixture.js';
import { cutDraft, type DraftFixture } from './draftFixture.js';
import { ALL, BENCH, CAPTAINS, POOL, T0, at, drive, err, liveDraft, must, startedDraft } from './draftRoomFixture.js';

const state = (f: DraftFixture) => DR.roomState(f.db, f.eventId)!;
const iso = (d: Date) => d.toISOString();
const staff = (f: DraftFixture, s: number) => ({ eventId: f.eventId, actor: ADMIN, now: at(s) });
const logs = (f: DraftFixture, action: string) =>
  (f.db.prepare('SELECT actor, detail FROM event_log WHERE action = ? ORDER BY id').all(action) as { actor: string | null; detail: string }[])
    .map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }));

describe('pause and resume', () => {
  it('stops the clock with the time left, and resume gives it back', () => {
    const f = startedDraft();
    expect(must(DR.pauseRoom(f.db, staff(f, 30)))).toEqual({ leftMs: 45_000 });
    expect(state(f).room).toMatchObject({ status: 'paused', deadline_at: null, paused_left_ms: 45_000 });
    expect(err(DR.autoPickDue(f.db, { eventId: f.eventId, now: at(500), present: ALL }))).toBe('not_due');
    expect(err(DR.pauseRoom(f.db, staff(f, 31)))).toBe('room_not_running');
    expect(must(DR.resumeRoom(f.db, staff(f, 600)))).toEqual({ deadlineAt: iso(at(645)) });
    expect(state(f).room).toMatchObject({ status: 'running', deadline_at: iso(at(645)), paused_left_ms: null });
    expect(err(DR.resumeRoom(f.db, staff(f, 601)))).toBe('room_not_paused');
  });

  it('never resumes with less than 5 seconds (Ruling 17)', () => {
    const f = startedDraft();
    must(DR.pauseRoom(f.db, staff(f, 74.5)));
    expect(must(DR.resumeRoom(f.db, staff(f, 100)))).toEqual({ deadlineAt: iso(at(105)) });
  });

  it('refuses before Start', () => {
    const f = liveDraft();
    expect(err(DR.pauseRoom(f.db, staff(f, 1)))).toBe('room_not_running');
  });
});

describe('undo', () => {
  it('takes back the last pick, frees the player and reopens the pick with a full clock', () => {
    const f = startedDraft();
    drive(f, 3);
    const third = state(f).picks[2]!;
    expect(must(DR.undoPick(f.db, staff(f, 40)))).toEqual({ undone: [3] });
    const st = state(f);
    expect(st.picks).toHaveLength(2);
    expect(st.next).toEqual({ pickNo: 3, round: 1, captain: CAPTAINS[2] });
    expect(st.room.deadline_at).toBe(iso(at(115)));
    expect(st.available.map((s) => s.steamid)).toContain(third.steamid);
    expect(D.signupOf(f.db, f.eventId, third.steamid)!.draft_team).toBeNull();
    const row = f.db.prepare('SELECT undone_at FROM draft_picks WHERE id = ?').get(third.id);
    expect(row).toEqual({ undone_at: iso(at(40)) });
    expect(logs(f, 'draft_pick_undone')).toEqual([{ actor: ADMIN, picks: [{ pickNo: 3, steamid: third.steamid }] }]);
  });

  it('refuses with nothing to undo', () => {
    const f = startedDraft();
    expect(err(DR.undoPick(f.db, staff(f, 2)))).toBe('no_picks');
  });

  it('keeps a paused room paused, with a full clock waiting', () => {
    const f = startedDraft();
    drive(f, 2);
    must(DR.pauseRoom(f.db, staff(f, 10)));
    must(DR.undoPick(f.db, staff(f, 11)));
    expect(state(f).room).toMatchObject({ status: 'paused', paused_left_ms: 75_000, deadline_at: null });
  });

  it('Review Focus 4: after the forced final pick, takes back both and holds publishing until done again', () => {
    const f = startedDraft();
    drive(f, 14);
    expect(state(f).room.status).toBe('done');
    expect(must(DR.undoPick(f.db, staff(f, 60)))).toEqual({ undone: [15, 14] });
    const st = state(f);
    expect(st.room).toMatchObject({ status: 'running', finished_at: null, deadline_at: iso(at(135)) });
    expect(st.next).toEqual({ pickNo: 14, round: 3, captain: CAPTAINS[3] });
    expect(st.available).toHaveLength(2);
    expect(err(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: at(61) }))).toBe('draft_not_done');
    drive(f, 1, 62);
    expect(state(f).room.status).toBe('done');
    expect(must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: at(70) })).entries).toHaveLength(5);
    expect(err(DR.undoPick(f.db, staff(f, 71)))).toBe('teams_made');
  });
});

describe('handing picking to a team\'s first pick (Ruling 16)', () => {
  it('lets the delegate pick for the team, from the captain\'s list when the clock runs out', () => {
    const f = startedDraft();
    drive(f, 1);
    const first = state(f).picks[0]!.steamid;
    expect(must(DR.setDelegate(f.db, { ...staff(f, 5), captain: CAPTAINS[0]!, on: true }))).toEqual({ delegate: first });
    expect(DR.captainFor(f.db, f.eventId, first)).toBe(CAPTAINS[0]);
    drive(f, 8, 10); // to pick 10, CAPTAINS[0]'s second pick
    const st = state(f);
    expect(st.next).toEqual({ pickNo: 10, round: 2, captain: CAPTAINS[0] });
    expect(st.picker).toBe(first);
    expect(err(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: st.available[0]!.steamid, pickNo: 10, now: at(30), present: ALL }))).toBe('not_your_pick');
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: first, player: st.available[0]!.steamid, pickNo: 10, now: at(30), present: ALL }));
    expect(must(DR.setDelegate(f.db, { ...staff(f, 31), captain: CAPTAINS[0]!, on: false }))).toEqual({ delegate: null });
    expect(state(f).delegates).toEqual({});
  });

  it('refuses a captain with no pick yet, and anyone who is not a captain', () => {
    const f = startedDraft();
    expect(err(DR.setDelegate(f.db, { ...staff(f, 1), captain: CAPTAINS[0]!, on: true }))).toBe('no_delegate');
    expect(err(DR.setDelegate(f.db, { ...staff(f, 1), captain: POOL[0]!, on: true }))).toBe('bad_captain');
  });

  it('drops the delegate when their pick is undone', () => {
    const f = startedDraft();
    drive(f, 1);
    must(DR.setDelegate(f.db, { ...staff(f, 5), captain: CAPTAINS[0]!, on: true }));
    must(DR.undoPick(f.db, staff(f, 6)));
    expect(state(f).delegates).toEqual({});
  });
});

describe('reset', () => {
  it('takes back every pick and returns to Ready, after which the room starts again or the method can change', () => {
    const f = startedDraft();
    drive(f, 4);
    expect(must(DR.resetRoom(f.db, staff(f, 20)))).toEqual({ undone: 4 });
    const st = state(f);
    expect(st.room).toMatchObject({ status: 'ready', order_json: '[]', deadline_at: null, started_at: null, delegates_json: '{}' });
    expect(st.picks).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM draft_picks WHERE event_id = ? AND undone_at IS NOT NULL').get(f.eventId)).toEqual({ n: 4 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM draft_signups WHERE event_id = ? AND draft_team IS NOT NULL').get(f.eventId)).toEqual({ n: 0 });
    must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: at(30), present: ALL }));
    must(DR.resetRoom(f.db, staff(f, 31)));
    must(D.chooseTeamMode(f.db, { eventId: f.eventId, mode: 'auto', actor: ADMIN, now: at(32) }));
  });

  it('flags every live pick undone, and a fresh Start has no filled slots', () => {
    const f = startedDraft();
    drive(f, 6);
    must(DR.resetRoom(f.db, staff(f, 20)));
    expect(DR.livePicks(f.db, f.eventId)).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM draft_picks WHERE event_id = ? AND undone_at IS NULL').get(f.eventId)).toEqual({ n: 0 });
    must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: at(30), present: ALL }));
    const st = state(f);
    expect(st.picks).toEqual([]);
    expect(st.next?.pickNo).toBe(1);
    expect(st.available).toHaveLength(st.pool.length);
    expect(st.pool.every((s) => s.draft_team === null)).toBe(true);
  });

  it('refuses a room that never started', () => {
    const f = liveDraft();
    expect(err(DR.resetRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: T0 }))).toBe('room_not_running');
  });
});

describe('pick lists (Rulings 1 and 2)', () => {
  const save = (f: DraftFixture, who: string, list: unknown, s = 1) => DR.savePickList(f.db, { eventId: f.eventId, steamid: who, list, now: at(s) });

  it('opens at the cut whatever the method, keeps pool players only and reads back in order', () => {
    const f = cutDraft();
    expect(must(save(f, CAPTAINS[0]!, [POOL[3], BENCH, POOL[3], 'nobody', POOL[1]]))).toEqual([POOL[3], POOL[1]]);
    expect(DR.pickListOf(f.db, f.eventId, CAPTAINS[0]!)).toEqual([POOL[3], POOL[1]]);
    expect(logs(f, 'draft_list_saved')).toEqual([{ actor: CAPTAINS[0], captain: CAPTAINS[0], size: 2 }]);
    must(save(f, CAPTAINS[0]!, [POOL[1]], 2));
    expect(DR.pickListOf(f.db, f.eventId, CAPTAINS[0]!)).toEqual([POOL[1]]);
  });

  it('refuses a pool player, a malformed list, and a cut not yet published', () => {
    const f = cutDraft();
    expect(err(save(f, POOL[0]!, [POOL[1]]))).toBe('not_a_captain');
    expect(err(save(f, CAPTAINS[0]!, 'nope'))).toBe('bad_list');
    expect(err(save(cutDraft({ publish: false }), CAPTAINS[0]!, []))).toBe('cut_not_published');
  });

  it('refuses a delegate: pick lists are the captain\'s alone, and nothing is written', () => {
    const f = startedDraft();
    drive(f, 1);
    const first = state(f).picks[0]!.steamid;
    must(DR.setDelegate(f.db, { eventId: f.eventId, captain: CAPTAINS[0]!, on: true, actor: ADMIN, now: at(3) }));
    const logsBefore = f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get();
    expect(err(save(f, first, [POOL[9]], 4))).toBe('not_a_captain');
    expect(DR.pickListOf(f.db, f.eventId, CAPTAINS[0]!)).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM draft_pick_lists').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get()).toEqual(logsBefore);
  });

  it('closes once the draft is done', () => {
    const f = startedDraft();
    drive(f, 14);
    expect(err(save(f, CAPTAINS[0]!, [POOL[1]], 40))).toBe('lists_closed');
  });

  it('Review Focus 5: drops a saved player who is no longer in the pool', () => {
    const f = cutDraft();
    must(save(f, CAPTAINS[0]!, [POOL[3], POOL[4]]));
    f.db.prepare("UPDATE draft_signups SET role = 'bench' WHERE event_id = ? AND steamid = ?").run(f.eventId, POOL[3]);
    expect(DR.pickListOf(f.db, f.eventId, CAPTAINS[0]!)).toEqual([POOL[4]]);
  });
});
