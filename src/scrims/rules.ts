import { rating } from 'openskill';
import type { DB } from '../db.js';
import { displaySr } from '../rating.js';
import { currentSeasonId } from '../players.js';
import { activeMembers } from '../teams/teams.js';
import { bookingLimits, capacityProblem, typicalCampaignMinutes, STEP_MINUTES, iso } from '../bookings/rules.js';

/**
 * The pure rules behind the scrim board (spec part 4, sections 1-2, and the
 * plan's Rulings 1, 3 and 4). Nothing here writes to the database: a post or
 * accept's own write path (src/scrims/scrims.ts, plan 2) is the only thing
 * that does, which is what lets the board call these on every render without
 * side effects piling up.
 */

/** A side posting or accepting a scrim: a team, or a pickup group identified
 *  by its captain. The same shape as bookings' Party (src/bookings/rules.ts),
 *  kept separate here so this module does not import booking-specific types
 *  it does not otherwise need. */
export type ScrimSide = { teamId: number } | { captain: string };

/** The SR a player with no rating row yet is treated as: openskill's own
 *  defaults (mu 25, sigma 25/3), the same ones ensureRating (src/players.ts)
 *  would write for them. Read here without writing anything, since this
 *  module never touches the database. */
const UNRATED_SR = displaySr(rating().mu, rating().sigma);

function srOf(db: DB, steamid: string, seasonId: number): number {
  const row = db.prepare('SELECT mu, sigma FROM player_ratings WHERE player_id = ? AND season_id = ?')
    .get(steamid, seasonId) as { mu: number; sigma: number } | undefined;
  return row ? displaySr(row.mu, row.sigma) : UNRATED_SR;
}

/**
 * Ruling 1: a side's SR is the average current-season display SR of a team's
 * active members, or of the pickup captain alone. A player with no rating
 * counts as the season's starting SR rather than being left out, so a team of
 * entirely new players still has a side SR to post or match against.
 */
export function sideSr(db: DB, side: ScrimSide): number {
  const season = currentSeasonId(db);
  if ('teamId' in side) {
    const members = activeMembers(db, side.teamId);
    if (members.length === 0) return UNRATED_SR;
    const total = members.reduce((sum, m) => sum + srOf(db, m.steamid, season), 0);
    return Math.round(total / members.length);
  }
  return srOf(db, side.captain, season);
}

/** Whether `sr` is within `range` of a post's `postSr`. A null range is open:
 *  everything fits. */
export function srFits(postSr: number, range: number | null, sr: number): boolean {
  if (range === null) return true;
  return Math.abs(sr - postSr) <= range;
}

/**
 * Ruling 3: the proposed playlist on an accept. The poster's picks and the
 * accepter's picks alternate, poster first, duplicates skipped wherever they
 * recur. The result is capped at `booking_playlist_max`, then trimmed to
 * whatever fits `blockMinutes` by typical campaign length
 * (typicalCampaignMinutes, src/bookings/rules.ts), always keeping at least
 * the first campaign even if it alone runs over the block.
 */
export function proposedPlaylist(
  db: DB,
  posterPicks: string[],
  accepterPicks: string[],
  blockMinutes: number,
): { playlist: string[]; minutes: number; fits: boolean } {
  const max = bookingLimits(db).playlistMax;
  const seen = new Set<string>();
  const alternated: string[] = [];
  const len = Math.max(posterPicks.length, accepterPicks.length);
  for (let i = 0; i < len; i++) {
    if (i < posterPicks.length && !seen.has(posterPicks[i])) {
      seen.add(posterPicks[i]);
      alternated.push(posterPicks[i]);
    }
    if (i < accepterPicks.length && !seen.has(accepterPicks[i])) {
      seen.add(accepterPicks[i]);
      alternated.push(accepterPicks[i]);
    }
  }

  const playlist: string[] = [];
  let minutes = 0;
  for (const campaign of alternated.slice(0, max)) {
    const next = minutes + typicalCampaignMinutes(db, campaign);
    if (playlist.length > 0 && next > blockMinutes) break;
    playlist.push(campaign);
    minutes = next;
  }
  return { playlist, minutes, fits: minutes <= blockMinutes };
}

/** How far nearestFreeSlot searches either side of the post's start. */
const SEARCH_WINDOW_MINUTES = 3 * 60;

/**
 * Ruling 4: when the slot a confirm wanted is gone, the nearest slot (same
 * length, same region) that currently has capacity, searched in 30 minute
 * steps out to 3 hours either side of `startMs`, closest first. Later and
 * earlier candidates at the same distance are both free or both are not; when
 * only one of a tied pair is free, the later one wins the tie (scrims are
 * proposed ahead of time, so sliding later is the smaller ask). Null when
 * nothing in the window has room. Offers a slot; books nothing.
 */
export function nearestFreeSlot(db: DB, region: string, startMs: number, minutes: number): string | null {
  const durationMs = minutes * 60_000;
  const stepMs = STEP_MINUTES * 60_000;
  const maxSteps = Math.floor(SEARCH_WINDOW_MINUTES / STEP_MINUTES);
  const free = (ms: number): boolean => capacityProblem(db, { region, startMs: ms, endMs: ms + durationMs }) === null;

  if (free(startMs)) return iso(startMs);
  for (let step = 1; step <= maxSteps; step++) {
    const later = startMs + step * stepMs;
    const earlier = startMs - step * stepMs;
    if (free(later)) return iso(later);
    if (free(earlier)) return iso(earlier);
  }
  return null;
}
