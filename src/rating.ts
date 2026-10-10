import { rating, rate, predictWin } from 'openskill';
import type { DB } from './db.js';
import { ensureRating } from './players.js';
import { completedPug } from './matchKinds.js';

/** Cosmetic SR shown on site. Stored mu/sigma remain canonical. */
export function displaySr(mu: number, sigma: number): number {
  return Math.max(0, Math.round((mu - 2 * sigma) * 100));
}

/** The SR a player with no rating row yet shows: openskill's own defaults,
 *  the ones ensureRating (src/players.ts) would write for them. */
export const UNRATED_SR = displaySr(rating().mu, rating().sigma);

/** A player's display SR in a season, read without writing a rating row.
 *  Scrim sides and event seeding both use it. */
export function seasonSr(db: DB, steamid: string, seasonId: number): number {
  const r = seasonRating(db, steamid, seasonId);
  return displaySr(r.mu, r.sigma);
}

/** A player's { mu, sigma } in a season, read without writing a rating row:
 *  openskill's defaults (what ensureRating would write) when unrated. */
export function seasonRating(db: DB, steamid: string, seasonId: number): { mu: number; sigma: number } {
  const row = db.prepare('SELECT mu, sigma FROM player_ratings WHERE player_id = ? AND season_id = ?')
    .get(steamid, seasonId) as { mu: number; sigma: number } | undefined;
  if (row) return { mu: row.mu, sigma: row.sigma };
  const fresh = rating();
  return { mu: fresh.mu, sigma: fresh.sigma };
}

/** Each side's chance to win, from the OpenSkill model that rates them
 *  (predictWin over each player's { mu, sigma }). matchForecast and the draft
 *  fairness readout both read it. */
export function winChances(sides: { mu: number; sigma: number }[][]): number[] {
  return predictWin(sides.map((side) => side.map((r) => rating({ mu: r.mu, sigma: r.sigma }))));
}

interface MpRow { player_id: string; team: 'a' | 'b'; joined_map: number }

/** What the ratings said about a match before it was played. */
export interface MatchForecast {
  /** Mean SR of the rated players on each side, as the site shows SR. */
  srA: number;
  srB: number;
  /** srA - srB. Positive means team A leads on the number players see.
   *
   *  NOT the same thing as being the stronger side, and the difference is not
   *  academic: match 40 had team B leading by 114 SR while team A had the
   *  higher mu, because the entire gap was team B's lower sigma. `displaySr`
   *  subtracts TWICE a player's uncertainty, so a team can lead on SR purely
   *  by being better understood. Compare `muGap` before reading anything into
   *  this. */
  srGap: number;
  /** Mean mu difference, A minus B: the skill gap the forecast is actually
   *  built from, with no uncertainty penalty in it. Near zero alongside a
   *  large `srGap` means the SR lead is confidence, not skill. */
  muGap: number;
  /** Mean skill and mean uncertainty per side, unfolded. SR is
   *  `mu - 2*sigma`, so on its own it cannot show who was favoured: a team can
   *  trail on SR purely by being less well understood. These are the two
   *  halves it is made of. */
  muA: number;
  muB: number;
  sigmaA: number;
  sigmaB: number;
  /** Probability each team wins, from the same OpenSkill model that rates
   *  them. The pair sums to 1: a draw is not forecast separately. */
  winProbA: number;
  winProbB: number;
  /** How many players on each side the forecast is built from. Fewer than the
   *  roster means subs who played too little to be rated. */
  ratedA: number;
  ratedB: number;
  /** `history`: each player's rating as it stood before this match, which is
   *  the honest forecast for a finished one. `current`: today's ratings, used
   *  only for a match still in flight, where nothing has updated yet and the
   *  two are the same thing. */
  source: 'history' | 'current';
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
  const match = db.prepare('SELECT state, season_id FROM matches WHERE id = ?').get(matchId) as
    { state: string; season_id: number } | undefined;
  if (!match) return null;

  let source: 'history' | 'current' = 'history';
  let rows = db.prepare(
    `SELECT mp.team AS team, rh.mu_before AS mu, rh.sigma_before AS sigma
     FROM rating_history rh
     JOIN match_players mp ON mp.match_id = rh.match_id AND mp.player_id = rh.player_id
     WHERE rh.match_id = ?`,
  ).all(matchId) as { team: 'a' | 'b'; mu: number; sigma: number }[];

  // A match still in flight has no history: applyMatchRatings runs at
  // completion. Its players' current ratings ARE their pre-match ratings,
  // which is what someone watching it live wants to know.
  //
  // Only while in flight. For a match completed long ago, current ratings are
  // several matches of hindsight later, and no forecast beats a confident
  // wrong one.
  if (rows.length === 0 && match.state !== 'completed' && match.state !== 'aborted') {
    source = 'current';
    rows = db.prepare(
      `SELECT mp.team AS team, pr.mu AS mu, pr.sigma AS sigma
       FROM match_players mp
       JOIN player_ratings pr ON pr.player_id = mp.player_id AND pr.season_id = ?
       WHERE mp.match_id = ?`,
    ).all(match.season_id, matchId) as { team: 'a' | 'b'; mu: number; sigma: number }[];
  }

  const a = rows.filter((r) => r.team === 'a');
  const b = rows.filter((r) => r.team === 'b');
  if (a.length === 0 || b.length === 0) return null;

  const meanSr = (side: typeof a): number =>
    Math.round(side.reduce((n, r) => n + displaySr(r.mu, r.sigma), 0) / side.length);
  const meanMu = (side: typeof a): number =>
    side.reduce((n, r) => n + r.mu, 0) / side.length;
  const meanSigma = (side: typeof a): number =>
    side.reduce((n, r) => n + r.sigma, 0) / side.length;
  const srA = meanSr(a);
  const srB = meanSr(b);

  const [winProbA, winProbB] = winChances([a, b]) as [number, number];

  const muA = meanMu(a);
  const muB = meanMu(b);
  return {
    srA, srB, srGap: srA - srB, muGap: muA - muB,
    muA, muB, sigmaA: meanSigma(a), sigmaB: meanSigma(b),
    winProbA, winProbB, ratedA: a.length, ratedB: b.length, source,
  };
}

/** Whether a player who was rostered on map `joinedMap` of a `mapsPlayed`-map
 *  match played enough of it to be rated: at least half the maps. A sub who
 *  came in for the last map of four keeps their stats but is not rated on
 *  it; with no maps recorded everyone is rated (nothing to judge by). */
export function ratedForMaps(joinedMap: number, mapsPlayed: number): boolean {
  if (mapsPlayed <= 0) return true;
  return (mapsPlayed - joinedMap) * 2 >= mapsPlayed;
}

/** Fewest rated players a side may have for the match to move ratings at
 *  all. A 1v1 reached through an admin's !load used to be rated like a 4v4,
 *  and one result between two people moved both a full match's worth. Counted
 *  AFTER the two exclusions below, so neither a roster row the dump disowned
 *  nor a last-map sub can lift a 1v1 over the line. */
export const MIN_RATED_PER_TEAM = 2;

export interface RatingOutcome {
  applied: boolean;
  /** Why not, when not. `too_few` is the only one worth telling anyone about:
   *  the others are a match that is not finished, one already rated, or one
   *  that is not a PUG. */
  reason?: 'not_completed' | 'already' | 'too_few' | 'not_pug';
  ratedA: number;
  ratedB: number;
}

/** The quitters on a match who take a rating loss: their match_abandons
 *  rows, less any staff restored. Empty for every other match. The roster
 *  row is the authority on the side, as for everyone else; the abandon row's
 *  own team is the fallback for a row that has none. */
export function activeAbandons(db: DB, matchId: number): { playerId: string; team: 'a' | 'b'; decided: 'a' | 'b' | null }[] {
  return (db.prepare(
    `SELECT a.player_id, COALESCE(mp.team, a.team) AS team, a.decided FROM match_abandons a
     LEFT JOIN match_players mp ON mp.match_id = a.match_id AND mp.player_id = a.player_id
     WHERE a.match_id = ? AND a.restored_at IS NULL ORDER BY a.player_id`,
  ).all(matchId) as { player_id: string; team: 'a' | 'b'; decided: 'a' | 'b' | null }[])
    .map((r) => ({ playerId: r.player_id, team: r.team, decided: r.decided }));
}

/**
 * The quitter's rating after an abandon (owner ruling 2026-10-10, rule 3: the
 * quitter never gains, and takes a loss in every abandon).
 *
 * It is exactly the update the quitter would get had their team LOST this
 * match with this lineup: one OpenSkill rate() over both full teams with the
 * quitter's team ranked last, of which only the quitter's own row is kept.
 * When their team really did lose, that is identical to the normal update;
 * when it won (a decided match their team led) or there was no result (an
 * undecided abandon, aborted), it is the loss they walked out on.
 *
 * Why not one player against the other team: OpenSkill sums a team's skill,
 * so one player against four is expected to lose by so much that the loss
 * would barely move them. Rating the team result keeps the penalty the size
 * of an ordinary loss in that match.
 */
export function quitterLoss(
  teamA: string[], teamB: string[], before: Map<string, { mu: number; sigma: number }>,
  quitter: string, quitterTeam: 'a' | 'b',
): { mu: number; sigma: number } {
  const a = teamA.filter((id) => id !== quitter);
  const b = teamB.filter((id) => id !== quitter);
  (quitterTeam === 'a' ? a : b).push(quitter);
  const rank = quitterTeam === 'a' ? [2, 1] : [1, 2];
  const [newA, newB] = rate(
    [a.map((id) => rating(before.get(id)!)), b.map((id) => rating(before.get(id)!))],
    { rank },
  );
  const side = quitterTeam === 'a' ? newA : newB;
  const r = side[(quitterTeam === 'a' ? a : b).length - 1];
  return { mu: r.mu, sigma: r.sigma };
}

/**
 * The quitters' losses for an abandon that is not rated as a whole: an
 * undecided abandon (the match aborted, everyone who stayed unchanged), or a
 * decided one that completed with too few rated players to rate. Writes each
 * quitter's player_ratings (a loss) and one rating_history row each, nothing
 * for anyone else. Idempotent per quitter on that history row, so a repeated
 * call, and a recompute that replays it, apply each exactly once.
 *
 * The lineup is who would have been rated: rated roster rows that played at
 * least half the maps so far (none played counts everyone), plus every
 * quitter whatever they played. All quitters are judged from the same
 * ratings, as they stood before this match (a quitter already applied is
 * read back from their history row), so the order they are written in and a
 * recompute cannot change the numbers. A quitter needs someone on the other
 * side to lose to.
 */
export function applyAbandonPenalty(db: DB, matchId: number): boolean {
  const match = db.prepare('SELECT season_id, state, kind FROM matches WHERE id = ?')
    .get(matchId) as { season_id: number; state: string; kind: string } | undefined;
  if (!match || match.kind !== 'pug') return false;
  if (match.state !== 'aborted' && match.state !== 'completed') return false;
  const quitters = activeAbandons(db, matchId);
  if (quitters.length === 0) return false;
  const histOf = db.prepare('SELECT mu_before, sigma_before FROM rating_history WHERE match_id = ? AND player_id = ?');
  const todo = quitters.filter((q) => !histOf.get(matchId, q.playerId));
  if (todo.length === 0) return false;

  const qids = new Set(quitters.map((q) => q.playerId));
  const all = db.prepare('SELECT player_id, team, joined_map FROM match_players WHERE match_id = ? AND rated = 1').all(matchId) as MpRow[];
  const mapsPlayed = (db.prepare('SELECT COUNT(*) AS n FROM match_maps WHERE match_id = ?').get(matchId) as { n: number }).n;
  const mps = all.filter((r) => !qids.has(r.player_id) && ratedForMaps(r.joined_map, mapsPlayed));
  const teamA = [...mps.filter((r) => r.team === 'a').map((r) => r.player_id), ...quitters.filter((q) => q.team === 'a').map((q) => q.playerId)];
  const teamB = [...mps.filter((r) => r.team === 'b').map((r) => r.player_id), ...quitters.filter((q) => q.team === 'b').map((q) => q.playerId)];

  const before = new Map<string, { mu: number; sigma: number }>();
  for (const id of [...teamA, ...teamB]) {
    const h = histOf.get(matchId, id) as { mu_before: number; sigma_before: number } | undefined;
    before.set(id, h ? { mu: h.mu_before, sigma: h.sigma_before } : ensureRating(db, id, match.season_id));
  }
  let applied = false;
  db.transaction(() => {
    const upd = db.prepare('UPDATE player_ratings SET mu = ?, sigma = ?, losses = losses + 1 WHERE player_id = ? AND season_id = ?');
    const hist = db.prepare(
      `INSERT INTO rating_history (player_id, match_id, season_id, mu_before, sigma_before, mu_after, sigma_after)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const q of todo) {
      if ((q.team === 'a' ? teamB : teamA).length === 0) continue;
      const after = quitterLoss(teamA, teamB, before, q.playerId, q.team);
      const b = before.get(q.playerId)!;
      upd.run(after.mu, after.sigma, q.playerId, match.season_id);
      hist.run(q.playerId, matchId, match.season_id, b.mu, b.sigma, after.mu, after.sigma);
      applied = true;
    }
  })();
  return applied;
}

/** Apply OpenSkill updates for a completed match: player_ratings mu/sigma/W-L
 *  plus one rating_history row per player. Idempotent via rating_history guard.
 *  Draws update mu/sigma (rank tie) but count as neither win nor loss.
 *
 *  Two kinds of roster row are left out: a sub who played under half the maps
 *  (ratedForMaps), and a row marked rated = 0, which completeMatch sets on a
 *  player the log stream rostered and the RCON dump never mentioned. The mark
 *  lives on the row so a season recompute leaves the same people out. */
export function applyMatchRatings(db: DB, matchId: number): RatingOutcome {
  const match = db
    .prepare('SELECT id, season_id, state, winner, kind FROM matches WHERE id = ?')
    .get(matchId) as { id: number; season_id: number; state: string; winner: 'a' | 'b' | 'draw' | null; kind: string } | undefined;
  if (!match || match.state !== 'completed' || !match.winner) return { applied: false, reason: 'not_completed', ratedA: 0, ratedB: 0 };
  // Scrims and tournament matches never move SR (spec: foundation section 1).
  if (match.kind !== 'pug') return { applied: false, reason: 'not_pug', ratedA: 0, ratedB: 0 };
  if (db.prepare('SELECT 1 FROM rating_history WHERE match_id = ? LIMIT 1').get(matchId)) {
    return { applied: false, reason: 'already', ratedA: 0, ratedB: 0 };
  }

  const all = db.prepare('SELECT player_id, team, joined_map FROM match_players WHERE match_id = ? AND rated = 1').all(matchId) as MpRow[];
  const mapsPlayed = (db.prepare('SELECT COUNT(*) AS n FROM match_maps WHERE match_id = ?').get(matchId) as { n: number }).n;
  const mps = all.filter((r) => ratedForMaps(r.joined_map, mapsPlayed));
  const teamA = mps.filter((r) => r.team === 'a').map((r) => r.player_id);
  const teamB = mps.filter((r) => r.team === 'b').map((r) => r.player_id);
  // Quitters, who take a loss whatever the result (owner rulings 2026-10-10).
  const quitters = activeAbandons(db, matchId);
  if (teamA.length < MIN_RATED_PER_TEAM || teamB.length < MIN_RATED_PER_TEAM) {
    // Nobody is rated on the result, but every quitter still loses.
    if (quitters.length > 0) applyAbandonPenalty(db, matchId);
    return { applied: false, reason: 'too_few', ratedA: teamA.length, ratedB: teamB.length };
  }
  // The lineup a quitter's loss is judged in: the rated lineup plus any
  // quitter outside it (a late sub, a row marked unrated), on their side.
  // Only the quitters' own numbers use it, so everyone else is rated exactly
  // as if nobody had quit.
  const qA = [...teamA], qB = [...teamB];
  for (const q of quitters) {
    if (qA.includes(q.playerId) || qB.includes(q.playerId)) continue;
    (q.team === 'a' ? qA : qB).push(q.playerId);
  }

  const before = new Map([...qA, ...qB].map((id) => [id, ensureRating(db, id, match.season_id)]));
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
    // Everyone else is rated on the result with the quitters in the lineup,
    // as they played it. Each quitter instead gets quitterLoss and a loss on
    // their record, whichever way the result went; all of them are judged
    // from the same pre-match ratings.
    const losses = new Map(quitters.map((q) => [q.playerId, quitterLoss(qA, qB, before, q.playerId, q.team)]));
    const apply = (ids: string[], rated: { mu: number; sigma: number }[], won: boolean, lost: boolean) => {
      ids.forEach((id, i) => {
        const b = before.get(id)!;
        const loss = losses.get(id);
        if (loss) {
          upd.run(loss.mu, loss.sigma, 0, 1, id, match.season_id);
          hist.run(id, matchId, match.season_id, b.mu, b.sigma, loss.mu, loss.sigma);
          return;
        }
        upd.run(rated[i].mu, rated[i].sigma, won ? 1 : 0, lost ? 1 : 0, id, match.season_id);
        hist.run(id, matchId, match.season_id, b.mu, b.sigma, rated[i].mu, rated[i].sigma);
      });
    };
    apply(teamA, newA, match.winner === 'a', match.winner === 'b');
    apply(teamB, newB, match.winner === 'b', match.winner === 'a');
    for (const [id, loss] of losses) {
      if (teamA.includes(id) || teamB.includes(id)) continue;
      const b = before.get(id)!;
      upd.run(loss.mu, loss.sigma, 0, 1, id, match.season_id);
      hist.run(id, matchId, match.season_id, b.mu, b.sigma, loss.mu, loss.sigma);
    }
  })();
  return { applied: true, ratedA: teamA.length, ratedB: teamB.length };
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
    // Completed PUGs, and every PUG whose quitter still owes an abandon loss
    // that no completed result carries: an undecided abandon (aborted), or a
    // decided one staff later voided. Voiding drops the result, not the
    // abandon; only a restore (restoreAbandonRating) lifts the quitter's loss.
    const matches = db.prepare(
      `SELECT id, state FROM matches m WHERE season_id = ? AND (${completedPug()}
         OR (kind = 'pug' AND state = 'aborted'
             AND EXISTS (SELECT 1 FROM match_abandons a WHERE a.match_id = m.id AND a.restored_at IS NULL)))
       ORDER BY COALESCE(ended_at, created_at), id`,
    ).all(seasonId) as { id: number; state: string }[];
    for (const m of matches) {
      if (m.state === 'completed') applyMatchRatings(db, m.id);
      else applyAbandonPenalty(db, m.id);
    }
  })();
}
