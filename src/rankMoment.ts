import type { DB } from './db.js';
import { currentSeasonId } from './players.js';
import { rankAfter, rankView, seasonRules, srUnder } from './seasonRules.js';
import { seasonOneLive } from './seasonThemes.js';

/**
 * The site's rank-up moment (owner-approved 2026-10-20): what a player's most
 * recent rated match did to their rank, when it is worth a celebration. The
 * site plays the animation once per match (it remembers the match id) the
 * next time the player opens it.
 *
 * Only two things count: completing placement, and moving UP a division or
 * a tier. A drop never gets an animation; the badge just changes.
 */
export type RankMoment =
  | { kind: 'placed'; matchId: number; to: string; srAfter: number; next: number | null; nextName: string | null }
  | {
      kind: 'up'; matchId: number; tierUp: boolean; from: string; to: string;
      srBefore: number; srAfter: number;
      /** Where `to` starts (the line crossed) and where the division after it starts. */
      floor: number; fromFloor: number; next: number | null; nextName: string | null;
    };

/** Older than this and the moment has passed: someone back from a break is
 *  not greeted with a rank-up from last week. */
export const RANK_MOMENT_FRESH_MS = 24 * 60 * 60 * 1000;

export function rankMoment(db: DB, steamid: string, now = new Date()): RankMoment | null {
  if (!seasonOneLive(db)) return null;
  const season = currentSeasonId(db);
  const rules = seasonRules(db, season);
  if (!rules.ranks) return null;
  const rows = db.prepare(
    `SELECT match_id, mu_before, sigma_before, mu_after, sigma_after FROM rating_history
     WHERE season_id = ? AND player_id = ? ORDER BY id`,
  ).all(season, steamid) as { match_id: number; mu_before: number; sigma_before: number; mu_after: number; sigma_after: number }[];
  if (rows.length === 0) return null;

  // The same fold as seasonLadder, stopping to remember the state before the
  // last game.
  let rankIdx: number | null = null;
  let before: number | null = null;
  rows.forEach((h, i) => {
    if (i === rows.length - 1) before = rankIdx;
    if (i + 1 < rules.placementGames) return;
    rankIdx = rankAfter(rankIdx, srUnder(rules, h.mu_after, h.sigma_after));
  });
  const last = rows[rows.length - 1];
  const ended = db.prepare('SELECT ended_at FROM matches WHERE id = ?').get(last.match_id) as { ended_at: string | null } | undefined;
  const endedMs = ended?.ended_at ? Date.parse(`${ended.ended_at.replace(' ', 'T')}${ended.ended_at.includes('Z') ? '' : 'Z'}`) : NaN;
  if (!Number.isFinite(endedMs) || now.getTime() - endedMs > RANK_MOMENT_FRESH_MS) return null;
  const after = rankIdx as number | null;
  if (after === null) return null;
  const to = rankView(after);
  const srAfter = srUnder(rules, last.mu_after, last.sigma_after);
  const nextName = to.next === null ? null : rankView(after + 1).name;
  if (before === null) {
    return { kind: 'placed', matchId: last.match_id, to: to.name, srAfter, next: to.next, nextName };
  }
  if (after <= before) return null;
  const from = rankView(before);
  return {
    kind: 'up', matchId: last.match_id, tierUp: from.tier !== to.tier, from: from.name, to: to.name,
    srBefore: srUnder(rules, last.mu_before, last.sigma_before), srAfter,
    floor: to.floor, fromFloor: from.floor, next: to.next, nextName,
  };
}
