// tests/integrityStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  ANALYZER_VERSION, saveRound, poolRounds, loadPrior, loadRoundPrior, setReview,
} from '../src/integrity/store.js';
import type { RoundMetrics } from '../src/integrity/round.js';

let db: DB;
const KEY = { matchId: 1, ordinal: 1, half: 1 };
const M: RoundMetrics = {
  fidMax: 0.9, fidP95: 0.5, occ: { observed: 4, expected: 2, expectedSq: 0.2, blocks: 40, pairs: 300 }, eligiblePairs: 300,
  gates: { considered: 900, notLive: 100, notGhost: 200, inGrace: 100, tooClose: 100, occluded: 100, passed: 300 },
};
const clip = { startMs: 1000, endMs: 3000, ghostSlot: 4, fidelity: 0.9, travel: 20, meanErr: 2, meanDist: 900 };

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

/**
 * The pool for a map IS the sum of its rounds' shares at the current analyzer
 * version, and `poolRounds` is the only writer of either, in one transaction.
 * That invariant is what makes leave-one-round-out safe: a share that can be
 * loaded is a share the pool contains.
 */
describe('priors', () => {
  const MAP = 'l4d_vs_farm01_hilltop';
  const share = (n: number, cell = '1,2') => ({ frames: n, counts: new Map([[cell, n]]) });

  it('stores each round\'s share and pools the map as their sum', () => {
    poolRounds(db, [
      { key: KEY, map: MAP, prior: share(40) },
      { key: { ...KEY, half: 2 }, map: MAP, prior: share(60, '3,4') },
    ]);
    const got = loadPrior(db, MAP)!;
    expect(got.rounds).toBe(2);
    expect(got.table.frames).toBe(100);
    expect(got.table.counts.get('1,2')).toBe(40);
    expect(got.table.counts.get('3,4')).toBe(60);
    expect(loadRoundPrior(db, KEY)!.counts.get('1,2')).toBe(40);
  });

  it('adds a later round to the pool that is already there', () => {
    poolRounds(db, [{ key: KEY, map: MAP, prior: share(40) }]);
    const grew = poolRounds(db, [{ key: { ...KEY, half: 2 }, map: MAP, prior: share(60) }]);
    expect(grew.get(MAP)).toEqual({ before: 1, after: 2 });
    expect(loadPrior(db, MAP)!.table.frames).toBe(100);
  });

  it('replaces a round pooled twice instead of counting it twice', () => {
    poolRounds(db, [{ key: KEY, map: MAP, prior: share(40) }]);
    poolRounds(db, [{ key: KEY, map: MAP, prior: share(50) }]);
    const got = loadPrior(db, MAP)!;
    expect(got.rounds).toBe(1);
    expect(got.table.frames).toBe(50);
  });

  it('returns null for a map never analysed', () => {
    expect(loadPrior(db, 'nope')).toBeNull();
  });

  // After an ANALYZER_VERSION bump the old pool and the old shares are still in
  // the table. Neither may be used: the pending pass used to subtract a round's
  // share from a pool that had never contained it, and subtractRound clamps
  // that to zero instead of failing.
  it('does not hand back a pool or a share written by another analyzer version', () => {
    poolRounds(db, [{ key: KEY, map: MAP, prior: share(40) }]);
    db.prepare('UPDATE integrity_prior SET analyzer_version = ?').run(ANALYZER_VERSION - 1);
    db.prepare('UPDATE integrity_prior_rounds SET analyzer_version = ?').run(ANALYZER_VERSION - 1);
    expect(loadPrior(db, MAP)).toBeNull();
    expect(loadRoundPrior(db, KEY)).toBeNull();
  });

  it('pools only the shares of the current version', () => {
    poolRounds(db, [{ key: KEY, map: MAP, prior: share(40) }]);
    db.prepare('UPDATE integrity_prior_rounds SET analyzer_version = ?').run(ANALYZER_VERSION - 1);
    poolRounds(db, [{ key: { ...KEY, half: 2 }, map: MAP, prior: share(60) }]);
    const got = loadPrior(db, MAP)!;
    expect(got.rounds).toBe(1);
    expect(got.table.frames).toBe(60);
  });
});
