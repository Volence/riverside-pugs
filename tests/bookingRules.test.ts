import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  addCampaignMinutes, allowance, bookingLimits, bookingsDue, capacityProblem, estimateMinutes, playlistMinutes, recentNoShows,
  typicalCampaignMinutes, upcomingCount, DEFAULT_CAMPAIGN_MINUTES, scheduledMatchSlots, EVENT_SLOT_MINUTES,
} from '../src/bookings/rules.js';

const A = '76561199000000501';
const B = '76561199000000502';
const H = 3_600_000;
const T0 = Date.parse('2026-10-02T20:00:00.000Z');
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [A, B]) db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')").run(id, id.slice(-3));
});

const servers = (n: number, region = 'na') => {
  for (let i = 0; i < n; i++) {
    db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status, region) VALUES (?, 'h', ?, 1, 'pw', 'idle', ?)")
      .run(`s${i}`, 27015 + i, region);
  }
};
const book = (startMs: number, endMs: number, o: { state?: string; captain?: string; teamId?: number | null; bConfirmed?: boolean; serverId?: number | null } = {}) => {
  const id = Number(db.prepare(
    `INSERT INTO bookings (purpose, starts_at, ends_at, state, server_id, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
     VALUES ('scrim', ?, ?, ?, ?, 'p', 't', 'standard', '{}', '[]', ?, 'x')`,
  ).run(new Date(startMs).toISOString(), new Date(endMs).toISOString(), o.state ?? 'scheduled', o.serverId ?? null, o.captain ?? A).lastInsertRowid);
  db.prepare("INSERT INTO booking_sides (booking_id, side, team_id, captain_steamid, confirmed_at) VALUES (?, 'a', ?, ?, 'x')")
    .run(id, o.teamId ?? null, o.captain ?? A);
  db.prepare("INSERT INTO booking_sides (booking_id, side, captain_steamid, confirmed_at) VALUES (?, 'b', ?, ?)")
    .run(id, B, o.bConfirmed === false ? null : 'x');
  return id;
};
const setReserve = (n: number) => db.prepare("UPDATE settings SET value = ? WHERE key = 'pug_reserve_servers'").run(String(n));

describe('capacity', () => {
  it('fits while enabled minus overlapping bookings stays at or above the reserve', () => {
    servers(3); // room for 1 booking at a time with the default reserve of 2
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBeNull();
    book(T0, T0 + H);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBe(T0);
    expect(capacityProblem(db, { region: 'na', startMs: T0 + H, endMs: T0 + 2 * H })).toBeNull(); // back to back is fine
    expect(capacityProblem(db, { region: 'na', startMs: T0 - H, endMs: T0 })).toBeNull();
  });

  it('checks the busiest moment, not just the start', () => {
    servers(4); // room for 2
    book(T0, T0 + H);
    book(T0 + H / 2, T0 + 2 * H);
    // 20:30-21:30: from 20:30 to 21:00 both are running, so a third does not fit.
    expect(capacityProblem(db, { region: 'na', startMs: T0 + H / 2, endMs: T0 + H + H / 2 })).toBe(T0 + H / 2);
    // 21:00-22:00 meets only the second.
    expect(capacityProblem(db, { region: 'na', startMs: T0 + H, endMs: T0 + 2 * H })).toBeNull();
    // 19:00-21:00 starts with nobody, then meets the first at 20:00 and the second at 20:30.
    expect(capacityProblem(db, { region: 'na', startMs: T0 - H, endMs: T0 + H })).toBe(T0 + H / 2);
  });

  it('ignores ended, cancelled and winding-down bookings, the booking itself, disabled boxes and other regions', () => {
    servers(3);
    servers(5, 'eu');
    db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password, status, enabled) VALUES ('off', 'h', 1, 1, 'pw', 'idle', 0)").run();
    book(T0, T0 + H, { state: 'cancelled' });
    book(T0, T0 + H, { state: 'ended' });
    const mine = book(T0, T0 + H);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H, exceptId: mine })).toBeNull();
    db.prepare("UPDATE bookings SET ending_at = 'x' WHERE id = ?").run(mine);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBeNull();
  });

  it('refuses everything when the reserve leaves no room, and staff can lower it', () => {
    servers(2);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBe(T0);
    setReserve(1);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBeNull();
  });

  it('keeps a box back for a scheduled tournament match until it is booked, in its region only (plan T4 Ruling 5)', () => {
    servers(3); // room for 1 at a time
    let n = 0;
    const seed = (region: string, scheduledAt: string, over: Record<string, unknown> = {}) => {
      n++;
      const cup = (db.prepare("SELECT id FROM rulesets WHERE name = 'Standard Cup'").get() as { id: number }).id;
      const ev = Number(db.prepare(
        `INSERT INTO events (slug, name, region, organizer_steamid, entry_kind, status, starts_at, eligibility_json, checkin_json, roster_json, created_at, updated_at)
         VALUES (?, 'Cup', ?, ?, 'team', 'live', ?, '{}', '{}', '{}', 'x', 'x')`,
      ).run(`cup-${n}`, region, A, scheduledAt).lastInsertRowid);
      const stage = Number(db.prepare(
        `INSERT INTO event_stages (event_id, ordinal, type, config_json, ruleset_id, campaign_pool_json, veto_type, scheduling, status, created_at, updated_at)
         VALUES (?, 1, 'league', '{}', ?, '[]', 'ban_to_one', 'window', 'live', 'x', 'x')`,
      ).run(ev, cup).lastInsertRowid);
      const row = { event_id: ev, stage_id: stage, round: 1, slot: 1, status: 'waiting', scheduled_at: scheduledAt, created_at: 'x', ...over };
      const cols = Object.keys(row);
      return Number(db.prepare(`INSERT INTO event_matches (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row)).lastInsertRowid);
    };
    const matchId = seed('na', new Date(T0).toISOString());
    expect(scheduledMatchSlots(db, 'na', T0 - H, T0 + 3 * H)).toEqual([{ s: T0, e: T0 + EVENT_SLOT_MINUTES * 60_000 }]);
    expect(scheduledMatchSlots(db, 'eu', T0 - H, T0 + 3 * H)).toEqual([]);
    expect(scheduledMatchSlots(db, null, T0 + 2 * H, T0 + 3 * H)).toEqual([]);
    expect(capacityProblem(db, { region: 'na', startMs: T0, endMs: T0 + H })).toBe(T0);
    expect(capacityProblem(db, { region: 'na', startMs: T0 + 2 * H, endMs: T0 + 3 * H })).toBeNull();
    expect(capacityProblem(db, { region: 'na', startMs: T0 - H, endMs: T0 + H })).toBe(T0);
    expect(bookingsDue(db, T0 - 74 * 60_000, 75)).toBe(1);
    expect(bookingsDue(db, T0 - 76 * 60_000, 75)).toBe(0);
    expect(bookingsDue(db, T0 + H, 75)).toBe(1);
    expect(bookingsDue(db, T0 + 2 * H, 75)).toBe(0);
    // Booked: the booking row counts, the match no longer does.
    const bookingId = book(T0, T0 + H);
    db.prepare('UPDATE event_matches SET booking_id = ? WHERE id = ?').run(bookingId, matchId);
    expect(scheduledMatchSlots(db, 'na', T0 - H, T0 + 3 * H)).toEqual([]);
    // The booking (no box yet, both sides confirmed, starting within 75 minutes) is the one count now, not booking plus match.
    expect(bookingsDue(db, T0 - H, 75)).toBe(1);
    expect(bookingsDue(db, T0 - 76 * 60_000, 75)).toBe(0);
    // Finished, or in a rolling stage, or of a stage not live: never counted.
    seed('na', new Date(T0 + 4 * H).toISOString(), { status: 'done' });
    expect(scheduledMatchSlots(db, 'na', T0 + 3 * H, T0 + 6 * H)).toEqual([]);
    const rolling = seed('na', new Date(T0 + 4 * H).toISOString());
    db.prepare("UPDATE event_stages SET scheduling = 'rolling' WHERE id = (SELECT stage_id FROM event_matches WHERE id = ?)").run(rolling);
    expect(scheduledMatchSlots(db, 'na', T0 + 3 * H, T0 + 6 * H)).toEqual([]);
    const notLive = seed('na', new Date(T0 + 4 * H).toISOString());
    db.prepare("UPDATE event_stages SET status = 'finished' WHERE id = (SELECT stage_id FROM event_matches WHERE id = ?)").run(notLive);
    expect(scheduledMatchSlots(db, 'na', T0 + 3 * H, T0 + 6 * H)).toEqual([]);
  });

  it('counts only unresolved, non-bye matches pending, waiting or in a room phase before the booking (ledger CARRY to Task 5)', () => {
    servers(3);
    let n = 0;
    const seed = (status: string, over: Record<string, unknown> = {}) => {
      n++;
      const cup = (db.prepare("SELECT id FROM rulesets WHERE name = 'Standard Cup'").get() as { id: number }).id;
      const ev = Number(db.prepare(
        `INSERT INTO events (slug, name, region, organizer_steamid, entry_kind, status, starts_at, eligibility_json, checkin_json, roster_json, created_at, updated_at)
         VALUES (?, 'Cup', 'na', ?, 'team', 'live', 'x', '{}', '{}', '{}', 'x', 'x')`,
      ).run(`cup-${n}`, A).lastInsertRowid);
      const stage = Number(db.prepare(
        `INSERT INTO event_stages (event_id, ordinal, type, config_json, ruleset_id, campaign_pool_json, veto_type, scheduling, status, created_at, updated_at)
         VALUES (?, 1, 'league', '{}', ?, '[]', 'ban_to_one', 'window', 'live', 'x', 'x')`,
      ).run(ev, cup).lastInsertRowid);
      const row = { event_id: ev, stage_id: stage, round: 1, slot: 1, status, scheduled_at: new Date(T0).toISOString(), created_at: 'x', ...over };
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO event_matches (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
    };
    const count = () => scheduledMatchSlots(db, 'na', T0 - H, T0 + H).length;
    for (const s of ['bye', 'done', 'forfeit', 'connect', 'live', 'confirming', 'admin_hold']) seed(s);
    seed('waiting', { scheduled_at: null });
    seed('pending', { scheduled_at: null });
    expect(count()).toBe(0);
    // A scheduled later-round match whose teams are not known yet still holds its box (fix round 1).
    seed('pending');
    expect(count()).toBe(1);
    for (const s of ['waiting', 'veto', 'lineup', 'booking']) seed(s);
    expect(count()).toBe(5);
    expect(bookingsDue(db, T0 - H, 75)).toBe(5);
  });
});

describe('allowance', () => {
  const now = T0 - 24 * H;
  it('counts open bookings a party is a confirmed side of', () => {
    book(T0, T0 + H, { captain: A });
    book(T0 + 2 * H, T0 + 3 * H, { captain: A, state: 'cancelled' });
    expect(upcomingCount(db, { captain: A })).toBe(1);
    expect(upcomingCount(db, { captain: B })).toBe(1); // B is side b of the first, confirmed
    book(T0 + 4 * H, T0 + 5 * H, { captain: A, bConfirmed: false });
    expect(upcomingCount(db, { captain: B })).toBe(1);  // an unconfirmed invite is not B's yet
  });

  it('a team party counts by team, not by captain', () => {
    db.prepare("INSERT INTO teams (name, name_key, tag, tag_key, slug, captain_steamid, created_by) VALUES ('R', 'r', 'RR', 'RR', 'r', ?, ?)").run(A, A);
    book(T0, T0 + H, { captain: A, teamId: 1 });
    expect(upcomingCount(db, { teamId: 1 })).toBe(1);
    expect(upcomingCount(db, { captain: A })).toBe(0);
  });

  it('each no-show in the last 30 days lowers the allowance by one, never below 1', () => {
    expect(allowance(db, { captain: A }, now)).toBe(4);
    for (let i = 0; i < 5; i++) {
      const id = book(T0 - (i + 1) * 24 * H, T0 - (i + 1) * 24 * H + H, { captain: A, state: 'no_show' });
      db.prepare("UPDATE booking_sides SET no_show_at = ? WHERE booking_id = ? AND side = 'a'").run(new Date(now - i * 24 * H).toISOString(), id);
    }
    expect(recentNoShows(db, { captain: A }, now)).toBe(5);
    expect(allowance(db, { captain: A }, now)).toBe(1);
    expect(recentNoShows(db, { captain: A }, now + 31 * 24 * H)).toBe(0);
  });
});

describe('campaign timing', () => {
  const match = (campaign: string, minutes: number) => {
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign, kind, went_live_at, ended_at)
       VALUES ((SELECT id FROM seasons LIMIT 1), 'completed', ?, 'pug', '2026-09-01 20:00:00', datetime('2026-09-01 20:00:00', ?))`,
    ).run(campaign, `+${minutes} minutes`);
  };
  it('is the median of recent completed PUGs, or the default with fewer than 3', () => {
    match('no_mercy', 50);
    match('no_mercy', 70);
    expect(typicalCampaignMinutes(db, 'no_mercy')).toBe(DEFAULT_CAMPAIGN_MINUTES);
    match('no_mercy', 80);
    expect(typicalCampaignMinutes(db, 'no_mercy')).toBe(70);
    match('no_mercy', 5); // a crash or abort shape, ignored
    expect(typicalCampaignMinutes(db, 'no_mercy')).toBe(70);
    expect(playlistMinutes(db, ['no_mercy', 'death_toll'])).toBe(70 + DEFAULT_CAMPAIGN_MINUTES);
  });

  it('estimates a booking as 15 plus each campaign and 10, rounded up to the 30 minute step', () => {
    // 15 + (60 + 10) = 85, up to 90.
    expect(estimateMinutes(db, ['death_toll'])).toBe(90);
    // 15 + 70 + 70 = 155, up to 180.
    expect(estimateMinutes(db, ['death_toll', 'dead_air'])).toBe(180);
    // 15 + 70 * 3 = 225, up to 240: above the default maximum, which the caller refuses.
    expect(estimateMinutes(db, ['death_toll', 'dead_air', 'crash_course'])).toBe(240);
    match('no_mercy', 50);
    match('no_mercy', 50);
    match('no_mercy', 50);
    // 15 + (50 + 10) = 75, up to 90; an exact step stays as it is.
    expect(estimateMinutes(db, ['no_mercy'])).toBe(90);
    match('no_mercy', 65);
    match('no_mercy', 65);
    match('no_mercy', 65);
    match('no_mercy', 65); // median 65: 15 + 75 = 90 exactly
    expect(estimateMinutes(db, ['no_mercy'])).toBe(90);
  });

  it('raises the estimate to the shortest booking', () => {
    expect(estimateMinutes(db, [])).toBe(60);
    db.prepare("UPDATE settings SET value = '120' WHERE key = 'booking_min_minutes'").run();
    expect(estimateMinutes(db, ['death_toll'])).toBe(120);
  });

  it('one more campaign adds its typical length and 10, rounded up to the step, 60 when none is named', () => {
    expect(addCampaignMinutes(db, null)).toBe(90);
    for (const m of [40, 40, 40]) match('no_mercy', m);
    expect(addCampaignMinutes(db, 'no_mercy')).toBe(60);
  });
});

describe('bookings due', () => {
  it('counts confirmed bookings with no box starting within the window', () => {
    book(T0, T0 + H);
    book(T0 + 30 * 60_000, T0 + H, { bConfirmed: false });
    book(T0, T0 + H, { serverId: null, state: 'cancelled' });
    expect(bookingsDue(db, T0 - 80 * 60_000, 75)).toBe(0);
    expect(bookingsDue(db, T0 - 70 * 60_000, 75)).toBe(1);
    expect(bookingsDue(db, T0 + 10 * 60_000, 75)).toBe(1); // late and still waiting
  });

  it('a booking whose time is over keeps no box back', () => {
    book(T0, T0 + H, { serverId: null });
    expect(bookingsDue(db, T0 + H - 60_000, 75)).toBe(1);
    expect(bookingsDue(db, T0 + H, 75)).toBe(0);
  });

  it('reads the limits from settings', () => {
    expect(bookingLimits(db)).toEqual({
      minMinutes: 60, daysAhead: 14, playlistMax: 4, maxUpcoming: 4, reserve: 2,
      holdLeadMinutes: 15, protectMinutes: 75, idleEndMinutes: 10,
      goneMinutes: 3, recoverWaitMinutes: 20,
    });
  });
});
