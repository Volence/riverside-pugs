import type { DB } from '../db.js';
import { settingNumber } from '../settings.js';
import { completedPug } from '../matchKinds.js';
import type { BookingRow } from './bookings.js';

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
/** The grace to connect when a booking's rules carry none (plan T3c Ruling 7). */
export const DEFAULT_GRACE_MINUTES = 15;
/** A campaign with too little history is assumed to take this long. */
export const DEFAULT_CAMPAIGN_MINUTES = 60;
/** An invite nobody confirms expires this long after it was made... */
export const UNCONFIRMED_TTL_MS = 24 * 3_600_000;
/** ...or this long before the start, whichever comes first. A booking made
 *  less than this far ahead has until its start instead. */
export const UNCONFIRMED_CUTOFF_MS = 30 * 60_000;

export const iso = (ms: number): string => new Date(ms).toISOString();

export interface BookingLimits {
  minMinutes: number; daysAhead: number; playlistMax: number; maxUpcoming: number;
  reserve: number; holdLeadMinutes: number; protectMinutes: number; idleEndMinutes: number;
  goneMinutes: number; recoverWaitMinutes: number;
}

export function bookingLimits(db: DB): BookingLimits {
  const n = (key: string, fallback: number, min: number, max: number) => settingNumber(db, key, fallback, { integer: true, min, max });
  const holdLeadMinutes = n('booking_hold_lead_minutes', 15, 5, 60);
  // Crash recovery (plan 5): clamped to the bound rather than rejected to the
  // fallback, since a number outside 2..15 or 5..60 still means something
  // close to that edge, not "ignore this and use the default instead".
  const bounded = (key: string, fallback: number, min: number, max: number) =>
    Math.min(max, Math.max(min, settingNumber(db, key, fallback, { integer: true })));
  return {
    minMinutes: n('booking_min_minutes', 60, 30, 360),
    daysAhead: n('booking_days_ahead', 14, 1, 60),
    playlistMax: n('booking_playlist_max', 4, 1, 8),
    maxUpcoming: n('booking_max_upcoming', 4, 1, 20),
    reserve: n('pug_reserve_servers', 2, 0, 10),
    holdLeadMinutes,
    // Never shorter than the lead: a box kept back must still be kept at T-lead.
    protectMinutes: Math.max(holdLeadMinutes, n('booking_protect_minutes', 75, 5, 180)),
    idleEndMinutes: n('booking_idle_end_minutes', 10, 5, 60),
    goneMinutes: bounded('booking_gone_minutes', 3, 2, 15),
    recoverWaitMinutes: bounded('booking_recover_wait_minutes', 20, 5, 60),
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

export function partyWhere(party: Party): { sql: string; arg: number | string } {
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
    `SELECT COUNT(*) AS n FROM booking_sides s
      WHERE ${w.sql} AND s.no_show_at IS NOT NULL AND s.no_show_at > ? AND s.excused_at IS NULL`,
  ).get(w.arg, iso(nowMs - NO_SHOW_WINDOW_DAYS * 86_400_000)) as { n: number }).n;
}

/** A side's own cancel this close to the start is a late cancel (scrim spec
 *  section 3a); 0 means never. */
export function lateCancelHours(db: DB): number {
  return settingNumber(db, 'scrim_late_cancel_hours', 2, { integer: true, min: 0, max: 24 });
}

/**
 * Whether this booking ended in a late cancel by `cancel_side`: a side's own
 * cancel (end_reason 'cancelled', so never a staff, decline or system end)
 * of a booked scrim, made less than scrim_late_cancel_hours before the start.
 * "Booked" means both sides had confirmed: pulling an invite nobody accepted
 * yet costs nobody anything. Excuses are the caller's business.
 */
export function isLateCancel(db: DB, b: BookingRow): boolean {
  if (b.state !== 'cancelled' || b.end_reason !== 'cancelled' || b.cancel_side === null || b.ending_at === null) return false;
  const hours = lateCancelHours(db);
  if (hours === 0) return false;
  if (Date.parse(b.starts_at) - Date.parse(b.ending_at) >= hours * 3_600_000) return false;
  return !db.prepare('SELECT 1 FROM booking_sides WHERE booking_id = ? AND confirmed_at IS NULL').get(b.id);
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

/** Setup and ready-up, once per booking, in the slot estimate. */
export const ESTIMATE_BASE_MINUTES = 15;
/** Slack per campaign for a slow round, in the slot estimate. */
export const ESTIMATE_SLACK_MINUTES = 10;

const upToStep = (m: number): number => Math.ceil(m / STEP_MINUTES) * STEP_MINUTES;

/**
 * The slot a booking of these campaigns holds (bookings by campaign, Ruling
 * 1): 15 minutes, plus each campaign's typical length and 10, rounded up to
 * the 30 minute step and raised to booking_min_minutes. It is never capped:
 * the campaign count (booking_playlist_max) is the only limit on a playlist,
 * whatever the slot it works out to.
 */
export function estimateMinutes(db: DB, playlist: string[]): number {
  const raw = ESTIMATE_BASE_MINUTES + playlist.reduce((sum, c) => sum + typicalCampaignMinutes(db, c) + ESTIMATE_SLACK_MINUTES, 0);
  return Math.max(bookingLimits(db).minMinutes, upToStep(raw));
}

/** estimateMinutes' inputs for these campaigns, so a form can show the
 *  estimate live as campaigns are ticked (GET options). */
export function estimateOptions(db: DB, campaigns: string[]): {
  perCampaign: Record<string, number>; base: number; slack: number; step: number; min: number;
} {
  const limits = bookingLimits(db);
  return {
    perCampaign: Object.fromEntries(campaigns.map((c) => [c, typicalCampaignMinutes(db, c)])),
    base: ESTIMATE_BASE_MINUTES, slack: ESTIMATE_SLACK_MINUTES, step: STEP_MINUTES, min: limits.minMinutes,
  };
}

/** How far +1 campaign moves the slot's end (Ruling 5): that campaign's
 *  typical length, or DEFAULT_CAMPAIGN_MINUTES when none is named, plus 10,
 *  rounded up to the step. */
export function addCampaignMinutes(db: DB, campaign: string | null): number {
  return upToStep((campaign ? typicalCampaignMinutes(db, campaign) : DEFAULT_CAMPAIGN_MINUTES) + ESTIMATE_SLACK_MINUTES);
}

/** Idle boxes claimIdle keeps back: one per confirmed booking without a box
 *  that starts within the window, and one per running booking whose box was
 *  given up and is waiting for another (plan 5: the only time a booking is
 *  ahead of the PUG queue). */
export function bookingsDue(db: DB, nowMs: number, withinMinutes: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM bookings b
      WHERE b.server_id IS NULL AND b.ending_at IS NULL AND (
        (b.state = 'scheduled' AND b.starts_at <= ? AND b.ends_at > ?
          AND NOT EXISTS (SELECT 1 FROM booking_sides s WHERE s.booking_id = b.id AND s.confirmed_at IS NULL))
        OR (b.state IN ('ready','active') AND b.waiting_since IS NOT NULL))`,
  ).get(iso(nowMs + withinMinutes * 60_000), iso(nowMs)) as { n: number }).n;
}
