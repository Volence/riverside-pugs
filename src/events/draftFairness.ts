import type { DB } from '../db.js';
import { currentSeasonId, getPlayer } from '../players.js';
import { seasonRating, seasonSr, winChances } from '../rating.js';
import * as D from './drafts.js';

/**
 * The Make teams fairness readout (drafts plan D2a Ruling 5): per working
 * team its captain, the four names and their average and total current-season
 * SR; overall the spread (highest average minus lowest) and a pairwise win
 * forecast from openskill over each player's current { mu, sigma }, unrated
 * players at the defaults. Read only, and for staff and the organizer only:
 * none of it goes into a player or public response.
 */

export interface FairnessTeam { captain: string; captainName: string; names: string[]; avgSr: number; totalSr: number }
/** a and b are indexes into teams; winA is team a's chance against team b. */
export interface Fairness { teams: FairnessTeam[]; spread: number; forecasts: { a: number; b: number; winA: number }[] }

/** Null while the working teams are not made (draftTeamsOf is null). */
export function draftFairness(db: DB, eventId: number): Fairness | null {
  const made = D.draftTeamsOf(db, eventId);
  if (!made) return null;
  const season = currentSeasonId(db);
  const nameOf = (steamid: string) => getPlayer(db, steamid)?.name ?? steamid;
  const fours = made.map((t) => [t.captain, ...t.players].map((s) => s.steamid));
  const teams = fours.map((four): FairnessTeam => {
    const totalSr = four.reduce((n, s) => n + seasonSr(db, s, season), 0);
    return { captain: four[0]!, captainName: nameOf(four[0]!), names: four.map(nameOf), avgSr: totalSr / four.length, totalSr };
  });
  const ratings = fours.map((four) => four.map((s) => seasonRating(db, s, season)));
  const forecasts: Fairness['forecasts'] = [];
  for (let a = 0; a < ratings.length; a++) {
    for (let b = a + 1; b < ratings.length; b++) forecasts.push({ a, b, winA: winChances([ratings[a]!, ratings[b]!])[0]! });
  }
  const avgs = teams.map((t) => t.avgSr);
  return { teams, spread: Math.max(...avgs) - Math.min(...avgs), forecasts };
}
