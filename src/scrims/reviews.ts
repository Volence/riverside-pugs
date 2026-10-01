import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { myTeams } from '../teams/teams.js';
import { iso, partyWhere, type Party } from '../bookings/rules.js';
import { actingSides, getBooking, logBookingEvent, type BookingRow, type Result, type Side } from '../bookings/bookings.js';

/**
 * Private reviews of the opponent after a booked scrim (scrim spec section 4;
 * plan 2 Rulings 5 and 6). Each side's captain or co-captain (team) or its
 * captain (pickup) leaves one thumbs up or down with optional tags, editable
 * for 7 days after the booking closes as ended or no_show.
 *
 * Privacy: a single review only ever leaves this module through staffReviews,
 * and the reviewer's own side's row through ownReview. A team sees
 * reviewSummary of the reviews it received; the toxic flag is for staff only.
 */

export const REVIEW_TAGS = ['on_time', 'good_comms', 'good_sport', 'left_early', 'toxic'] as const;
export type ReviewTag = (typeof REVIEW_TAGS)[number];
export const REVIEW_TAG_LABELS: Record<ReviewTag, string> = {
  on_time: 'On time', good_comms: 'Good comms', good_sport: 'Good sport', left_early: 'Left early', toxic: 'Toxic',
};
export const REVIEW_WINDOW_DAYS = 7;
/** Reviews received before a percentage or top tag is shown (Ruling 5). */
export const SUMMARY_MIN = 3;
/** Toxic tags from distinct bookings inside TOXIC_DAYS that raise the flag (Ruling 6). */
export const TOXIC_MIN = 3;
export const TOXIC_DAYS = 60;
const DAY_MS = 86_400_000;

interface ReviewRow {
  id: number; booking_id: number; by_side: Side; reviewer: string; thumbs: number; tags_json: string; created_at: string; updated_at: string;
}

/** When the booking closed: ended_at once the box is back, ending_at until then. */
const closedAt = (b: BookingRow): string | null => b.ended_at ?? b.ending_at;

/** A scrim booking that closed as ended or no_show, so it can be reviewed at all. */
export function reviewable(b: BookingRow): boolean {
  return b.purpose === 'scrim' && (b.state === 'ended' || b.state === 'no_show') && closedAt(b) !== null;
}

/** Still inside the 7 days after the close. */
export function reviewOpen(b: BookingRow, nowMs: number): boolean {
  const at = closedAt(b);
  return reviewable(b) && at !== null && nowMs < Date.parse(at) + REVIEW_WINDOW_DAYS * DAY_MS;
}

function parseTags(raw: unknown): ReviewTag[] | null {
  if (!Array.isArray(raw) || raw.length > REVIEW_TAGS.length) return null;
  if (!raw.every((t) => typeof t === 'string' && (REVIEW_TAGS as readonly string[]).includes(t))) return null;
  if (new Set(raw).size !== raw.length) return null;
  return raw as ReviewTag[];
}

const parseTagsJson = (json: string): ReviewTag[] => {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((t): t is ReviewTag => (REVIEW_TAGS as readonly string[]).includes(t as string)) : [];
  } catch {
    return [];
  }
};

export function submitReview(db: DB, o: { bookingId: number; by: string; thumbs: unknown; tags: unknown; now?: Date }): Result<{ side: Side }> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<{ side: Side }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return { ok: false, error: 'not_found' };
    if (!reviewable(b)) return { ok: false, error: 'wrong_state' };
    // Someone who manages both sides would be reviewing themselves.
    const acting = actingSides(db, b.id, o.by);
    if (acting.length !== 1) return { ok: false, error: 'not_manager' };
    const side = acting[0];
    if (!reviewOpen(b, now.getTime())) return { ok: false, error: 'review_closed' };
    const tags = parseTags(o.tags);
    if ((o.thumbs !== 1 && o.thumbs !== -1) || tags === null) return { ok: false, error: 'bad_review' };
    const t = now.toISOString();
    const edit = db.prepare('SELECT 1 FROM scrim_reviews WHERE booking_id = ? AND by_side = ?').get(b.id, side) !== undefined;
    db.prepare(
      `INSERT INTO scrim_reviews (booking_id, by_side, reviewer, thumbs, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (booking_id, by_side) DO UPDATE SET reviewer = excluded.reviewer, thumbs = excluded.thumbs,
         tags_json = excluded.tags_json, updated_at = excluded.updated_at`,
    ).run(b.id, side, o.by, o.thumbs, JSON.stringify(tags), t, t);
    // The audit row says who reviewed, never what they said.
    logBookingEvent(db, b.id, o.by, 'reviewed', { side, edit }, now);
    return { ok: true, value: { side } };
  })();
}

/** The review this side wrote on this booking, for its own managers. */
export function ownReview(db: DB, bookingId: number, side: Side): { thumbs: 1 | -1; tags: ReviewTag[] } | null {
  const r = db.prepare('SELECT * FROM scrim_reviews WHERE booking_id = ? AND by_side = ?').get(bookingId, side) as ReviewRow | undefined;
  return r ? { thumbs: r.thumbs as 1 | -1, tags: parseTagsJson(r.tags_json) } : null;
}

export interface StaffReview {
  side: Side; reviewer: string; reviewerName: string; thumbs: 1 | -1; tags: ReviewTag[]; createdAt: string; updatedAt: string;
}

/** Both sides' reviews of one booking. Staff only. */
export function staffReviews(db: DB, bookingId: number): StaffReview[] {
  return (db.prepare('SELECT * FROM scrim_reviews WHERE booking_id = ? ORDER BY by_side').all(bookingId) as ReviewRow[]).map((r) => ({
    side: r.by_side, reviewer: r.reviewer, reviewerName: getPlayer(db, r.reviewer)?.name ?? r.reviewer,
    thumbs: r.thumbs as 1 | -1, tags: parseTagsJson(r.tags_json), createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

/** Reviews this party received: written by the other side of a booking where
 *  the party was a side. */
function received(db: DB, party: Party): ReviewRow[] {
  const w = partyWhere(party);
  return db.prepare(
    `SELECT r.* FROM scrim_reviews r JOIN booking_sides s ON s.booking_id = r.booking_id AND s.side != r.by_side
      WHERE ${w.sql} ORDER BY r.id`,
  ).all(w.arg) as ReviewRow[];
}

/** count is absent for a non-staff viewer while under SUMMARY_MIN. */
export interface ReviewSummary { count?: number; positivePct: number | null; topTag: ReviewTag | null }

/** The aggregate a team (or pickup captain) may see of the reviews it
 *  received. Under SUMMARY_MIN there is no percentage and no top tag, so a
 *  single review cannot be read back out of it, and only staff get the count:
 *  a team watching it tick from 0 to 1 after a scrim would learn that the
 *  opponent reviewed them. Tied tags go to the first in REVIEW_TAGS order. */
export function reviewSummary(db: DB, party: Party, viewer: { staff: boolean }): ReviewSummary {
  const rows = received(db, party);
  if (rows.length < SUMMARY_MIN) return viewer.staff ? { count: rows.length, positivePct: null, topTag: null } : { positivePct: null, topTag: null };
  const counts = new Map<ReviewTag, number>();
  for (const r of rows) for (const t of parseTagsJson(r.tags_json)) counts.set(t, (counts.get(t) ?? 0) + 1);
  let topTag: ReviewTag | null = null;
  for (const t of REVIEW_TAGS) if ((counts.get(t) ?? 0) > (topTag ? counts.get(topTag)! : 0)) topTag = t;
  return {
    count: rows.length,
    positivePct: Math.round((100 * rows.filter((r) => r.thumbs === 1).length) / rows.length),
    topTag,
  };
}

/** Ruling 6: TOXIC_MIN or more toxic tags from distinct bookings, each given
 *  (created_at) inside the last TOXIC_DAYS. Staff only. */
export function toxicFlag(db: DB, party: Party, nowMs: number = Date.now()): boolean {
  const since = iso(nowMs - TOXIC_DAYS * DAY_MS);
  const bookings = new Set(received(db, party)
    .filter((r) => r.created_at > since && parseTagsJson(r.tags_json).includes('toxic'))
    .map((r) => r.booking_id));
  return bookings.size >= TOXIC_MIN;
}

/** A player's review aggregates and toxic flags for the staff desks: as a
 *  pickup captain, and each current team's. Staff only. */
export interface ScrimReviews {
  pickup: { summary: ReviewSummary; toxic: boolean };
  teams: { teamId: number; slug: string; name: string; tag: string; summary: ReviewSummary; toxic: boolean }[];
}

export function scrimReviewsOf(db: DB, steamid: string, nowMs: number = Date.now()): ScrimReviews {
  return {
    pickup: { summary: reviewSummary(db, { captain: steamid }, { staff: true }), toxic: toxicFlag(db, { captain: steamid }, nowMs) },
    teams: myTeams(db, steamid).map((t) => ({
      teamId: t.id, slug: t.slug, name: t.name, tag: t.tag,
      summary: reviewSummary(db, { teamId: t.id }, { staff: true }), toxic: toxicFlag(db, { teamId: t.id }, nowMs),
    })),
  };
}

/** Claim the one review ask for this booking: true the first time only, when
 *  it also writes the review_asked event, so a second settle sends nothing. */
export function claimReviewAsk(db: DB, bookingId: number, now: Date): boolean {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM booking_events WHERE booking_id = ? AND event = 'review_asked'").get(bookingId)) return false;
    logBookingEvent(db, bookingId, null, 'review_asked', {}, now);
    return true;
  })();
}
