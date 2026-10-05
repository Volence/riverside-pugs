import type { DB } from './db.js';
import type { LogEvent } from './logParse.js';
import { completedPug } from './matchKinds.js';

/**
 * Which look (time of day, weather, moon, event, power) l4d_nightmode had on
 * a map while a round was played, so a match page can name it and survival
 * can be compared by look (owner ask 2026-10-04, the night the L4D1 rotation
 * went live and players argued about the storm).
 *
 * The plugin logs "[nightmode] look ..." on every round_start game event: at
 * map load, again when the map is reloaded by setup, and once more when the
 * second half starts. The line names neither map nor round, so a round is
 * paired with the LATEST look logged before it went live (pug-match's
 * ROUND_START, which comes after ready-up). Setup's double roll on map 1
 * therefore resolves to the roll players actually saw.
 */

export type LookEvent = Extract<LogEvent, { kind: 'look' }>;

/** The match this server is setting up or playing. Map 1 loads, and its look
 *  rolls, while the match is still 'configuring'. */
export function matchOnServer(db: DB, serverId: number): number | null {
  const row = db.prepare(
    "SELECT id FROM matches WHERE server_id = ? AND state IN ('configuring', 'live') ORDER BY id DESC LIMIT 1",
  ).get(serverId) as { id: number } | undefined;
  return row?.id ?? null;
}

export function recordLook(db: DB, serverId: number, ev: LookEvent, now = Date.now()): void {
  db.prepare(
    'INSERT INTO map_looks (server_id, at, title, preset, layers, match_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(serverId, now, ev.title, ev.preset, ev.layers ? JSON.stringify(ev.layers) : null, matchOnServer(db, serverId));
}

/** A round's look: the last look line before it went live. Five seconds of
 *  slack because the look line and ROUND_START can share a second and the
 *  round row's clock is the backend's, not the server's. A round that only
 *  ever got an end row (its start datagram lost) falls back to its end. */
const ROUND_LOOK = `
  SELECT r.ordinal, r.half,
         (SELECT l.title FROM map_looks l
           WHERE l.match_id = r.match_id
             AND l.at <= strftime('%s', COALESCE(r.started_at, r.ended_at)) * 1000 + 5000
           ORDER BY l.at DESC LIMIT 1) AS title
  FROM match_rounds r
  WHERE r.match_id = ? AND COALESCE(r.started_at, r.ended_at) IS NOT NULL
  ORDER BY r.ordinal, r.half`;

/** The look of each map of a match, by ordinal: the halves' looks, joined
 *  with " / " on the rare map whose two halves differ. Maps whose rounds
 *  have no look line (played before the plugin logged one) are absent. */
export function mapLooksFor(db: DB, matchId: number): Map<number, string> {
  const out = new Map<number, string>();
  const rows = db.prepare(ROUND_LOOK).all(matchId) as { ordinal: number; half: number; title: string | null }[];
  for (const r of rows) {
    if (r.title === null) continue;
    const have = out.get(r.ordinal);
    if (have === undefined) out.set(r.ordinal, r.title);
    else if (!have.split(' / ').includes(r.title)) out.set(r.ordinal, `${have} / ${r.title}`);
  }
  return out;
}

export interface LookStatRow {
  campaign: string;
  title: string;
  matches: number;
  rounds: number;
  /** Mean survivor score of a half under this look. */
  avgScore: number;
  /** Share of halves that ended with at least one survivor in the saferoom,
   *  over the halves where that was recorded; null when none were. */
  finishRate: number | null;
  /** Mean survivors alive at the end of a half, same caveat. */
  avgAlive: number | null;
}

/** Survival by look since `sinceIso`, per campaign and per look, over the
 *  reliable rounds of completed, unvoided PUGs (scrims and tournament games
 *  are left out: different players, different stakes). The comparison that
 *  matters is within a campaign: a look's row against that campaign's
 *  "Default" row. */
export function lookStats(db: DB, sinceIso: string): LookStatRow[] {
  return db.prepare(`
    WITH rl AS (
      SELECT r.match_id, r.score, r.survivors_alive, m.campaign,
             (SELECT l.title FROM map_looks l
               WHERE l.match_id = r.match_id
                 AND l.at <= strftime('%s', COALESCE(r.started_at, r.ended_at)) * 1000 + 5000
               ORDER BY l.at DESC LIMIT 1) AS title
      FROM match_rounds r
      JOIN matches m ON m.id = r.match_id
      WHERE ${completedPug('m')} AND m.voided_at IS NULL AND r.reliable = 1
        AND m.created_at >= ? AND COALESCE(r.started_at, r.ended_at) IS NOT NULL
    )
    SELECT campaign, title,
           COUNT(DISTINCT match_id) AS matches,
           COUNT(*) AS rounds,
           AVG(score) AS avgScore,
           AVG(CASE WHEN survivors_alive IS NULL THEN NULL WHEN survivors_alive > 0 THEN 1.0 ELSE 0.0 END) AS finishRate,
           AVG(survivors_alive) AS avgAlive
    FROM rl
    WHERE title IS NOT NULL
    GROUP BY campaign, title
    ORDER BY campaign, rounds DESC, title`).all(sinceIso) as LookStatRow[];
}
