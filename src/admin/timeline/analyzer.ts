import type { DB } from '../../db.js';
import { ANALYZER_VERSION } from '../../integrity/store.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row {
  id: number; match_id: number; ordinal: number; half: number;
  start_ms: number; end_ms: number; kind: string; score: number;
  at: string; has_replay: number;
}

/** What each clip kind means, in the words an admin reads. An unknown kind
 *  (an old row, a future analyzer) shows as itself rather than disappearing. */
const CLIP_TEXT: Record<string, string> = {
  ghost_track: 'followed a ghost',
  hidden_track: 'followed a spawned infected nobody on the team could see',
};

/**
 * Clips the replay analyzer flagged.
 *
 * CURRENT ANALYZER VERSION ONLY, as on the board: an old clip is a claim the
 * current analyzer does not make, and a round whose replay was pruned can
 * never be measured again, so its old rows stay in the table and are simply
 * not shown.
 *
 * A clip carries no timestamp of its own, so it is dated by the match it was
 * measured from. The deep link is offered only when a match_replays row
 * exists and has not been pruned: with no file there is nothing to seek to,
 * and a dead link in an evidence list is worse than no link.
 */
export const analyzerAdapter: TimelineAdapter = {
  source: 'analyzer',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT c.id, c.match_id, c.ordinal, c.half, c.start_ms, c.end_ms, c.kind, c.score,
              COALESCE(m.ended_at, m.created_at) AS at,
              (SELECT COUNT(*) FROM match_replays r
                WHERE r.match_id = c.match_id AND r.ordinal = c.ordinal
                  AND r.half = c.half AND r.pruned_at IS NULL) AS has_replay
       FROM integrity_clips c JOIN matches m ON m.id = c.match_id
       WHERE c.steamid IN (${marks(ids)}) AND c.analyzer_version = ?
       ORDER BY at DESC, c.score DESC LIMIT ?`,
    ).all(...ids, ANALYZER_VERSION, ROW_LIMIT) as Row[];
    return rows.map((r) => ({
      at: toIso(r.at),
      source: 'analyzer' as const,
      kind: r.kind,
      summary: `Analyzer clip: ${CLIP_TEXT[r.kind] ?? r.kind}, fidelity ${r.score.toFixed(2)} over `
        + `${((r.end_ms - r.start_ms) / 1000).toFixed(1)} s. Watch it before deciding anything.`,
      matchId: r.match_id,
      replay: r.has_replay > 0 ? { ordinal: r.ordinal, half: r.half, tMs: r.start_ms } : null,
      ref: { type: 'integrity_clip', id: r.id },
    }));
  },
  evidence(db: DB) {
    return (db.prepare(
      `SELECT c.steamid, MAX(COALESCE(m.ended_at, m.created_at)) AS at
       FROM integrity_clips c JOIN matches m ON m.id = c.match_id
       WHERE c.analyzer_version = ? GROUP BY c.steamid`,
    ).all(ANALYZER_VERSION) as { steamid: string; at: string }[])
      .map((r) => ({ steamid: r.steamid, at: toIso(r.at) }));
  },
};
