import type { DB } from '../db.js';
import { integrityBoard } from './integrity.js';
import type { ClassScores } from '../integrity/score.js';
import type { InfectedClass } from '../integrity/los.js';

/**
 * The integrity board as a per-player lookup.
 *
 * Same numbers, same gate: integrityBoard scores at read time, keeps the
 * current analyzer version only, and leaves anybody under MIN_BOARD_ROUNDS
 * unranked and listed last. The board's own screen is going away, so what
 * the columns meant moves onto the file and onto the Needs a look list, and
 * the rank comes from here rather than being recomputed alongside it.
 *
 * Rank is the place among RANKED players, which is what "1 of 82" has always
 * meant on that board: a sort key over a named population, not a claim.
 */
export interface AnalyzerRank {
  steamid: string;
  ranked: boolean;
  rank: number | null;
  /** How many players are ranked at all, the denominator of `rank`. */
  of: number;
  rounds: number;
  eligibleRounds: number;
  clips: number;
  trackShare: number | null;
  occZ: number | null;
  teamGap: number | null;
  pFid: number | null;
  pOcc: number | null;
  pGap: number | null;
  composite: number | null;
  /** Metrics D, E and F. Shown beside the rank, not part of it. */
  losRounds: number;
  hiddenShare: number | null;
  hiddenOccZ: number | null;
  reveals: number;
  revealShare: number | null;
  pHidden: number | null;
  pHiddenOcc: number | null;
  pReveal: number | null;
  byClass: Record<InfectedClass, ClassScores>;
}

export function analyzerRanks(db: DB, seasonId: number | null = null): Map<string, AnalyzerRank> {
  const board = integrityBoard(db, seasonId);
  const of = board.filter((p) => p.ranked).length;
  return new Map(board.map((p, i) => [p.steamid, {
    steamid: p.steamid,
    ranked: p.ranked,
    // Unranked rows come after every ranked one, so the index is the rank
    // for exactly the rows that have one.
    rank: p.ranked ? i + 1 : null,
    of,
    rounds: p.rounds,
    eligibleRounds: p.eligibleRounds,
    clips: p.clips,
    trackShare: p.trackShare,
    occZ: p.occZ,
    teamGap: p.teamGap,
    pFid: p.pFid,
    pOcc: p.pOcc,
    pGap: p.pGap,
    composite: p.composite,
    losRounds: p.losRounds,
    hiddenShare: p.hiddenShare,
    hiddenOccZ: p.hiddenOccZ,
    reveals: p.reveals,
    revealShare: p.revealShare,
    pHidden: p.pHidden,
    pHiddenOcc: p.pHiddenOcc,
    pReveal: p.pReveal,
    byClass: p.byClass,
  }]));
}

export function analyzerRankOf(
  db: DB, steamid: string, seasonId: number | null = null,
): AnalyzerRank | null {
  return analyzerRanks(db, seasonId).get(steamid) ?? null;
}
