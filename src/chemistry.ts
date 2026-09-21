import type { DB } from './db.js';
import { resolveAlias } from './aliases.js';
import { getSetting } from './settings.js';

/**
 * Who a player wins with and loses to. Three lines on the profile and no
 * more: the profile already carries a lot of numbers.
 *
 * No schema. It is a self join on match_players over completed matches,
 * which is also what excludes a voided match, since voiding sets 'aborted'.
 */

export interface ChemistryLine {
  steamid: string;
  name: string;
  games: number;
  wins: number;
  /** wins / games, 0 to 1. A draw is a game that is not a win. */
  winRate: number;
}

export interface Chemistry {
  /** A count, so it has no threshold: a count of three is honestly three. */
  mostPlayedWith: ChemistryLine | null;
  /** Averages, so both are gated by chemistry_min_games. An average over
   *  three games is noise (the precedent in 5d2ae85). Null, never an empty
   *  line, when nobody clears it. */
  bestWith: ChemistryLine | null;
  worstAgainst: ChemistryLine | null;
}

interface PairRow { steamid: string; name: string; same: number; games: number; wins: number }

export function chemistryFor(db: DB, steamid: string): Chemistry {
  const me = resolveAlias(db, steamid);
  const minGames = Math.max(1, Math.trunc(Number(getSetting(db, 'chemistry_min_games'))) || 5);

  // Ids resolve through player_aliases on BOTH sides of the join, so a merged
  // alt is not counted as a separate teammate. DISTINCT because an alt and its
  // owner can both sit on one old roster, and that is one shared match.
  const rows = db.prepare(
    `WITH roster AS (
       SELECT DISTINCT mp.match_id, COALESCE(pa.canonical_id, mp.player_id) AS pid, mp.team
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id AND m.state = 'completed'
       LEFT JOIN player_aliases pa ON pa.steamid = mp.player_id
     )
     SELECT o.pid AS steamid, p.name AS name,
            CASE WHEN o.team = me.team THEN 1 ELSE 0 END AS same,
            COUNT(*) AS games,
            SUM(CASE WHEN m.winner = me.team THEN 1 ELSE 0 END) AS wins
     FROM roster me
     JOIN roster o ON o.match_id = me.match_id AND o.pid != me.pid
     JOIN matches m ON m.id = me.match_id
     JOIN players p ON p.steamid = o.pid
     WHERE me.pid = ?
     GROUP BY o.pid, same`,
  ).all(me) as PairRow[];

  const line = (r: PairRow | undefined): ChemistryLine | null =>
    r ? { steamid: r.steamid, name: r.name, games: r.games, wins: r.wins, winRate: r.wins / r.games } : null;
  // Every ordering ends on name then id, so two equal pairs never swap places
  // between page loads.
  const stable = (a: PairRow, b: PairRow) => a.name.localeCompare(b.name) || a.steamid.localeCompare(b.steamid);
  const rate = (r: PairRow) => r.wins / r.games;

  const withRows = rows.filter((r) => r.same === 1);
  const againstRows = rows.filter((r) => r.same === 0);

  return {
    mostPlayedWith: line([...withRows].sort((a, b) => b.games - a.games || stable(a, b))[0]),
    bestWith: line(withRows.filter((r) => r.games >= minGames)
      .sort((a, b) => rate(b) - rate(a) || b.games - a.games || stable(a, b))[0]),
    worstAgainst: line(againstRows.filter((r) => r.games >= minGames)
      .sort((a, b) => rate(a) - rate(b) || b.games - a.games || stable(a, b))[0]),
  };
}
