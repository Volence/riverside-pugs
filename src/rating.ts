import { rating, rate, predictWin } from 'openskill';
import type { DB } from './db.js';
import { ensureRating } from './players.js';

/** Cosmetic SR shown on site. Stored mu/sigma remain canonical. */
export function displaySr(mu: number, sigma: number): number {
  return Math.max(0, Math.round((mu - 2 * sigma) * 100));
}

interface MpRow { player_id: string; team: 'a' | 'b'; joined_map: number }

/** What the ratings said about a match before it was played. */
export interface MatchForecast {
  /** Mean SR of the rated players on each side, as the site shows SR. */
  srA: number;
  srB: number;
  /** srA - srB. Positive means team A was favoured on paper. */
  srGap: number;
  /** Probability each team wins, from the same OpenSkill model that rates
   *  them. The pair sums to 1: a draw is not forecast separately. */
  winProbA: number;
  winProbB: number;
  /** How many players on each side the forecast is built from. Fewer than the
   *  roster means subs who played too little to be rated. */
  ratedA: number;
  ratedB: number;
}

/**
 * The paper odds for a completed match, for judging whether balance is any
 * good after the fact.
 *
 * Read from `rating_history`, not from `player_ratings`, which is the whole
 * point: history stores each player's mu and sigma BEFORE this match, so the
 * forecast is what the system believed at the time rather than what it
 * believes now, several matches later. Using current ratings would make every
 * past match look like it was predicted by hindsight.
 *
 * Only rated players count. A sub who played under half the maps gets no
 * history row (see `ratedForMaps`), and crediting their team for a ringer who
 * played one map would misstate the very thing this is here to measure.
 *
 * Null when there is no history for the match: an old match from before
 * ratings, a voided one, or one where a side had nobody ratable.
 */
export function matchForecast(db: DB, matchId: number): MatchForecast | null {
  const rows = db.prepare(
    `SELECT mp.team AS team, rh.mu_before AS mu, rh.sigma_before AS sigma
     FROM rating_history rh
     JOIN match_players mp ON mp.match_id = rh.match_id AND mp.player_id = rh.player_id
     WHERE rh.match_id = ?`,
  ).all(matchId) as { team: 'a' | 'b'; mu: number; sigma: number }[];

  const a = rows.filter((r) => r.team === 'a');
  const b = rows.filter((r) => r.team === 'b');
  if (a.length === 0 || b.length === 0) return null;

  const meanSr = (side: typeof a): number =>
    Math.round(side.reduce((n, r) => n + displaySr(r.mu, r.sigma), 0) / side.length);
  const srA = meanSr(a);
  const srB = meanSr(b);

  const [winProbA, winProbB] = predictWin([
    a.map((r) => rating(r)),
    b.map((r) => rating(r)),
  ]);

  return { srA, srB, srGap: srA - srB, winProbA, winProbB, ratedA: a.length, ratedB: b.length };
}

/** Whether a player who was rostered on map `joinedMap` of a `mapsPlayed`-map
 *  match played enough of it to be rated: at least half the maps. A sub who
 *  came in for the last map of four keeps their stats but is not rated on
 *  it; with no maps recorded everyone is rated (nothing to judge by). */
export function ratedForMaps(joinedMap: number, mapsPlayed: number): boolean {
  if (mapsPlayed <= 0) return true;
  return (mapsPlayed - joinedMap) * 2 >= mapsPlayed;
}

/** Apply OpenSkill updates for a completed match: player_ratings mu/sigma/W-L
 *  plus one rating_history row per player. Idempotent via rating_history guard.
 *  Draws update mu/sigma (rank tie) but count as neither win nor loss. */
export function applyMatchRatings(db: DB, matchId: number): void {
  const match = db
    .prepare('SELECT id, season_id, state, winner FROM matches WHERE id = ?')
    .get(matchId) as { id: number; season_id: number; state: string; winner: 'a' | 'b' | 'draw' | null } | undefined;
  if (!match || match.state !== 'completed' || !match.winner) return;
  if (db.prepare('SELECT 1 FROM rating_history WHERE match_id = ? LIMIT 1').get(matchId)) return;

  const all = db.prepare('SELECT player_id, team, joined_map FROM match_players WHERE match_id = ?').all(matchId) as MpRow[];
  const mapsPlayed = (db.prepare('SELECT COUNT(*) AS n FROM match_maps WHERE match_id = ?').get(matchId) as { n: number }).n;
  const mps = all.filter((r) => ratedForMaps(r.joined_map, mapsPlayed));
  const teamA = mps.filter((r) => r.team === 'a').map((r) => r.player_id);
  const teamB = mps.filter((r) => r.team === 'b').map((r) => r.player_id);
  if (teamA.length === 0 || teamB.length === 0) return;

  const before = new Map(mps.map((r) => [r.player_id, ensureRating(db, r.player_id, match.season_id)]));
  const rank = match.winner === 'a' ? [1, 2] : match.winner === 'b' ? [2, 1] : [1, 1];
  const [newA, newB] = rate(
    [teamA.map((id) => rating(before.get(id)!)), teamB.map((id) => rating(before.get(id)!))],
    { rank },
  );

  db.transaction(() => {
    const upd = db.prepare(
      'UPDATE player_ratings SET mu = ?, sigma = ?, wins = wins + ?, losses = losses + ? WHERE player_id = ? AND season_id = ?',
    );
    const hist = db.prepare(
      `INSERT INTO rating_history (player_id, match_id, season_id, mu_before, sigma_before, mu_after, sigma_after)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const apply = (ids: string[], rated: { mu: number; sigma: number }[], won: boolean, lost: boolean) => {
      ids.forEach((id, i) => {
        const b = before.get(id)!;
        upd.run(rated[i].mu, rated[i].sigma, won ? 1 : 0, lost ? 1 : 0, id, match.season_id);
        hist.run(id, matchId, match.season_id, b.mu, b.sigma, rated[i].mu, rated[i].sigma);
      });
    };
    apply(teamA, newA, match.winner === 'a', match.winner === 'b');
    apply(teamB, newB, match.winner === 'b', match.winner === 'a');
  })();
}

/**
 * Rebuild a season's ratings from scratch by replaying every completed match
 * in the order they finished.
 *
 * What makes voiding a match honest: ratings are sequential, so removing one
 * result changes every rating computed after it, not just the ratings of the
 * eight people in it. Replaying through applyMatchRatings rather than a second
 * implementation means the rebuilt numbers are the ones the incremental path
 * would have produced had the voided match never been played.
 */
export function recomputeSeasonRatings(db: DB, seasonId: number): void {
  db.transaction(() => {
    db.prepare('DELETE FROM rating_history WHERE season_id = ?').run(seasonId);
    const fresh = rating();
    db.prepare('UPDATE player_ratings SET mu = ?, sigma = ?, wins = 0, losses = 0 WHERE season_id = ?')
      .run(fresh.mu, fresh.sigma, seasonId);
    const matches = db.prepare(
      `SELECT id FROM matches WHERE season_id = ? AND state = 'completed'
       ORDER BY COALESCE(ended_at, created_at), id`,
    ).all(seasonId) as { id: number }[];
    for (const m of matches) applyMatchRatings(db, m.id);
  })();
}
