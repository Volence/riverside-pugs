import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { createTeam, invitePlayer, respondInvite, setRole, transferCaptain } from '../src/teams/teams.js';
import {
  addPerson, bookingView, cancelBooking, claimNoShow, closeBooking, confirmBooking, createBooking, declineBooking,
  endBooking, expireUnconfirmed, extendBooking, getBooking, holdBox, markActive, markReady, markReleased, markSetup,
  myBookings, peopleOf, recordPresence, removePerson, respondPerson, sideRow,
} from '../src/bookings/bookings.js';

const P = Array.from({ length: 14 }, (_, i) => `765611990000007${String(i).padStart(2, '0')}`);
const NOW = new Date('2026-10-01T12:00:00.000Z');
const START = '2026-10-02T20:00:00.000Z';
const MIN = 60_000;
const at = (iso: string, plusMin = 0) => new Date(Date.parse(iso) + plusMin * MIN);
let db: DB;
let servers: number[];

beforeEach(() => {
  db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')");
  P.forEach((id, i) => ins.run(id, `p${i}`));
  setSetting(db, 'competitive_enabled', 'everyone');
  setSetting(db, 'map_pool', JSON.stringify(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest', 'crash_course']));
  servers = ['a', 'bb', 'ccc', 'dddd'].map((n) => {
    const id = addServer(db, { name: n, host: 'h', port: 27000 + n.length, rconPort: 1, rconPassword: 'x' });
    db.prepare("UPDATE servers SET status = 'idle' WHERE id = ?").run(id);
    return id;
  }); // 4 enabled, reserve 2: room for 2 bookings at once
});

const base = (over: Record<string, unknown> = {}) => ({
  by: P[0], opponent: { steamid: P[1] }, startsAt: START, minutes: 120, playlist: ['no_mercy', 'death_toll'], now: NOW, ...over,
});
const create = (over: Record<string, unknown> = {}) => {
  const r = createBooking(db, base(over) as Parameters<typeof createBooking>[1]);
  if (!r.ok) throw new Error(r.error);
  return r.value.id;
};
const team = (captain: string, name: string, tag: string, members: string[] = []) => {
  const t = createTeam(db, { creator: captain, name, tag, now: NOW });
  if (!t.ok) throw new Error(t.error);
  for (const m of members) {
    const inv = invitePlayer(db, { teamId: t.value.id, by: captain, target: m, now: NOW });
    if (!inv.ok) throw new Error(inv.error);
    respondInvite(db, { inviteId: inv.value.inviteId, steamid: m, accept: true, now: NOW });
  }
  return t.value.id;
};

describe('creating', () => {
  it('a pickup booking against a player: side a confirmed with its captain, side b invited', () => {
    const id = create();
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'scheduled', purpose: 'scrim', region: 'na', starts_at: START, ends_at: '2026-10-02T22:00:00.000Z', game_config: 'standard' });
    expect(JSON.parse(b.playlist_json)).toEqual(['no_mercy', 'death_toll']);
    expect(JSON.parse(b.rules_json).rated).toBe(false);
    expect(b.password).toMatch(/^[a-z0-9]{8}$/);
    expect(b.tv_password).not.toBe(b.password);
    expect(sideRow(db, id, 'a')).toMatchObject({ team_id: null, captain_steamid: P[0] });
    expect(sideRow(db, id, 'a')!.confirmed_at).not.toBeNull();
    expect(sideRow(db, id, 'b')).toMatchObject({ captain_steamid: P[1], confirmed_at: null });
    expect(peopleOf(db, id).map((p) => [p.side, p.steamid, p.status])).toEqual([['a', P[0], 'accepted'], ['b', P[1], 'invited']]);
  });

  it('refuses bad input with a reason', () => {
    const r = (over: Record<string, unknown>) => {
      const res = createBooking(db, base(over) as Parameters<typeof createBooking>[1]);
      return res.ok ? 'ok' : res.error;
    };
    expect(r({ startsAt: '2026-10-01T11:00:00.000Z' })).toBe('bad_time');
    expect(r({ startsAt: '2026-10-20T11:00:00.000Z' })).toBe('bad_time');
    expect(r({ startsAt: 'tomorrow' })).toBe('bad_time');
    expect(r({ minutes: 45 })).toBe('bad_length');
    expect(r({ minutes: 240 })).toBe('bad_length');
    expect(r({ playlist: [] })).toBe('bad_playlist');
    expect(r({ playlist: ['no_mercy', 'no_mercy'] })).toBe('bad_playlist');
    expect(r({ playlist: ['the_sacrifice'] })).toBe('bad_playlist'); // not in the pool
    expect(r({ playlist: ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest', 'crash_course'] })).toBe('bad_playlist');
    expect(r({ opponent: { steamid: P[0] } })).toBe('bad_opponent');
    expect(r({ opponent: { steamid: '76561199999999999' } })).toBe('not_player');
    expect(r({ gameConfig: 'nope' })).toBe('bad_config');
    expect(r({ rulesetId: 999 })).toBe('bad_ruleset');
    setSetting(db, 'competitive_enabled', 'admins');
    expect(r({})).toBe('not_open');
  });

  it('only a captain or co-captain books for a team', () => {
    const t = team(P[0], 'Rats', 'RR', [P[2]]);
    expect(createBooking(db, base({ by: P[2], teamId: t }) as Parameters<typeof createBooking>[1])).toEqual({ ok: false, error: 'not_manager' });
    const id = create({ teamId: t });
    expect(peopleOf(db, id).filter((p) => p.side === 'a').map((p) => p.steamid).sort()).toEqual([P[0], P[2]].sort());
  });

  it('refuses a slot without capacity, and the allowance', () => {
    create({ opponent: { steamid: P[1] } });
    create({ by: P[2], opponent: { steamid: P[3] } });
    expect(createBooking(db, base({ by: P[4], opponent: { steamid: P[5] } }) as Parameters<typeof createBooking>[1]))
      .toEqual({ ok: false, error: 'no_capacity' });
    setSetting(db, 'booking_max_upcoming', '1');
    expect(createBooking(db, base({ startsAt: '2026-10-03T20:00:00.000Z' }) as Parameters<typeof createBooking>[1]))
      .toEqual({ ok: false, error: 'allowance' });
  });
});

describe('confirming', () => {
  it('the invited player confirms and becomes the pickup captain', () => {
    const id = create();
    expect(confirmBooking(db, { bookingId: id, by: P[2], now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    expect(confirmBooking(db, { bookingId: id, by: P[1], now: NOW })).toEqual({ ok: true, value: null });
    expect(sideRow(db, id, 'b')!.confirmed_at).not.toBeNull();
    expect(peopleOf(db, id).find((p) => p.steamid === P[1])!.status).toBe('accepted');
    expect(confirmBooking(db, { bookingId: id, by: P[1], now: NOW })).toEqual({ ok: false, error: 'already_confirmed' });
  });

  it('a team side is confirmed by its captain or co-captain, and a player on both teams stays on side a', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2], P[4]]);
    const mice = team(P[1], 'Mice', 'MM', [P[3], P[4]]);
    setRole(db, { teamId: mice, by: P[1], target: P[3], role: 'cocaptain' });
    const id = create({ teamId: rats, opponent: { teamId: mice } });
    expect(confirmBooking(db, { bookingId: id, by: P[3], now: NOW }).ok).toBe(true);
    const b = peopleOf(db, id).filter((p) => p.side === 'b').map((p) => p.steamid).sort();
    expect(b).toEqual([P[1], P[3]].sort());
    expect(addPerson(db, { bookingId: id, by: P[1], side: 'b', steamid: P[4], role: 'player', now: NOW }))
      .toEqual({ ok: false, error: 'already_in' });
  });

  it('declining cancels the booking at once', () => {
    const id = create();
    expect(declineBooking(db, { bookingId: id, by: P[1], now: NOW }).ok).toBe(true);
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'declined', cancel_side: 'b' });
    expect(getBooking(db, id)!.ended_at).not.toBeNull();
  });

  it('an invite nobody confirms expires after 24 hours or 30 minutes before the start', () => {
    const late = create({ startsAt: '2026-10-01T13:00:00.000Z' });
    const early = create({ by: P[2], opponent: { steamid: P[3] }, startsAt: '2026-10-05T20:00:00.000Z' });
    expect(expireUnconfirmed(db, at('2026-10-01T12:20:00.000Z'))).toEqual([]);
    expect(expireUnconfirmed(db, at('2026-10-01T12:31:00.000Z'))).toEqual([late]);
    expect(expireUnconfirmed(db, at('2026-10-02T12:00:01.000Z'))).toEqual([early]);
    expect(getBooking(db, late)).toMatchObject({ state: 'cancelled', end_reason: 'unconfirmed' });
  });
});

describe('people', () => {
  it('a manager adds people; non-members are invited until they accept', () => {
    const id = create();
    expect(addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[5], role: 'ringer', now: NOW })).toEqual({ ok: true, value: { status: 'invited' } });
    expect(addPerson(db, { bookingId: id, by: P[5], side: 'a', steamid: P[6], role: 'player', now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    expect(respondPerson(db, { bookingId: id, steamid: P[5], accept: true, now: NOW }).ok).toBe(true);
    expect(peopleOf(db, id).find((p) => p.steamid === P[5])).toMatchObject({ role: 'ringer', status: 'accepted' });
    expect(removePerson(db, { bookingId: id, by: P[0], steamid: P[0], now: NOW })).toEqual({ ok: false, error: 'is_captain' });
    expect(removePerson(db, { bookingId: id, by: P[5], steamid: P[5], now: NOW }).ok).toBe(true); // leaving
  });

  it('side b cannot add people before it confirms', () => {
    const id = create();
    expect(addPerson(db, { bookingId: id, by: P[1], side: 'b', steamid: P[5], role: 'player', now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
  });

  it('a side holds at most 12 people', () => {
    const id = create();
    for (const sid of P.slice(2, 13)) addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: sid, role: 'player', now: NOW });
    expect(addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[13], role: 'player', now: NOW })).toEqual({ ok: false, error: 'side_full' });
  });
});

describe('cancel, extend, end, no-show', () => {
  it('rights follow the current team roles', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2]]);
    setRole(db, { teamId: rats, by: P[0], target: P[2], role: 'cocaptain' });
    const id = create({ teamId: rats });
    setRole(db, { teamId: rats, by: P[0], target: P[2], role: 'member' });
    expect(cancelBooking(db, { bookingId: id, by: P[2], now: NOW })).toEqual({ ok: false, error: 'not_manager' });
    transferCaptain(db, { teamId: rats, by: P[0], target: P[2] });
    expect(cancelBooking(db, { bookingId: id, by: P[2], reason: '  sorry  ', now: NOW }).ok).toBe(true);
    expect(getBooking(db, id)).toMatchObject({ state: 'cancelled', end_reason: 'cancelled', cancel_side: 'a', cancel_reason: 'sorry', cancelled_by: P[2] });
  });

  it('a cancel with a box leaves the release to the runner; staff cancels count against nobody', () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    expect(holdBox(db, id, servers[3], at(START, -15))).toBe(true);
    expect(cancelBooking(db, { bookingId: id, by: P[9], staff: true, now: at(START, -10) })).toEqual({ ok: true, value: { hadServer: true } });
    const b = getBooking(db, id)!;
    expect(b).toMatchObject({ state: 'cancelled', end_reason: 'staff', cancel_side: null, ended_at: null });
    expect(b.ending_at).not.toBeNull();
    markReleased(db, id, at(START, -9));
    expect(getBooking(db, id)!.ended_at).not.toBeNull();
  });

  it('extends only while the capacity rule holds for the extra time', () => {
    const id = create();
    create({ by: P[2], opponent: { steamid: P[3] }, startsAt: '2026-10-02T22:00:00.000Z' });
    create({ by: P[4], opponent: { steamid: P[5] }, startsAt: '2026-10-02T22:00:00.000Z' });
    expect(extendBooking(db, { bookingId: id, by: P[0], now: NOW })).toEqual({ ok: false, error: 'no_capacity' });
    setSetting(db, 'pug_reserve_servers', '1');
    expect(extendBooking(db, { bookingId: id, by: P[0], now: NOW })).toEqual({ ok: true, value: { endsAt: '2026-10-02T22:30:00.000Z' } });
    expect(getBooking(db, id)).toMatchObject({ extended_minutes: 30, warned_minutes: null });
  });

  it('a no-show is claimed only after the grace, by a side that showed, against one that did not', () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    holdBox(db, id, servers[3], at(START, -15));
    markSetup(db, id, at(START, -15));
    markReady(db, id, at(START, -12));
    markActive(db, id, at(START, -5));
    const claim = (min: number) => claimNoShow(db, { bookingId: id, by: P[0], now: at(START, min) });
    expect(claim(10)).toEqual({ ok: false, error: 'too_early' });
    expect(claim(16)).toEqual({ ok: false, error: 'not_shown' });
    recordPresence(db, id, { a: 4, b: 2 }, true, at(START, 1));
    recordPresence(db, id, { a: 3, b: 1 }, true, at(START, 2));
    expect(sideRow(db, id, 'a')!.peak_present).toBe(4);
    expect(claim(16)).toEqual({ ok: true, value: { absent: 'b' } });
    expect(getBooking(db, id)).toMatchObject({ state: 'no_show', end_reason: 'no_show' });
    expect(sideRow(db, id, 'b')!.no_show_at).not.toBeNull();
  });

  it('a captain ends a running booking; the runner closes and releases', () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    expect(endBooking(db, { bookingId: id, by: P[0], now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
    holdBox(db, id, servers[3], at(START, -15));
    markSetup(db, id, at(START, -15));
    markReady(db, id, at(START, -12));
    expect(endBooking(db, { bookingId: id, by: P[1], now: at(START, 30) }).ok).toBe(true);
    expect(getBooking(db, id)).toMatchObject({ state: 'ended', end_reason: 'captain' });
    expect(closeBooking(db, id, 'ended', 'time', at(START, 31))).toBe(false); // already ending
  });
});

describe('runner writes', () => {
  it('holdBox takes only an idle, enabled box nobody holds', () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    db.prepare("UPDATE servers SET status = 'live' WHERE id = ?").run(servers[0]);
    expect(holdBox(db, id, servers[0], NOW)).toBe(false);
    expect(holdBox(db, id, servers[1], NOW)).toBe(true);
    expect(getBooking(db, id)).toMatchObject({ state: 'held', server_id: servers[1] });
    const other = create({ by: P[2], opponent: { steamid: P[3] } });
    confirmBooking(db, { bookingId: other, by: P[3], now: NOW });
    expect(holdBox(db, other, servers[1], NOW)).toBe(false);
  });

  it('markSetup counts attempts', () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    holdBox(db, id, servers[1], NOW);
    expect(markSetup(db, id, NOW)).toBe(1);
    expect(markSetup(db, id, NOW)).toBe(2);
  });
});

describe('views', () => {
  it('only the people in it, the side managers and staff can see a booking; connect only when ready', () => {
    const id = create();
    expect(bookingView(db, id, { steamid: P[9], staff: false })).toBeNull();
    const invited = bookingView(db, id, { steamid: P[1], staff: false })!;
    expect(invited.viewer).toEqual({ side: 'b', manages: ['b'], staff: false, invited: true });
    expect(invited.connect).toBeNull();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    holdBox(db, id, servers[1], NOW);
    markSetup(db, id, NOW);
    markReady(db, id, NOW);
    const v = bookingView(db, id, { steamid: P[0], staff: false })!;
    expect(v.connect).toEqual({ host: 'h', port: 27002, password: getBooking(db, id)!.password });
    expect(JSON.stringify(v)).not.toContain(getBooking(db, id)!.tv_password);
    expect(bookingView(db, id, { steamid: P[9], staff: true })!.connect).not.toBeNull();
  });

  it('myBookings lists what needs the viewer', () => {
    const id = create();
    expect(myBookings(db, P[1]).open.map((b) => [b.id, b.needs])).toEqual([[id, 'confirm']]);
    expect(myBookings(db, P[0]).open.map((b) => b.needs)).toEqual([null]);
  });
});
