import type { DB } from '../db.js';
import type { RoundMetrics } from './round.js';
import { aggregate } from './score.js';
import { TUNING } from './constants.js';
import { ANALYZER_VERSION } from './store.js';
import { recordIntegrityFlag } from '../integrityFlags.js';

/**
 * Newcomer outliers: one match, scored on its own, from a player the board
 * cannot rank yet.
 *
 * The board needs MIN_BOARD_ROUNDS (8) rounds before it ranks anyone, which
 * is right for a ranking and blind to the case that actually happened: the
 * first confirmed cheater (yes / Bella<3, match 631, Aimware, confessed
 * 2026-10-10) was a fresh alt that played ONE match, 4 rounds, and was never
 * on the board. Scored per match, that match had the highest hidden-infected
 * occupancy of all 2,773 player-matches on record.
 *
 * So each match is scored on its own (NEWCOMER_MIN_ROUNDS rounds with line of
 * sight), and a player still under the board's minimum whose match lands in
 * the top NEWCOMER_TOP_SHARE of every per-match score is flagged. Honest
 * players do reach the top of a single match (the second highest on record is
 * a long-standing player), so this is "watch this one", never a verdict, and
 * it is only asked of accounts the board has not got to yet.
 */

export const NEWCOMER_MIN_ROUNDS = 4;
/** Top 1% of every per-match score on record. */
export const NEWCOMER_TOP_SHARE = 0.01;
export const NEWCOMER_KIND = 'newcomer_esp';

export interface NewcomerOutlier {
  steamid: string;
  matchId: number;
  hiddenOccZ: number;
  /** 1-based, among `of` player-matches with a score. */
  rank: number;
  of: number;
  /** Rounds with line of sight this player has in total, all matches. */
  totalRounds: number;
}

interface Row { steamid: string; match_id: number; metrics: string; map: string | null; round: string }

/** Pure over the stored measurements, so a rerun finds the same outliers. */
export function newcomerOutliers(db: DB): NewcomerOutlier[] {
  const rows = db.prepare(
    `SELECT r.steamid, r.match_id, r.metrics, pr.map,
            r.match_id || '/' || r.ordinal || '/' || r.half AS round
     FROM integrity_rounds r
     LEFT JOIN integrity_prior_rounds pr
       ON pr.match_id = r.match_id AND pr.ordinal = r.ordinal AND pr.half = r.half
     WHERE r.analyzer_version = ?`,
  ).all(ANALYZER_VERSION) as Row[];
  const parsed = rows.map((r) => ({ ...r, m: JSON.parse(r.metrics) as RoundMetrics }));

  // A player's whole history, the way the board counts it.
  const losRounds = new Map<string, number>();
  for (const r of parsed) if (r.m.hidden) losRounds.set(r.steamid, (losRounds.get(r.steamid) ?? 0) + 1);

  // One pseudo-player per (player, match). Calibration still runs over every
  // row, exactly as on the board, because the map ratios do not depend on
  // how rows are grouped.
  const SEP = '|';
  const perMatch = aggregate(parsed.map((r) => ({
    steamid: `${r.steamid}${SEP}${r.match_id}`, metrics: r.m, map: r.map, round: r.round,
  })), { minRounds: NEWCOMER_MIN_ROUNDS })
    .filter((a) => a.hiddenOccZ != null)
    .sort((a, b) => b.hiddenOccZ! - a.hiddenOccZ!);

  const cut = Math.max(1, Math.floor(perMatch.length * NEWCOMER_TOP_SHARE));
  const out: NewcomerOutlier[] = [];
  perMatch.slice(0, cut).forEach((a, i) => {
    const [steamid, match] = a.steamid.split(SEP);
    const totalRounds = losRounds.get(steamid) ?? 0;
    if (totalRounds >= TUNING.MIN_BOARD_ROUNDS) return; // the board has them
    out.push({ steamid, matchId: Number(match), hiddenOccZ: a.hiddenOccZ!, rank: i + 1, of: perMatch.length, totalRounds });
  });
  return out;
}

/** Store a flag for every outlier that has none yet. Returns the new ones. */
export function flagNewcomers(db: DB, now = new Date()): NewcomerOutlier[] {
  const created: NewcomerOutlier[] = [];
  for (const o of newcomerOutliers(db)) {
    const has = db.prepare(
      "SELECT 1 FROM integrity_flags WHERE steamid = ? AND match_id = ? AND source = 'analyzer' AND kind = ?",
    ).get(o.steamid, o.matchId, NEWCOMER_KIND);
    if (has) continue;
    recordIntegrityFlag(db, {
      matchId: o.matchId, serverId: null, steamid: o.steamid, source: 'analyzer', kind: NEWCOMER_KIND,
      severity: 'suspected', detail: newcomerDetail(o),
    }, now);
    created.push(o);
  }
  return created;
}

export function newcomerDetail(o: Pick<NewcomerOutlier, 'hiddenOccZ' | 'rank' | 'of' | 'totalRounds'>): string {
  return `aim on infected the team could not see: z ${o.hiddenOccZ.toFixed(2)}, #${o.rank} of ${o.of} matches on record; `
    + `${o.totalRounds} scored round${o.totalRounds === 1 ? '' : 's'} in total, too few for the board`;
}

/**
 * Newcomer flags nobody has been told about, oldest first, claimed as they
 * are returned so two sweeps cannot post one twice. Only flags on matches
 * that ended inside `withinMs`: the first run flags history too, and a page
 * of week-old alerts would bury the one that matters.
 */
export function claimNewcomerPosts(db: DB, now = new Date(), withinMs = 2 * 86_400_000): { id: number; steamid: string; matchId: number; detail: string }[] {
  const since = new Date(now.getTime() - withinMs).toISOString().replace('T', ' ').slice(0, 19);
  const rows = db.prepare(
    `SELECT f.id, f.steamid, f.match_id AS matchId, f.detail FROM integrity_flags f
     JOIN matches m ON m.id = f.match_id
     WHERE f.source = 'analyzer' AND f.kind = ?
       AND NOT EXISTS (SELECT 1 FROM integrity_flag_posts p WHERE p.flag_id = f.id)
     ORDER BY f.id`,
  ).all(NEWCOMER_KIND) as { id: number; steamid: string; matchId: number; detail: string }[];
  const claim = db.prepare('INSERT OR IGNORE INTO integrity_flag_posts (flag_id, posted_at) VALUES (?, ?)');
  const ended = db.prepare('SELECT COALESCE(ended_at, created_at) AS at FROM matches WHERE id = ?');
  const out: typeof rows = [];
  for (const r of rows) {
    // Claimed either way: an old one is settled by being on the file.
    if (claim.run(r.id, now.toISOString()).changes === 0) continue;
    const at = (ended.get(r.matchId) as { at: string } | undefined)?.at ?? '';
    if (at >= since) out.push(r);
  }
  return out;
}

export function ensureNewcomerSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integrity_flag_posts (
      flag_id   INTEGER PRIMARY KEY,
      posted_at TEXT NOT NULL
    );
  `);
}
