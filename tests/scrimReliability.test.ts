import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { createTeam, invitePlayer, respondInvite } from '../src/teams/teams.js';
import {
  bookingView, cancelBooking, closeBooking, confirmBooking, createBooking, excuseMark, getBooking, sideRow,
} from '../src/bookings/bookings.js';
import { allowance, isLateCancel, recentNoShows } from '../src/bookings/rules.js';
import { bookingMessage } from '../src/bookings/messages.js';
import { canSeeReliability, reliability } from '../src/scrims/reliability.js';

const P = Array.from({ length: 12 }, (_, i) => `765611990000017${String(i).padStart(2, '0')}`);
const STAFF = P[11];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Long after every booking below has started. */
const LATER = Date.parse('2026-10-20T12:00:00.000Z');
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')");
  P.forEach((id, i) => ins.run(id, `p${i}`));
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(STAFF);
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
const cancelAt = (id: number, by: string, msBefore: number) => {
  const start = Date.parse(getBooking(db, id)!.starts_at);
  const r = cancelBooking(db, { bookingId: id, by, now: new Date(start - msBefore) });
  if (!r.ok) throw new Error(r.error);
};

describe('isLateCancel', () => {
  it('a side cancel just inside the hours is late; just outside is not', () => {
    const inside = booked(2);
    cancelAt(inside.id, P[0], 2 * HOUR - 1);
    expect(isLateCancel(db, getBooking(db, inside.id)!)).toBe(true);
    const outside = booked(3);
    cancelAt(outside.id, P[0], 2 * HOUR);
    expect(isLateCancel(db, getBooking(db, outside.id)!)).toBe(false);
  });

  it('follows the setting, and 0 means never', () => {
    const { id } = booked(2);
    cancelAt(id, P[1], 3 * HOUR);
    expect(isLateCancel(db, getBooking(db, id)!)).toBe(false);
    setSetting(db, 'scrim_late_cancel_hours', '4');
    expect(isLateCancel(db, getBooking(db, id)!)).toBe(true);
    setSetting(db, 'scrim_late_cancel_hours', '0');
    expect(isLateCancel(db, getBooking(db, id)!)).toBe(false);
  });

  it('a staff cancel and a no_server cancel are never late', () => {
    const staff = booked(2);
    cancelBooking(db, { bookingId: staff.id, by: STAFF, staff: true, now: new Date(staff.start - 10 * 60_000) });
    expect(isLateCancel(db, getBooking(db, staff.id)!)).toBe(false);
    const system = booked(3);
    closeBooking(db, system.id, 'cancelled', 'no_server', new Date(system.start - 10 * 60_000));
    expect(isLateCancel(db, getBooking(db, system.id)!)).toBe(false);
  });

  it('cancelling an invite the other side never confirmed is not a late cancel', () => {
    const start = Date.parse('2026-10-02T20:00:00.000Z');
    const r = createBooking(db, { by: P[0], opponent: { steamid: P[1] }, startsAt: new Date(start).toISOString(), minutes: 60, playlist: ['no_mercy'], now: new Date(start - DAY) });
    if (!r.ok) throw new Error(r.error);
    cancelBooking(db, { bookingId: r.value.id, by: P[0], now: new Date(start - HOUR) });
    expect(isLateCancel(db, getBooking(db, r.value.id)!)).toBe(false);
  });
});

describe('reliability', () => {
  it('a mixed history: shown, no-show, early cancel, late cancel, excused late cancel, excused no-show', () => {
    const shown = booked(2); played(shown.id, { a: 4, b: 4 });
    const noShow = booked(3); played(noShow.id, { a: 1, b: 4 }, 'a');
    const early = booked(4); cancelAt(early.id, P[0], 5 * HOUR);
    const late = booked(5); cancelAt(late.id, P[0], HOUR);
    const lateExcused = booked(6); cancelAt(lateExcused.id, P[0], HOUR);
    expect(excuseMark(db, { bookingId: lateExcused.id, by: P[1], now: new Date(lateExcused.start) }).ok).toBe(true);
    const noShowExcused = booked(7); played(noShowExcused.id, { a: 0, b: 4 }, 'a');
    expect(excuseMark(db, { bookingId: noShowExcused.id, by: STAFF, staff: true, side: 'a', note: 'server crash' }).ok).toBe(true);
    // The other side's cancel is not P[0]'s.
    const theirs = booked(8); cancelAt(theirs.id, P[1], HOUR);
    const showedShort = booked(9); played(showedShort.id, { a: 3, b: 4 });

    expect(reliability(db, { captain: P[0] }, LATER)).toEqual({ shown: 1, booked: 4, noShows: 1, lateCancels: 1, excused: 2 });
    expect(reliability(db, { captain: P[1] }, LATER)).toEqual({ shown: 4, booked: 5, noShows: 0, lateCancels: 1, excused: 0 });
  });

  it('a booking whose start has not passed is not counted yet', () => {
    const late = booked(5); cancelAt(late.id, P[0], HOUR);
    expect(reliability(db, { captain: P[0] }, late.start - 1)).toEqual({ shown: 0, booked: 0, noShows: 0, lateCancels: 0, excused: 0 });
    expect(reliability(db, { captain: P[0] }, late.start).lateCancels).toBe(1);
  });

  it('a pickup captain carries the record across two different pickup groups', () => {
    const one = booked(2, { by: P[0], opponent: { steamid: P[1] } }); played(one.id, { a: 1, b: 4 }, 'a');
    const two = booked(3, { by: P[0], opponent: { steamid: P[2] } }); played(two.id, { a: 4, b: 4 });
    expect(reliability(db, { captain: P[0] }, LATER)).toMatchObject({ shown: 1, booked: 2, noShows: 1 });
  });

  it("team bookings never mix into the captain's pickup record, nor the other way", () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2], P[3]]);
    const t = booked(2, { by: P[0], teamId: rats, opponent: { steamid: P[1] } }); played(t.id, { a: 1, b: 4 }, 'a');
    const p = booked(3, { by: P[0], opponent: { steamid: P[1] } }); played(p.id, { a: 4, b: 4 });
    expect(reliability(db, { captain: P[0] }, LATER)).toEqual({ shown: 1, booked: 1, noShows: 0, lateCancels: 0, excused: 0 });
    expect(reliability(db, { teamId: rats }, LATER)).toEqual({ shown: 0, booked: 1, noShows: 1, lateCancels: 0, excused: 0 });
  });
});

describe('excuseMark', () => {
  it("the other side excuses a late cancel once, with a trimmed note, and it is logged", () => {
    const { id, start } = booked(2);
    cancelAt(id, P[0], HOUR);
    const r = excuseMark(db, { bookingId: id, by: P[1], note: `  ${'x'.repeat(250)}  `, now: new Date(start) });
    expect(r).toEqual({ ok: true, value: { side: 'a' } });
    const s = sideRow(db, id, 'a')!;
    expect(s).toMatchObject({ excused_by: P[1], excused_at: new Date(start).toISOString() });
    expect(s.excuse_note).toBe('x'.repeat(200));
    const ev = db.prepare("SELECT actor, detail FROM booking_events WHERE booking_id = ? AND event = 'excused'").get(id) as { actor: string; detail: string };
    expect(ev.actor).toBe(P[1]);
    expect(JSON.parse(ev.detail)).toEqual({ side: 'a', staff: false });
    expect(excuseMark(db, { bookingId: id, by: P[1] })).toEqual({ ok: false, error: 'already_excused' });
  });

  it("refuses excusing your own side's cancel, an early cancel, and a non-manager", () => {
    const own = booked(2);
    cancelAt(own.id, P[0], HOUR);
    expect(excuseMark(db, { bookingId: own.id, by: P[0] })).toEqual({ ok: false, error: 'not_manager' });
    expect(excuseMark(db, { bookingId: own.id, by: P[5] })).toEqual({ ok: false, error: 'not_manager' });
    const early = booked(3);
    cancelAt(early.id, P[0], 3 * HOUR);
    expect(excuseMark(db, { bookingId: early.id, by: P[1] })).toEqual({ ok: false, error: 'wrong_state' });
    expect(excuseMark(db, { bookingId: 999, by: P[1] })).toEqual({ ok: false, error: 'not_found' });
  });

  it('a side cannot excuse a no-show; staff can, and a side with no mark is wrong_state', () => {
    const { id } = booked(2);
    played(id, { a: 4, b: 0 }, 'b');
    expect(excuseMark(db, { bookingId: id, by: P[0] })).toEqual({ ok: false, error: 'wrong_state' });
    expect(excuseMark(db, { bookingId: id, by: STAFF, staff: true, side: 'a' })).toEqual({ ok: false, error: 'wrong_state' });
    expect(excuseMark(db, { bookingId: id, by: STAFF, staff: true, side: 'x' })).toEqual({ ok: false, error: 'bad_side' });
    expect(excuseMark(db, { bookingId: id, by: STAFF, staff: true, side: 'b', note: 'crash' })).toEqual({ ok: true, value: { side: 'b' } });
    expect(excuseMark(db, { bookingId: id, by: STAFF, staff: true, side: 'b' })).toEqual({ ok: false, error: 'already_excused' });
    const ev = db.prepare("SELECT detail FROM booking_events WHERE booking_id = ? AND event = 'excused'").get(id) as { detail: string };
    expect(JSON.parse(ev.detail)).toEqual({ side: 'b', staff: true });
  });

  it('staff can excuse a late cancel too', () => {
    const { id } = booked(2);
    cancelAt(id, P[1], HOUR);
    expect(excuseMark(db, { bookingId: id, by: STAFF, staff: true, side: 'b' })).toEqual({ ok: true, value: { side: 'b' } });
  });
});

describe('allowance', () => {
  it('rises again after staff excuse a recent no-show', () => {
    const { id, start } = booked(2);
    played(id, { a: 0, b: 4 }, 'a');
    const now = start + DAY;
    expect(recentNoShows(db, { captain: P[0] }, now)).toBe(1);
    expect(allowance(db, { captain: P[0] }, now)).toBe(3);
    excuseMark(db, { bookingId: id, by: STAFF, staff: true, side: 'a' });
    expect(recentNoShows(db, { captain: P[0] }, now)).toBe(0);
    expect(allowance(db, { captain: P[0] }, now)).toBe(4);
  });
});

describe('who sees a record', () => {
  it('staff, a current team member, the pickup captain, or anyone once the setting is on', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2]]);
    expect(canSeeReliability(db, { teamId: rats }, P[2])).toBe(true);
    expect(canSeeReliability(db, { teamId: rats }, STAFF)).toBe(true);
    expect(canSeeReliability(db, { teamId: rats }, P[5])).toBe(false);
    expect(canSeeReliability(db, { teamId: rats }, null)).toBe(false);
    expect(canSeeReliability(db, { captain: P[0] }, P[0])).toBe(true);
    expect(canSeeReliability(db, { captain: P[0] }, P[1])).toBe(false);
    setSetting(db, 'scrim_reliability_public', 'on');
    expect(canSeeReliability(db, { teamId: rats }, P[5])).toBe(true);
    expect(canSeeReliability(db, { captain: P[0] }, null)).toBe(true);
  });
});

describe('bookingView', () => {
  it('the record shows to the side itself and staff, not to the other side or strangers, unless public', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2]]);
    const owls = team(P[1], 'Owls', 'OW', [P[3]]);
    const { id } = booked(2, { by: P[0], teamId: rats, opponent: { teamId: owls } });
    const rec = (as: string, staff = false) => bookingView(db, id, { steamid: as, staff })!.sides.map((s) => 'record' in s);
    expect(rec(P[2])).toEqual([true, false]); // a member of side a
    expect(rec(P[3])).toEqual([false, true]); // a member of side b
    expect(rec(STAFF, true)).toEqual([true, true]);
    expect(bookingView(db, id, { steamid: P[5], staff: false })).toBeNull(); // a stranger sees no page at all
    expect(canSeeReliability(db, { teamId: rats }, P[5])).toBe(false);
    expect(bookingView(db, id, { steamid: P[2], staff: false })!.sides[0].record).toEqual({ shown: 0, booked: 0, noShows: 0, lateCancels: 0, excused: 0 });
    setSetting(db, 'scrim_reliability_public', 'on');
    expect(rec(P[3])).toEqual([true, true]);
  });

  it('marks a late cancel, offers the excuse only to the other side, and shows it excused', () => {
    const { id, start } = booked(2);
    cancelAt(id, P[0], HOUR);
    const side = (as: string, s: 0 | 1) => bookingView(db, id, { steamid: as, staff: false })!.sides[s];
    expect(side(P[1], 0)).toMatchObject({ lateCancel: true, excused: false, canExcuse: true });
    expect(side(P[0], 0)).toMatchObject({ lateCancel: true, excused: false, canExcuse: false });
    expect(side(P[1], 1)).toMatchObject({ lateCancel: false, excused: false, canExcuse: false });
    excuseMark(db, { bookingId: id, by: P[1], now: new Date(start) });
    expect(side(P[1], 0)).toMatchObject({ lateCancel: true, excused: true, canExcuse: false });
  });
});

describe('messages', () => {
  it("the reminder carries a Cancel link that opens the cancel confirm", () => {
    const { id } = booked(2);
    const m = bookingMessage(db, 'https://riversidepug.com', id, 'booking_starting', { minutes: 15 })!;
    expect(m.components).toEqual([[
      { kind: 'link', url: `https://riversidepug.com/booking/${id}`, label: 'Open the booking' },
      { kind: 'link', url: `https://riversidepug.com/booking/${id}?cancel=1`, label: 'Cancel' },
    ]]);
  });

  it('a late cancel notice asks the other side to excuse it, keeping the link', () => {
    const { id } = booked(2);
    cancelAt(id, P[0], HOUR);
    const late = bookingMessage(db, 'https://x', id, 'booking_cancelled', { reason: 'sick', lateCancel: true })!;
    expect(late.content).toContain('This is a late cancel. If it is fine with you, excuse it on the booking page so it does not count against them.');
    expect(late.components).toEqual([[{ kind: 'link', url: `https://x/booking/${id}`, label: 'Open the booking' }]]);
    expect(bookingMessage(db, 'https://x', id, 'booking_cancelled', { reason: 'sick' })!.content).not.toContain('late cancel');
  });
});
