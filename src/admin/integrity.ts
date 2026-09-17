import type { DB } from '../db.js';
import type { RoundMetrics } from '../integrity/round.js';
import { aggregate, scorePlayers, type ScoredPlayer } from '../integrity/score.js';

export interface IntegrityRoundRow {
  matchId: number;
  ordinal: number;
  half: number;
  slot: number;
  campaign: string | null;
  metrics: RoundMetrics;
  computedAt: string;
  reviewState: string;
  reviewNote: string;
}

export interface IntegrityClipRow {
  id: number;
  matchId: number;
  ordinal: number;
  half: number;
  slot: number;
  startMs: number;
  endMs: number;
  kind: string;
  score: number;
  detail: Record<string, unknown>;
}

/** The board: one row per player, ranked. Scores are computed here, never read
 *  from a column, so changing a threshold changes the page and nothing else. */
export function integrityBoard(db: DB, seasonId: number | null): ScoredPlayer[] {
  const rows = db.prepare(
    `SELECT r.steamid, r.metrics
     FROM integrity_rounds r JOIN matches m ON m.id = r.match_id
     WHERE (? IS NULL OR m.season_id = ?)`,
  ).all(seasonId, seasonId) as { steamid: string; metrics: string }[];
  return scorePlayers(aggregate(rows.map((r) => ({ steamid: r.steamid, metrics: JSON.parse(r.metrics) as RoundMetrics }))));
}

export function integrityPlayer(db: DB, steamid: string): { rounds: IntegrityRoundRow[]; clips: IntegrityClipRow[] } {
  const rounds = (db.prepare(
    `SELECT r.match_id, r.ordinal, r.half, r.slot, m.campaign, r.metrics, r.computed_at,
            COALESCE(v.state, 'new') AS state, COALESCE(v.note, '') AS note
     FROM integrity_rounds r
     JOIN matches m ON m.id = r.match_id
     LEFT JOIN integrity_reviews v
       ON v.match_id = r.match_id AND v.ordinal = r.ordinal AND v.half = r.half AND v.slot = r.slot
     WHERE r.steamid = ?
     ORDER BY r.match_id DESC, r.ordinal, r.half`,
  ).all(steamid) as {
    match_id: number; ordinal: number; half: number; slot: number; campaign: string | null;
    metrics: string; computed_at: string; state: string; note: string;
  }[]).map((r) => ({
    matchId: r.match_id, ordinal: r.ordinal, half: r.half, slot: r.slot, campaign: r.campaign,
    metrics: JSON.parse(r.metrics) as RoundMetrics, computedAt: r.computed_at,
    reviewState: r.state, reviewNote: r.note,
  }));

  const clips = (db.prepare(
    `SELECT id, match_id, ordinal, half, slot, start_ms, end_ms, kind, score, detail
     FROM integrity_clips WHERE steamid = ? ORDER BY score DESC`,
  ).all(steamid) as {
    id: number; match_id: number; ordinal: number; half: number; slot: number;
    start_ms: number; end_ms: number; kind: string; score: number; detail: string;
  }[]).map((c) => ({
    id: c.id, matchId: c.match_id, ordinal: c.ordinal, half: c.half, slot: c.slot,
    startMs: c.start_ms, endMs: c.end_ms, kind: c.kind, score: c.score,
    detail: JSON.parse(c.detail) as Record<string, unknown>,
  }));

  return { rounds, clips };
}
