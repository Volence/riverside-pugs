import { rating, rate } from 'openskill';
import type { DB } from './db.js';
import { ensureRating } from './players.js';

/** Cosmetic SR shown on site. Stored mu/sigma remain canonical. */
export function displaySr(mu: number, sigma: number): number {
  return Math.max(0, Math.round((mu - 2 * sigma) * 100));
}

interface MpRow { player_id: string; team: 'a' | 'b'; joined_map: number }

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
