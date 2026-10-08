// tests/draftLiveIntegration.test.ts
import { describe, it, expect } from 'vitest';
import * as D from '../src/events/drafts.js';
import * as DR from '../src/events/draftRoom.js';
import * as N from '../src/events/entries.js';
import { DraftClock } from '../src/events/draftClock.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P, draftFixture } from './draftFixture.js';
import { must } from './draftRoomFixture.js';

/** Spec, Testing (Ruling 15): a 20-signup event from signups to the cut to
 *  a live draft to published entries, with one absent captain, a web
 *  restart mid-draft and an undo. */
describe('a live draft from signups to entries', () => {
  it('runs with an absent captain, a restart and an undo, and publishes five full teams', () => {
    const f = draftFixture();
    P.slice(0, 20).forEach((s, i) => must(D.signUp(f.db, { eventId: f.eventId, steamid: s, captainPref: 'willing', note: null, now: new Date(NOW.getTime() + i * 1000) })));
    must(D.closeSignups(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
    const captains = P.slice(15, 20); // SR 1375 to 1475, so lowest first is signup order
    expect(must(D.pickCaptains(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW })).captains.sort()).toEqual([...captains].sort());
    must(D.publishCut(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
    must(D.chooseTeamMode(f.db, { eventId: f.eventId, mode: 'live', actor: ADMIN, now: NOW }));
    const absent = captains[4]!;
    const here = captains.slice(0, 4);
    for (const c of here) must(DR.savePickList(f.db, { eventId: f.eventId, steamid: c, list: P.slice(0, 15), now: NOW }));

    let t = NOW.getTime() + 3_600_000 - 30_000;
    let clock = new DraftClock({ db: f.db, now: () => t });
    t += 30_000; // the site has been up a while: its startup grace is over
    const beat = () => { for (const c of here) clock.heartbeat(f.eventId, c); };
    const st = () => DR.roomState(f.db, f.eventId)!;
    beat();
    expect(must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date(t), present: clock.present(f.eventId) })).order).toEqual(captains);

    let restarted = false;
    let undone = false;
    for (let guard = 0; guard < 60 && st().room.status !== 'done'; guard++) {
      const s = st();
      if (s.picks.length === 7 && !restarted) {
        // A web restart: a new process with no heartbeats; the stored deadline stands.
        restarted = true;
        const deadline = Date.parse(s.room.deadline_at!);
        clock = new DraftClock({ db: f.db, now: () => t });
        t += 1000;
        clock.tick();
        expect(st().picks).toHaveLength(7);
        t = deadline;
        clock.tick();
        expect(st().picks).toHaveLength(8);
        expect(st().picks[7]).toMatchObject({ auto: 1 });
        beat();
        continue;
      }
      if (s.picks.length === 10 && !undone) {
        undone = true;
        must(DR.undoPick(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date(t), present: clock.present(f.eventId) }));
        expect(st().picks).toHaveLength(9);
        expect(st().room.deadline_at).toBe(new Date(t + 75_000).toISOString());
        continue;
      }
      if (s.picker === absent) {
        // The absent captain's clock is 5 seconds from when the pick opened.
        expect(Date.parse(s.room.deadline_at!) - t).toBe(5000);
        t = Date.parse(s.room.deadline_at!);
        clock.tick();
        continue;
      }
      t += 2000;
      beat();
      const free = new Set(s.available.map((a) => a.steamid));
      const choice = DR.pickListOf(f.db, f.eventId, s.next!.captain).find((x) => free.has(x))!;
      must(DR.makePick(f.db, { eventId: f.eventId, steamid: s.picker!, player: choice, pickNo: s.next!.pickNo, now: new Date(t), present: clock.present(f.eventId) }));
    }

    expect(restarted && undone).toBe(true);
    const picks = st().picks;
    expect(st().room.status).toBe('done');
    expect(picks).toHaveLength(15);
    const absentPicks = picks.filter((p) => p.captain_steamid === absent);
    expect(absentPicks).toHaveLength(3);
    expect(absentPicks.every((p) => p.auto === 1)).toBe(true);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM draft_picks WHERE event_id = ? AND undone_at IS NOT NULL').get(f.eventId)).toEqual({ n: 1 });

    const out = must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date(t) }));
    expect(out.entries).toHaveLength(5);
    for (const id of out.entries) {
      const e = N.getEntry(f.db, id)!;
      expect(N.rosterOf(f.db, id).starters).toHaveLength(4);
      expect(N.entryManagers(f.db, e)).toEqual([e.captain_steamid]);
    }
    expect(new Set(out.entries.map((id) => N.getEntry(f.db, id)!.captain_steamid))).toEqual(new Set(captains));
  });
});
