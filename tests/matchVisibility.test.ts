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
let pub: number, priv: number, staffOnly: number, bookingGame: number;
let bookingId: number;

/** A pickup booking (two sides, no teams) with an accepted spectator and an
 *  invited-but-not-accepted player on side a, neither of whom played in the
 *  seeded match line-up. Enough rows for the read-only visibility queries;
 *  not run through the booking lifecycle functions. */
function seedBooking(): number {
  const id = Number(db.prepare(
    `INSERT INTO bookings (purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
     VALUES ('scrim', 'na', '2026-09-21T11:00:00.000Z', '2026-09-21T13:00:00.000Z', 'pw', 'tvpw', 'standard', '{}', '[]', ?, '2026-09-21T10:00:00.000Z')`,
  ).run(captainA).lastInsertRowid);
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

beforeEach(() => {
  db = openDb(':memory:');
  const all = seedPlayers(db, 14);
  ids = all.slice(0, 8);
  outsider = all[8];
  mod = all[9];
  captainA = all[10];
  captainB = all[11];
  acceptedSpectator = all[12];
  invitedPlayer = all[13];
  db.prepare('UPDATE players SET is_mod = 1 WHERE steamid = ?').run(mod);
  const lines = ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b' }));
  pub = seedMatch(db, { endedAt: '2026-09-21 12:00:00', lines });
  priv = seedMatch(db, { endedAt: '2026-09-21 13:00:00', kind: 'scrim', visibility: 'participants', lines });
  staffOnly = seedMatch(db, { endedAt: '2026-09-21 14:00:00', kind: 'scrim', visibility: 'staff', lines });
  bookingId = seedBooking();
  bookingGame = seedMatch(db, { endedAt: '2026-09-21 15:00:00', kind: 'scrim', visibility: 'participants', lines });
  db.prepare('UPDATE matches SET booking_id = ? WHERE id = ?').run(bookingId, bookingGame);
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
});

describe('visibleMatchesSql', () => {
  const idsFor = (who: string | null): number[] => {
    const { sql, params } = visibleMatchesSql(viewerFor(db, who), 'm');
    return (db.prepare(`SELECT m.id FROM matches m WHERE ${sql} ORDER BY m.id`).all(...params) as { id: number }[]).map((r) => r.id);
  };
  it('matches canViewMatch for every viewer', () => {
    expect(idsFor(null)).toEqual([pub]);
    expect(idsFor(outsider)).toEqual([pub]);
    expect(idsFor(ids[0])).toEqual([pub, priv, bookingGame]);
    expect(idsFor(mod)).toEqual([pub, priv, staffOnly, bookingGame]);
  });

  it("lists the booking's scrim match for an accepted spectator and a pickup captain, but not for an invited-not-accepted person", () => {
    expect(idsFor(acceptedSpectator)).toEqual([pub, bookingGame]);
    expect(idsFor(captainA)).toEqual([pub, bookingGame]);
    expect(idsFor(captainB)).toEqual([pub, bookingGame]);
    expect(idsFor(invitedPlayer)).toEqual([pub]);
  });
});
