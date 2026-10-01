import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';
import { viewerFor, canViewMatch, visibleMatchesSql } from '../src/matchVisibility.js';

let db: DB;
let ids: string[];
let outsider: string;
let mod: string;
let captainA: string;
let captainB: string;
let acceptedSpectator: string;
let invitedPlayer: string;
let teamCoCaptain: string;
let teamMember: string;
let formerCaptain: string;
let unconfirmedCaptain: string;
let pub: number, priv: number, staffOnly: number, bookingGame: number;
let teamGame: number;
let unconfirmedGame: number;
let bookingId: number;

const newBookingRow = (createdBy: string): number => Number(db.prepare(
  `INSERT INTO bookings (purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
   VALUES ('scrim', 'na', '2026-09-21T11:00:00.000Z', '2026-09-21T13:00:00.000Z', 'pw', 'tvpw', 'standard', '{}', '[]', ?, '2026-09-21T10:00:00.000Z')`,
).run(createdBy).lastInsertRowid);

/** A pickup booking (two sides, no teams, both confirmed) with an accepted
 *  spectator and an invited-but-not-accepted player on side a, neither of
 *  whom played in the seeded match line-up. Enough rows for the read-only
 *  visibility queries; not run through the booking lifecycle functions. */
function seedBooking(): number {
  const id = newBookingRow(captainA);
  const side = db.prepare('INSERT INTO booking_sides (booking_id, side, captain_steamid, confirmed_at) VALUES (?, ?, ?, ?)');
  side.run(id, 'a', captainA, '2026-09-21T10:00:00.000Z');
  side.run(id, 'b', captainB, '2026-09-21T10:00:00.000Z');
  const person = db.prepare(
    'INSERT INTO booking_people (booking_id, side, steamid, role, status, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  person.run(id, 'a', acceptedSpectator, 'spectator', 'accepted', captainA, '2026-09-21T10:00:00.000Z');
  person.run(id, 'a', invitedPlayer, 'player', 'invited', captainA, '2026-09-21T10:00:00.000Z');
  return id;
}

/** A booking whose confirmed side b is a team: a current co-captain with no
 *  booking_people row, a plain member, and a captain who has since left the
 *  team (left_at set). None of the three played in the seeded line-up. */
function seedTeamBooking(): number {
  const id = newBookingRow(captainA);
  const teamId = Number(db.prepare(
    `INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by, created_at)
     VALUES ('Team X', 'team-x', 'TX', 'tx', 'team-x', ?, ?, '2026-09-21T09:00:00.000Z')`,
  ).run(teamCoCaptain, teamCoCaptain).lastInsertRowid);
  const tm = db.prepare('INSERT INTO team_members (team_id, steamid, role, joined_at, left_at) VALUES (?, ?, ?, ?, ?)');
  tm.run(teamId, teamCoCaptain, 'cocaptain', '2026-09-21T09:00:00.000Z', null);
  tm.run(teamId, teamMember, 'member', '2026-09-21T09:00:00.000Z', null);
  tm.run(teamId, formerCaptain, 'captain', '2026-09-21T09:00:00.000Z', '2026-09-21T09:30:00.000Z');
  db.prepare('INSERT INTO booking_sides (booking_id, side, captain_steamid, confirmed_at) VALUES (?, ?, ?, ?)')
    .run(id, 'a', captainA, '2026-09-21T10:00:00.000Z');
  db.prepare('INSERT INTO booking_sides (booking_id, side, team_id, captain_steamid, confirmed_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'b', teamId, teamCoCaptain, '2026-09-21T10:00:00.000Z');
  return id;
}

/** A booking whose side b is a pickup side that has never confirmed
 *  (confirmed_at NULL): its named captain is only a prospective manager
 *  (see actingSides in bookings/bookings.ts) until the side confirms. */
function seedUnconfirmedBooking(): number {
  const id = newBookingRow(captainA);
  db.prepare('INSERT INTO booking_sides (booking_id, side, captain_steamid, confirmed_at) VALUES (?, ?, ?, ?)')
    .run(id, 'a', captainA, '2026-09-21T10:00:00.000Z');
  db.prepare('INSERT INTO booking_sides (booking_id, side, captain_steamid, confirmed_at) VALUES (?, ?, ?, ?)')
    .run(id, 'b', unconfirmedCaptain, null);
  return id;
}

beforeEach(() => {
  db = openDb(':memory:');
  const all = seedPlayers(db, 18);
  ids = all.slice(0, 8);
  outsider = all[8];
  mod = all[9];
  captainA = all[10];
  captainB = all[11];
  acceptedSpectator = all[12];
  invitedPlayer = all[13];
  teamCoCaptain = all[14];
  teamMember = all[15];
  formerCaptain = all[16];
  unconfirmedCaptain = all[17];
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(mod);
  const lines = ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));
  pub = seedMatch(db, { endedAt: '2026-09-21 12:00:00', lines });
  priv = seedMatch(db, { endedAt: '2026-09-21 13:00:00', kind: 'scrim', visibility: 'participants', lines });
  staffOnly = seedMatch(db, { endedAt: '2026-09-21 14:00:00', kind: 'scrim', visibility: 'staff', lines });
  bookingId = seedBooking();
  bookingGame = seedMatch(db, { endedAt: '2026-09-21 15:00:00', kind: 'scrim', visibility: 'participants', lines });
  db.prepare('UPDATE matches SET booking_id = ? WHERE id = ?').run(bookingId, bookingGame);
  const teamBookingId = seedTeamBooking();
  teamGame = seedMatch(db, { endedAt: '2026-09-21 16:00:00', kind: 'scrim', visibility: 'participants', lines });
  db.prepare('UPDATE matches SET booking_id = ? WHERE id = ?').run(teamBookingId, teamGame);
  const unconfirmedBookingId = seedUnconfirmedBooking();
  unconfirmedGame = seedMatch(db, { endedAt: '2026-09-21 17:00:00', kind: 'scrim', visibility: 'participants', lines });
  db.prepare('UPDATE matches SET booking_id = ? WHERE id = ?').run(unconfirmedBookingId, unconfirmedGame);
});

describe('canViewMatch', () => {
  it.each([
    ['anonymous', (): string | null => null, [true, false, false, false]],
    ['outsider', (): string => outsider, [true, false, false, false]],
    ['participant', (): string => ids[0], [true, true, false, true]],
    ['mod', (): string => mod, [true, true, true, true]],
  ] as const)('%s', (_label, who, expected) => {
    const v = viewerFor(db, who());
    expect([pub, priv, staffOnly, bookingGame].map((id) => canViewMatch(db, v, id))).toEqual(expected);
  });

  it('a missing match is not viewable', () => {
    expect(canViewMatch(db, viewerFor(db, mod), 999_999)).toBe(false);
  });

  it("an accepted spectator of the booking, not a match_players row, can view its scrim match", () => {
    expect(canViewMatch(db, viewerFor(db, acceptedSpectator), bookingGame)).toBe(true);
  });

  it('a pickup captain (a side manager) can view the booking\'s scrim match', () => {
    expect(canViewMatch(db, viewerFor(db, captainA), bookingGame)).toBe(true);
    expect(canViewMatch(db, viewerFor(db, captainB), bookingGame)).toBe(true);
  });

  it('an invited-but-not-accepted person cannot view the booking\'s scrim match', () => {
    expect(canViewMatch(db, viewerFor(db, invitedPlayer), bookingGame)).toBe(false);
  });

  it('a stranger to the booking cannot view its scrim match', () => {
    expect(canViewMatch(db, viewerFor(db, outsider), bookingGame)).toBe(false);
  });

  it('booking visibility never leaks onto a public or staff-only match with the same booking_id unset', () => {
    // priv and staffOnly carry no booking_id: an accepted booking person gets
    // nothing extra on them.
    expect(canViewMatch(db, viewerFor(db, acceptedSpectator), priv)).toBe(false);
    expect(canViewMatch(db, viewerFor(db, acceptedSpectator), staffOnly)).toBe(false);
  });

  it("a current co-captain of a team side can view the game though they have no booking_people row", () => {
    expect(canViewMatch(db, viewerFor(db, teamCoCaptain), teamGame)).toBe(true);
  });

  it('a plain member of a team side cannot view the game', () => {
    expect(canViewMatch(db, viewerFor(db, teamMember), teamGame)).toBe(false);
  });

  it('a captain who has since left the team side cannot view the game', () => {
    expect(canViewMatch(db, viewerFor(db, formerCaptain), teamGame)).toBe(false);
  });

  it('an unconfirmed side\'s prospective pickup captain cannot view the booking\'s game', () => {
    expect(canViewMatch(db, viewerFor(db, unconfirmedCaptain), unconfirmedGame)).toBe(false);
  });
});

describe('visibleMatchesSql', () => {
  const idsFor = (who: string | null): number[] => {
    const { sql, params } = visibleMatchesSql(viewerFor(db, who), 'm');
    return (db.prepare(`SELECT m.id FROM matches m WHERE ${sql} ORDER BY m.id`).all(...params) as { id: number }[]).map((r) => r.id);
  };
  it('matches canViewMatch for every viewer', () => {
    // teamGame and unconfirmedGame reuse the same match_players line-up as
    // the other scrims, so a line-up participant sees them regardless of
    // booking status; the dedicated booking tests below isolate the
    // booking-only visibility paths (managers and accepted people who never
    // played in the line-up).
    expect(idsFor(null)).toEqual([pub]);
    expect(idsFor(outsider)).toEqual([pub]);
    expect(idsFor(ids[0])).toEqual([pub, priv, bookingGame, teamGame, unconfirmedGame]);
    expect(idsFor(mod)).toEqual([pub, priv, staffOnly, bookingGame, teamGame, unconfirmedGame]);
  });

  it("lists the booking's scrim match for an accepted spectator and a pickup captain, but not for an invited-not-accepted person", () => {
    expect(idsFor(acceptedSpectator)).toEqual([pub, bookingGame]);
    // captainA also confirmed-manages side a of the team booking and the
    // unconfirmed booking (only their side b is unconfirmed), so they see
    // all three booking games.
    expect(idsFor(captainA)).toEqual([pub, bookingGame, teamGame, unconfirmedGame]);
    expect(idsFor(captainB)).toEqual([pub, bookingGame]);
    expect(idsFor(invitedPlayer)).toEqual([pub]);
  });

  it("lists a team side's game for its current co-captain, but not for a plain member or a former captain", () => {
    expect(idsFor(teamCoCaptain)).toEqual([pub, teamGame]);
    expect(idsFor(teamMember)).toEqual([pub]);
    expect(idsFor(formerCaptain)).toEqual([pub]);
  });

  it("leaves out an unconfirmed side's prospective pickup captain", () => {
    expect(idsFor(unconfirmedCaptain)).toEqual([pub]);
  });
});
