// tests/matchSides.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { bookedSidesFor } from '../src/matchSides.js';
import { stubOrchestrator } from './helpers.js';
import { seedPlayers, seedMatch } from './weeklyFixtures.js';

let db: DB;
let ids: string[];

const T = '2026-10-23T08:00:00.000Z';

/** A booking with two named sides (a draft entry's snapshot on each). */
function seedBooking(purpose: 'scrim' | 'tournament', captainA: string, captainB: string): number {
  const id = Number(db.prepare(
    `INSERT INTO bookings (purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, playlist_json, created_by, created_at)
     VALUES (?, 'na', ?, ?, 'pw', 'tvpw', 'standard', '{}', '[]', ?, ?)`,
  ).run(purpose, T, T, captainA, T).lastInsertRowid);
  const side = db.prepare('INSERT INTO booking_sides (booking_id, side, captain_steamid, confirmed_at, name, tag) VALUES (?, ?, ?, ?, ?, ?)');
  side.run(id, 'a', captainA, T, 'Bone Breakage', 'BB');
  side.run(id, 'b', captainB, T, 'Poop Packers', null);
  return id;
}

beforeEach(() => {
  db = openDb(':memory:');
  ids = seedPlayers(db, 8);
});

describe('bookedSidesFor', () => {
  it('is null for a PUG', () => {
    const m = seedMatch(db, { endedAt: '2026-10-23 08:44:00', lines: [{ id: ids[0], team: 'a' }] });
    expect(bookedSidesFor(db, m)).toBeNull();
  });

  it("names a scrim game's match teams through booking_side_a, swapped when side b played as team a", () => {
    const b = seedBooking('scrim', ids[0], ids[4]);
    const m = seedMatch(db, { endedAt: '2026-10-23 08:44:00', kind: 'scrim', lines: [{ id: ids[0], team: 'b' }] });
    db.prepare("UPDATE matches SET booking_id = ?, booking_side_a = 'b' WHERE id = ?").run(b, m);
    expect(bookedSidesFor(db, m)).toEqual({
      kind: 'scrim', a: { name: 'Poop Packers', tag: null }, b: { name: 'Bone Breakage', tag: 'BB' }, event: null,
    });
  });

  it('links a tournament game to its event and the event match it was played under', () => {
    const b = seedBooking('tournament', ids[0], ids[4]);
    const m = seedMatch(db, { endedAt: '2026-10-23 08:44:00', kind: 'tournament', lines: [{ id: ids[0], team: 'a' }] });
    db.prepare("UPDATE matches SET booking_id = ?, booking_side_a = 'a' WHERE id = ?").run(b, m);
    const ev = Number(db.prepare(
      `INSERT INTO events (slug, name, organizer_steamid, entry_kind, starts_at, eligibility_json, checkin_json, roster_json, created_at, updated_at)
       VALUES ('cup', 'The Cup', ?, 'draft', ?, '{}', '{}', '{}', ?, ?)`,
    ).run(ids[0], T, T, T).lastInsertRowid);
    const stage = Number(db.prepare(
      `INSERT INTO event_stages (event_id, ordinal, type, config_json, ruleset_id, campaign_pool_json, veto_type, scheduling, created_at, updated_at)
       VALUES (?, 1, 'single_elim', '{}', 1, '[]', 'ban_to_one', 'rolling', ?, ?)`,
    ).run(ev, T, T).lastInsertRowid);
    const em = Number(db.prepare(
      "INSERT INTO event_matches (event_id, stage_id, round, slot, status, booking_id, created_at) VALUES (?, ?, 1, 1, 'done', ?, ?)",
    ).run(ev, stage, b, T).lastInsertRowid);
    db.prepare('INSERT INTO event_games (event_match_id, ordinal, campaign, match_id, created_at) VALUES (?, 1, ?, ?, ?)')
      .run(em, 'blood_harvest', m, T);
    expect(bookedSidesFor(db, m)).toEqual({
      kind: 'tournament', a: { name: 'Bone Breakage', tag: 'BB' }, b: { name: 'Poop Packers', tag: null },
      event: { slug: 'cup', name: 'The Cup', matchId: em },
    });
  });
});

describe('GET /api/matches faces and names', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
  });
  afterEach(async () => { await app.close(); });

  it("lists both rosters, best SI damage first, and no booked names on a PUG", async () => {
    const lines = ids.map((id, i) => ({ id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b', fixed: { si_damage: i * 100 } }));
    const m = seedMatch(db, { endedAt: '2026-10-23 08:44:00', lines });
    const res = await app.inject({ method: 'GET', url: '/api/matches' });
    const row = res.json().matches.find((x: { id: number }) => x.id === m);
    expect(row.players.a.map((p: { steamid: string }) => p.steamid)).toEqual([ids[3], ids[2], ids[1], ids[0]]);
    expect(row.players.b).toHaveLength(4);
    expect(row.booked).toBeUndefined();
    expect(row.bookingId).toBeUndefined();
  });
});
