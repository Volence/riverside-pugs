import type { DB } from '../db.js';
import { loadRoundInput } from './loadRound.js';
import { loadRoundReplay } from './replayRound.js';
import { computeRound, ENGINE } from './registry.js';
import { writeRoundMetrics } from './store.js';
import type { RoundKey, RoundReplay } from './types.js';

export const REAPER_ROUNDS_PER_TICK = 2;
export const REPLAY_WAIT_MIN = 30;

const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Suffixes on a stored engine that mean "settled on this engine, do not pick
 *  again until the engine changes". */
export const FAILED_SUFFIX = '!failed';
export const FROZEN_SUFFIX = '!frozen';

/** Rounds whose metrics are missing, stale (engine changed) or waiting on a
 *  replay that has since arrived. A round with no replay row yet is only
 *  picked once its match is more than `replayWaitMin` minutes old, since a
 *  remote server's files arrive by a pull that can lag a few minutes.
 *
 *  A round marked failed (its stored engine is `opts.engine + '!failed'`) is
 *  not picked again on the same engine, only once the engine changes, so a
 *  round that always throws does not spin the reaper forever. A round whose
 *  replay has already been seen once (`replay_seen`) is not re-picked by the
 *  replay-arrived branch just because decoding it keeps failing.
 *
 *  A round frozen on this engine (`opts.engine + '!frozen'`, see
 *  runMetricsPass) is likewise settled until the engine changes. */
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
        OR (c.engine != ? AND c.engine != (? || '${FAILED_SUFFIX}') AND c.engine != (? || '${FROZEN_SUFFIX}'))
        OR (c.has_replay = 0 AND c.replay_seen = 0 AND rp.match_id IS NOT NULL)
      )
      AND (rp.match_id IS NOT NULL OR m.ended_at <= datetime(?, '-' || ? || ' minutes'))
    ORDER BY m.ended_at, r.match_id, r.ordinal, r.half
    LIMIT ?`).all(opts.engine, opts.engine, opts.engine, now, opts.replayWaitMin, opts.limit) as RoundKey[]);
}

function hasUnprunedReplay(db: DB, key: RoundKey): boolean {
  return db.prepare(`SELECT 1 FROM match_replays WHERE match_id = ? AND ordinal = ? AND half = ? AND pruned_at IS NULL`)
    .get(key.matchId, key.ordinal, key.half) !== undefined;
}

export interface PassResult {
  computed: number;
  failed: number;
  /** Rounds kept as they were because their replay is gone (see below). */
  frozen: number;
  /** The rounds counted in `failed`, in the order they failed. */
  failedKeys: RoundKey[];
}

/** Mark a round's stored metrics as settled on this engine without touching
 *  its metric rows. */
function freezeRound(db: DB, key: RoundKey, now: string): void {
  db.prepare(`UPDATE round_metric_context SET engine = ?, computed_at = ?
              WHERE match_id = ? AND ordinal = ? AND half = ?`)
    .run(ENGINE + FROZEN_SUFFIX, now, key.matchId, key.ordinal, key.half);
}

/** Compute and store metrics for a batch of pending rounds. A round that
 *  throws, or whose input cannot be loaded, is recorded as failed (empty
 *  rows, engine tagged `!failed`) so it is not retried every tick; the pass
 *  itself never throws.
 *
 *  A round last computed with a replay (`has_replay = 1`) whose replay is no
 *  longer usable (pruned, missing, or unreadable) is not recomputed, since
 *  that would replace its replay metrics with event-only ones for good.
 *  Instead its engine becomes `ENGINE + '!frozen'` and its rows stay as they
 *  are. A later engine bump makes it pending again and it freezes again
 *  under the same rule, unless its replay has come back. */
export function runMetricsPass(db: DB, replayDir: string, opts: {
  limit: number; replayWaitMin?: number; now?: string; load?: (key: RoundKey) => RoundReplay | null;
}): PassResult {
  const load = opts.load ?? ((key: RoundKey) => loadRoundReplay(db, key, replayDir));
  const keys = pendingRounds(db, { engine: ENGINE, replayWaitMin: opts.replayWaitMin ?? REPLAY_WAIT_MIN, limit: opts.limit, now: opts.now });
  const priorOf = db.prepare('SELECT has_replay FROM round_metric_context WHERE match_id = ? AND ordinal = ? AND half = ?');
  const res: PassResult = { computed: 0, failed: 0, frozen: 0, failedKeys: [] };
  const fail = (key: RoundKey, err: unknown) => {
    console.error(`[metrics] round ${key.matchId}/${key.ordinal}/${key.half} failed`, err);
    res.failed++;
    res.failedKeys.push(key);
  };
  for (const key of keys) {
    const replaySeen = hasUnprunedReplay(db, key);
    let replay: RoundReplay | null | undefined;
    const prior = priorOf.get(key.matchId, key.ordinal, key.half) as { has_replay: number } | undefined;
    if (prior?.has_replay === 1) {
      replay = null;
      if (replaySeen) {
        try { replay = load(key); } catch { replay = null; }
      }
      if (replay === null) {
        try {
          freezeRound(db, key, opts.now ?? sqliteNow());
          res.frozen++;
        } catch (err) {
          fail(key, err);
        }
        continue;
      }
    }
    try {
      const base = loadRoundInput(db, key);
      if (!base) throw new Error('round input missing');
      if (replay === undefined) replay = load(key);
      const rows = computeRound({ ...base, replay });
      writeRoundMetrics(db, key, rows, { hasReplay: replay !== null, hasStats: base.hasStats, replaySeen, engine: ENGINE, now: opts.now });
      res.computed++;
    } catch (err) {
      try {
        writeRoundMetrics(db, key, [], { hasReplay: false, hasStats: false, replaySeen, engine: ENGINE + FAILED_SUFFIX, now: opts.now });
      } catch { /* best effort; the round stays pending and is tried again next tick */ }
      fail(key, err);
    }
  }
  return res;
}

const keyStr = (k: RoundKey) => `${k.matchId}/${k.ordinal}/${k.half}`;

export interface DrainResult { computed: number; failed: number; frozen: number; passes: number; stop: 'done' | 'stuck' | 'cap' }

/** Run passes until nothing is pending. Stops early ('stuck') when a pass
 *  made no progress: nothing computed or frozen, and every round it failed had
 *  already failed earlier in this run (a round whose failed marker cannot be
 *  written stays pending and would otherwise be retried forever). Also stops
 *  after `maxPasses` passes ('cap'). */
export function drainPending(db: DB, replayDir: string, opts: {
  limit: number; maxPasses: number; replayWaitMin?: number; now?: string;
  load?: (key: RoundKey) => RoundReplay | null; onPass?: (total: DrainResult) => void;
}): DrainResult {
  const total: DrainResult = { computed: 0, failed: 0, frozen: 0, passes: 0, stop: 'done' };
  const failedBefore = new Set<string>();
  for (;;) {
    if (total.passes >= opts.maxPasses) { total.stop = 'cap'; break; }
    const pass = runMetricsPass(db, replayDir, opts);
    total.passes++;
    total.computed += pass.computed;
    total.failed += pass.failed;
    total.frozen += pass.frozen;
    if (pass.computed + pass.failed + pass.frozen === 0) break;
    const repeatsOnly = pass.failedKeys.every((k) => failedBefore.has(keyStr(k)));
    for (const k of pass.failedKeys) failedBefore.add(keyStr(k));
    opts.onPass?.(total);
    if (pass.computed + pass.frozen === 0 && repeatsOnly) { total.stop = 'stuck'; break; }
  }
  return total;
}

/** True while a match could be using the event loop for live ingestion. */
export function matchActive(db: DB): boolean {
  return (db.prepare("SELECT COUNT(*) AS n FROM matches WHERE state IN ('live', 'configuring')").get() as { n: number }).n > 0;
}
