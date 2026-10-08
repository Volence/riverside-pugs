// tests/draftClock.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as DR from '../src/events/draftRoom.js';
import { DraftClock, HEARTBEAT_FRESH_MS } from '../src/events/draftClock.js';
import { ADMIN } from './eventFixture.js';
import { CAPTAINS, POOL, T0, at, liveDraft, must, startedDraft } from './draftRoomFixture.js';

describe('presence (Ruling 8)', () => {
  it('counts a heartbeat for 25 seconds, per event', () => {
    let t = T0.getTime();
    const clock = new DraftClock({ db: liveDraft().db, now: () => t });
    clock.heartbeat(7, 'a');
    expect(clock.present(7)('a')).toBe(true);
    expect(clock.present(8)('a')).toBe(false);
    t += HEARTBEAT_FRESH_MS;
    expect(clock.present(7)('a')).toBe(true);
    t += 1;
    expect(clock.present(7)('a')).toBe(false);
  });
});

describe('the tick (Ruling 7)', () => {
  it('auto-picks a running room once its deadline passes, pushes it, and gives an absent next picker 5 seconds', () => {
    const f = startedDraft();
    let t = at(74).getTime();
    const push = vi.fn();
    const clock = new DraftClock({ db: f.db, now: () => t, push });
    clock.tick();
    expect(DR.livePicks(f.db, f.eventId)).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
    t = at(75).getTime();
    clock.tick();
    expect(DR.livePicks(f.db, f.eventId)).toHaveLength(1);
    expect(push).toHaveBeenCalledWith(f.eventId);
    expect(DR.roomOf(f.db, f.eventId)!.deadline_at).toBe(new Date(t + 5000).toISOString());
  });

  it('never picks for a paused room', () => {
    const f = startedDraft();
    must(DR.pauseRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: at(10) }));
    new DraftClock({ db: f.db, now: () => at(500).getTime() }).tick();
    expect(DR.livePicks(f.db, f.eventId)).toHaveLength(0);
  });

  it('Review Focus 3: a restart keeps the stored deadline, picks once it passes, and leaves a paused room paused', () => {
    const f = liveDraft();
    let t = T0.getTime();
    const before = new DraftClock({ db: f.db, now: () => t });
    for (const c of CAPTAINS) before.heartbeat(f.eventId, c);
    must(DR.startRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date(t), present: before.present(f.eventId) }));
    t += 2000;
    must(DR.makePick(f.db, { eventId: f.eventId, steamid: CAPTAINS[0]!, player: POOL[0]!, pickNo: 1, now: new Date(t), present: before.present(f.eventId) }));
    const deadline = DR.roomOf(f.db, f.eventId)!.deadline_at!;
    expect(deadline).toBe(new Date(t + 75_000).toISOString());

    const after = new DraftClock({ db: f.db, now: () => t }); // a new process: no heartbeats
    t += 30_000;
    after.tick();
    expect(DR.livePicks(f.db, f.eventId)).toHaveLength(1);
    expect(DR.roomOf(f.db, f.eventId)!.deadline_at).toBe(deadline);
    t = Date.parse(deadline);
    after.tick();
    expect(DR.livePicks(f.db, f.eventId)[1]).toMatchObject({ pick_no: 2, captain_steamid: CAPTAINS[1], auto: 1 });

    must(DR.pauseRoom(f.db, { eventId: f.eventId, actor: ADMIN, now: new Date(t) }));
    new DraftClock({ db: f.db, now: () => t + 3_600_000 }).tick();
    expect(DR.livePicks(f.db, f.eventId)).toHaveLength(2);
    expect(DR.roomOf(f.db, f.eventId)!.status).toBe('paused');
  });
});
