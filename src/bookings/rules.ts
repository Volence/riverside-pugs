import type { DB } from '../db.js';
import { settingNumber } from '../settings.js';
import { completedPug } from '../matchKinds.js';

/**
 * The numbers and arithmetic of server bookings (spec part 1 section 3):
 * capacity per region, how many upcoming bookings a side may hold, how long
 * a campaign usually takes, and how many boxes the queue must leave idle for
 * bookings about to start. Read-only; src/bookings/bookings.ts writes.
 *
 * Times are stored as Date#toISOString() strings, so they compare as text.
 */

export type BookingState = 'scheduled' | 'held' | 'setup' | 'ready' | 'active' | 'ended' | 'cancelled' | 'no_show';
/** States that still take up a slot of capacity. A row whose end has
 *  started (ending_at set) does not, whatever its state says. */
export const OPEN_STATES_SQL = "('scheduled','held','setup','ready','active')";
export const STEP_MINUTES = 30;
/** People of one side who must be on the server at once for it to count as
 *  shown (scrim spec section 3, "Shown"). */
export const SHOWN_MIN = 4;
/** Players, ringers and spectators one side may list. */
export const PEOPLE_PER_SIDE = 12;
export const NO_SHOW_WINDOW_DAYS = 30;
/** A campaign with too little history is assumed to take this long. */
export const DEFAULT_CAMPAIGN_MINUTES = 60;
/** An invite nobody confirms expires this long after it was made... */
export const UNCONFIRMED_TTL_MS = 24 * 3_600_000;
/** ...or this long before the start, whichever comes first. */
export const UNCONFIRMED_CUTOFF_MS = 30 * 60_000;

export const iso = (ms: number): string => new Date(ms).toISOString();

export interface BookingLimits {
  minMinutes: number; maxMinutes: number; daysAhead: number; playlistMax: number; maxUpcoming: number;
  reserve: number; holdLeadMinutes: number; protectMinutes: number; idleEndMinutes: number; extendMinutes: number;
}

export function bookingLimits(db: DB): BookingLimits {
  const n = (key: string, fallback: number, min: number, max: number) => settingNumber(db, key, fallback, { integer: true, min, max });
  const holdLeadMinutes = n('booking_hold_lead_minutes', 15, 5, 60);
  return {
    minMinutes: n('booking_min_minutes', 60, 30, 360),
    maxMinutes: n('booking_max_minutes', 180, 30, 360),
    daysAhead: n('booking_days_ahead', 14, 1, 60),
    playlistMax: n('booking_playlist_max', 4, 1, 8),
    maxUpcoming: n('booking_max_upcoming', 4, 1, 20),
    reserve: n('pug_reserve_servers', 2, 0, 10),
    holdLeadMinutes,
    // Never shorter than the lead: a box kept back must still be kept at T-lead.
    protectMinutes: Math.max(holdLeadMinutes, n('booking_protect_minutes', 75, 5, 180)),
    idleEndMinutes: n('booking_idle_end_minutes', 10, 5, 60),
    extendMinutes: n('booking_extend_minutes', 30, 15, 120),
  };
}

function enabledServers(db: DB, region: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM servers WHERE enabled = 1 AND region = ?').get(region) as { n: number }).n;
}

/**
 * The capacity rule: at every moment of [startMs, endMs), enabled servers in
 * the region minus overlapping bookings stays at or above pug_reserve_servers.
 * Null when the new booking fits; otherwise the first moment it would not.
 *
 * Overlap is half-open, so back-to-back bookings never overlap. The number of
 * bookings running at once only rises at a booking's start, so checking the
 * new booking's own start and every other start inside it is enough.
 */
export function capacityProblem(db: DB, o: { region: string; startMs: number; endMs: number; exceptId?: number }): number | null {
  const room = enabledServers(db, o.region) - bookingLimits(db).reserve;
  if (room < 1) return o.startMs;
  const rows = (db.prepare(
    `SELECT starts_at, ends_at FROM bookings
      WHERE region = ? AND state IN ${OPEN_STATES_SQL} AND ending_at IS NULL AND id != ?
        AND starts_at < ? AND ends_at > ?`,
  ).all(o.region, o.exceptId ?? 0, iso(o.endMs), iso(o.startMs)) as { starts_at: string; ends_at: string }[])
    .map((r) => ({ s: Date.parse(r.starts_at), e: Date.parse(r.ends_at) }));
  const points = [o.startMs, ...rows.map((r) => r.s).filter((s) => s > o.startMs)].sort((x, y) => x - y);
  for (const t of points) {
    const running = rows.filter((r) => r.s <= t && r.e > t).length;
    if (running + 1 > room) return t;
  }
  return null;
}

/** Who an allowance belongs to: a team, or the captain of a pickup group
 *  (scrim spec section 3: a pickup group's record is its captain's). */
export type Party = { teamId: number } | { captain: string };

function partyWhere(party: Party): { sql: string; arg: number | string } {
  return 'teamId' in party
    ? { sql: 's.team_id = ?', arg: party.teamId }
    : { sql: 's.team_id IS NULL AND s.captain_steamid = ?', arg: party.captain };
}

/** Open bookings the party is a confirmed side of. */
export function upcomingCount(db: DB, party: Party): number {
  const w = partyWhere(party);
  return (db.prepare(
    `SELECT COUNT(DISTINCT b.id) AS n FROM bookings b JOIN booking_sides s ON s.booking_id = b.id
      WHERE ${w.sql} AND s.confirmed_at IS NOT NULL AND b.state IN ${OPEN_STATES_SQL} AND b.ending_at IS NULL`,
  ).get(w.arg) as { n: number }).n;
}

export function recentNoShows(db: DB, party: Party, nowMs: number): number {
  const w = partyWhere(party);
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM booking_sides s WHERE ${w.sql} AND s.no_show_at IS NOT NULL AND s.no_show_at > ?`,
  ).get(w.arg, iso(nowMs - NO_SHOW_WINDOW_DAYS * 86_400_000)) as { n: number }).n;
}

export function allowance(db: DB, party: Party, nowMs: number): number {
  return Math.max(1, bookingLimits(db).maxUpcoming - recentNoShows(db, party, nowMs));
}

/**
 * How long this campaign usually takes, in minutes: the median of its last 30
 * completed PUGs, from going live to the end, ignoring anything under 10
 * minutes or over 4 hours (aborts, a box left running). With fewer than 3
 * such games, DEFAULT_CAMPAIGN_MINUTES.
 */
export function typicalCampaignMinutes(db: DB, campaign: string): number {
  const mins = (db.prepare(
    `SELECT (julianday(ended_at) - julianday(went_live_at)) * 1440 AS m FROM matches
      WHERE ${completedPug()} AND campaign = ? AND went_live_at IS NOT NULL AND ended_at IS NOT NULL
      ORDER BY id DESC LIMIT 30`,
  ).all(campaign) as { m: number }[]).map((r) => r.m).filter((m) => m >= 10 && m <= 240).sort((a, b) => a - b);
  if (mins.length < 3) return DEFAULT_CAMPAIGN_MINUTES;
  const mid = Math.floor(mins.length / 2);
  return Math.round(mins.length % 2 ? mins[mid] : (mins[mid - 1] + mins[mid]) / 2);
}

export function playlistMinutes(db: DB, playlist: string[]): number {
  return playlist.reduce((sum, c) => sum + typicalCampaignMinutes(db, c), 0);
}

/**
 * Confirmed bookings without a box that start within `withinMinutes` of now
 * (or should already have started): how many idle boxes the queue, practice
 * leases and side games must leave alone right now (claimIdle), or how many
 * bookings are waiting on a box at all (withinMinutes = the hold lead).
 */
export function bookingsDue(db: DB, nowMs: number, withinMinutes: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM bookings b
      WHERE b.state = 'scheduled' AND b.server_id IS NULL AND b.ending_at IS NULL AND b.starts_at <= ?
        AND NOT EXISTS (SELECT 1 FROM booking_sides s WHERE s.booking_id = b.id AND s.confirmed_at IS NULL)`,
  ).get(iso(nowMs + withinMinutes * 60_000)) as { n: number }).n;
}
