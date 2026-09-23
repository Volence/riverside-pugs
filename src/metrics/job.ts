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
 *  remote server's files arrive by a pull that can lag a few minutes. */
export function pendingRounds(db: DB, opts: { engine: string; replayWaitMin: number; limit: number; now?: string }): RoundKey[] {
  const now = opts.now ?? sqliteNow();
  return (db.prepare(`
    SELECT r.match_id AS matchId, r.ordinal AS ordinal, r.half AS half
    FROM match_rounds r
    JOIN matches m ON m.id = r.match_id
    LEFT JOIN round_metric_context c ON c.match_id = r.match_id AND c.ordinal = r.ordinal AND c.half = r.half
    LEFT JOIN match_replays rp ON rp.match_id = r.match_id AND rp.ordinal = r.ordinal AND rp.half = r.half AND rp.pruned_at IS NULL
    WHERE m.state = 'completed' AND m.voided_at IS NULL AND r.ended_at IS NOT NULL
      AND (c.match_id IS NULL OR c.engine != ? OR (c.has_replay = 0 AND rp.match_id IS NOT NULL))
      AND (rp.match_id IS NOT NULL OR m.ended_at <= datetime(?, '-' || ? || ' minutes'))
    ORDER BY m.ended_at, r.match_id, r.ordinal, r.half
    LIMIT ?`).all(opts.engine, now, opts.replayWaitMin, opts.limit) as RoundKey[]);
}

/** Compute and store metrics for a batch of pending rounds. */
export function runMetricsPass(db: DB, replayDir: string, opts: {
  limit: number; replayWaitMin?: number; now?: string; load?: (key: RoundKey) => RoundReplay | null;
}): { computed: number } {
  const load = opts.load ?? ((key: RoundKey) => loadRoundReplay(db, key, replayDir));
  const keys = pendingRounds(db, { engine: ENGINE, replayWaitMin: opts.replayWaitMin ?? REPLAY_WAIT_MIN, limit: opts.limit, now: opts.now });
  let computed = 0;
  for (const key of keys) {
    const base = loadRoundInput(db, key);
    if (!base) continue;
    const replay = load(key);
    const rows = computeRound({ ...base, replay });
    writeRoundMetrics(db, key, rows, { hasReplay: replay !== null, hasStats: base.hasStats, engine: ENGINE, now: opts.now });
    computed++;
  }
  return { computed };
}

/** True while a match could be using the event loop for live ingestion. */
export function matchActive(db: DB): boolean {
  return (db.prepare("SELECT COUNT(*) AS n FROM matches WHERE state IN ('live', 'configuring')").get() as { n: number }).n > 0;
}
