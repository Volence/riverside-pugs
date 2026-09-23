import type { DB } from '../db.js';
import { loadRoundInput } from './loadRound.js';
import { loadRoundReplay } from './replayRound.js';
import { computeRound, ENGINE } from './registry.js';
import { writeRoundMetrics } from './store.js';
import type { RoundKey, RoundReplay } from './types.js';

export const REAPER_ROUNDS_PER_TICK = 2;
export const REPLAY_WAIT_MIN = 30;

const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Rounds whose metrics are missing, stale (engine changed) or waiting on a
 *  replay that has since arrived. A round with no replay row yet is only
 *  picked once its match is more than `replayWaitMin` minutes old, since a
 *  remote server's files arrive by a pull that can lag a few minutes.
 *
 *  A round marked failed (its stored engine is `opts.engine + '!failed'`) is
 *  not picked again on the same engine, only once the engine changes, so a
 *  round that always throws does not spin the reaper forever. A round whose
 *  replay has already been seen once (`replay_seen`) is not re-picked by the
 *  replay-arrived branch just because decoding it keeps failing. */
export function pendingRounds(db: DB, opts: { engine: string; replayWaitMin: number; limit: number; now?: string }): RoundKey[] {
  const now = opts.now ?? sqliteNow();
  return (db.prepare(`
    SELECT r.match_id AS matchId, r.ordinal AS ordinal, r.half AS half
    FROM match_rounds r
    JOIN matches m ON m.id = r.match_id
    LEFT JOIN round_metric_context c ON c.match_id = r.match_id AND c.ordinal = r.ordinal AND c.half = r.half
    LEFT JOIN match_replays rp ON rp.match_id = r.match_id AND rp.ordinal = r.ordinal AND rp.half = r.half AND rp.pruned_at IS NULL
    WHERE m.state = 'completed' AND m.voided_at IS NULL AND r.ended_at IS NOT NULL
      AND (
        c.match_id IS NULL
        OR (c.engine != ? AND c.engine != (? || '!failed'))
        OR (c.has_replay = 0 AND c.replay_seen = 0 AND rp.match_id IS NOT NULL)
      )
      AND (rp.match_id IS NOT NULL OR m.ended_at <= datetime(?, '-' || ? || ' minutes'))
    ORDER BY m.ended_at, r.match_id, r.ordinal, r.half
    LIMIT ?`).all(opts.engine, opts.engine, now, opts.replayWaitMin, opts.limit) as RoundKey[]);
}

function hasUnprunedReplay(db: DB, key: RoundKey): boolean {
  return db.prepare(`SELECT 1 FROM match_replays WHERE match_id = ? AND ordinal = ? AND half = ? AND pruned_at IS NULL`)
    .get(key.matchId, key.ordinal, key.half) !== undefined;
}

/** Compute and store metrics for a batch of pending rounds. A round that
 *  throws, or whose input cannot be loaded, is recorded as failed (empty
 *  rows, engine tagged `!failed`) so it is not retried every tick; the pass
 *  itself never throws. */
export function runMetricsPass(db: DB, replayDir: string, opts: {
  limit: number; replayWaitMin?: number; now?: string; load?: (key: RoundKey) => RoundReplay | null;
}): { computed: number; failed: number } {
  const load = opts.load ?? ((key: RoundKey) => loadRoundReplay(db, key, replayDir));
  const keys = pendingRounds(db, { engine: ENGINE, replayWaitMin: opts.replayWaitMin ?? REPLAY_WAIT_MIN, limit: opts.limit, now: opts.now });
  let computed = 0;
  let failed = 0;
  for (const key of keys) {
    const replaySeen = hasUnprunedReplay(db, key);
    try {
      const base = loadRoundInput(db, key);
      if (!base) throw new Error('round input missing');
      const replay = load(key);
      const rows = computeRound({ ...base, replay });
      writeRoundMetrics(db, key, rows, { hasReplay: replay !== null, hasStats: base.hasStats, replaySeen, engine: ENGINE, now: opts.now });
      computed++;
    } catch (err) {
      try {
        writeRoundMetrics(db, key, [], { hasReplay: false, hasStats: false, replaySeen, engine: ENGINE + '!failed', now: opts.now });
      } catch { /* best effort; the round stays pending and is tried again next tick */ }
      console.error(`[metrics] round ${key.matchId}/${key.ordinal}/${key.half} failed`, err);
      failed++;
    }
  }
  return { computed, failed };
}

/** True while a match could be using the event loop for live ingestion. */
export function matchActive(db: DB): boolean {
  return (db.prepare("SELECT COUNT(*) AS n FROM matches WHERE state IN ('live', 'configuring')").get() as { n: number }).n > 0;
}
