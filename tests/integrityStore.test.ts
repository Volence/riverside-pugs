// tests/integrityStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  ANALYZER_VERSION, saveRound, savePrior, loadPrior, saveRoundPrior, loadRoundPrior, setReview,
} from '../src/integrity/store.js';
import type { RoundMetrics } from '../src/integrity/ghostTrack.js';

let db: DB;
const KEY = { matchId: 1, ordinal: 1, half: 1 };
const M: RoundMetrics = { fidMax: 0.9, fidP95: 0.5, occZ: 2.5, teamRank: 1, teamGap: 1.2, eligiblePairs: 300 };
const clip = { startMs: 1000, endMs: 3000, ghostSlot: 4, fidelity: 0.9, meanErr: 2, meanDist: 900 };

beforeEach(() => {
  db = openDb(':memory:');
  // Foreign keys are ON, so insert a match to satisfy integrity_rounds/clips/reviews constraints
  db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'no_mercy')").run();
});

describe('saveRound', () => {
  it('stores metrics and clips for a slot', () => {
    saveRound(db, KEY, [{ slot: 0, steamid: '765', metrics: M, clips: [clip] }]);
    const r = db.prepare('SELECT * FROM integrity_rounds').get() as { metrics: string; analyzer_version: number };
    expect(JSON.parse(r.metrics).fidMax).toBeCloseTo(0.9);
    expect(r.analyzer_version).toBe(ANALYZER_VERSION);
    expect(db.prepare('SELECT COUNT(*) c FROM integrity_clips').get()).toEqual({ c: 1 });
  });

  it('replaces a previous analysis rather than accumulating duplicates', () => {
    saveRound(db, KEY, [{ slot: 0, steamid: '765', metrics: M, clips: [clip, { ...clip, startMs: 9000, endMs: 11000 }] }]);
    saveRound(db, KEY, [{ slot: 0, steamid: '765', metrics: M, clips: [clip] }]);
    expect(db.prepare('SELECT COUNT(*) c FROM integrity_rounds').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM integrity_clips').get()).toEqual({ c: 1 });
  });

  it('keeps review state across a re-analysis', () => {
    // The whole point of storing measurements rather than verdicts is that
    // thresholds can change. A retune must not wipe what an admin already
    // looked at, which is why review lives on the player-round and not the clip.
    saveRound(db, KEY, [{ slot: 0, steamid: '765', metrics: M, clips: [clip] }]);
    setReview(db, KEY, 0, 'dismissed', 'watched it, he heard the spawn', 'admin1');
    saveRound(db, KEY, [{ slot: 0, steamid: '765', metrics: M, clips: [] }]);
    const rev = db.prepare('SELECT state, note FROM integrity_reviews').get();
    expect(rev).toEqual({ state: 'dismissed', note: 'watched it, he heard the spawn' });
  });
});

describe('priors', () => {
  it('round-trips a pooled prior', () => {
    savePrior(db, 'l4d_vs_farm01_hilltop', { frames: 500, counts: new Map([['1,2', 10]]) }, 25);
    const got = loadPrior(db, 'l4d_vs_farm01_hilltop');
    expect(got!.rounds).toBe(25);
    expect(got!.table.frames).toBe(500);
    expect(got!.table.counts.get('1,2')).toBe(10);
  });

  it('returns null for a map never analysed', () => {
    expect(loadPrior(db, 'nope')).toBeNull();
  });

  it('replaces a map prior wholesale rather than merging', () => {
    savePrior(db, 'm', { frames: 500, counts: new Map([['1,2', 10]]) }, 25);
    savePrior(db, 'm', { frames: 100, counts: new Map([['3,4', 1]]) }, 5);
    const got = loadPrior(db, 'm')!;
    expect(got.table.counts.has('1,2')).toBe(false);
    expect(got.table.frames).toBe(100);
  });

  it('round-trips a per-round prior contribution', () => {
    saveRoundPrior(db, KEY, { frames: 40, counts: new Map([['0,0', 40]]) });
    expect(loadRoundPrior(db, KEY)!.counts.get('0,0')).toBe(40);
  });
});
