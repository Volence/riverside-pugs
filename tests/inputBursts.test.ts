import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  DEFAULT_POUNCE_SPAM_THRESHOLD, detectionsForPlayer, isFirstDetectionInMatch,
  recordInputBurst, rerunSignatures,
} from '../src/inputBursts.js';
import { decodeIntervals } from '../src/inputStats.js';

const A = '76561198030413993';
let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

const burst = (over: Partial<Parameters<typeof recordInputBurst>[1]> = {}) => ({
  matchId: 7, serverId: 1, steamid: A, kind: 'pounce' as const, weapon: 'weapon_hunter_claw',
  airPresses: 2, groundTicks: 4, serverTick: 1000, clientTick: 999, intervals: [8, 9, 8],
  ...over,
});

describe('recordInputBurst', () => {
  it('stores the burst and fires nothing for a human pounce', () => {
    const r = recordInputBurst(db, burst());
    expect(r.detections).toEqual([]);
    const row = db.prepare('SELECT * FROM input_bursts WHERE id = ?').get(r.id) as { n: number; intervals: string };
    expect(row.n).toBe(3);
    expect(row.intervals).toHaveLength(3);
  });

  it('fires pounce_spam on a button held through the air', () => {
    const r = recordInputBurst(db, burst({ airPresses: 25 }));
    expect(r.detections).toEqual(['pounce_spam']);
    expect(detectionsForPlayer(db, A)).toHaveLength(1);
  });

  it('does not fire on a fire burst however many presses', () => {
    expect(recordInputBurst(db, burst({ kind: 'fire', airPresses: 99 })).detections).toEqual([]);
  });

  it('does not fire on a survivor who was merely airborne', () => {
    expect(recordInputBurst(db, burst({ weapon: 'weapon_pistol', airPresses: 40 })).detections).toEqual([]);
  });

  it('round trips the intervals through storage', () => {
    const r = recordInputBurst(db, burst({ intervals: [1, 30, 15, 2] }));
    const again = rerunSignatures(db);
    expect(again).toBe(0);                 // same signature, already recorded
    expect(r.id).toBeGreaterThan(0);
  });
});

describe('isFirstDetectionInMatch', () => {
  // A macro fires on every single pounce. Posting per burst would bury the
  // admin feed under one player's round, so only the first in a match posts.
  it('is true once per player per match and false after', () => {
    recordInputBurst(db, burst({ airPresses: 25 }));
    expect(isFirstDetectionInMatch(db, A, 7)).toBe(true);
    recordInputBurst(db, burst({ airPresses: 30 }));
    expect(isFirstDetectionInMatch(db, A, 7)).toBe(false);
  });

  it('is true again in a different match', () => {
    recordInputBurst(db, burst({ airPresses: 25 }));
    recordInputBurst(db, burst({ matchId: 8, airPresses: 25 }));
    expect(isFirstDetectionInMatch(db, A, 8)).toBe(true);
  });
});

describe('storage round trip', () => {
  // This exists because recordInputBurst once carried its own inlined copy of
  // the encoder. When the alphabet changed, storage wrote one base and the
  // decoder read another, every stored burst decoded to nothing, and re-run
  // silently found zero detections. Encode-only and decode-only tests both
  // passed throughout. Assert on what comes back OUT of the database.
  it('decodes every stored burst back to exactly what went in', () => {
    const ticks = [1, 30, 7, 15, 2];
    recordInputBurst(db, burst({ intervals: ticks }));
    const row = db.prepare('SELECT intervals FROM input_bursts ORDER BY id DESC LIMIT 1').get() as { intervals: string };
    expect(decodeIntervals(row.intervals)).toEqual(ticks);
  });
});

describe('rerunSignatures', () => {
  // The whole reason raw ordered intervals are stored: a signature written
  // later applies to everything recorded before it existed.
  it('finds detections a stricter earlier threshold missed', () => {
    recordInputBurst(db, burst({ airPresses: 14 }), 40);   // threshold too high, nothing fires
    expect(detectionsForPlayer(db, A)).toHaveLength(0);
    expect(rerunSignatures(db, DEFAULT_POUNCE_SPAM_THRESHOLD)).toBe(1);
    expect(detectionsForPlayer(db, A)).toHaveLength(1);
  });

  it('is idempotent, so re-running twice does not double count', () => {
    recordInputBurst(db, burst({ airPresses: 25 }));
    rerunSignatures(db);
    rerunSignatures(db);
    expect(detectionsForPlayer(db, A)).toHaveLength(1);
  });
});
