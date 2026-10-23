import type { DB } from './db.js';
import { completedPug } from './matchKinds.js';
import { getSetting, settingNumber } from './settings.js';
import { balanceTeams, validSplits, type RatedPlayer, type Split } from './balance.js';

/**
 * Stat-aware tie-break for PUG team balancing (owner approved 2026-10-23).
 *
 * The Season 0 audit found the rating forecast barely beats a coin flip
 * (out of sample AUC 0.51) while a player's past SI damage per game predicts
 * the winner far better (AUC 0.67). Half of all S0 PUGs went live 60/40 or
 * worse by a stat-aware view, and those favourites won 72%.
 *
 * Policy ("gated tie-break" from the 2026-10-23 backtest):
 *   1. Find the rating-best split exactly as before (balanceTeams).
 *   2. If that split's stat-aware favourite is at or above the gate (60%),
 *      look at every valid split whose rating favourite is no more than the
 *      tolerance (5 points) further from even than the rating-best split's,
 *      and take the one whose stat-aware odds are closest to 50%.
 *   3. Otherwise keep the rating-best split.
 *   Holdout: when the gate fires on a match whose id is a multiple of
 *   balance_stats_holdout_every (4), the rating-best split plays anyway and
 *   the row is marked, so the tie-break has a same-time A/B control.
 *
 * Ratings, SR and the admin rating forecast are never touched: this only
 * decides who plays on which side. Off (balance_stats_enabled 0) the chosen
 * split is the rating-best split, byte for byte. Every queue match is logged
 * to match_balance_log either way.
 */

/**
 * The fitted model. Source: scratchpad balstat/run.py (2026-10-23), a
 * Newton logistic fit, no intercept, on the oldest 60% of Season 0 queue
 * PUGs (353 of 589), features = team A minus team B totals of mu and of S.
 * Printed by run.py as "coef per mu 0.0501 per dmg 0.000312 lambda 6.22".
 */
export const STAT_BALANCE_MODEL = {
  /** Logit per point of team-total mu gap. */
  perMu: 0.05014488243569039,
  /** Logit per point of team-total S gap (S in SI damage per game). */
  perDamage: 0.00031208712173839157,
  /** Shrinkage: S is pulled toward the average by this many average games. */
  shrinkGames: 1,
  /** Players with fewer prior completed PUGs than this get S = 0, so one
   *  freak game (a 9999-damage outlier) cannot swing teams on its own. */
  minGames: 3,
} as const;

/** One player's stat line as the tie-break sees it. */
export interface StatLine {
  steamid: string;
  /** Prior completed, unvoided PUGs (all seasons, any origin), rated and played from the start. */
  games: number;
  /** Mean SI damage per game, null with no games. */
  rawPerGame: number | null;
  /** (sum + avg * shrinkGames) / (games + shrinkGames). */
  shrunkPerGame: number;
  /** shrunkPerGame - avg, or 0 under minGames. */
  s: number;
}

/** S for one player: shrunk damage per game minus the average, 0 below the minimum. */
export function statScore(sum: number, games: number, avg: number, model = STAT_BALANCE_MODEL): number {
  if (games < model.minGames) return 0;
  return (sum + model.shrinkGames * avg) / (games + model.shrinkGames) - avg;
}

/**
 * Which match_players rows count as a real game: rated (the RCON dump named
 * them, so the stats are theirs) and on the starting roster (joined_map 0).
 * A sub who came in at a later map played part of a match and would read as
 * a weak full game.
 */
export const REAL_GAME = 'mp.rated = 1 AND mp.joined_map = 0';

/** The average SI damage per player-game over every completed, unvoided PUG. */
export function averageSiDamage(db: DB): number {
  const row = db.prepare(
    `SELECT AVG(mp.si_damage) AS avg FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE ${completedPug('m')} AND m.voided_at IS NULL AND ${REAL_GAME}`,
  ).get() as { avg: number | null };
  return row.avg ?? 0;
}

/** Career (every season) stat lines for the given players. A season reset
 *  does not touch these: they come from match_players, not ratings. */
export function statLines(db: DB, steamids: string[], avg = averageSiDamage(db)): Map<string, StatLine> {
  const sums = new Map<string, { n: number; sum: number }>();
  if (steamids.length > 0) {
    const rows = db.prepare(
      `SELECT mp.player_id AS steamid, COUNT(*) AS n, SUM(mp.si_damage) AS sum
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE ${completedPug('m')} AND m.voided_at IS NULL AND ${REAL_GAME}
         AND mp.player_id IN (${steamids.map(() => '?').join(',')})
       GROUP BY mp.player_id`,
    ).all(...steamids) as { steamid: string; n: number; sum: number }[];
    for (const r of rows) sums.set(r.steamid, { n: r.n, sum: r.sum ?? 0 });
  }
  const out = new Map<string, StatLine>();
  const k = STAT_BALANCE_MODEL.shrinkGames;
  for (const id of steamids) {
    const { n, sum } = sums.get(id) ?? { n: 0, sum: 0 };
    out.set(id, {
      steamid: id,
      games: n,
      rawPerGame: n > 0 ? sum / n : null,
      shrunkPerGame: (sum + k * avg) / (n + k),
      s: statScore(sum, n, avg),
    });
  }
  return out;
}

/** Stat-aware odds that team A wins: logistic on the team-total gaps. */
export function statWinA(teamA: string[], teamB: string[], mu: Map<string, number>, s: Map<string, number>): number {
  const total = (ids: string[], m: Map<string, number>) => ids.reduce((acc, id) => acc + (m.get(id) ?? 0), 0);
  const z = STAT_BALANCE_MODEL.perMu * (total(teamA, mu) - total(teamB, mu))
    + STAT_BALANCE_MODEL.perDamage * (total(teamA, s) - total(teamB, s));
  return 1 / (1 + Math.exp(-z));
}

/** The favourite's odds: whichever side is above 50%. */
export const favourite = (pA: number): number => Math.max(pA, 1 - pA);

export interface StatBalanceConfig {
  enabled: boolean;
  /** Stat favourite odds (0.5..1) at or above which the tie-break runs. */
  gate: number;
  /** How much further from even (0..1) a candidate's rating favourite may be. */
  tolerance: number;
  /** Every Nth match id (id % N === 0) where the gate fires keeps the
   *  rating-best split as a holdout, the honest A/B. 0: no holdout. */
  holdoutEvery: number;
}

/** Whether this match is a holdout: it keeps the rating-best split even when
 *  the gate fires, so the tie-break can be measured against teams as rated. */
export function isHoldout(matchId: number, cfg: StatBalanceConfig): boolean {
  return cfg.holdoutEvery > 0 && matchId % cfg.holdoutEvery === 0;
}

export function statBalanceConfig(db: DB): StatBalanceConfig {
  return {
    enabled: getSetting(db, 'balance_stats_enabled') === '1',
    gate: settingNumber(db, 'balance_stats_gate_pct', 60, { min: 50, max: 100, integer: true }) / 100,
    tolerance: settingNumber(db, 'balance_stats_tolerance_pts', 5, { min: 0, max: 50, integer: true }) / 100,
    holdoutEvery: settingNumber(db, 'balance_stats_holdout_every', 4, { min: 0, max: 100, integer: true }),
  };
}

export interface ScoredSplit extends Split {
  /** Stat-aware odds that team A wins. */
  statA: number;
}

export interface StatBalanceDecision {
  ratingBest: ScoredSplit;
  chosen: ScoredSplit;
  /** The rating-best split's stat favourite is at or above the gate. */
  overGate: boolean;
  /** Enabled and over the gate (the tie-break ran, or would have but for the holdout). */
  gateFired: boolean;
  /** The gate fired but this match is a holdout: the rating-best split plays. */
  holdout: boolean;
  /** Players on a different side in the chosen split than in the rating-best one. */
  moved: number;
}

/** Players who changed side, counting a mirrored split as no change. */
export function playersMoved(a1: string[], a2: string[]): number {
  const set = new Set(a2);
  const d = a1.filter((x) => !set.has(x)).length;
  return 2 * Math.min(d, a1.length - d);
}

/**
 * Pick the teams. `players` carry the mu the balancer uses (newcomer offset
 * and duo bonus included); `s` holds each player's S. The rating-best split
 * is balanceTeams on exactly these players and groups, so with the switch
 * off the answer cannot differ from today's.
 */
export function chooseTeams(
  players: RatedPlayer[],
  s: Map<string, number>,
  cfg: StatBalanceConfig,
  opts: { groups?: [string, string][]; holdout?: boolean } = {},
): StatBalanceDecision {
  const mu = new Map(players.map((p) => [p.steamid, p.mu]));
  const score = (sp: Split): ScoredSplit => ({ ...sp, statA: statWinA(sp.teamA, sp.teamB, mu, s) });
  const best = balanceTeams(players, opts);
  const ratingBest = score({ teamA: best.teamA, teamB: best.teamB, pWinA: best.pWinA });
  const overGate = favourite(ratingBest.statA) >= cfg.gate;
  const gateFired = cfg.enabled && overGate;
  const holdout = gateFired && opts.holdout === true;
  let chosen = ratingBest;
  if (gateFired && !holdout) {
    // A hair of slack so the rating-best split always qualifies against itself.
    const limit = Math.abs(ratingBest.pWinA - 0.5) + cfg.tolerance + 1e-12;
    for (const sp of validSplits(players, opts)) {
      if (Math.abs(sp.pWinA - 0.5) > limit) continue;
      const c = score(sp);
      // Strict <: on a tie the rating-best split (or the earlier one) stays.
      if (Math.abs(c.statA - 0.5) < Math.abs(chosen.statA - 0.5)) chosen = c;
    }
  }
  return { ratingBest, chosen, overGate, gateFired, holdout, moved: playersMoved(ratingBest.teamA, chosen.teamA) };
}

/** Per-player detail written to match_balance_log.players_json. */
export interface BalanceLogPlayer {
  steamid: string;
  /** Stored rating mu and sigma. */
  mu: number;
  sigma: number;
  /** The mu the balancer used (newcomer offset and duo bonus applied). */
  balanceMu: number;
  games: number;
  rawPerGame: number | null;
  shrunkPerGame: number;
  s: number;
}

export function logBalance(
  db: DB,
  matchId: number,
  cfg: StatBalanceConfig,
  avg: number,
  d: StatBalanceDecision,
  players: BalanceLogPlayer[],
): void {
  db.prepare(
    `INSERT OR REPLACE INTO match_balance_log
       (match_id, enabled, gate, tolerance, over_gate, gate_fired, holdout, stat_avg,
        best_team_a, best_team_b, best_rating_a, best_stat_a,
        chosen_team_a, chosen_team_b, chosen_rating_a, chosen_stat_a, moved, players_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    matchId, cfg.enabled ? 1 : 0, cfg.gate, cfg.tolerance, d.overGate ? 1 : 0, d.gateFired ? 1 : 0, d.holdout ? 1 : 0, avg,
    JSON.stringify(d.ratingBest.teamA), JSON.stringify(d.ratingBest.teamB), d.ratingBest.pWinA, d.ratingBest.statA,
    JSON.stringify(d.chosen.teamA), JSON.stringify(d.chosen.teamB), d.chosen.pWinA, d.chosen.statA,
    d.moved, JSON.stringify(players),
  );
}

export interface BalanceLogRow {
  matchId: number;
  createdAt: string;
  enabled: boolean;
  overGate: boolean;
  gateFired: boolean;
  holdout: boolean;
  moved: number;
  bestRatingA: number;
  bestStatA: number;
  chosenRatingA: number;
  chosenStatA: number;
  /** 'a' | 'b' | 'draw' once the match completed unvoided, else null. */
  winner: string | null;
  state: string;
}

export interface BalanceLogBucket {
  matches: number;
  /** Mean predicted odds of the stat favourite. */
  predicted: number | null;
  /** Share the stat favourite actually won, over decided matches. */
  favWon: number | null;
  decided: number;
}

export interface BalanceLogSummary {
  logged: number;
  enabledMatches: number;
  /** Matches where the tie-break ran, over matches logged with it on. */
  gateFireRate: number | null;
  /** Gate fired and the tie-break picked the teams: stat favourite of the
   *  chosen teams (target near 50%). Holdouts are not in it. */
  firedChosen: BalanceLogBucket;
  /** Gate fired, holdout: the rating-best teams played. The A/B control for
   *  firedChosen, under the same conditions and the same time. */
  holdout: BalanceLogBucket;
  /** Gate fired: the rating-best split's stat favourite, predicted only
   *  (those teams never played, so it has no result). */
  firedRatingBestPredicted: number | null;
  /** Over the gate with the switch off: the control, teams as rated. */
  offOverGate: BalanceLogBucket;
  /** Every logged match: stat favourite of the teams that played. */
  allChosen: BalanceLogBucket;
}

const rowOf = (r: Record<string, unknown>): BalanceLogRow => ({
  matchId: Number(r.match_id),
  createdAt: String(r.created_at),
  enabled: r.enabled === 1,
  overGate: r.over_gate === 1,
  gateFired: r.gate_fired === 1,
  holdout: r.holdout === 1,
  moved: Number(r.moved),
  bestRatingA: Number(r.best_rating_a),
  bestStatA: Number(r.best_stat_a),
  chosenRatingA: Number(r.chosen_rating_a),
  chosenStatA: Number(r.chosen_stat_a),
  winner: (r.winner as string | null) ?? null,
  state: String(r.state ?? ''),
});

function readRows(db: DB, limit?: number): BalanceLogRow[] {
  const rows = db.prepare(
    `SELECT l.*, m.state AS state,
            CASE WHEN ${completedPug('m')} AND m.voided_at IS NULL THEN m.winner END AS winner
     FROM match_balance_log l LEFT JOIN matches m ON m.id = l.match_id
     ORDER BY l.match_id DESC ${limit ? 'LIMIT ?' : ''}`,
  ).all(...(limit ? [limit] : [])) as Record<string, unknown>[];
  return rows.map(rowOf);
}

function bucket(rows: BalanceLogRow[]): BalanceLogBucket {
  const decided = rows.filter((r) => r.winner === 'a' || r.winner === 'b');
  const won = decided.filter((r) => r.winner === (r.chosenStatA >= 0.5 ? 'a' : 'b')).length;
  return {
    matches: rows.length,
    predicted: rows.length ? rows.reduce((a, r) => a + favourite(r.chosenStatA), 0) / rows.length : null,
    favWon: decided.length ? won / decided.length : null,
    decided: decided.length,
  };
}

export function balanceLogSummary(db: DB): BalanceLogSummary {
  const rows = readRows(db);
  const on = rows.filter((r) => r.enabled);
  const fired = rows.filter((r) => r.gateFired);
  const tieBreak = fired.filter((r) => !r.holdout);
  return {
    logged: rows.length,
    enabledMatches: on.length,
    gateFireRate: on.length ? fired.length / on.length : null,
    firedChosen: bucket(tieBreak),
    holdout: bucket(fired.filter((r) => r.holdout)),
    firedRatingBestPredicted: tieBreak.length ? tieBreak.reduce((a, r) => a + favourite(r.bestStatA), 0) / tieBreak.length : null,
    offOverGate: bucket(rows.filter((r) => !r.enabled && r.overGate)),
    allChosen: bucket(rows),
  };
}

export function recentBalanceLog(db: DB, limit = 50): BalanceLogRow[] {
  return readRows(db, limit);
}
