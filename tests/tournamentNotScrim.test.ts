import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { createTeam, invitePlayer, respondInvite } from '../src/teams/teams.js';
import {
  cancelBooking, confirmBooking, createBooking, getBooking, sideRow,
} from '../src/bookings/bookings.js';
import { recentNoShows, upcomingCount } from '../src/bookings/rules.js';
import { hasPickupBookings, reliability, scrimRecordOf } from '../src/scrims/reliability.js';
import { completedPug } from '../src/matchKinds.js';
import { applyMatchRatings } from '../src/rating.js';
import { seriesFixture, type SeriesFixture } from './seriesFixture.js';

const P = Array.from({ length: 12 }, (_, i) => `765611990000017${String(i).padStart(2, '0')}`);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Long after every booking below has started. */
const LATER = Date.parse('2026-10-20T12:00:00.000Z');
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')");
  P.forEach((id, i) => ins.run(id, `p${i}`));
  setSetting(db, 'competitive_enabled', 'everyone');
  setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'death_toll']));
  for (const n of ['a', 'bb', 'ccc', 'dddd']) {
    const id = addServer(db, { name: n, host: 'h', port: 27000 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
  }
});

const team = (captain: string, name: string, tag: string, members: string[] = []) => {
  const t = createTeam(db, { creator: captain, name, tag, now: new Date('2026-09-01T00:00:00.000Z') });
  if (!t.ok) throw new Error(t.error);
  for (const m of members) {
    const inv = invitePlayer(db, { teamId: t.value.id, by: captain, target: m, now: new Date('2026-09-01T00:00:00.000Z') });
    if (!inv.ok) throw new Error(inv.error);
    respondInvite(db, { inviteId: inv.value.inviteId, steamid: m, accept: true, now: new Date('2026-09-01T00:00:00.000Z') });
  }
  return t.value.id;
};

/** A confirmed booking starting on day `d` of October at 20:00 UTC, made a day ahead. */
const booked = (d: number, o: { by?: string; opponent?: object; teamId?: number } = {}) => {
  const start = Date.parse(`2026-10-${String(d).padStart(2, '0')}T20:00:00.000Z`);
  const r = createBooking(db, {
    by: o.by ?? P[0], teamId: o.teamId, opponent: o.opponent ?? { steamid: P[1] }, startsAt: new Date(start).toISOString(),
    minutes: 60, playlist: ['no_mercy'], now: new Date(start - DAY),
  });
  if (!r.ok) throw new Error(r.error);
  const id = r.value.id;
  const s = sideRow(db, id, 'b')!;
  const confirmer = s.team_id !== null
    ? (db.prepare('SELECT captain_steamid AS c FROM teams WHERE id = ?').get(s.team_id) as { c: string }).c
    : s.captain_steamid;
  const c = confirmBooking(db, { bookingId: id, by: confirmer, now: new Date(start - DAY) });
  if (!c.ok) throw new Error(c.error);
  return { id, start };
};
/** Played out: each side's peak, and the no-show side if any. */
const played = (id: number, peak: { a: number; b: number }, absent?: 'a' | 'b') => {
  const b = getBooking(db, id)!;
  const end = new Date(Date.parse(b.starts_at) + 30 * 60_000).toISOString();
  db.prepare('UPDATE booking_sides SET peak_present = ? WHERE booking_id = ? AND side = ?').run(peak.a, id, 'a');
  db.prepare('UPDATE booking_sides SET peak_present = ? WHERE booking_id = ? AND side = ?').run(peak.b, id, 'b');
  if (absent) db.prepare('UPDATE booking_sides SET no_show_at = ? WHERE booking_id = ? AND side = ?').run(end, id, absent);
  db.prepare("UPDATE bookings SET state = ?, end_reason = ?, ending_at = ?, ended_at = ? WHERE id = ?")
    .run(absent ? 'no_show' : 'ended', absent ? 'no_show' : 'time', end, end, id);
};


/** The same booking, as the series engine makes it: purpose tournament. */
const asTournament = (id: number) => db.prepare("UPDATE bookings SET purpose = 'tournament' WHERE id = ?").run(id);

describe('tournament bookings stay out of scrim records', () => {
  it('a scrim no-show and a tournament no-show side by side: only the scrim one counts', () => {
    const scrim = booked(2); played(scrim.id, { a: 1, b: 4 }, 'a');
    const tour = booked(3); played(tour.id, { a: 0, b: 4 }, 'a'); asTournament(tour.id);
    const rec = reliability(db, { captain: P[0] }, LATER);
    expect(rec).toEqual({ shown: 0, booked: 1, noShows: 1, lateCancels: 0, excused: 0 });
    expect(recentNoShows(db, { captain: P[0] }, LATER)).toBe(1);
    // The opponent's side of the tournament booking is out too.
    expect(reliability(db, { captain: P[1] }, LATER)).toMatchObject({ booked: 1, shown: 1 });
  });

  it('a tournament late cancel is not a late cancel', () => {
    const tour = booked(4); asTournament(tour.id);
    const start = Date.parse(getBooking(db, tour.id)!.starts_at);
    expect(cancelBooking(db, { bookingId: tour.id, by: P[0], now: new Date(start - HOUR) }).ok).toBe(true);
    expect(reliability(db, { captain: P[0] }, LATER)).toEqual({ shown: 0, booked: 0, noShows: 0, lateCancels: 0, excused: 0 });
  });

  it('a pickup captain with only an open tournament booking has no upcoming scrims and no pickup bookings', () => {
    const tour = booked(25); asTournament(tour.id);
    expect(upcomingCount(db, { captain: P[0] })).toBe(0);
    expect(hasPickupBookings(db, P[0])).toBe(false);
    const scrim = booked(26);
    expect(scrim.id).not.toBe(tour.id);
    expect(upcomingCount(db, { captain: P[0] })).toBe(1);
    expect(hasPickupBookings(db, P[0])).toBe(true);
  });

  it('scrimRecordOf ignores the tournament side', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2], P[3]]);
    const scrim = booked(2, { by: P[0], teamId: rats }); played(scrim.id, { a: 1, b: 4 }, 'a');
    const tour = booked(3, { by: P[0], teamId: rats }); played(tour.id, { a: 0, b: 4 }, 'a'); asTournament(tour.id);
    const pickupTour = booked(5, { by: P[0] }); played(pickupTour.id, { a: 0, b: 4 }, 'a'); asTournament(pickupTour.id);
    const r = scrimRecordOf(db, P[0], LATER);
    expect(r.teams[0]!.record).toMatchObject({ booked: 1, noShows: 1 });
    expect(r.pickup).toEqual({ shown: 0, booked: 0, noShows: 0, lateCancels: 0, excused: 0 });
  });
});

describe('tournament games are not PUGs', () => {
  let f: SeriesFixture;
  afterEach(() => f?.close());

  it('a finished tournament game adds no rating_history row, moves no SR, and completedPug excludes it', async () => {
    f = await seriesFixture();
    await f.tick();
    const g1 = f.gameOf(1).match_id!;
    f.goLive(g1);
    f.endGame(g1, [{ map: 'm1', a: 300, b: 200 }, { map: 'm2', a: 100, b: 400 }]);
    const m = f.db.prepare('SELECT kind, state FROM matches WHERE id = ?').get(g1) as { kind: string; state: string };
    expect(m.kind).toBe('tournament');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM rating_history').get()).toEqual({ n: 0 });
    expect(applyMatchRatings(f.db, g1)).toMatchObject({ applied: false, reason: 'not_pug' });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM rating_history').get()).toEqual({ n: 0 });
    expect(f.db.prepare(`SELECT id FROM matches WHERE id = ? AND ${completedPug()}`).get(g1)).toBeUndefined();
    f.db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(g1);
    expect(f.db.prepare(`SELECT id FROM matches WHERE id = ? AND ${completedPug()}`).get(g1)).toBeUndefined();
  });
});
