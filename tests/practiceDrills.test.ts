import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  CODE_ALPHABET, createDrill, drillForMoment, drillsCreatedSince, fetchDrill, momentKey, normalizeCode,
} from '../src/practiceDrills.js';
import type { DrillBody } from '../src/drillSpec.js';
import { upsertPlayer } from '../src/players.js';

const ME = '76561199000000001';

function body(tMs = 1000): DrillBody {
  return {
    version: 1, map: 'l4d_vs_hospital03_sewers', title: 't',
    source: { matchId: 1, ordinal: 0, half: 1, tMs },
    actors: [], entities: [],
  };
}

let db: DB;
let matchId: number;
beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: ME, name: 'me', avatar: null }, []);
  matchId = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'no_mercy')").run().lastInsertRowid);
});

describe('codes', () => {
  it('uses an alphabet with nothing that reads as something else', () => {
    for (const bad of ['0', 'O', '1', 'I', 'L']) expect(CODE_ALPHABET).not.toContain(bad);
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
  });

  it('makes four-character upper-case codes from that alphabet', () => {
    const { spec } = createDrill(db, body(), { matchId, ordinal: 0, half: 1, tMs: 1000 }, ME);
    expect(spec.code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{4}$`));
  });

  it('retries a code that is taken, and goes to five characters when four keep colliding', () => {
    const picks = ['AAAA', 'AAAA', 'BBBB'];
    const pick = (len: number) => (picks.shift() ?? 'C'.repeat(len));
    const a = createDrill(db, body(), { matchId, ordinal: 0, half: 1, tMs: 0 }, ME, pick).spec.code;
    const b = createDrill(db, body(), { matchId, ordinal: 0, half: 1, tMs: 100 }, ME, pick).spec.code;
    expect([a, b]).toEqual(['AAAA', 'BBBB']);
    // Every four-character pick is now taken: the picker keeps answering CCCC.
    createDrill(db, body(), { matchId, ordinal: 0, half: 1, tMs: 200 }, ME, pick);
    const d = createDrill(db, body(), { matchId, ordinal: 0, half: 1, tMs: 300 }, ME, pick).spec.code;
    expect(d).toBe('CCCCC');
  });

  it('normalises a typed code and refuses anything that cannot be one', () => {
    expect(normalizeCode(' k7qx ')).toBe('K7QX');
    expect(normalizeCode('k7qxz')).toBe('K7QXZ');
    expect(normalizeCode('K7Q')).toBeNull();
    expect(normalizeCode('K7QXZZ')).toBeNull();
    expect(normalizeCode('K0QX')).toBeNull();
    expect(normalizeCode("'; DROP")).toBeNull();
  });
});

describe('createDrill and fetchDrill', () => {
  it('stores the spec with its code leading, and fetches it by any case', () => {
    const { spec, reused } = createDrill(db, body(), { matchId, ordinal: 0, half: 1, tMs: 1000 }, ME);
    expect(reused).toBe(false);
    expect(Object.keys(spec)[0]).toBe('code');
    const json = fetchDrill(db, spec.code.toLowerCase());
    expect(JSON.parse(json!)).toEqual(spec);
  });

  it('counts fetches', () => {
    const { spec } = createDrill(db, body(), { matchId, ordinal: 0, half: 1, tMs: 1000 }, ME);
    fetchDrill(db, spec.code, '2026-09-28T03:00:00.000Z');
    fetchDrill(db, spec.code, '2026-09-28T04:00:00.000Z');
    expect(db.prepare('SELECT fetch_count, last_fetched_at FROM practice_drills').get())
      .toEqual({ fetch_count: 2, last_fetched_at: '2026-09-28 04:00:00' });
  });

  it('answers null for an unknown or malformed code', () => {
    expect(fetchDrill(db, 'ZZZZ')).toBeNull();
    expect(fetchDrill(db, '')).toBeNull();
  });

  it('gives the same moment, to the 100 ms, the drill it already has', () => {
    const a = createDrill(db, body(), { matchId, ordinal: 0, half: 1, tMs: 12_310 }, ME);
    const b = createDrill(db, body(), { matchId, ordinal: 0, half: 1, tMs: 12_340 }, null);
    expect(b).toEqual({ spec: a.spec, reused: true });
    expect(drillForMoment(db, { matchId, ordinal: 0, half: 1, tMs: 12_290 })!.code).toBe(a.spec.code);
    expect(createDrill(db, body(), { matchId, ordinal: 0, half: 2, tMs: 12_310 }, ME).reused).toBe(false);
    expect(createDrill(db, body(), { matchId, ordinal: 0, half: 1, tMs: 12_400 }, ME).reused).toBe(false);
    expect(momentKey(12_349)).toBe(12_300);
  });

  it('never dedups hand-made drills that have no match', () => {
    const m = { matchId: null, ordinal: 0, half: 1, tMs: 0 };
    expect(createDrill(db, body(), m, null).spec.code).not.toBe(createDrill(db, body(), m, null).spec.code);
  });

  it('counts a player\'s drills in a window', () => {
    createDrill(db, body(), { matchId, ordinal: 0, half: 1, tMs: 0 }, ME);
    createDrill(db, body(), { matchId, ordinal: 0, half: 1, tMs: 100 }, ME);
    expect(drillsCreatedSince(db, ME, new Date(Date.now() - 60_000).toISOString())).toBe(2);
    expect(drillsCreatedSince(db, ME, new Date(Date.now() + 60_000).toISOString())).toBe(0);
  });
});
