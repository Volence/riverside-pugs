import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { addServer } from '../src/serverPool.js';
import { setSetting } from '../src/settings.js';
import { createTeam, invitePlayer, respondInvite, setRole, transferCaptain } from '../src/teams/teams.js';
import { currentSeasonId } from '../src/players.js';
import {
  BOOKING_ERRORS, addPerson, allowInGame, allowList, bookingView, cancelBooking, claimNoShow, closeBooking, confirmBooking, createBooking, declineBooking,
  addCampaign, endBooking, expireUnconfirmed, getBooking, holdBox, markActive, markReady, markReleased, markSetup,
  myBookings, peopleOf, recordPresence, removePerson, respondPerson, sideRow,
} from '../src/bookings/bookings.js';
import { acceptPost, confirmAccept, createPost } from '../src/scrims/scrims.js';
import { blockTarget } from '../src/scrims/blocks.js';

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
    expect(b).toMatchObject({ state: 'scheduled', purpose: 'scrim', region: 'na', starts_at: START, ends_at: '2026-10-02T23:00:00.000Z', game_config: 'standard' });
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

  it('the length is estimated from the campaigns, whatever minutes are sent', () => {
    const id = create({ minutes: 45 });
    // 15 + (60 + 10) * 2 = 155, up to 180.
    expect(getBooking(db, id)).toMatchObject({ starts_at: START, ends_at: '2026-10-02T23:00:00.000Z', games_allowed: 2, close_at: null });
    const one = create({ by: P[2], opponent: { steamid: P[3] }, minutes: 'nope', playlist: ['dead_air'] });
    expect(getBooking(db, one)).toMatchObject({ ends_at: '2026-10-02T21:30:00.000Z', games_allowed: 1 });
  });

  it('a 4-campaign booking with no history is created fine with the default settings', () => {
    const four = { playlist: ['no_mercy', 'death_toll', 'dead_air', 'blood_harvest'] };
    // No history anywhere, so every campaign falls back to 60: 15 + (60 + 10) * 4 = 295, up to 300 (about 5 h).
    const id = create(four);
    expect(getBooking(db, id)).toMatchObject({ ends_at: '2026-10-03T01:00:00.000Z', games_allowed: 4 });
  });

  it('only a captain or co-captain books for a team', () => {
    const t = team(P[0], 'Rats', 'RR', [P[2]]);
    expect(createBooking(db, base({ by: P[2], teamId: t }) as Parameters<typeof createBooking>[1])).toEqual({ ok: false, error: 'not_manager' });
    const id = create({ teamId: t });
    expect(peopleOf(db, id).filter((p) => p.side === 'a').map((p) => p.steamid).sort()).toEqual([P[0], P[2]].sort());
  });

  it('refuses a team opponent the booker captains or co-captains', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2]]);
    expect(createBooking(db, base({ opponent: { teamId: rats } }) as Parameters<typeof createBooking>[1]))
      .toEqual({ ok: false, error: 'bad_opponent' });
    setRole(db, { teamId: rats, by: P[0], target: P[2], role: 'cocaptain' });
    expect(createBooking(db, base({ by: P[2], opponent: { teamId: rats } }) as Parameters<typeof createBooking>[1]))
      .toEqual({ ok: false, error: 'bad_opponent' });
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

  it('a booking made 30 minutes or less ahead is not expired by the cutoff; it has until its start', () => {
    const made = at('2026-10-01T12:00:00.000Z');
    const id = create({ startsAt: '2026-10-01T12:30:00.000Z', minutes: 60, now: made });
    expect(expireUnconfirmed(db, at('2026-10-01T12:01:00.000Z'))).toEqual([]);
    expect(expireUnconfirmed(db, at('2026-10-01T12:29:00.000Z'))).toEqual([]);
    expect(confirmBooking(db, { bookingId: id, by: P[1], now: at('2026-10-01T12:29:00.000Z') }).ok).toBe(true);
    const unconfirmed = create({ by: P[2], opponent: { steamid: P[3] }, startsAt: '2026-10-01T12:30:00.000Z', minutes: 60, now: made });
    expect(expireUnconfirmed(db, at('2026-10-01T12:30:00.000Z'))).toEqual([unconfirmed]);
  });

  it('team members out of good standing are not snapshotted onto either side', () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2], P[4]]);
    const mice = team(P[1], 'Mice', 'MM', [P[3], P[5]]);
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid IN (?, ?)").run(P[4], P[5]);
    const id = create({ teamId: rats, opponent: { teamId: mice } });
    expect(confirmBooking(db, { bookingId: id, by: P[1], now: NOW }).ok).toBe(true);
    const on = peopleOf(db, id).map((p) => p.steamid);
    expect(on.sort()).toEqual([P[0], P[1], P[2], P[3]].sort());
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

  it('accepting re-checks standing; a player who fell out of it cannot accept', () => {
    const id = create();
    addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[5], role: 'player', now: NOW });
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(P[5]);
    expect(respondPerson(db, { bookingId: id, steamid: P[5], accept: true, now: NOW })).toEqual({ ok: false, error: 'not_open' });
  });

  it("a team side's captain follows a transfer: the new captain cannot be removed, the old one can", () => {
    const rats = team(P[0], 'Rats', 'RR', [P[2]]);
    const id = create({ teamId: rats });
    transferCaptain(db, { teamId: rats, by: P[0], target: P[2] });
    expect(removePerson(db, { bookingId: id, by: P[2], steamid: P[2], now: NOW })).toEqual({ ok: false, error: 'is_captain' });
    expect(removePerson(db, { bookingId: id, by: P[2], steamid: P[0], now: NOW }).ok).toBe(true);
    const v = bookingView(db, id, { steamid: P[2], staff: false })!;
    expect(v.sides.find((s) => s.side === 'a')!.captain.steamid).toBe(P[2]);
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

  it('+1 campaign holds only while the capacity rule holds for the extra time (staff, any open state)', () => {
    const id = create(); // 2 campaigns: 20:00 to 23:00
    create({ by: P[2], opponent: { steamid: P[3] }, startsAt: '2026-10-02T23:00:00.000Z' });
    create({ by: P[4], opponent: { steamid: P[5] }, startsAt: '2026-10-02T23:00:00.000Z' });
    expect(addCampaign(db, { bookingId: id, by: P[9], staff: true, now: NOW })).toEqual({ ok: false, error: 'no_campaign_room' });
    expect(getBooking(db, id)).toMatchObject({ games_allowed: 2, ends_at: '2026-10-02T23:00:00.000Z' });
    setSetting(db, 'pug_reserve_servers', '1');
    // No campaign named: 60 + 10, up to 90.
    expect(addCampaign(db, { bookingId: id, by: P[9], staff: true, now: NOW }))
      .toEqual({ ok: true, value: { gamesAllowed: 3, endsAt: '2026-10-03T00:30:00.000Z', campaign: null } });
    expect(getBooking(db, id)).toMatchObject({ games_allowed: 3, extended_minutes: 90, warned_minutes: null });
    expect(JSON.parse(getBooking(db, id)!.playlist_json)).toEqual(['no_mercy', 'death_toll']);
  });

  it('+1 campaign checks the caller before the campaign, so a stranger learns nothing from a bad slug', () => {
    const id = create();
    expect(addCampaign(db, { bookingId: id, by: P[9], campaign: 'the_sacrifice', now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
  });

  it('+1 campaign appends a named pool campaign, and two calls add 2', () => {
    const id = create();
    expect(addCampaign(db, { bookingId: id, by: P[9], staff: true, campaign: 'the_sacrifice', now: NOW })).toEqual({ ok: false, error: 'bad_campaign' });
    expect(addCampaign(db, { bookingId: id, by: P[9], staff: true, campaign: 7, now: NOW })).toEqual({ ok: false, error: 'bad_campaign' });
    expect(addCampaign(db, { bookingId: id, by: P[9], staff: true, campaign: 'dead_air', now: NOW }))
      .toEqual({ ok: true, value: { gamesAllowed: 3, endsAt: '2026-10-03T00:30:00.000Z', campaign: 'dead_air' } });
    // A campaign already on the list is a replay, and still one more game.
    expect(addCampaign(db, { bookingId: id, by: P[9], staff: true, campaign: 'no_mercy', now: NOW }))
      .toEqual({ ok: true, value: { gamesAllowed: 4, endsAt: '2026-10-03T02:00:00.000Z', campaign: 'no_mercy' } });
    expect(JSON.parse(getBooking(db, id)!.playlist_json)).toEqual(['no_mercy', 'death_toll', 'dead_air', 'no_mercy']);
    const events = db.prepare("SELECT actor, detail FROM booking_events WHERE booking_id = ? AND event = 'campaign_added' ORDER BY id").all(id) as { actor: string; detail: string }[];
    expect(events.map((e) => [e.actor, JSON.parse(e.detail)])).toEqual([
      [P[9], { campaign: 'dead_air', gamesAllowed: 3, minutes: 90, endsAt: '2026-10-03T00:30:00.000Z', staff: true }],
      [P[9], { campaign: 'no_mercy', gamesAllowed: 4, minutes: 90, endsAt: '2026-10-03T02:00:00.000Z', staff: true }],
    ]);
  });

  it('+1 campaign during the closing grace cancels the close', () => {
    const id = create();
    db.prepare("UPDATE bookings SET close_at = '2026-10-02T22:05:00.000Z' WHERE id = ?").run(id);
    expect(addCampaign(db, { bookingId: id, by: P[9], staff: true, now: NOW }).ok).toBe(true);
    expect(getBooking(db, id)!.close_at).toBeNull();
  });

  it('a captain adds a campaign only to a ready or active booking, and only as a confirmed side', () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    expect(addCampaign(db, { bookingId: id, by: P[0], now: NOW })).toEqual({ ok: false, error: 'wrong_state' });
    holdBox(db, id, servers[3], at(START, -15));
    markSetup(db, id, at(START, -15));
    markReady(db, id, at(START, -12));
    expect(addCampaign(db, { bookingId: id, by: P[5], now: at(START, -12) })).toEqual({ ok: false, error: 'not_manager' });
    expect(addCampaign(db, { bookingId: id, by: P[0], now: at(START, -12) }))
      .toEqual({ ok: true, value: { gamesAllowed: 3, endsAt: '2026-10-03T00:30:00.000Z', campaign: null } });
    markActive(db, id, at(START, -5));
    expect(addCampaign(db, { bookingId: id, by: P[1], now: at(START, 5) }).ok).toBe(true);
    endBooking(db, { bookingId: id, by: P[0], now: at(START, 10) });
    expect(addCampaign(db, { bookingId: id, by: P[0], now: at(START, 11) })).toEqual({ ok: false, error: 'wrong_state' });
    expect(addCampaign(db, { bookingId: id, by: P[9], staff: true, now: at(START, 11) })).toEqual({ ok: false, error: 'wrong_state' });
  });

  it('an unconfirmed side acts only through confirm or decline, not cancel, extend, end or no-show', () => {
    const id = create();
    expect(cancelBooking(db, { bookingId: id, by: P[1], now: NOW })).toEqual({ ok: false, error: 'not_manager' });
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

  it('markReleased does nothing before an end has started', () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    holdBox(db, id, servers[1], NOW);
    markReleased(db, id, NOW);
    expect(getBooking(db, id)).toMatchObject({ state: 'held', ended_at: null });
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

  it('an open booking has no late cancel on either side; a side cancel 10 minutes out is one, a staff cancel is not', () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    const marks = (as: string) => bookingView(db, id, { steamid: as, staff: false })!.sides.map((s) => [s.lateCancel, s.excused, s.canExcuse]);
    expect(marks(P[1])).toEqual([[false, false, false], [false, false, false]]);
    cancelBooking(db, { bookingId: id, by: P[1], now: at(START, -10) });
    expect(marks(P[0])).toEqual([[false, false, false], [true, false, true]]);
    const staffed = create({ startsAt: '2026-10-03T20:00:00.000Z' });
    confirmBooking(db, { bookingId: staffed, by: P[1], now: NOW });
    cancelBooking(db, { bookingId: staffed, by: P[9], staff: true, now: at('2026-10-03T20:00:00.000Z', -10) });
    expect(bookingView(db, staffed, { steamid: P[0], staff: false })!.sides.map((s) => s.lateCancel)).toEqual([false, false]);
  });

  it("bookingView lists the booking's games oldest first", () => {
    const id = create();
    expect(bookingView(db, id, { steamid: P[0], staff: false })!.games).toEqual([]);
    const insertGame = (state: string, token: string, a: number, b: number): number => Number(db.prepare(
      `INSERT INTO matches (season_id, state, campaign, token, origin, kind, visibility, booking_id, booking_side_a, team_a_score, team_b_score)
       VALUES (?, ?, 'no_mercy', ?, 'in_game', 'scrim', 'participants', ?, 'a', ?, ?)`,
    ).run(currentSeasonId(db), state, token, id, a, b).lastInsertRowid);
    const first = insertGame('completed', 't1', 300, 200);
    const second = insertGame('live', 't2', 10, 5);
    const v = bookingView(db, id, { steamid: P[0], staff: false })!;
    expect(v.games.map((g) => g.matchId)).toEqual([first, second]);
    expect(v.games).toEqual([
      { matchId: first, campaign: 'no_mercy', state: 'completed', scoreA: 300, scoreB: 200, sideA: 'a', startedAt: expect.any(String), endedAt: null },
      { matchId: second, campaign: 'no_mercy', state: 'live', scoreA: 10, scoreB: 5, sideA: 'a', startedAt: expect.any(String), endedAt: null },
    ]);
  });

  it('bookingView counts campaigns: allowed, finished games played (an abort or a live game is not one), and the close deadline', () => {
    const id = create();
    const count = () => {
      const v = bookingView(db, id, { steamid: P[0], staff: false })!;
      return [v.gamesAllowed, v.gamesPlayed, v.closeAt];
    };
    expect(count()).toEqual([2, 0, null]);
    for (const [state, token] of [['completed', 'c1'], ['aborted', 'c2'], ['live', 'c3']]) {
      db.prepare(
        `INSERT INTO matches (season_id, state, campaign, token, origin, kind, visibility, booking_id, booking_side_a)
         VALUES (?, ?, 'no_mercy', ?, 'in_game', 'scrim', 'participants', ?, 'a')`,
      ).run(currentSeasonId(db), state, token, id);
    }
    db.prepare("UPDATE bookings SET close_at = '2026-10-02T22:05:00.000Z' WHERE id = ?").run(id);
    expect(count()).toEqual([2, 1, '2026-10-02T22:05:00.000Z']);
  });

  it('games show only to staff and to those who may see a booking game: not an invited person, not an unconfirmed side manager', () => {
    const id = create();
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign, token, origin, kind, visibility, booking_id, booking_side_a)
       VALUES (?, 'completed', 'no_mercy', 'tg', 'in_game', 'scrim', 'participants', ?, 'a')`,
    ).run(currentSeasonId(db), id);
    expect(addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[5], role: 'player', now: NOW })).toMatchObject({ ok: true, value: { status: 'invited' } });
    const games = (steamid: string, staff = false) => bookingView(db, id, { steamid, staff })!.games.length;
    expect(games(P[0])).toBe(1);
    expect(games(P[5])).toBe(0); // invited, not accepted
    expect(games(P[1])).toBe(0); // side b's captain before side b confirms
    expect(games(P[9], true)).toBe(1);
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    expect(games(P[1])).toBe(1);
    expect(games(P[5])).toBe(0);
    respondPerson(db, { bookingId: id, steamid: P[5], accept: true, now: NOW });
    expect(games(P[5])).toBe(1);
  });

  it('myBookings lists what needs the viewer', () => {
    const id = create();
    expect(myBookings(db, P[1]).open.map((b) => [b.id, b.needs])).toEqual([[id, 'confirm']]);
    expect(myBookings(db, P[0]).open.map((b) => b.needs)).toEqual([null]);
  });
});

describe('repost (plan 2)', () => {
  const bookFromPost = (startsAt = START): number => {
    const r1 = createPost(db, { by: P[0], startsAt, minutes: 120, campaigns: ['no_mercy'], srRange: null, note: '', now: NOW });
    if (!r1.ok) throw new Error(r1.error);
    const r2 = acceptPost(db, { postId: r1.value.id, by: P[1], now: NOW });
    if (!r2.ok) throw new Error(r2.error);
    const r3 = confirmAccept(db, { acceptId: r2.value.id, by: P[0], now: NOW });
    if (!r3.ok) throw new Error(r3.error);
    return r3.value.bookingId;
  };

  it('is allowed once cancelled, for a manager of either side; not before, and not to an outsider', () => {
    const id = bookFromPost();
    expect(bookingView(db, id, { steamid: P[0], staff: false })!.repost).toEqual({ allowed: false }); // not cancelled yet
    cancelBooking(db, { bookingId: id, by: P[0], now: NOW });
    expect(bookingView(db, id, { steamid: P[0], staff: false })!.repost).toEqual({ allowed: true });
    expect(bookingView(db, id, { steamid: P[1], staff: false })!.repost).toEqual({ allowed: true });
    expect(bookingView(db, id, { steamid: P[5], staff: false })).toBeNull();
  });

  it('is never allowed for a staff viewer who manages no side, nor for a cancelled booking not from a post', () => {
    const id = bookFromPost();
    cancelBooking(db, { bookingId: id, by: P[0], now: NOW });
    expect(bookingView(db, id, { steamid: P[9], staff: true })!.repost).toEqual({ allowed: false });
    const plain = create({ startsAt: '2026-10-03T20:00:00.000Z' });
    confirmBooking(db, { bookingId: plain, by: P[1], now: NOW });
    cancelBooking(db, { bookingId: plain, by: P[0], now: NOW });
    expect(bookingView(db, plain, { steamid: P[0], staff: false })!.repost).toEqual({ allowed: false });
  });
});

describe('who may be on the box (plan 4b2)', () => {
  const running = () => {
    const id = create();
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    holdBox(db, id, servers[1], NOW);
    markSetup(db, id, NOW);
    markReady(db, id, NOW);
    return id;
  };
  const ban = (steamid: string) => db.prepare("INSERT INTO bans (player_id, reason, created_by, created_at) VALUES (?, 'x', 'system', ?)")
    .run(steamid, '2026-09-01T00:00:00.000Z');

  it('allowList is the accepted people plus staff in good standing, sorted, no invited people, no banned admin', () => {
    const id = running();
    addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[5], role: 'player', now: NOW }); // invited
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid IN (?, ?)').run(P[9], P[0]);
    db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(P[10]);
    db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(P[11]);
    ban(P[11]);
    const list = allowList(db, id);
    expect(list).toEqual([P[0], P[1], P[9], P[10]].sort());
    expect(list).not.toContain(P[5]);
    expect(list).not.toContain(P[11]);
  });

  it('a captain adds a ringer to their side, creating a players row for an unknown id', () => {
    const id = running();
    const unknown = '76561199123456789';
    const r = allowInGame(db, { bookingId: id, by: P[1], steamid: unknown, name: '  Some Name  ', now: NOW });
    expect(r).toEqual({ ok: true, value: { side: 'b', added: true } });
    expect(db.prepare('SELECT name, status, is_admin FROM players WHERE steamid = ?').get(unknown)).toEqual({ name: 'Some Name', status: 'invited', is_admin: 0 });
    expect(peopleOf(db, id).find((p) => p.steamid === unknown)).toMatchObject({ side: 'b', role: 'ringer', status: 'accepted', added_by: P[1] });
    expect(db.prepare("SELECT actor, detail FROM booking_events WHERE booking_id = ? AND event = 'person_allowed_in_game'").get(id))
      .toEqual({ actor: P[1], detail: JSON.stringify({ steamid: unknown, side: 'b' }) });
    expect(allowList(db, id)).toContain(unknown);
  });

  it('an existing player keeps their row; an unsafe or long name is cut or falls back to the steamid', () => {
    const id = running();
    expect(allowInGame(db, { bookingId: id, by: P[0], steamid: P[6], name: 'whatever', now: NOW })).toEqual({ ok: true, value: { side: 'a', added: true } });
    expect(db.prepare('SELECT name, status FROM players WHERE steamid = ?').get(P[6])).toEqual({ name: 'p6', status: 'active' });
    const long = '76561199123456780';
    allowInGame(db, { bookingId: id, by: P[0], steamid: long, name: 'x'.repeat(40), now: NOW });
    expect((db.prepare('SELECT name FROM players WHERE steamid = ?').get(long) as { name: string }).name).toBe('x'.repeat(32));
    const bad = '76561199123456781';
    allowInGame(db, { bookingId: id, by: P[0], steamid: bad, name: 'evil\u202Ename', now: NOW });
    expect((db.prepare('SELECT name FROM players WHERE steamid = ?').get(bad) as { name: string }).name).toBe(bad);
    const blank = '76561199123456782';
    allowInGame(db, { bookingId: id, by: P[0], steamid: blank, name: 42, now: NOW });
    expect((db.prepare('SELECT name FROM players WHERE steamid = ?').get(blank) as { name: string }).name).toBe(blank);
  });

  it('refuses a non-captain, a bad id, a banned id, and a booking that is not running', () => {
    const id = create();
    const r = (by: string, steamid: unknown) => {
      const res = allowInGame(db, { bookingId: id, by, steamid, name: 'n', now: NOW });
      return res.ok ? 'ok' : res.error;
    };
    expect(r(P[0], P[7])).toBe('wrong_state'); // scheduled, not running
    confirmBooking(db, { bookingId: id, by: P[1], now: NOW });
    holdBox(db, id, servers[1], NOW);
    markSetup(db, id, NOW);
    markReady(db, id, NOW);
    expect(r(P[7], P[8])).toBe('not_manager');
    expect(r(P[0], '123')).toBe('not_player');
    expect(r(P[0], 76561199000000799)).toBe('not_player');
    ban(P[7]);
    expect(r(P[0], P[7])).toBe('not_player');
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(P[8]);
    expect(r(P[0], P[8])).toBe('not_player');
    expect(peopleOf(db, id).map((p) => p.steamid)).toEqual([P[0], P[1]]);
    endBooking(db, { bookingId: id, by: P[0], now: NOW });
    expect(r(P[0], P[6])).toBe('wrong_state');
  });

  it('someone already accepted is added: false and nothing changes', () => {
    const id = running();
    allowInGame(db, { bookingId: id, by: P[0], steamid: P[6], name: 'n', now: NOW });
    const before = peopleOf(db, id);
    expect(allowInGame(db, { bookingId: id, by: P[1], steamid: P[6], name: 'n', now: NOW })).toEqual({ ok: true, value: { side: 'b', added: false } });
    expect(allowInGame(db, { bookingId: id, by: P[1], steamid: P[0], name: 'n', now: NOW })).toEqual({ ok: true, value: { side: 'b', added: false } });
    expect(peopleOf(db, id)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE event = 'person_allowed_in_game'").get()).toEqual({ n: 1 });
  });

  it("an open invite on the captain's side is accepted (role kept) and goes on the list", () => {
    const id = running();
    addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[5], role: 'spectator', now: NOW }); // invited on a
    expect(allowList(db, id)).not.toContain(P[5]);
    expect(allowInGame(db, { bookingId: id, by: P[0], steamid: P[5], name: 'n', now: NOW })).toEqual({ ok: true, value: { side: 'a', added: true } });
    expect(peopleOf(db, id).find((p) => p.steamid === P[5])).toMatchObject({ side: 'a', role: 'spectator', status: 'accepted', added_by: P[0] });
    expect(db.prepare("SELECT actor, detail FROM booking_events WHERE booking_id = ? AND event = 'person_allowed_in_game'").get(id))
      .toEqual({ actor: P[0], detail: JSON.stringify({ steamid: P[5], side: 'a', accepted: true }) });
    expect(allowList(db, id)).toContain(P[5]);
  });

  it("an open invite from the other side is refused as invited_elsewhere and left alone", () => {
    const id = running();
    addPerson(db, { bookingId: id, by: P[0], side: 'a', steamid: P[5], role: 'player', now: NOW }); // invited on a
    const before = peopleOf(db, id);
    expect(allowInGame(db, { bookingId: id, by: P[1], steamid: P[5], name: 'n', now: NOW })).toEqual({ ok: false, error: 'invited_elsewhere' });
    expect(peopleOf(db, id)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE event = 'person_allowed_in_game'").get()).toEqual({ n: 0 });
  });

  it('a merged alt is refused, with or without a players row of its own', () => {
    const id = running();
    const alias = (alt: string) => db.prepare("INSERT INTO player_aliases (steamid, canonical_id, created_at, created_by) VALUES (?, ?, '2026-09-01T00:00:00.000Z', 'admin')").run(alt, P[9]);
    alias(P[8]);
    const rowless = '76561199123456700';
    alias(rowless);
    expect(allowInGame(db, { bookingId: id, by: P[0], steamid: P[8], name: 'n', now: NOW })).toEqual({ ok: false, error: 'not_player' });
    expect(allowInGame(db, { bookingId: id, by: P[0], steamid: rowless, name: 'n', now: NOW })).toEqual({ ok: false, error: 'not_player' });
    expect(db.prepare('SELECT 1 FROM players WHERE steamid = ?').get(rowless)).toBeUndefined();
  });

  it('allowList drops accepted people who are banned, banned by status, or merged away, but keeps an invited-status ringer', () => {
    const id = running();
    const ringer = '76561199123456701';
    allowInGame(db, { bookingId: id, by: P[0], steamid: ringer, name: 'r', now: NOW });
    for (const sid of [P[5], P[6], P[7]]) allowInGame(db, { bookingId: id, by: P[0], steamid: sid, name: 'n', now: NOW });
    expect(allowList(db, id)).toEqual([P[0], P[1], P[5], P[6], P[7], ringer].sort());
    ban(P[5]);
    db.prepare("UPDATE players SET status = 'banned' WHERE steamid = ?").run(P[6]);
    db.prepare("INSERT INTO player_aliases (steamid, canonical_id, created_at, created_by) VALUES (?, ?, '2026-09-01T00:00:00.000Z', 'admin')").run(P[7], P[9]);
    expect(allowList(db, id)).toEqual([P[0], P[1], ringer].sort());
  });

  it('a full side is side_full', () => {
    const id = running();
    for (let i = 0; i < 11; i++) {
      expect(allowInGame(db, { bookingId: id, by: P[1], steamid: `765611991000000${String(i).padStart(2, '0')}`, name: `r${i}`, now: NOW }).ok).toBe(true);
    }
    const r = allowInGame(db, { bookingId: id, by: P[1], steamid: '76561199100000099', name: 'late', now: NOW });
    expect(r).toEqual({ ok: false, error: 'side_full' });
    expect(db.prepare('SELECT 1 FROM players WHERE steamid = ?').get('76561199100000099')).toBeUndefined();
  });
});

describe('blocks', () => {
  type Party = { teamId: number } | { captain: string };
  const block = (by: string, party: Party, target: unknown): void => {
    const r = blockTarget(db, { by, party, target, now: NOW });
    if (!r.ok) throw new Error(r.error);
  };
  const err = (over: Record<string, unknown>) => {
    const r = createBooking(db, base(over) as Parameters<typeof createBooking>[1]);
    return r.ok ? 'ok' : r.error;
  };

  it('createBooking refuses not_available between a blocked pair, whichever side blocked', () => {
    const rats = team(P[0], 'Rats', 'RR');
    const cats = team(P[1], 'Cats', 'CC');
    block(P[0], { teamId: rats }, { teamId: cats });
    expect(err({ teamId: rats, opponent: { teamId: cats } })).toBe('not_available');
    expect(err({ by: P[1], teamId: cats, opponent: { teamId: rats } })).toBe('not_available');
    // A pickup captain the other side blocked, in both directions.
    block(P[2], { captain: P[2] }, { steamid: P[3] });
    expect(err({ by: P[2], opponent: { steamid: P[3] } })).toBe('not_available');
    expect(err({ by: P[3], opponent: { steamid: P[2] } })).toBe('not_available');
    // A player block follows them into a team they captain.
    expect(err({ by: P[2], opponent: { teamId: team(P[3], 'Mice', 'MM') } })).toBe('not_available');
    expect(err({ by: P[4], opponent: { steamid: P[5] } })).toBe('ok');
    expect(BOOKING_ERRORS.not_available).toEqual({ status: 409, text: 'This scrim is not available to you.' });
  });

  it('an invite sent before the block cannot then be confirmed', () => {
    const id = create();
    block(P[1], { captain: P[1] }, { steamid: P[0] });
    expect(confirmBooking(db, { bookingId: id, by: P[1], now: NOW })).toEqual({ ok: false, error: 'not_available' });
  });
});
