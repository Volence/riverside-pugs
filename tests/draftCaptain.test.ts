import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { authedCookie } from './helpers.js';
import { adminEventRoutes } from '../src/routes/adminEvents.js';
import type { Notifier } from '../src/notify/notify.js';
import { upsertPlayer } from '../src/players.js';
import * as B from '../src/bookings/bookings.js';
import { gameLines } from '../src/bookings/runner.js';
import { getServer } from '../src/serverPool.js';
import * as N from '../src/events/entries.js';
import * as PL from '../src/events/play.js';
import * as R from '../src/events/room.js';
import { EVENT_ERRORS } from '../src/events/validate.js';
import { presetConfig } from '../src/events/vetoConfig.js';
import { ADMIN, NOW } from './eventFixture.js';
import { P, cutDraft, type DraftFixture } from './draftFixture.js';
import { A, B as BATS, entryFixture, rosterA } from './entryFixture.js';
import { POOL7, TIMERS, roomFixture, type RoomFixture } from './roomFixture.js';
import { driveLoserPicks, seriesFixture, type SeriesFixture } from './seriesFixture.js';

/**
 * D2c addendum (owner 2026-10-07): staff transfer a draft team's captaincy.
 */

const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const LATER = new Date(NOW.getTime() + 3_600_000);
const BENCH = P[15]!;

function published(o: { startsAt?: string; now?: Date } = {}): DraftFixture & { entries: number[] } {
  const f = cutDraft({ balance: true, ...o });
  const { entries } = must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: o.now ?? NOW }));
  return { ...f, entries };
}
const starters = (f: { db: DraftFixture['db'] }, entryId: number) => N.rosterOf(f.db, entryId).starters;
const snapshot = (f: { db: DraftFixture['db'] }) => JSON.stringify([
  f.db.prepare('SELECT * FROM event_entries ORDER BY id').all(),
  f.db.prepare('SELECT * FROM event_entry_players ORDER BY id').all(),
  f.db.prepare('SELECT * FROM booking_sides ORDER BY rowid').all(),
  f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get(),
]);
const logs = (f: { db: DraftFixture['db'] }, action: string) =>
  (f.db.prepare('SELECT actor, detail FROM event_log WHERE action = ? ORDER BY id').all(action) as { actor: string; detail: string }[])
    .map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }));

/** As tests/draftReplace.test.ts: the room fixture's two team entries made draft entries (test setup only). */
const asDraft = (f: RoomFixture) => {
  f.db.prepare("UPDATE events SET entry_kind = 'draft', teams_made_at = ? WHERE id = ?").run(NOW.toISOString(), f.eventId);
  f.db.prepare('UPDATE event_entries SET team_id = NULL, captain_steamid = CASE id WHEN ? THEN ? ELSE ? END WHERE id IN (?, ?)')
    .run(f.entryA, A[0], BATS[0], f.entryA, f.entryB);
  f.db.prepare('UPDATE event_entry_players SET removed_at = ? WHERE entry_id = ? AND steamid = ?').run(NOW.toISOString(), f.entryA, A[4]);
};

describe('setDraftCaptain', () => {
  it('makes another starter the captain before the event is live, with one log row; the old captain stays a starter and the name stays', () => {
    const f = published();
    const entryId = f.entries[0]!;
    const [old, next] = starters(f, entryId) as [string, string];
    const name = N.getEntry(f.db, entryId)!.name;
    const r = N.setDraftCaptain(f.db, { eventId: f.eventId, entryId, steamid: next, actor: ADMIN, now: LATER });
    expect(r).toEqual({ ok: true, value: { from: old, to: next } });
    const e = N.getEntry(f.db, entryId)!;
    expect(e.captain_steamid).toBe(next);
    expect(e.name).toBe(name);
    expect(N.entryManagers(f.db, e)).toEqual([next]);
    expect(starters(f, entryId)).toContain(old);
    expect(logs(f, 'entry_captain_set')).toEqual([{ actor: ADMIN, entryId, from: old, to: next }]);
  });

  it('refuses an entry that is out (entry_out), writing nothing', () => {
    const f = published();
    const entryId = f.entries[0]!;
    f.db.prepare("UPDATE event_entries SET status = 'disqualified' WHERE id = ?").run(entryId);
    const before = snapshot(f);
    const r = N.setDraftCaptain(f.db, { eventId: f.eventId, entryId, steamid: starters(f, entryId)[1]!, actor: ADMIN, now: LATER });
    expect(r.ok ? null : r.error).toBe('entry_out');
    expect(snapshot(f)).toBe(before);
  });

  it('refuses a non-starter, the captain, an unknown entry, a team entry, and outside the window, writing nothing', () => {
    const f = published();
    const [e0, e1] = f.entries as [number, number];
    const [captain] = starters(f, e0);
    const other = starters(f, e1)[2]!;
    const before = snapshot(f);
    const go = (over: Partial<Parameters<typeof N.setDraftCaptain>[1]>) =>
      N.setDraftCaptain(f.db, { eventId: f.eventId, entryId: e0, steamid: starters(f, e0)[1]!, actor: ADMIN, now: LATER, ...over });
    const err = (r: ReturnType<typeof go>) => (r.ok ? null : r.error);
    expect(err(go({ steamid: other }))).toBe('replace_not_starter');
    expect(err(go({ steamid: BENCH }))).toBe('replace_not_starter');
    expect(err(go({ steamid: captain! }))).toBe('already_captain');
    expect(EVENT_ERRORS.already_captain).toEqual({ status: 409, text: 'That player is already the captain.' });
    expect(err(go({ entryId: 999_999 }))).toBe('entry_not_found');
    f.db.prepare('UPDATE events SET teams_made_at = NULL WHERE id = ?').run(f.eventId);
    expect(err(go({}))).toBe('wrong_status');
    f.db.prepare('UPDATE events SET teams_made_at = ? WHERE id = ?').run(NOW.toISOString(), f.eventId);
    f.db.prepare("UPDATE events SET status = 'finished' WHERE id = ?").run(f.eventId);
    expect(err(go({}))).toBe('wrong_status');
    f.db.prepare("UPDATE events SET status = 'registration' WHERE id = ?").run(f.eventId);
    expect(snapshot(f)).toBe(before);
    const t = entryFixture();
    const entryId = must(N.registerEntry(t.db, { eventId: t.eventId, teamId: t.teamA, by: A[0]!, roster: rosterA(), now: NOW })).entry.id;
    const r = N.setDraftCaptain(t.db, { eventId: t.eventId, entryId, steamid: A[1]!, actor: ADMIN, now: NOW });
    expect(r.ok ? null : r.error).toBe('replace_not_draft');
  });

  it('the new captain acts in the match room and the old one cannot', async () => {
    const f = await roomFixture();
    asDraft(f);
    must(N.setDraftCaptain(f.db, { eventId: f.eventId, entryId: f.entryA, steamid: A[1]!, actor: ADMIN, now: NOW }));
    must(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
    const ready = (steamid: string) => R.readyUp(f.db, { matchId: f.matchId, steamid, timers: TIMERS, now: new Date(NOW.getTime() + 60_000) });
    const old = ready(A[0]!);
    expect(old.ok ? null : old.error).toBe('not_manager');
    expect(ready(A[1]!).ok).toBe(true);
    const m = PL.getMatch(f.db, f.matchId)!;
    expect(R.sideOf(f.db, m, A[1]!)).toBe('a');
    expect(R.sideOf(f.db, m, A[0]!)).toBeNull();
  });
});

describe('a captain change during a booked series', () => {
  let s: SeriesFixture;
  afterEach(() => { vi.restoreAllMocks(); s?.close(); });

  it('moves the booking side\'s captain to the new one, keeps the side\'s name, and leaves the other side alone', async () => {
    s = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: (f) => { asDraft(f); driveLoserPicks(f); } });
    await s.tick();
    const b = s.booking();
    expect(B.isOpen(b)).toBe(true);
    const sideA = B.sideRow(s.db, b.id, 'a')!;
    const sideB = B.sideRow(s.db, b.id, 'b')!;
    expect(sideA.captain_steamid).toBe(A[0]);
    const nameA = B.sideName(s.db, sideA);
    const sentBefore = s.sent.length;
    const r = N.setDraftCaptain(s.db, { eventId: s.eventId, entryId: s.entryA, steamid: A[1]!, actor: ADMIN, now: new Date(s.t.t) });
    expect(r).toEqual({ ok: true, value: { from: A[0], to: A[1] } });
    const after = B.sideRow(s.db, b.id, 'a')!;
    expect(after.captain_steamid).toBe(A[1]);
    expect(B.sideName(s.db, after)).toBe(nameA);
    expect(B.sideRow(s.db, b.id, 'b')).toEqual(sideB);
    // Every booking reader follows: the in-game captain check and the captains cvar the minute re-push sends.
    expect(B.actingSides(s.db, b.id, A[1]!)).toEqual(['a']);
    expect(B.actingSides(s.db, b.id, A[0]!)).toEqual([]);
    const fresh = B.getBooking(s.db, b.id)!;
    const captainsLine = gameLines(s.db, fresh, getServer(s.db, fresh.server_id!)!).find((l) => l.startsWith('l4d_booking_captains '))!;
    expect(captainsLine).toContain(A[1]!);
    expect(captainsLine).not.toContain(A[0]!);
    // The change itself sends nothing to the box (the minute re-push carries the captains list).
    expect(s.sent.length).toBe(sentBefore);
    const bev = s.db.prepare("SELECT actor, detail FROM booking_events WHERE booking_id = ? AND event = 'captain_set'").all(b.id) as { actor: string; detail: string }[];
    expect(bev.map((x) => ({ actor: x.actor, ...JSON.parse(x.detail) }))).toEqual([{ actor: ADMIN, side: 'a', from: A[0], to: A[1] }]);
  });
});

describe('a captain change on entry_b during a booked series', () => {
  let s: SeriesFixture;
  afterEach(() => { s?.close(); });
  it('moves booking side b\'s captain and leaves side a alone', async () => {
    s = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: (f) => { asDraft(f); driveLoserPicks(f); } });
    await s.tick();
    const b = s.booking();
    expect(s.match().entry_b).toBe(s.entryB);
    const sideA = B.sideRow(s.db, b.id, 'a')!;
    const sideB = B.sideRow(s.db, b.id, 'b')!;
    expect(sideB.captain_steamid).toBe(BATS[0]);
    must(N.setDraftCaptain(s.db, { eventId: s.eventId, entryId: s.entryB, steamid: BATS[1]!, actor: ADMIN, now: new Date(s.t.t) }));
    const after = B.sideRow(s.db, b.id, 'b')!;
    expect(after.captain_steamid).toBe(BATS[1]);
    expect(B.sideName(s.db, after)).toBe(B.sideName(s.db, sideB));
    expect(B.sideRow(s.db, b.id, 'a')).toEqual(sideA);
    expect(B.actingSides(s.db, b.id, BATS[1]!)).toEqual(['b']);
  });
});

describe('setSideCaptain', () => {
  let s: SeriesFixture;
  afterEach(() => { s?.close(); });
  it('refuses a team side and a closed booking', async () => {
    s = await seriesFixture({ pool: POOL7, veto: presetConfig('loser_picks', 7), drive: (f) => { asDraft(f); driveLoserPicks(f); } });
    await s.tick();
    const b = s.booking();
    s.db.prepare('UPDATE booking_sides SET team_id = ? WHERE booking_id = ? AND side = ?').run(
      (s.db.prepare('SELECT id FROM teams LIMIT 1').get() as { id: number }).id, b.id, 'b');
    const r = B.setSideCaptain(s.db, b.id, 'b', BATS[1]!, ADMIN, new Date(s.t.t));
    expect(r.ok ? null : r.error).toBe('wrong_state');
    s.db.prepare("UPDATE bookings SET state = 'ended', ended_at = ? WHERE id = ?").run(NOW.toISOString(), b.id);
    const r2 = B.setSideCaptain(s.db, b.id, 'a', A[1]!, ADMIN, new Date(s.t.t));
    expect(r2.ok ? null : r2.error).toBe('wrong_state');
  });
});

describe('the captain route', () => {
  let desk: FastifyInstance;
  let send: ReturnType<typeof vi.fn>;
  let f: DraftFixture & { entries: number[] };
  const MOD = '76561199000000990';
  beforeEach(async () => {
    const now = new Date();
    f = published({ startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), now });
    upsertPlayer(f.db, { steamid: MOD, name: 'mod', avatar: null }, []);
    f.db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(MOD);
    send = vi.fn(() => 1);
    desk = Fastify();
    await desk.register(cookie, { secret: 'x'.repeat(32) });
    await desk.register(adminEventRoutes, { db: f.db, store: () => { throw new Error('no store'); }, notifier: { send } as unknown as Notifier, publicUrl: 'https://x' });
    await desk.ready();
  });
  afterEach(async () => { await desk.close(); });
  const post = (as: string, body: object) => desk.inject({
    method: 'POST', url: `/api/admin/events/${f.eventId}/entries/${f.entries[0]}/captain`, cookies: authedCookie(desk, f.db, as), payload: body,
  });
  const name = (s: string) => `d${P.indexOf(s)}`;

  it('refuses a mod; an admin makes a starter captain with an audit row and the two DMs', async () => {
    const [old, next] = starters(f, f.entries[0]!) as [string, string];
    expect((await post(MOD, { steamid: next })).statusCode).toBe(403);
    expect(N.getEntry(f.db, f.entries[0]!)!.captain_steamid).toBe(old);
    const res = await post(ADMIN, { steamid: next });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ from: old, to: next });
    const audit = f.db.prepare("SELECT admin_id, detail FROM admin_actions WHERE action = 'event_entry_captain'").all() as { admin_id: string; detail: string }[];
    expect(audit.map((a) => ({ admin: a.admin_id, ...JSON.parse(a.detail) }))).toEqual([{ admin: ADMIN, entryId: f.entries[0], from: old, to: next }]);
    const team = N.getEntry(f.db, f.entries[0]!)!.name;
    expect(team).toBe(`Team ${name(old)}`);
    const calls = send.mock.calls.map(([to, type, payload]) => ({ to: [...(to as string[])], type, content: (payload as { content: string }).content }));
    expect(calls).toEqual([
      { to: [next], type: 'draft_captain_set_new', content: `You are now the captain of ${team} in Draft Night. You run the match room, prep and the team name: https://x/event/${f.slug}` },
      { to: [old], type: 'draft_captain_set_old', content: `${name(next)} is now the captain of ${team} in Draft Night.` },
    ]);
  });

  it('refuses with the sentence and sends nothing', async () => {
    const [captain] = starters(f, f.entries[0]!);
    const res = await post(ADMIN, { steamid: captain });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(EVENT_ERRORS.already_captain.text);
    expect((await post(ADMIN, { steamid: 5 })).statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'event_entry_captain'").get()).toEqual({ n: 0 });
  });
});

describe('the captain route with an open room', () => {
  it('pushes each open room of the entry after the change, so room pages refresh', async () => {
    const f = await roomFixture();
    asDraft(f);
    must(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
    const pushChange = vi.fn();
    const desk = Fastify();
    await desk.register(cookie, { secret: 'x'.repeat(32) });
    await desk.register(adminEventRoutes, { db: f.db, store: () => { throw new Error('no store'); }, notifier: { send: vi.fn(() => 1) } as unknown as Notifier, publicUrl: 'https://x', rooms: { pushChange } as never });
    await desk.ready();
    const res = await desk.inject({
      method: 'POST', url: `/api/admin/events/${f.eventId}/entries/${f.entryA}/captain`, cookies: authedCookie(desk, f.db, ADMIN), payload: { steamid: A[1] },
    });
    expect(res.statusCode).toBe(200);
    expect(pushChange.mock.calls).toEqual([[f.matchId]]);
    await desk.close();
  });
});

describe('the captain_replace sentence', () => {
  it('points staff at Make captain', () => {
    expect(EVENT_ERRORS.captain_replace.text).toBe('That player is the team\'s captain. Make another player captain first (Make captain), then replace this player.');
  });
});
