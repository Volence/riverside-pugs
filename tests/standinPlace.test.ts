// tests/standinPlace.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as N from '../src/events/entries.js';
import * as P from '../src/events/play.js';
import * as R from '../src/events/room.js';
import * as ST from '../src/events/standins.js';
import { RoomClock } from '../src/events/roomClock.js';
import { draftBench } from '../src/events/views.js';
import type { Notifier } from '../src/notify/notify.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P as DP } from './draftFixture.js';
import { A, B as BATS, OUTSIDER } from './entryFixture.js';
import { TIMERS, driveToBooking, roomFixture } from './roomFixture.js';
import { BENCH, asDraft, benchOn, entryOf, offeredFor, standinFixture } from './standinFixture.js';

const MIN = 60_000;
const at = (min: number) => new Date(NOW.getTime() + min * MIN);
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);
const rows = (db: Parameters<typeof N.getEntry>[0]) => JSON.stringify([
  db.prepare('SELECT * FROM event_entry_players ORDER BY id').all(),
  db.prepare('SELECT * FROM event_lineups ORDER BY id').all(),
  db.prepare('SELECT * FROM draft_standins ORDER BY id').all(),
  db.prepare('SELECT * FROM draft_standin_offers ORDER BY id').all(),
  db.prepare('SELECT COUNT(*) AS n FROM event_log').get(),
]);

describe('placeStandin, rest of the event (Ruling 6)', () => {
  it('puts the stand-in on as a starter in place of the dropout, fills the request, and logs once', () => {
    const f = standinFixture();
    const out = DP[11]!;
    const entry = entryOf(f, out);
    const o = offeredFor(f, entry.id, out, 'event');
    expect(o.steamid).toBe(BENCH[0]);
    const before = N.rosterOf(f.db, entry.id).starters;
    const r = must(N.placeStandin(f.db, { eventId: f.eventId, requestId: o.requestId, offerId: o.offerId, steamid: o.steamid, acceptedAt: at(1), now: at(1) }));
    expect(r).toEqual({ subbedInMatch: null, requestId: o.requestId, entryId: entry.id, out, in: BENCH[0], scope: 'event', matchId: null });
    expect(N.rosterOf(f.db, entry.id).starters).toEqual([...before.filter((s) => s !== out), BENCH[0]]);
    expect(N.entryOfPlayer(f.db, f.eventId, out)).toBeUndefined();
    expect(ST.requestOf(f.db, o.requestId)).toMatchObject({ status: 'filled', filled_by: BENCH[0] });
    expect(ST.offerOf(f.db, o.offerId)?.answer).toBe('accept');
    expect(draftBench(f.db, f.eventId).map((b) => b.steamid)).not.toContain(BENCH[0]);
    expect(f.db.prepare("SELECT actor, detail FROM event_log WHERE action = 'standin_placed'").all()).toEqual([
      { actor: BENCH[0], detail: JSON.stringify({ requestId: o.requestId, entryId: entry.id, out, in: BENCH[0], scope: 'event' }) },
    ]);
  });

  it('refuses a late accept, someone else pressing it, a stopped offer, and a stand-in placed elsewhere since, writing nothing', () => {
    const f = standinFixture();
    const out = DP[11]!;
    const entry = entryOf(f, out);
    const o = offeredFor(f, entry.id, out, 'event');
    const go = (over: Partial<N.StandinPlaceInput> = {}) =>
      N.placeStandin(f.db, { eventId: f.eventId, requestId: o.requestId, offerId: o.offerId, steamid: o.steamid, acceptedAt: at(1), now: at(1), ...over });
    const before = rows(f.db);
    expect(err(go({ acceptedAt: at(10), now: at(10) }))).toBe('standin_offer_expired');
    expect(err(go({ steamid: BENCH[1]! }))).toBe('standin_offer_gone');
    expect(rows(f.db)).toBe(before);
    // BENCH[0] goes onto another team by a staff replace first.
    const other = f.entries.find((id) => id !== entry.id)!;
    const otherOut = N.rosterOf(f.db, other).starters.find((s) => s !== N.getEntry(f.db, other)!.captain_steamid)!;
    must(N.replaceDraftPlayer(f.db, { eventId: f.eventId, entryId: other, out: otherOut, in: BENCH[0]!, reason: 'other', note: null, actor: ADMIN, now: at(1) }));
    const mid = rows(f.db);
    expect(err(go())).toBe('player_entered');
    expect(rows(f.db)).toBe(mid);
    must(ST.cancelStandin(f.db, { requestId: o.requestId, by: ADMIN, staff: true, now: at(2) }));
    expect(err(go({ acceptedAt: at(2), now: at(2) }))).toBe('standin_offer_gone');
  });
});

describe('placeStandin, next match (Ruling 7)', () => {
  it('with the lineup locked: a sub of the team, swapped into the lineup without using a sub, and gone once the match is over', async () => {
    const f = await roomFixture();
    asDraft(f);
    driveToBooking(f);
    benchOn(f.db, f.eventId, OUTSIDER);
    const o = offeredFor(f, f.entryA, A[3]!, 'match', at(5));
    expect(o.steamid).toBe(OUTSIDER);
    const r = must(N.placeStandin(f.db, { eventId: f.eventId, requestId: o.requestId, offerId: o.offerId, steamid: OUTSIDER, acceptedAt: at(6), now: at(6) }));
    expect(r).toMatchObject({ subbedInMatch: f.matchId, scope: 'match', matchId: f.matchId, out: A[3], in: OUTSIDER });
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], OUTSIDER]);
    expect(R.subsUsed(f.db, P.getMatch(f.db, f.matchId)!, 'a')).toBe(0);
    expect(N.rosterOf(f.db, f.entryA)).toMatchObject({ starters: A.slice(0, 4), subs: [OUTSIDER] });
    expect(N.endStandin(f.db, { requestId: o.requestId, now: at(7) })).toEqual({ ok: false, error: 'standin_running' });
    // Test setup only: the match is over.
    f.db.prepare("UPDATE event_matches SET status = 'done' WHERE id = ?").run(f.matchId);
    expect(ST.endableStandins(f.db).map((x) => x.id)).toEqual([o.requestId]);
    expect(N.endStandin(f.db, { requestId: o.requestId, now: at(60) })).toEqual({ ok: true, value: { entryId: f.entryA, steamid: OUTSIDER } });
    expect(N.rosterOf(f.db, f.entryA).subs).toEqual([]);
    expect(ST.requestOf(f.db, o.requestId)?.status).toBe('ended');
    expect(err(N.endStandin(f.db, { requestId: o.requestId, now: at(61) }))).toBe('standin_closed');
  });

  it('refuses once the target match is over', async () => {
    const f = await roomFixture();
    asDraft(f);
    benchOn(f.db, f.eventId, OUTSIDER);
    const o = offeredFor(f, f.entryA, A[3]!, 'match');
    f.db.prepare("UPDATE event_matches SET status = 'forfeit' WHERE id = ?").run(f.matchId);
    expect(err(N.placeStandin(f.db, { eventId: f.eventId, requestId: o.requestId, offerId: o.offerId, steamid: OUTSIDER, acceptedAt: NOW, now: NOW }))).toBe('standin_match_over');
  });

  it('Review Focus 4: the timed-out lineup locks the stand-in in place of the missing starter', async () => {
    const f = await roomFixture();
    asDraft(f);
    benchOn(f.db, f.eventId, OUTSIDER);
    const o = offeredFor(f, f.entryA, A[3]!, 'match');
    must(N.placeStandin(f.db, { eventId: f.eventId, requestId: o.requestId, offerId: o.offerId, steamid: OUTSIDER, acceptedAt: NOW, now: NOW }));
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toBeNull();
    const t = { t: NOW.getTime() };
    const clock = new RoomClock({ db: f.db, notifier: { send: vi.fn(() => 1) } as unknown as Notifier, publicUrl: 'https://x', push: vi.fn(), now: () => t.t, seed: () => 5 });
    await clock.tick();
    for (const steamid of [A[0]!, BATS[0]!]) R.readyUp(f.db, { matchId: f.matchId, steamid, timers: TIMERS, now: at(1) });
    for (const min of [2, 3, 4]) { t.t = at(min).getTime(); await clock.tick(); }
    expect(P.getMatch(f.db, f.matchId)!.status).toBe('lineup');
    t.t = at(20).getTime();
    await clock.tick();
    expect(R.lineupFour(f.db, f.matchId, f.entryA)).toEqual([A[0], A[1], A[2], OUTSIDER]);
    expect(R.lineupFour(f.db, f.matchId, f.entryB)).toEqual(BATS.slice(0, 4));
  });
});

describe('a placed stand-in is busy', () => {
  it('an event stand-in is skipped for another team\'s request while placed', () => {
    const f = standinFixture();
    const out = DP[11]!;
    const entry = entryOf(f, out);
    const o = offeredFor(f, entry.id, out, 'event');
    must(N.placeStandin(f.db, { eventId: f.eventId, requestId: o.requestId, offerId: o.offerId, steamid: o.steamid, acceptedAt: at(1), now: at(1) }));
    const other = f.entries.find((id) => id !== entry.id)!;
    const otherOut = N.rosterOf(f.db, other).starters.find((s) => s !== N.getEntry(f.db, other)!.captain_steamid)!;
    const o2 = offeredFor(f, other, otherOut, 'event', at(2));
    expect(o2.steamid).not.toBe(o.steamid);
    expect(BENCH).toContain(o2.steamid);
  });

  it('a match stand-in (a sub place) is skipped for another team\'s request while placed', async () => {
    const f = await roomFixture();
    asDraft(f);
    benchOn(f.db, f.eventId, OUTSIDER);
    const o = offeredFor(f, f.entryA, A[3]!, 'match');
    must(N.placeStandin(f.db, { eventId: f.eventId, requestId: o.requestId, offerId: o.offerId, steamid: OUTSIDER, acceptedAt: NOW, now: NOW }));
    const { requestId } = must(ST.requestStandin(f.db, { eventId: f.eventId, entryId: f.entryB, out: BATS[3]!, scope: 'match', by: ADMIN, staff: true, now: at(1) }));
    must(ST.setStandinMarginOff(f.db, { requestId, actor: ADMIN, now: at(1) }));
    const step = must(ST.offerNextStandin(f.db, { requestId, now: at(1), minutes: 10 }));
    expect(step.offered).toBeNull();
  });
});
