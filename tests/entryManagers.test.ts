import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { DB } from '../src/db.js';
import * as N from '../src/events/entries.js';
import * as R from '../src/events/room.js';
import * as PL from '../src/events/play.js';
import * as B from '../src/bookings/bookings.js';
import * as E from '../src/events/events.js';
import { tellCheckinOpen } from '../src/events/notices.js';
import { myEventView } from '../src/events/views.js';
import { eventRoutes } from '../src/routes/events.js';
import type { Notifier } from '../src/notify/notify.js';
import { authedCookie } from './helpers.js';
import { ADMIN, NOW } from './eventFixture.js';
import { A, B as BATS, entryFixture, rosterA, rosterB } from './entryFixture.js';
import { draftFixture, P } from './draftFixture.js';
import { TIMERS, driveToBooking, roomFixture } from './roomFixture.js';
import { seriesFixture, type SeriesFixture } from './seriesFixture.js';

const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };

/** A draft entry inserted by hand (test setup only; plan D2a Task 4 writes
 *  them for real): team_id NULL, the captain set, four starters. */
function draftEntry(db: DB, eventId: number, name: string, captain: string, starters: string[], seed: number): number {
  const t = NOW.toISOString();
  const id = Number(db.prepare(
    `INSERT INTO event_entries (event_id, team_id, name, tag, logo_key, seed, registered_by, created_at, captain_steamid)
     VALUES (?, NULL, ?, '', NULL, ?, ?, ?, ?)`,
  ).run(eventId, name, seed, ADMIN, t, captain).lastInsertRowid);
  for (const s of starters) db.prepare("INSERT INTO event_entry_players (entry_id, steamid, role, added_at) VALUES (?, ?, 'starter', ?)").run(id, s, t);
  return id;
}

/** A live draft event with two draft entries (captains P[0] and P[4]) and
 *  their round 1 match waiting, set up by SQL the way the room needs it. */
function draftRoom(o: { startsAt?: string } = {}): { db: DB; eventId: number; slug: string; matchId: number; entryA: number; entryB: number; stageId: number } {
  const f = draftFixture({ startsAt: o.startsAt });
  const entryA = draftEntry(f.db, f.eventId, 'Team d0', P[0]!, P.slice(0, 4), 1);
  const entryB = draftEntry(f.db, f.eventId, 'Team d4', P[4]!, P.slice(4, 8), 2);
  const stageId = E.stagesOf(f.db, f.eventId)[0]!.id;
  f.db.prepare("UPDATE events SET status = 'live', locked_at = ? WHERE id = ?").run(NOW.toISOString(), f.eventId);
  f.db.prepare("UPDATE event_stages SET status = 'live' WHERE id = ?").run(stageId);
  const matchId = Number(f.db.prepare(
    `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, entry_a, entry_b, status, created_at)
     VALUES (?, ?, 1, 1, 1, ?, ?, 'waiting', ?)`,
  ).run(f.eventId, stageId, entryA, entryB, NOW.toISOString()).lastInsertRowid);
  return { db: f.db, eventId: f.eventId, slug: f.slug, matchId, entryA, entryB, stageId };
}

describe('entryManagers', () => {
  it('gives a team entry exactly its team\'s managers (captain and co-captain)', () => {
    const f = entryFixture();
    const id = ok(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamA, by: A[0]!, roster: rosterA(), now: NOW })).entry.id;
    const idB = ok(N.registerEntry(f.db, { eventId: f.eventId, teamId: f.teamB, by: BATS[0]!, roster: rosterB(), now: NOW })).entry.id;
    const e = N.getEntry(f.db, id)!;
    expect(N.entryManagers(f.db, e)).toEqual(N.managersOf(f.db, f.teamA));
    expect(N.entryManagers(f.db, e).sort()).toEqual([A[0], A[1]].sort());
    expect(N.entryManagers(f.db, N.getEntry(f.db, idB)!)).toEqual([BATS[0]]);
    expect(e.captain_steamid).toBeNull();
  });

  it('gives a draft entry its captain, and nobody when it has none', () => {
    const f = draftFixture();
    const id = draftEntry(f.db, f.eventId, 'Team d0', P[0]!, P.slice(0, 4), 1);
    expect(N.entryManagers(f.db, N.getEntry(f.db, id)!)).toEqual([P[0]]);
    expect(N.entryManagers(f.db, { team_id: null, captain_steamid: null })).toEqual([]);
  });

  it('matches managersOf at every entry of a room fixture (team path unchanged)', async () => {
    const f = await roomFixture();
    for (const id of [f.entryA, f.entryB]) {
      const e = N.getEntry(f.db, id)!;
      expect(N.entryManagers(f.db, e)).toEqual(N.managersOf(f.db, e.team_id));
    }
  });
});

describe('a draft captain runs the match room', () => {
  it('takes the captain\'s Ready, veto steps and lineup lock, and refuses another starter as a non-manager', () => {
    const f = draftRoom();
    ok(R.openRoom(f.db, { matchId: f.matchId, by: null, higher: 'a', seed: 0, timers: TIMERS, now: NOW }));
    expect(R.sideOf(f.db, PL.getMatch(f.db, f.matchId)!, P[0]!)).toBe('a');
    expect(R.sideOf(f.db, PL.getMatch(f.db, f.matchId)!, P[1]!)).toBeNull();
    expect(R.readyUp(f.db, { matchId: f.matchId, steamid: P[1]!, timers: TIMERS, now: at(1) })).toEqual({ ok: false, error: 'not_manager' });
    ok(R.readyUp(f.db, { matchId: f.matchId, steamid: P[0]!, timers: TIMERS, now: at(1) }));
    ok(R.readyUp(f.db, { matchId: f.matchId, steamid: P[4]!, timers: TIMERS, now: at(1) }));
    expect(R.actVeto(f.db, { matchId: f.matchId, steamid: P[1]!, step: 0, action: 'first', campaign: null, timers: TIMERS, now: at(2) }))
      .toEqual({ ok: false, error: 'not_manager' });
    ok(R.actVeto(f.db, { matchId: f.matchId, steamid: P[0]!, step: 0, action: 'first', campaign: null, timers: TIMERS, now: at(2) }));
    ok(R.actVeto(f.db, { matchId: f.matchId, steamid: P[0]!, step: 1, action: 'ban', campaign: 'dead_air', timers: TIMERS, now: at(2) }));
    ok(R.actVeto(f.db, { matchId: f.matchId, steamid: P[4]!, step: 2, action: 'survivors', campaign: null, timers: TIMERS, now: at(2) }));
    expect(R.lockLineup(f.db, { matchId: f.matchId, steamid: P[1]!, steamids: P.slice(0, 4), timers: TIMERS, now: at(4) }))
      .toEqual({ ok: false, error: 'not_manager' });
    ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: P[0]!, steamids: P.slice(0, 4), timers: TIMERS, now: at(4) }));
    ok(R.lockLineup(f.db, { matchId: f.matchId, steamid: P[4]!, steamids: P.slice(4, 8), timers: TIMERS, now: at(4) }));
    expect(PL.getMatch(f.db, f.matchId)!.status).toBe('booking');
  });

  it('lets the draft captain save preferences, and refuses another starter', () => {
    const f = draftRoom();
    expect(R.savePrefs(f.db, { entryId: f.entryA, by: P[1]!, staff: false, prefs: { side: 'infected' }, now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    ok(R.savePrefs(f.db, { entryId: f.entryA, by: P[0]!, staff: false, prefs: { side: 'infected' }, now: NOW }));
  });

  it('serves the prefs route to the draft captain only', async () => {
    const f = draftRoom({ startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString() });
    const app = Fastify();
    await app.register(cookie, { secret: 'x'.repeat(32) });
    await app.register(eventRoutes, { db: f.db, store: () => { throw new Error('no store'); }, publicUrl: 'https://x' });
    await app.ready();
    try {
      const url = `/api/events/${f.slug}/entries/${f.entryA}/prefs`;
      expect((await app.inject({ method: 'GET', url, cookies: authedCookie(app, f.db, P[1]!) })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url, cookies: authedCookie(app, f.db, P[0]!) })).json()).toMatchObject({ entryId: f.entryA });
    } finally {
      await app.close();
    }
  });

  it('tells the draft captain when check-in opens, and shows the captain as managing the entry', () => {
    const f = draftRoom();
    const send = vi.fn();
    tellCheckinOpen({ db: f.db, notifier: { send } as unknown as Notifier, publicUrl: 'https://x' }, f.eventId);
    expect(send.mock.calls.map((c) => c[0])).toEqual([[P[0]], [P[4]]]);
    const ev = E.getEvent(f.db, f.eventId)!;
    const mine = (s: string) => myEventView(f.db, ev, s, NOW).entries.find((e) => e.id === f.entryA)!;
    expect(mine(P[0]!)).toMatchObject({ manage: true, canEditRoster: false, members: [] });
    expect(mine(P[1]!)).toMatchObject({ manage: false });
  });
});

describe('booking a series between two draft entries', () => {
  let s: SeriesFixture;
  afterEach(() => { vi.restoreAllMocks(); s?.close(); });

  it('books sides with team_id NULL, the captain and the four starters', async () => {
    // The room fixture's two entries turned into draft entries before the
    // room runs (test setup only): no site team, a captain each.
    s = await seriesFixture({
      drive: (f) => {
        f.db.prepare('UPDATE event_entries SET team_id = NULL, captain_steamid = CASE id WHEN ? THEN ? ELSE ? END WHERE id IN (?, ?)')
          .run(f.entryA, A[0], BATS[0], f.entryA, f.entryB);
        driveToBooking(f);
      },
    });
    await s.tick();
    const b = s.booking();
    expect(b.purpose).toBe('tournament');
    expect(s.db.prepare('SELECT side, team_id, captain_steamid FROM booking_sides WHERE booking_id = ? ORDER BY side').all(b.id)).toEqual([
      { side: 'a', team_id: null, captain_steamid: A[0] }, { side: 'b', team_id: null, captain_steamid: BATS[0] },
    ]);
    expect(B.peopleOf(s.db, b.id).map((p) => [p.side, p.steamid, p.role])).toEqual([
      ...A.slice(0, 4).map((x) => ['a', x, 'player']), ['a', A[4], 'spectator'], ...BATS.slice(0, 4).map((x) => ['b', x, 'player']),
    ]);
  });
});
