import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { lookStats, mapLooksFor, matchOnServer, recordLook } from '../src/mapLooks.js';

const server = (db: DB, name: string): number => Number(db.prepare(
  "INSERT INTO servers (name, host, port, rcon_port, rcon_password, tv_port, tv_enabled) VALUES (?, '1.2.3.4', 27015, 27015, 'x', 27020, 1)",
).run(name).lastInsertRowid);
const match = (db: DB, serverId: number, state: string, campaign = 'death_toll', createdAt = '2026-10-05 03:40:00'): number => Number(db.prepare(
  'INSERT INTO matches (season_id, state, campaign, server_id, created_at) VALUES (1, ?, ?, ?, ?)',
).run(state, campaign, serverId, createdAt).lastInsertRowid);
const MIDNIGHT = { kind: 'look' as const, title: 'Midnight', preset: 'midnight', layers: { time: 'midnight', weather: 'clear', moon: 'pale', event: 'none', power: 'on' } };
const STORM = { kind: 'look' as const, title: 'Storm', preset: 'storm', layers: { time: 'night', weather: 'storm', moon: 'none', event: 'none', power: 'on' } };
const DEFAULT = { kind: 'look' as const, title: 'Default', preset: 'default', layers: null };
const T0 = Date.UTC(2026, 9, 5, 3, 41, 30);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const round = (db: DB, m: number, ordinal: number, half: number, startedMs: number | null, score: number, alive: number | null, endedMs?: number) =>
  db.prepare(
    "INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, reliable, started_at, ended_at, survivors_alive) VALUES (?, ?, ?, 'a', ?, 1, ?, ?, ?)",
  ).run(m, ordinal, half, score, startedMs === null ? null : iso(startedMs), endedMs === undefined ? null : iso(endedMs), alive);

let db: DB;
let s1: number;
beforeEach(() => {
  db = openDb(':memory:');
  s1 = server(db, 'Dallas');
});

describe('recordLook', () => {
  it('attributes a look to the match being set up or played on that server, else to no match', () => {
    recordLook(db, s1, DEFAULT, T0);
    const m = match(db, s1, 'configuring');
    recordLook(db, s1, MIDNIGHT, T0 + 1000);
    db.prepare("UPDATE matches SET state = 'live' WHERE id = ?").run(m);
    recordLook(db, s1, MIDNIGHT, T0 + 2000);
    db.prepare("UPDATE matches SET state = 'completed' WHERE id = ?").run(m);
    recordLook(db, s1, STORM, T0 + 3000);
    expect(matchOnServer(db, s1)).toBeNull();
    const rows = db.prepare('SELECT at, title, layers, match_id FROM map_looks ORDER BY id').all() as any[];
    expect(rows).toEqual([
      { at: T0, title: 'Default', layers: null, match_id: null },
      { at: T0 + 1000, title: 'Midnight', layers: JSON.stringify(MIDNIGHT.layers), match_id: m },
      { at: T0 + 2000, title: 'Midnight', layers: JSON.stringify(MIDNIGHT.layers), match_id: m },
      { at: T0 + 3000, title: 'Storm', layers: JSON.stringify(STORM.layers), match_id: null },
    ]);
  });

  it('ignores another server\'s match', () => {
    const s2 = server(db, 'Riverside #3');
    match(db, s2, 'live');
    recordLook(db, s1, MIDNIGHT, T0);
    expect((db.prepare('SELECT match_id FROM map_looks').get() as any).match_id).toBeNull();
  });
});

describe('mapLooksFor', () => {
  it('pairs each round with the last look logged before it went live, so setup\'s double roll resolves to what players saw', () => {
    const m = match(db, s1, 'live');
    // Map 1 loads (Storm), setup reloads it (Midnight), ready-up, round 1 goes
    // live; half 2 logs its look again; map 2 rolls Storm.
    recordLook(db, s1, STORM, T0);
    recordLook(db, s1, MIDNIGHT, T0 + 7_000);
    round(db, m, 0, 1, T0 + 300_000, 804, 4);
    recordLook(db, s1, MIDNIGHT, T0 + 620_000);
    round(db, m, 0, 2, T0 + 700_000, 540, 4);
    recordLook(db, s1, STORM, T0 + 1_100_000);
    round(db, m, 1, 1, T0 + 1_200_000, 23, 0);
    recordLook(db, s1, STORM, T0 + 1_400_000);
    round(db, m, 1, 2, T0 + 1_500_000, 71, 0);
    expect([...mapLooksFor(db, m)]).toEqual([[0, 'Midnight'], [1, 'Storm']]);
  });

  it('names both looks when a map\'s halves differ, and skips rounds with no look before them', () => {
    const m = match(db, s1, 'live');
    round(db, m, 0, 1, T0, 100, 1);
    recordLook(db, s1, MIDNIGHT, T0 + 10_000);
    round(db, m, 0, 2, T0 + 20_000, 100, 1);
    recordLook(db, s1, DEFAULT, T0 + 30_000);
    round(db, m, 1, 1, T0 + 40_000, 100, 1);
    recordLook(db, s1, STORM, T0 + 50_000);
    round(db, m, 1, 2, T0 + 60_000, 100, 1);
    expect([...mapLooksFor(db, m)]).toEqual([[0, 'Midnight'], [1, 'Default / Storm']]);
  });

  it('tolerates the look line and the round sharing a second, and a round that only has an end time', () => {
    const m = match(db, s1, 'live');
    recordLook(db, s1, MIDNIGHT, T0 + 4_000);
    round(db, m, 0, 1, T0, 10, 2);           // round clock a touch behind the look
    round(db, m, 0, 2, null, 10, 2, T0 + 60_000); // start datagram lost
    expect([...mapLooksFor(db, m)]).toEqual([[0, 'Midnight']]);
    expect(mapLooksFor(db, 999).size).toBe(0);
  });
});

// Looks are recorded while a match is live; these play a match out and then
// finish it, the way production rows come to be.
const finish = (db: DB, m: number, voided = false) =>
  db.prepare("UPDATE matches SET state = 'completed', voided_at = ? WHERE id = ?").run(voided ? '2026-10-05 04:00:00' : null, m);

describe('lookStats', () => {
  it('groups reliable rounds of completed, unvoided matches by campaign and look', () => {
    const m1 = match(db, s1, 'live', 'death_toll');
    recordLook(db, s1, STORM, T0);
    round(db, m1, 0, 1, T0 + 1000, 200, 0);
    round(db, m1, 0, 2, T0 + 2000, 400, 2);
    finish(db, m1);
    const m2 = match(db, s1, 'live', 'death_toll');
    recordLook(db, s1, DEFAULT, T0 + 10_000);
    round(db, m2, 0, 1, T0 + 11_000, 600, 4);
    round(db, m2, 0, 2, T0 + 12_000, 800, null);
    // An unreliable round, a voided match, an old match and a live one are left out.
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, reliable, started_at) VALUES (?, 1, 1, 'a', 9999, 0, ?)").run(m2, iso(T0 + 13_000));
    finish(db, m2);
    const voided = match(db, s1, 'live', 'death_toll');
    recordLook(db, s1, DEFAULT, T0 + 20_000);
    round(db, voided, 0, 1, T0 + 21_000, 5, 0);
    finish(db, voided, true);
    const old = match(db, s1, 'live', 'no_mercy', '2026-09-01 00:00:00');
    recordLook(db, s1, STORM, T0 + 30_000);
    round(db, old, 0, 1, T0 + 31_000, 5, 0);
    finish(db, old);
    const live = match(db, s1, 'live', 'death_toll');
    recordLook(db, s1, STORM, T0 + 40_000);
    round(db, live, 0, 1, T0 + 41_000, 5, 0);

    expect(lookStats(db, '2026-10-01 00:00:00')).toEqual([
      { campaign: 'death_toll', title: 'Default', matches: 1, rounds: 2, avgScore: 700, finishRate: 1, avgAlive: 4 },
      { campaign: 'death_toll', title: 'Storm', matches: 1, rounds: 2, avgScore: 300, finishRate: 0.5, avgAlive: 1 },
    ]);
  });

  it('reports null survival figures when no round under a look recorded survivors alive', () => {
    const m = match(db, s1, 'live');
    recordLook(db, s1, MIDNIGHT, T0);
    round(db, m, 0, 1, T0 + 1000, 100, null);
    finish(db, m);
    expect(lookStats(db, '2026-10-01 00:00:00')).toEqual([
      { campaign: 'death_toll', title: 'Midnight', matches: 1, rounds: 1, avgScore: 100, finishRate: null, avgAlive: null },
    ]);
  });
});
