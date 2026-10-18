import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { holdTotal } from '../src/fingerprint.js';
import { cachedPopulation, fingerprintWorld, memberMatchFingerprints, playerFingerprint } from '../src/fingerprintData.js';
import { addMember, createPerson } from '../src/evaderPeople.js';
import { encodeIntervals } from '../src/inputStats.js';
import { endedMatch, playMatch } from './fingerprintFixtures.js';

const A = '76561198000000001';
const B = '76561198000000002';
const C = '76561198000000003';
const D = '76561198000000004';
const STAFF = '76561198000000009';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [1, 2, 3]) endedMatch(db, id);
});

describe('playerFingerprint', () => {
  it('reads base-class holds only', () => {
    playMatch(db, A, 1, 10, 80);
    db.prepare(
      `INSERT INTO input_bursts (match_id, server_id, steamid, kind, weapon, n, ground_ticks, air_presses, server_tick, client_tick, intervals, at, wire, holds)
       VALUES (1, 1, ?, 'fire', 'weapon_pistol', 1, 0, 0, 1, 1, '7', '2026-10-17T19:00:00.000Z', 2, ?)`,
    ).run(A, encodeIntervals([8, 8]));
    db.prepare(
      `INSERT INTO input_bursts (match_id, server_id, steamid, kind, weapon, n, ground_ticks, air_presses, server_tick, client_tick, intervals, at, wire, holds)
       VALUES (1, 1, ?, 'fire', 'weapon_hunter_claw', 1, 0, 0, 1, 1, '7', '2026-10-17T19:00:00.000Z', 1, NULL)`,
    ).run(A);
    expect(holdTotal(playerFingerprint(db, A))).toBe(160);
  });

  it('splits a member\'s history per match', () => {
    playMatch(db, A, 1, 10, 60);
    playMatch(db, A, 2, 10, 60);
    playMatch(db, B, 2, 12, 60);
    expect(memberMatchFingerprints(db, [A]).map(holdTotal)).toEqual([120, 120]);
    expect(memberMatchFingerprints(db, [A, B])).toHaveLength(3);
    expect(memberMatchFingerprints(db, [])).toEqual([]);
  });
});

describe('fingerprintWorld', () => {
  it('builds every player once, then only who played since', () => {
    for (const [id, peak] of [[A, 10], [B, 14], [C, 6]] as const) playMatch(db, id, 1, peak, 80, '2026-10-17T10:00:00.000Z');
    expect(fingerprintWorld(db, new Date('2026-10-17T11:00:00Z')).rebuilt).toBe(3);
    expect(fingerprintWorld(db, new Date('2026-10-17T11:05:00Z')).rebuilt).toBe(0);
    playMatch(db, B, 2, 14, 80, '2026-10-17T12:00:00.000Z');
    expect(fingerprintWorld(db, new Date('2026-10-17T12:30:00Z')).rebuilt).toBe(1);
  });

  it('puts only players with 150 base holds in the field', () => {
    playMatch(db, A, 1, 10, 80); // 160
    playMatch(db, D, 1, 10, 70); // 140
    const { field } = fingerprintWorld(db, new Date('2026-10-17T21:00:00Z'));
    expect(field.map((e) => e.subject)).toEqual([`steam:${A}`]);
  });

  it('pools an open person from their members and rebuilds it when membership changes', () => {
    playMatch(db, A, 1, 10, 80);
    playMatch(db, B, 1, 10, 80);
    const id = createPerson(db, 'dethisa', '', STAFF);
    addMember(db, id, 'steam', A, STAFF, 'manual');
    let w = fingerprintWorld(db, new Date('2026-10-17T21:00:00Z'));
    expect(holdTotal(w.persons[0].pooled)).toBe(160);
    expect(w.field.map((e) => e.subject)).toContain(`person:${id}`);
    addMember(db, id, 'steam', B, STAFF, 'manual');
    w = fingerprintWorld(db, new Date('2026-10-17T21:01:00Z'));
    expect(w.rebuilt).toBe(1);
    expect(holdTotal(w.persons[0].pooled)).toBe(320);
  });

  it('gives a person their own threshold from three member-matches', () => {
    for (const m of [1, 2, 3]) playMatch(db, A, m, 10, 60);
    const id = createPerson(db, 'dethisa', '', STAFF);
    addMember(db, id, 'steam', A, STAFF, 'manual');
    expect(fingerprintWorld(db).persons[0].threshold).toBe(0);
  });

  it('a person with no data is in persons with an empty pool, and the population reads the cache', () => {
    createPerson(db, 'empty', '', STAFF);
    playMatch(db, A, 1, 10, 80);
    const w = fingerprintWorld(db);
    expect(holdTotal(w.persons[0].pooled)).toBe(0);
    expect(holdTotal(cachedPopulation(db))).toBe(160);
  });
});
