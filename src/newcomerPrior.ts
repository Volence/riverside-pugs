import type { DB } from './db.js';
import { completedPug } from './matchKinds.js';
import { getSetting } from './settings.js';

/**
 * How much weaker the team balancer treats a player in their first PUG.
 *
 * The 2026-10-09 audit (backup of that day, 477 completed PUGs) found that a
 * player's first match is won 31.9% of the time (n = 235) against 48-50% for
 * every later bracket, and that teams with more first-timers than the other
 * side were forecast at 49% and won 30% (n = 139). It is a "first time on our
 * setup" effect, not inexperience: it holds in every Steam-hours bucket, and
 * the forecast is calibrated everywhere else (favourite 55% predicted, 54%
 * won). Fitting a mu offset for first-match players in the same model the
 * balancer uses improved the fit up to 8-10 mu.
 *
 * Balancing only: the offset is subtracted from the mu handed to
 * balanceTeams and nowhere else. Stored ratings, SR, the admin forecast and
 * every rating update are untouched, so the forecast keeps measuring whether
 * this works. The setting `newcomer_balance_offset` is 0 (off) by default.
 */

/** The offset in mu for one player with `careerMatches` finished PUGs. */
export function newcomerOffset(careerMatches: number, offset: number): number {
  return careerMatches === 0 ? offset : 0;
}

/** The configured offset, clamped to what the settings panel allows. */
export function configuredOffset(db: DB): number {
  const n = Number(getSetting(db, 'newcomer_balance_offset'));
  return Number.isFinite(n) ? Math.min(12, Math.max(0, n)) : 0;
}

/** Finished, unvoided PUGs per player, for the given players only. */
export function careerMatchCounts(db: DB, steamids: string[]): Map<string, number> {
  const out = new Map(steamids.map((s) => [s, 0]));
  if (steamids.length === 0) return out;
  const rows = db.prepare(
    `SELECT mp.player_id AS steamid, COUNT(*) AS n
     FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE ${completedPug('m')} AND m.voided_at IS NULL
       AND mp.player_id IN (${steamids.map(() => '?').join(',')})
     GROUP BY mp.player_id`,
  ).all(...steamids) as { steamid: string; n: number }[];
  for (const r of rows) out.set(r.steamid, r.n);
  return out;
}

/** The mu each player should be balanced at: their own, less the newcomer
 *  offset for anyone with no finished PUG yet. Everyone's own mu when the
 *  setting is 0. */
export function balanceMu(db: DB, ratings: Map<string, { mu: number }>): Map<string, number> {
  const offset = configuredOffset(db);
  const out = new Map<string, number>();
  const counts = offset > 0 ? careerMatchCounts(db, [...ratings.keys()]) : null;
  for (const [steamid, r] of ratings) {
    out.set(steamid, r.mu - (counts ? newcomerOffset(counts.get(steamid) ?? 0, offset) : 0));
  }
  return out;
}
