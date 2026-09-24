import { describe, it, expect, beforeEach } from 'vitest';
import { ICY_WHEEL } from './fixtures/wheelSamples.js';
import { openDb, type DB } from '../src/db.js';
import { captureHealth, recentFlagFeed, recordIntegrityFlag } from '../src/integrityFlags.js';
import { recordInputBurst } from '../src/inputBursts.js';
import { DEFAULT_THRESHOLDS, POUNCE_REPEATS } from '../src/inputStats.js';

const A = '76561198030413993';
let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('captureHealth', () => {
  // The whole point: an empty panel must be able to say "capturing, nothing
  // suspicious" rather than looking identical to a broken pipeline.
  it('reports zeroes rather than throwing when nothing has been captured', () => {
    expect(captureHealth(db)).toEqual({
      bursts: 0, detections: 0, lilacFlags: 0,
      lastBurstAt: null, lastFlagAt: null, matchesWithBursts: 0, caps: 0,
    });
  });

  it('counts bursts, matches and the most recent capture', () => {
    recordInputBurst(db, {
      matchId: 4, serverId: 1, steamid: A, kind: 'pounce', weapon: 'weapon_hunter_claw',
      airPresses: 3, groundTicks: 100, serverTick: 1, clientTick: 0, intervals: [18, 20, 19, 21],
    });
    const h = captureHealth(db);
    expect(h.bursts).toBe(1);
    expect(h.matchesWithBursts).toBe(1);
    expect(h.detections).toBe(0);
    expect(h.lastBurstAt).not.toBeNull();
  });
});

describe('recentFlagFeed', () => {
  it('merges LilAC flags and input detections, newest first', () => {
    const t0 = new Date('2026-09-21T12:00:00.000Z');
    recordIntegrityFlag(db, {
      matchId: 1, serverId: 1, steamid: A, source: 'lilac',
      kind: 'aimlock', severity: 'suspected', detail: '',
    }, t0);
    // One detection however many pounces qualify: the feed is a front door,
    // and a macro that fires on every pounce must not bury it.
    for (let i = 0; i < POUNCE_REPEATS + 2; i++) {
      recordInputBurst(db, {
        matchId: 2, serverId: 1, steamid: A, kind: 'pounce', weapon: 'weapon_hunter_claw',
        airPresses: 9, groundTicks: 60, serverTick: 1, clientTick: 0, intervals: [7, 8, 8, 7, 8, 8],
      }, DEFAULT_THRESHOLDS, new Date(t0.getTime() + 60_000 + i));
    }
    const feed = recentFlagFeed(db);
    expect(feed).toHaveLength(2);
    expect(feed[0].source).toBe('inputstats');
    expect(feed[0].kind).toBe('pounce_spam');
    expect(feed[0].severity).toBe('low');
    expect(feed[1].source).toBe('lilac');
  });

  it('leaves out scroll-wheel detections, which are allowed', () => {
    for (let i = 0; i < 2; i++) {
      recordInputBurst(db, {
        matchId: 2, serverId: 1, steamid: A, kind: 'fire', weapon: 'weapon_pistol', airPresses: 0, groundTicks: 0,
        serverTick: 1, clientTick: 0, intervals: ICY_WHEEL,
        holds: Array.from({ length: ICY_WHEEL.length + 1 }, () => 1), wire: 2,
      });
    }
    expect((db.prepare('SELECT note FROM input_detections').get() as { note: string }).note).toBe('wheel-like');
    expect(recentFlagFeed(db)).toEqual([]);
  });

  it('is empty, not broken, when nothing has been flagged', () => {
    expect(recentFlagFeed(db)).toEqual([]);
  });

  it('falls back to the steamid when we have never seen a name', () => {
    recordIntegrityFlag(db, {
      matchId: null, serverId: 1, steamid: A, source: 'lilac',
      kind: 'bhop', severity: 'suspected', detail: '',
    });
    expect(recentFlagFeed(db)[0].name).toBe(A);
  });
});
