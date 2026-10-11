import type { DB } from '../db.js';
import { settingNumber } from '../settings.js';
import { completedPug } from '../matchKinds.js';
import { campaignRegistry } from '../campaignRegistry.js';
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

export type BookingPurpose = 'scrim' | 'tournament';

/** Who gets the next free box among bookings (server priority, Ruling 2):
 *  a tournament match before a scrim, then the earlier start, then the
 *  older row. The runner walks its queue in this order; the holds view
 *  (src/serverHolds.ts) keeps one rank for every booking. */
export const PURPOSE_RANK: Record<BookingPurpose, number> = { tournament: 0, scrim: 1 };

export function byPriority(a: Pick<BookingRow, 'purpose' | 'starts_at' | 'id'>, b: Pick<BookingRow, 'purpose' | 'starts_at' | 'id'>): number {
  return PURPOSE_RANK[a.purpose] - PURPOSE_RANK[b.purpose]
    || (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0)
    || a.id - b.id;
}

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
  reserve: number; scrimMax: number; holdLeadMinutes: number; protectMinutes: number; idleEndMinutes: number;
  goneMinutes: number; recoverWaitMinutes: number; closeGraceMinutes: number;
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
    scrimMax: n('scrim_max_servers', 2, 0, 10),
    holdLeadMinutes,
    // Never shorter than the lead: a box kept back must still be kept at T-lead.
    protectMinutes: Math.max(holdLeadMinutes, n('booking_protect_minutes', 75, 5, 180)),
    idleEndMinutes: n('booking_idle_end_minutes', 10, 5, 60),
    goneMinutes: bounded('booking_gone_minutes', 3, 2, 15),
    recoverWaitMinutes: bounded('booking_recover_wait_minutes', 20, 5, 60),
    closeGraceMinutes: n('booking_close_grace_minutes', 5, 1, 30),
  };
}

function enabledServers(db: DB, region: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM servers WHERE enabled = 1 AND region = ?').get(region) as { n: number }).n;
}

/**
 * The capacity rule: at every moment of [startMs, endMs), enabled servers in
 * the region minus overlapping bookings stays at or above pug_reserve_servers,
 * and for a scrim (the default purpose) the scrims running at once stay at or
 * under scrim_max_servers (server priority, Ruling 3). Null when the new
 * booking fits; otherwise the first moment it would not.
 *
 * Overlap is half-open, so back-to-back bookings never overlap. The number of
 * bookings running at once only rises at a booking's start, so checking the
 * new booking's own start and every other start inside it is enough. A
 * tournament booking and a scheduled match count toward the room but never
 * toward the scrim cap.
 */
/** How long a booking still holding a box past its slot (a game running
 *  over, Ruling 4, or the close grace) is assumed to keep it from now, and a
 *  box in its wind-down (restarting before it goes back to the pool). */
const OVERRUN_HOLD_MS = 30 * 60_000;
const WIND_DOWN_HOLD_MS = 10 * 60_000;

export function capacityProblem(db: DB, o: { region: string; startMs: number; endMs: number; exceptId?: number; purpose?: BookingPurpose; nowMs?: number }): number | null {
  const nowMs = o.nowMs ?? Date.now();
  const limits = bookingLimits(db);
  const room = enabledServers(db, o.region) - limits.reserve;
  if (room < 1) return o.startMs;
  const scrim = (o.purpose ?? 'scrim') === 'scrim';
  if (scrim && limits.scrimMax < 1) return o.startMs;
  // A booking still holding a box counts until it lets go of it, not until
  // its slot's end: one running over (or winding down) still has the box.
  const effectiveEnd = (r: { ends_at: string; close_at: string | null; ending_at: string | null; server_id: number | null }): number => {
    const end = Date.parse(r.ends_at);
    if (r.server_id === null) return end;
    if (r.ending_at !== null) return Math.max(end, nowMs + WIND_DOWN_HOLD_MS);
    if (end > nowMs) return end;
    return Math.max(r.close_at ? Date.parse(r.close_at) : 0, nowMs + OVERRUN_HOLD_MS);
  };
  const rows = [
    ...(db.prepare(
      `SELECT starts_at, ends_at, purpose, close_at, ending_at, server_id FROM bookings
        WHERE region = ? AND id != ? AND starts_at < ?
          AND ((state IN ${OPEN_STATES_SQL} AND ending_at IS NULL) OR (server_id IS NOT NULL AND ended_at IS NULL))`,
    ).all(o.region, o.exceptId ?? 0, iso(o.endMs)) as { starts_at: string; ends_at: string; purpose: BookingPurpose; close_at: string | null; ending_at: string | null; server_id: number | null }[])
      .map((r) => ({ s: Date.parse(r.starts_at), e: effectiveEnd(r), scrim: r.purpose === 'scrim' }))
      .filter((r) => r.e > o.startMs),
    // Plan T4 Ruling 5: a scheduled tournament match holds a box before it is booked.
    ...scheduledMatchSlots(db, o.region, o.startMs, o.endMs).map((r) => ({ ...r, scrim: false })),
  ];
  const points = [o.startMs, ...rows.map((r) => r.s).filter((s) => s > o.startMs)].sort((x, y) => x - y);
  for (const t of points) {
    const running = rows.filter((r) => r.s <= t && r.e > t);
    if (running.length + 1 > room) return t;
    if (scrim && running.filter((r) => r.scrim).length + 1 > limits.scrimMax) return t;
  }
  return null;
}

/** Boxes scrims hold right now, from the hold to the end of the wind-down
 *  (the Live board's "N of max", Ruling 9). With a region, that region only. */
export function scrimsHolding(db: DB, region: string | null = null): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM bookings WHERE purpose = 'scrim' AND server_id IS NOT NULL AND ended_at IS NULL AND (? IS NULL OR region = ?)",
  ).get(region, region) as { n: number }).n;
}

/** Who an allowance belongs to: a team, or the captain of a pickup group
 *  (scrim spec section 3: a pickup group's record is its captain's). */
export type Party = { teamId: number } | { captain: string };

export function partyWhere(party: Party): { sql: string; arg: number | string } {
  return 'teamId' in party
    ? { sql: 's.team_id = ?', arg: party.teamId }
    : { sql: 's.team_id IS NULL AND s.captain_steamid = ?', arg: party.captain };
}

/** Open scrim bookings the party is a confirmed side of (tournament bookings
 *  do not count toward the booking limit). */
export function upcomingCount(db: DB, party: Party): number {
  const w = partyWhere(party);
  return (db.prepare(
    `SELECT COUNT(DISTINCT b.id) AS n FROM bookings b JOIN booking_sides s ON s.booking_id = b.id
      WHERE ${w.sql} AND b.purpose <> 'tournament' AND s.confirmed_at IS NOT NULL AND b.state IN ${OPEN_STATES_SQL} AND b.ending_at IS NULL`,
  ).get(w.arg) as { n: number }).n;
}

/** Whether the party is a confirmed side of an open booking (any purpose)
 *  whose slot overlaps [startMs, endMs), leaving out booking `exceptId`.
 *  Half-open, as capacityProblem: back to back is not an overlap. One side
 *  never holds two slots at once (owner, 2026-10-11); an invite the side has
 *  not confirmed yet does not count against it. */
export function bookedDuring(db: DB, party: Party, startMs: number, endMs: number, exceptId = 0): boolean {
  const w = partyWhere(party);
  return db.prepare(
    `SELECT 1 FROM bookings b JOIN booking_sides s ON s.booking_id = b.id
      WHERE ${w.sql} AND s.confirmed_at IS NOT NULL AND b.state IN ${OPEN_STATES_SQL} AND b.ending_at IS NULL
        AND b.id != ? AND b.starts_at < ? AND b.ends_at > ? LIMIT 1`,
  ).get(w.arg, exceptId, iso(endMs), iso(startMs)) !== undefined;
}

export function recentNoShows(db: DB, party: Party, nowMs: number): number {
  const w = partyWhere(party);
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM booking_sides s JOIN bookings b ON b.id = s.booking_id
      WHERE ${w.sql} AND b.purpose <> 'tournament' AND s.no_show_at IS NOT NULL AND s.no_show_at > ? AND s.excused_at IS NULL`,
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

/** Whole-campaign games needed before measured lengths replace the PUG-only
 *  figure, and how many of the latest are used (owner, 2026-10-11: the
 *  board said "about 2 h 30" for Dark Wood plus Blood Harvest, and Dark Wood
 *  alone took 90 minutes). */
export const MEASURED_MIN_GAMES = 5;
export const MEASURED_LAST_GAMES = 20;

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How long this campaign really takes, in minutes: the median of the last
 * MEASURED_LAST_GAMES games of any kind (PUG, scrim or tournament) that played
 * the whole campaign, or null with fewer than MEASURED_MIN_GAMES of them.
 *
 * Whole campaign: completed (never aborted, so never voided either, since a
 * voided game is stored as aborted), not a !gg forfeit, not replayed from a
 * later map after a restart (restored_at_map), and a match_maps row for every
 * map the campaign has (at least one when the registry does not list its
 * maps). Going live is went_live_at for a match the site set up, and
 * created_at for one adopted live from the box (an in-game PUG, every booking
 * game), which never stamps went_live_at and is created at go-live. The same
 * 10 minute to 4 hour window as below keeps out a box left running.
 *
 * Every kind on purpose: this is how long the campaign holds a server, and
 * the raw filter is allowlisted in tests/matchKindGuard.test.ts.
 */
export function measuredCampaignMinutes(db: DB, campaign: string): number | null {
  const want = Math.max(1, campaignRegistry(db).get(campaign)?.maps.length ?? 0);
  const rows = db.prepare(
    `SELECT (julianday(m.ended_at) - julianday(COALESCE(m.went_live_at, m.created_at))) * 1440 AS mins,
            (SELECT COUNT(*) FROM match_maps mm WHERE mm.match_id = m.id) AS maps
       FROM matches m
      WHERE m.state = 'completed' AND m.campaign = ? AND m.ended_at IS NOT NULL
        AND m.forfeit_team IS NULL AND m.restored_at_map IS NULL
      ORDER BY m.id DESC LIMIT 200`,
  ).all(campaign) as { mins: number; maps: number }[];
  const mins = rows.filter((r) => r.maps >= want && r.mins >= 10 && r.mins <= 240)
    .slice(0, MEASURED_LAST_GAMES).map((r) => r.mins).sort((a, b) => a - b);
  return mins.length < MEASURED_MIN_GAMES ? null : Math.round(median(mins));
}

/**
 * How long this campaign usually takes, in minutes: measuredCampaignMinutes
 * once there are enough whole-campaign games. Before that, the median of its
 * last 30 completed PUGs from going live to the end, ignoring anything under
 * 10 minutes or over 4 hours (aborts, a box left running); with fewer than 3
 * such games, DEFAULT_CAMPAIGN_MINUTES.
 */
export function typicalCampaignMinutes(db: DB, campaign: string): number {
  const measured = measuredCampaignMinutes(db, campaign);
  if (measured !== null) return measured;
  const mins = (db.prepare(
    `SELECT (julianday(ended_at) - julianday(went_live_at)) * 1440 AS m FROM matches
      WHERE ${completedPug()} AND campaign = ? AND went_live_at IS NOT NULL AND ended_at IS NOT NULL
      ORDER BY id DESC LIMIT 30`,
  ).all(campaign) as { m: number }[]).map((r) => r.m).filter((m) => m >= 10 && m <= 240).sort((a, b) => a - b);
  if (mins.length < 3) return DEFAULT_CAMPAIGN_MINUTES;
  return Math.round(median(mins));
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

/** The seeded default of event_slot_minutes (plan T5 Ruling 2): a Bo1 with
 *  setup, the grace to connect and a possible tiebreak. */
export const EVENT_SLOT_MINUTES = 120;

/** The match statuses a scheduled tournament match can hold before its
 *  booking exists: pending (a later round whose teams are not known yet still
 *  needs its box at its time), waiting, and the room phases ahead of the
 *  booking. Never a resolved status (done, forfeit, bye) or a phase that
 *  already has its booking (ledger CARRY to Task 5). admin_hold is left out
 *  on purpose: a held match waits on staff, who set a new time on release.
 *  A bracket's pending row never waits on a permanent bye: syncBracket
 *  writes only matches with both opponent slots, and deletes a row once the
 *  library turns a slot into a bye (see the Task 5 report). */
const UNBOOKED_MATCH_SQL = "('pending','waiting','veto','lineup','booking')";

/**
 * Scheduled tournament matches not yet booked, as slots (plan T4 Ruling 5):
 * each waits in a live window stage of a live event with a time, no booking
 * and no winner, and holds EVENT_SLOT_MINUTES from its time. Once the series
 * engine books it, the booking row counts instead. With a region, that
 * region's events only. Only slots overlapping [fromMs, toMs) come back.
 */
export function scheduledMatchSlots(db: DB, region: string | null, fromMs: number, toMs: number): { s: number; e: number }[] {
  const slot = settingNumber(db, 'event_slot_minutes', EVENT_SLOT_MINUTES, { integer: true, min: 60, max: 360 }) * 60_000;
  return (db.prepare(
    `SELECT m.scheduled_at FROM event_matches m
       JOIN event_stages s ON s.id = m.stage_id JOIN events e ON e.id = m.event_id
      WHERE e.status = 'live' AND s.status = 'live' AND s.scheduling = 'window'
        AND m.status IN ${UNBOOKED_MATCH_SQL} AND m.booking_id IS NULL AND m.winner_entry IS NULL
        AND m.scheduled_at IS NOT NULL AND (? IS NULL OR e.region = ?) AND m.scheduled_at < ? AND m.scheduled_at > ?
      ORDER BY m.scheduled_at, m.id`,
  ).all(region, region, iso(toMs), iso(fromMs - slot)) as { scheduled_at: string }[])
    .map((r) => { const s = Date.parse(r.scheduled_at); return { s, e: s + slot }; });
}

/** Idle boxes claimIdle keeps back: one per confirmed booking without a box
 *  that starts within the window, one per running booking whose box was
 *  given up and is waiting for another (plan 5: the only time a booking is
 *  ahead of the PUG queue), and one per scheduled tournament match not yet
 *  booked whose slot overlaps the window (plan T4 Ruling 5). */
export function bookingsDue(db: DB, nowMs: number, withinMinutes: number): number {
  const bookings = (db.prepare(
    `SELECT COUNT(*) AS n FROM bookings b
      WHERE b.server_id IS NULL AND b.ending_at IS NULL AND (
        (b.state = 'scheduled' AND b.starts_at <= ? AND b.ends_at > ?
          AND NOT EXISTS (SELECT 1 FROM booking_sides s WHERE s.booking_id = b.id AND s.confirmed_at IS NULL))
        OR (b.state IN ('ready','active') AND b.waiting_since IS NOT NULL))`,
  ).get(iso(nowMs + withinMinutes * 60_000), iso(nowMs)) as { n: number }).n;
  return bookings + scheduledMatchSlots(db, null, nowMs, nowMs + withinMinutes * 60_000).length;
}
