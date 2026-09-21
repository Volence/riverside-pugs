import type { DB } from '../db.js';
import type { RoundMetrics } from '../integrity/round.js';
import { aggregate, scorePlayers, type ScoredPlayer } from '../integrity/score.js';
import { flagsForPlayer, type IntegrityFlagRow } from '../integrityFlags.js';

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

export interface IntegrityBoardRow extends ScoredPlayer {
  /** The player's name, falling back to the SteamID when we have never seen
   *  one. Every other admin surface resolves names for the same reason: a
   *  17 digit number is not a person an admin can recognise. */
  name: string;
  /** Clips currently in existence for this player. A board with none anywhere
   *  is a ranking over clean data, and the panel has to be able to say so. */
  clips: number;
}

/** The board: one row per player, ranked. Scores are computed here, never read
 *  from a column, so changing a threshold changes the page and nothing else. */
export function integrityBoard(db: DB, seasonId: number | null): IntegrityBoardRow[] {
  const rows = db.prepare(
    `SELECT r.steamid, r.metrics, p.name
     FROM integrity_rounds r
     JOIN matches m ON m.id = r.match_id
     LEFT JOIN players p ON p.steamid = r.steamid
     WHERE (? IS NULL OR m.season_id = ?)`,
  ).all(seasonId, seasonId) as { steamid: string; metrics: string; name: string | null }[];

  const names = new Map(rows.map((r) => [r.steamid, r.name]));
  const clips = new Map((db.prepare(
    `SELECT c.steamid, COUNT(*) AS n
     FROM integrity_clips c JOIN matches m ON m.id = c.match_id
     WHERE (? IS NULL OR m.season_id = ?)
     GROUP BY c.steamid`,
  ).all(seasonId, seasonId) as { steamid: string; n: number }[]).map((r) => [r.steamid, r.n]));

  // Names and clip counts are attached AFTER scoring rather than carried
  // through it, so score.ts stays a pure function of the measurements and
  // cannot start ranking on anything but them.
  return scorePlayers(aggregate(rows.map((r) => ({ steamid: r.steamid, metrics: JSON.parse(r.metrics) as RoundMetrics }))))
    .map((p) => ({ ...p, name: names.get(p.steamid) || p.steamid, clips: clips.get(p.steamid) ?? 0 }));
}

export function integrityPlayer(
  db: DB, steamid: string,
): { rounds: IntegrityRoundRow[]; clips: IntegrityClipRow[]; flags: IntegrityFlagRow[] } {
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

  // A separate list, not folded into clips: a flag has no replay behind it and
  // nothing to watch, so it belongs beside them rather than among them.
  return { rounds, clips, flags: flagsForPlayer(db, steamid) };
}
