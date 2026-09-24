import type { DB } from '../db.js';
import { HEADER_BYTES } from '../replayFormat.js';
import { resolveReplayPath } from '../replays.js';
import { infectedMaskForHeader } from '../replaySides.js';
import { loadRoundInput } from './loadRound.js';
import { computeRound, ENGINE } from './registry.js';
import { decodeRoundReplay } from './replayRound.js';
import { writeRoundMetrics } from './store.js';
import type { RoundKey } from './types.js';

export interface R2Round extends RoundKey { r2Key: string }

/** Counted rounds (finished, completed and unvoided match) whose replay now
 *  lives only in R2 and whose stored metrics lack it or are out of date:
 *  never computed, computed without the replay, or on an older or frozen
 *  engine. The metrics job only reads local files, and the prune removes a
 *  local copy once R2 holds it, so these rounds cannot get replay metrics any
 *  other way. A round whose file is still on disk is left to the job. */
export function roundsToRecomputeFromR2(db: DB, replayDir: string): R2Round[] {
  const rows = db.prepare(`
    SELECT r.match_id AS matchId, r.ordinal AS ordinal, r.half AS half, rp.r2_key AS r2Key
    FROM match_rounds r
    JOIN matches m ON m.id = r.match_id
    JOIN match_replays rp ON rp.match_id = r.match_id AND rp.ordinal = r.ordinal AND rp.half = r.half
    LEFT JOIN round_metric_context c ON c.match_id = r.match_id AND c.ordinal = r.ordinal AND c.half = r.half
    WHERE m.state = 'completed' AND m.voided_at IS NULL AND r.ended_at IS NOT NULL
      AND rp.r2_key IS NOT NULL
      AND (c.match_id IS NULL OR c.has_replay = 0 OR c.engine != ?)
    ORDER BY m.ended_at, r.match_id, r.ordinal, r.half`).all(ENGINE) as R2Round[];
  return rows.filter((k) => resolveReplayPath(db, k.matchId, k.ordinal, k.half, replayDir) === null);
}

export interface R2RecomputeResult {
  recomputed: number;
  /** R2 answered 404. */
  missing: number;
  /** The copy came back but does not decode to a usable replay. */
  undecodable: number;
  /** The fetch or the computation threw. */
  failed: number;
}

/** Fetch each round's replay from R2 and store its metrics on the current
 *  engine, exactly as the job would with the file on disk. A round whose copy
 *  is missing or unreadable keeps what it has. Dry run unless `apply`: the
 *  metrics are computed and counted but nothing is written. */
export async function recomputeFromR2(db: DB, replayDir: string, opts: {
  apply: boolean; fetch: (r2Key: string) => Promise<Buffer | null>; limit?: number; now?: string;
  onRound?: (done: number, total: number) => void;
}): Promise<R2RecomputeResult> {
  const res: R2RecomputeResult = { recomputed: 0, missing: 0, undecodable: 0, failed: 0 };
  const rounds = roundsToRecomputeFromR2(db, replayDir).slice(0, opts.limit ?? Infinity);
  let done = 0;
  for (const k of rounds) {
    try {
      const buf = await opts.fetch(k.r2Key);
      if (!buf) { res.missing++; continue; }
      const replay = decodeRoundReplay(buf,
        () => infectedMaskForHeader(db, buf.subarray(0, HEADER_BYTES), k.matchId, k.ordinal, k.half));
      if (!replay) { res.undecodable++; continue; }
      const base = loadRoundInput(db, k);
      if (!base) throw new Error('round input missing');
      const rows = computeRound({ ...base, replay });
      if (opts.apply) {
        writeRoundMetrics(db, k, rows, { hasReplay: true, hasStats: base.hasStats, replaySeen: true, engine: ENGINE, now: opts.now });
      }
      res.recomputed++;
    } catch (err) {
      console.error(`[metrics] R2 recompute of round ${k.matchId}/${k.ordinal}/${k.half} failed`, err);
      res.failed++;
    } finally {
      opts.onRound?.(++done, rounds.length);
    }
  }
  return res;
}
