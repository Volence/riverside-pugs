import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { sideSr, srFits, proposedPlaylist, nearestFreeSlot } from '../src/scrims/rules.js';

const A = '76561199000002001';
const B = '76561199000002002';
const C = '76561199000002003';
const H = 3_600_000;
const T0 = Date.parse('2026-10-05T20:00:00.000Z');
/** displaySr(25, 25/3): openskill's default rating for a player with no row. */
const UNRATED_SR = 833;

let db: DB;
let seasonId: number;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [A, B, C]) db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')").run(id, id.slice(-3));
  seasonId = (db.prepare('SELECT id FROM seasons LIMIT 1').get() as { id: number }).id;
});

const rate = (steamid: string, mu: number, sigma: number): void => {
  db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, ?, ?, ?)').run(steamid, seasonId, mu, sigma);
};

const team = (captain: string): number => Number(db.prepare(
  "INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by) VALUES ('Riverside', 'riverside', 'RS', 'rs', 'riverside', ?, ?)",
).run(captain, captain).lastInsertRowid);

const join = (teamId: number, steamid: string, role: 'captain' | 'cocaptain' | 'member' = 'member'): void => {
  db.prepare("INSERT INTO team_members (team_id, steamid, role, joined_at) VALUES (?, ?, ?, 'x')").run(teamId, steamid, role);
};

describe('sideSr', () => {
  it("averages a team's active members' current-season display SR", () => {
    const teamId = team(A);
    join(teamId, A, 'captain');
    join(teamId, B, 'member');
    rate(A, 30, 5); // displaySr = round((30 - 10) * 100) = 2000
    rate(B, 20, 5); // displaySr = round((20 - 10) * 100) = 1000
    expect(sideSr(db, { teamId })).toBe(1500);
  });

  it('counts a member with no rating as the season starting SR', () => {
    const teamId = team(A);
    join(teamId, A, 'captain');
    join(teamId, B, 'member'); // B is never rated
    rate(A, 30, 5); // 2000
    expect(sideSr(db, { teamId })).toBe(Math.round((2000 + UNRATED_SR) / 2));
  });

  it('leaves out a member who left the team', () => {
    const teamId = team(A);
    join(teamId, A, 'captain');
    join(teamId, B, 'member');
    db.prepare("UPDATE team_members SET left_at = 'x' WHERE team_id = ? AND steamid = ?").run(teamId, B);
    rate(A, 30, 5); // 2000
    rate(B, 100, 5); // would dominate the average if it still counted
    expect(sideSr(db, { teamId })).toBe(2000);
  });

  it('is the pickup captain\'s own SR alone', () => {
    rate(C, 30, 5); // 2000
    expect(sideSr(db, { captain: C })).toBe(2000);
  });

  it('an unrated pickup captain counts as the season starting SR', () => {
    expect(sideSr(db, { captain: C })).toBe(UNRATED_SR);
  });
});

describe('srFits', () => {
  it('is always true for an open (null) range', () => {
    expect(srFits(1000, null, 0)).toBe(true);
    expect(srFits(1000, null, 1_000_000)).toBe(true);
  });

  it('is true at the edges of the range and false just past them', () => {
    expect(srFits(1000, 100, 1100)).toBe(true);
    expect(srFits(1000, 100, 900)).toBe(true);
    expect(srFits(1000, 100, 1101)).toBe(false);
    expect(srFits(1000, 100, 899)).toBe(false);
  });

  it('with a zero range only the exact SR fits', () => {
    expect(srFits(1000, 0, 1000)).toBe(true);
    expect(srFits(1000, 0, 1001)).toBe(false);
    expect(srFits(1000, 0, 999)).toBe(false);
  });
});

describe('proposedPlaylist', () => {
  // A fresh database has no completed matches, so typicalCampaignMinutes
  // (src/bookings/rules.ts) falls back to DEFAULT_CAMPAIGN_MINUTES (60) for
  // every campaign, making the minutes in these tests predictable.

  it('alternates poster and accepter picks, poster first', () => {
    const r = proposedPlaylist(db, ['no_mercy', 'death_toll'], ['dead_air'], 1000);
    expect(r.playlist).toEqual(['no_mercy', 'dead_air', 'death_toll']);
    expect(r.minutes).toBe(180);
    expect(r.fits).toBe(true);
  });

  it('skips a campaign that already appeared, wherever it recurs', () => {
    const r = proposedPlaylist(db, ['no_mercy', 'death_toll'], ['no_mercy', 'dead_air'], 1000);
    expect(r.playlist).toEqual(['no_mercy', 'death_toll', 'dead_air']);
  });

  it('trims to what fits the block, in alternation order', () => {
    // Each campaign defaults to 60 minutes; a 90 minute block fits one.
    const r = proposedPlaylist(db, ['no_mercy', 'death_toll'], [], 90);
    expect(r.playlist).toEqual(['no_mercy']);
    expect(r.minutes).toBe(60);
    expect(r.fits).toBe(true);
  });

  it('always keeps at least one campaign, even if it alone runs over the block', () => {
    const r = proposedPlaylist(db, ['no_mercy'], [], 30);
    expect(r.playlist).toEqual(['no_mercy']);
    expect(r.minutes).toBe(60);
    expect(r.fits).toBe(false);
  });

  it('never exceeds booking_playlist_max, whatever the block allows', () => {
    setSetting(db, 'booking_playlist_max', '2');
    const r = proposedPlaylist(
      db,
      ['no_mercy', 'death_toll', 'dead_air'],
      ['blood_harvest', 'dark_carnival', 'swamp_fever'],
      100_000,
    );
    expect(r.playlist).toHaveLength(2);
    expect(r.playlist).toEqual(['no_mercy', 'blood_harvest']);
  });
});

describe('nearestFreeSlot', () => {
  const servers = (n: number, region = 'na'): void => {
    for (let i = 0; i < n; i++) {
      db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status, region) VALUES (?, 'h', ?, 1, 'pw', 'idle', ?)")
        .run(`s${i}`, 27015 + i, region);
    }
  };
  const book = (startMs: number, endMs: number): void => {
    db.prepare(
      `INSERT INTO bookings (purpose, region, starts_at, ends_at, state, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
       VALUES ('scrim', 'na', ?, ?, 'scheduled', 'p', 't', 'standard', '{}', '[]', ?, 'x')`,
    ).run(new Date(startMs).toISOString(), new Date(endMs).toISOString(), A);
  };

  beforeEach(() => {
    servers(1);
    setSetting(db, 'pug_reserve_servers', '0'); // 1 server, 0 reserve: room for exactly one booking at a time
  });

  it('returns the post start itself when it already has room', () => {
    expect(nearestFreeSlot(db, 'na', T0, 60)).toBe(new Date(T0).toISOString());
  });

  it('steps out 30 minutes at a time and returns the closest free slot, preferring later on a tie', () => {
    book(T0, T0 + H); // blocks the start and the +-30 min candidates; +-60 min are both free (back to back)
    expect(nearestFreeSlot(db, 'na', T0, 60)).toBe(new Date(T0 + H).toISOString());
  });

  it('returns the earlier slot when only the earlier side has room', () => {
    book(T0, T0 + 5 * H); // every later candidate within the 3 hour window stays inside this booking
    expect(nearestFreeSlot(db, 'na', T0, 60)).toBe(new Date(T0 - H).toISOString());
  });

  it('returns null when nothing is free within 3 hours either side', () => {
    book(T0 - 4 * H, T0 + 4 * H); // covers the whole search window plus the slot length on both ends
    expect(nearestFreeSlot(db, 'na', T0, 60)).toBeNull();
  });
});
