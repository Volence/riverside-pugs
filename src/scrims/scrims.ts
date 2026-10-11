import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { inGoodStanding } from '../standing.js';
import { getSetting, settingNumber } from '../settings.js';
import { findSlurs } from '../slurs.js';
import { activeMembers, getTeam, myTeams, roleOf } from '../teams/teams.js';
import {
  BOOKING_ERRORS, canUse, confirmBooking, createBooking, getBooking, managedSides, parsePlaylist, parseStart,
  sideRow, type BookingError,
} from '../bookings/bookings.js';
import { allowance, bookedDuring, bookingLimits, capacityProblem, estimateMinutes, iso, upcomingCount, type Party } from '../bookings/rules.js';
import { inNight } from './night.js';
import { ACCEPT_CUTOFF_MS, openPostAt, nearestFreeSlot, proposedPlaylist, showSr, sideSr, srFits, type ScrimSide } from './rules.js';
import { reliability, type Reliability } from './reliability.js';
import { blocked } from './blocks.js';

/**
 * Every rule about the scrim board (spec part 4, sections 1-2; scrim board
 * plan 1). The routes and the minute tick call these and nothing else writes
 * scrim_posts or scrim_accepts.
 *
 * Each write is one better-sqlite3 transaction that re-checks its rules
 * inside, the same as bookings. A post reserves nothing; confirmAccept is the
 * one place a booking is made, by calling the booking domain (createBooking
 * by the poster, then confirmBooking by the accepter) inside its own
 * transaction, so every booking rule applies and a refusal at either step
 * leaves nothing behind.
 *
 * Rights follow CURRENT team roles, as in bookings: a team side is managed by
 * whoever is captain or co-captain of that team now; a pickup side by its
 * captain_steamid.
 */

export type PostStatus = 'open' | 'pending' | 'booked' | 'expired' | 'withdrawn';
export type AcceptStatus = 'pending' | 'chosen' | 'declined' | 'expired' | 'withdrawn';

export interface PostRow {
  id: number; side_kind: 'team' | 'pickup'; team_id: number | null; captain_steamid: string; region: string;
  starts_at: string; block_minutes: number; campaigns_json: string; sr_range: number | null; note: string;
  status: PostStatus; created_at: string; target_team_id: number | null; booking_id: number | null;
}
export interface AcceptRow {
  id: number; post_id: number; side_kind: 'team' | 'pickup'; team_id: number | null; captain_steamid: string;
  campaigns_json: string; status: AcceptStatus; created_at: string; responded_at: string | null;
}

export const SCRIM_ERRORS = {
  // A confirm passes the booking domain's refusals straight through.
  ...BOOKING_ERRORS,
  not_found: { status: 404, text: 'No such scrim post.' },
  wrong_state: { status: 409, text: 'That scrim post or acceptance is past that point.' },
  bad_sr_range: { status: 400, text: 'An SR range is open, or a whole number from 50 to 1000.' },
  bad_note: { status: 400, text: 'A note is at most 200 characters.' },
  note_slur: { status: 400, text: 'That note is not allowed.' },
  bad_target: { status: 400, text: 'Challenge another live team, not your own.' },
  bad_campaigns: { status: 400, text: 'Add campaigns from the map pool, each once, up to the limit.' },
  own_post: { status: 409, text: 'That is your own post.' },
  already_accepted: { status: 409, text: 'That side has already accepted this post.' },
  challenge_side: { status: 400, text: 'This challenge is for your team; accept it as that team.' },
  too_late: { status: 409, text: 'Too close to the start: an acceptance needs at least 30 minutes to be answered.' },
  too_many_posts: { status: 409, text: 'That side already has 3 open scrim posts. Withdraw one first.' },
  // One side, one slot (owner, 2026-10-11), and the acceptance limits that came with it.
  booked_then: { status: 409, text: 'That side already has a booking at that time.' },
  duplicate_post: { status: 409, text: 'That side already has an open post starting at that time.' },
  accept_cooldown: { status: 409, text: 'The poster declined that side less than an hour ago. Try again later, or accept another post.' },
  too_many_accepts: { status: 409, text: 'That side already has 3 pending acceptances. Withdraw one first.' },
} as const satisfies Record<string, { status: number; text: string }>;
export type ScrimError = keyof typeof SCRIM_ERRORS;
/** As bookings' Result. A refusal that came from the booking domain (in
 *  confirmAccept) carries that domain's own `text`, so SCRIM_ERRORS' scrim
 *  wording for the same code never replaces it; a `no_capacity` one also
 *  carries the nearest free slot (null when nothing within 3 hours has room).
 *  `declined` is set when a confirm declined the acceptance because the booking
 *  domain refused it in a way that can never clear (NEVER_CLEARS). */
export type ScrimResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ScrimError; text?: string; nearestSlot?: string | null; declined?: boolean };
const ok = <T>(value: T): ScrimResult<T> => ({ ok: true, value });
const fail = (error: ScrimError): { ok: false; error: ScrimError } => ({ ok: false, error });

/** A booking refusal inside confirmAccept's transaction. Thrown, not
 *  returned, so better-sqlite3 rolls back what createBooking already wrote.
 *  `step` is whose call refused: createBooking speaks for the poster's side,
 *  confirmBooking for the accepting side. */
class Refused extends Error {
  constructor(readonly code: BookingError, readonly step: 'poster' | 'accepter') {
    super(code);
  }
}

/** Booking refusals about the accepting side that waiting never clears
 *  (owner, 2026-10-11): the acceptance is declined at once. */
const NEVER_CLEARS: ReadonlySet<BookingError> = new Set<BookingError>(['not_open', 'not_player', 'bad_opponent', 'not_available']);
const ACCEPTER_GONE = 'The accepting side can no longer play this scrim, so its acceptance was declined.';
const ACCEPTER_BUSY = 'The accepting side already has a booking at that time.';
const OWN_BUSY = 'Your side already has a booking at that time.';
/** The poster reads every confirm refusal, but the booking domain words each
 *  one for the side that made the call. These say whose side it is about.
 *  A code not listed keeps the booking domain's text (not_available's never
 *  says why, on purpose). The poster's own not_open is checked before
 *  createBooking runs, so a not_open from it is the accepting side's. */
const REFUSAL_TEXT: Record<Refused['step'], Partial<Record<BookingError, string>>> = {
  poster: {
    allowance: 'Your side already has as many upcoming bookings as allowed.',
    busy_us: OWN_BUSY, busy_them: ACCEPTER_BUSY,
    not_open: ACCEPTER_GONE, not_player: ACCEPTER_GONE, bad_opponent: ACCEPTER_GONE,
  },
  accepter: {
    allowance: 'The accepting side already has as many upcoming bookings as allowed.',
    busy_us: ACCEPTER_BUSY, busy_them: OWN_BUSY,
    not_open: ACCEPTER_GONE,
  },
};

export const NOTE_MAX = 200;
const SR_RANGE_MIN = 50;
const SR_RANGE_MAX = 1000;
/** A pending acceptance nobody answers expires this long after it was made... */
export const ACCEPT_TTL_MS = 2 * 3_600_000;
/** ...or this long before the post's start, whichever comes first. Defined in
 *  rules.ts (no import cycle with bookings.ts) and re-exported here. */
export { ACCEPT_CUTOFF_MS };
/** Open or pending posts one side (a team, or a pickup captain) may hold at once. */
export const SCRIM_MAX_OPEN_POSTS = 3;
/** Pending acceptances one side may hold at once, across all posts (owner
 *  ruling 2026-10-11, mirroring the open-posts limit). Each acceptance DMs
 *  every manager of the post, so this also caps what one side can send. */
export const SCRIM_MAX_PENDING_ACCEPTS = 3;
/** After a side's acceptance of a post is declined (by the poster, or by a
 *  confirm that could never book it), that side waits this long before
 *  accepting the same post again. Withdrawing your own has no wait. */
export const ACCEPT_COOLDOWN_MS = 60 * 60_000;

// ---------- reads and helpers ----------

export function getPost(db: DB, id: number): PostRow | undefined {
  return db.prepare('SELECT * FROM scrim_posts WHERE id = ?').get(id) as PostRow | undefined;
}
export function getAccept(db: DB, id: number): AcceptRow | undefined {
  return db.prepare('SELECT * FROM scrim_accepts WHERE id = ?').get(id) as AcceptRow | undefined;
}
export function pendingAccepts(db: DB, postId: number): AcceptRow[] {
  return db.prepare("SELECT * FROM scrim_accepts WHERE post_id = ? AND status = 'pending' ORDER BY created_at, id").all(postId) as AcceptRow[];
}

export { openPostAt };
type SideRef = Pick<PostRow, 'team_id' | 'captain_steamid'>;
const isManagerRole = (r: string | null): boolean => r === 'captain' || r === 'cocaptain';
/** Whether `steamid` manages a post's or acceptance's side right now. */
export function managesScrimSide(db: DB, s: SideRef, steamid: string): boolean {
  return s.team_id !== null ? isManagerRole(roleOf(db, s.team_id, steamid)) : s.captain_steamid === steamid;
}
/** Everyone who manages a side right now. */
function managersOf(db: DB, s: SideRef): string[] {
  return s.team_id !== null
    ? activeMembers(db, s.team_id).filter((m) => isManagerRole(m.role)).map((m) => m.steamid)
    : [s.captain_steamid];
}
const scrimSide = (s: SideRef): ScrimSide => (s.team_id !== null ? { teamId: s.team_id } : { captain: s.captain_steamid });
const partyOf = (s: SideRef): Party => (s.team_id !== null ? { teamId: s.team_id } : { captain: s.captain_steamid });
const outOfAllowance = (db: DB, party: Party, nowMs: number): boolean => upcomingCount(db, party) >= allowance(db, party, nowMs);
const campaignsOf = (row: { campaigns_json: string }): string[] => JSON.parse(row.campaigns_json) as string[];

function teamGone(db: DB, id: number): boolean {
  const t = getTeam(db, id);
  return !t || t.disbanded_at !== null;
}
/** A post whose posting team or challenged team has been disbanded: off the
 *  board, not acceptable, and withdrawn by the next expire. */
function postGone(db: DB, p: PostRow): boolean {
  return (p.team_id !== null && teamGone(db, p.team_id)) || (p.target_team_id !== null && teamGone(db, p.target_team_id));
}
/** Whether anyone could still run this side: a pickup captain, or one of a
 *  team's captain and co-captains, in good standing (not banned or merged
 *  away). A side nobody can run never confirms, so its post or acceptance
 *  only times out. The rollout switch is not asked: flipping it must not
 *  wipe the board. */
function sideCanPlay(db: DB, s: Pick<PostRow, 'team_id' | 'captain_steamid'>): boolean {
  if (s.team_id === null) return inGoodStanding(db, s.captain_steamid);
  return activeMembers(db, s.team_id).some((m) => isManagerRole(m.role) && inGoodStanding(db, m.steamid));
}
/** A direct challenge does not exist for anyone managing neither side, so
 *  every action on it answers them not_found rather than not_manager. */
function hiddenFrom(db: DB, p: PostRow, steamid: string): boolean {
  return p.target_team_id !== null && !managesScrimSide(db, p, steamid) && !isManagerRole(roleOf(db, p.target_team_id, steamid));
}
/** A pending acceptance past its 2 hours or its post's 30 minute cutoff:
 *  expired in all but name until the next tick writes it. */
function acceptTimedOut(createdAt: string, startsAt: string, nowMs: number): boolean {
  return Date.parse(createdAt) + ACCEPT_TTL_MS <= nowMs || Date.parse(startsAt) - ACCEPT_CUTOFF_MS <= nowMs;
}
function openPostCount(db: DB, s: SideRef): number {
  const row = s.team_id !== null
    ? db.prepare("SELECT COUNT(*) AS n FROM scrim_posts WHERE status IN ('open','pending') AND team_id = ?").get(s.team_id)
    : db.prepare("SELECT COUNT(*) AS n FROM scrim_posts WHERE status IN ('open','pending') AND team_id IS NULL AND captain_steamid = ?").get(s.captain_steamid);
  return (row as { n: number }).n;
}
function pendingAcceptCount(db: DB, s: SideRef): number {
  const row = s.team_id !== null
    ? db.prepare("SELECT COUNT(*) AS n FROM scrim_accepts WHERE status = 'pending' AND team_id = ?").get(s.team_id)
    : db.prepare("SELECT COUNT(*) AS n FROM scrim_accepts WHERE status = 'pending' AND team_id IS NULL AND captain_steamid = ?").get(s.captain_steamid);
  return (row as { n: number }).n;
}
/** This side's acceptance of this post was declined inside ACCEPT_COOLDOWN_MS. */
function declinedLately(db: DB, postId: number, s: SideRef, nowMs: number): boolean {
  const row = (s.team_id !== null
    ? db.prepare("SELECT MAX(responded_at) AS at FROM scrim_accepts WHERE post_id = ? AND status = 'declined' AND team_id = ?").get(postId, s.team_id)
    : db.prepare("SELECT MAX(responded_at) AS at FROM scrim_accepts WHERE post_id = ? AND status = 'declined' AND team_id IS NULL AND captain_steamid = ?").get(postId, s.captain_steamid)) as { at: string | null };
  return row.at !== null && Date.parse(row.at) + ACCEPT_COOLDOWN_MS > nowMs;
}

/** Once nothing is left pending on a pending post, it is open again. */
function reopenIfIdle(db: DB, postId: number): boolean {
  return db.prepare(
    `UPDATE scrim_posts SET status = 'open' WHERE id = ? AND status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM scrim_accepts WHERE post_id = scrim_posts.id AND status = 'pending')`,
  ).run(postId).changes > 0;
}

/** Withdraw a post and its pending acceptances, as a withdraw by hand does. */
function closePost(db: DB, postId: number, t: string): void {
  db.prepare("UPDATE scrim_posts SET status = 'withdrawn' WHERE id = ?").run(postId);
  db.prepare("UPDATE scrim_accepts SET status = 'withdrawn', responded_at = ? WHERE post_id = ? AND status = 'pending'").run(t, postId);
}

/** What a confirm withdrew because the sides are now booked over it. */
export interface Withdrawn {
  /** Either side's own open or pending posts. */
  posts: number[];
  /** Other sides' pending acceptances of those posts, withdrawn with them. */
  postAccepts: number[];
  /** Either side's own pending acceptances of other posts. */
  accepts: number[];
}

/**
 * Owner ruling 2026-10-11: once both sides are booked, each side's other open
 * or pending posts and its pending acceptances whose block overlaps the
 * booked slot are withdrawn, exactly as by hand: a post takes its pending
 * acceptances with it, and a post left with nothing pending is open again.
 * Runs inside confirmAccept's transaction after the chosen post is booked and
 * its acceptances answered, so neither is touched here.
 */
function withdrawOverlaps(db: DB, sides: SideRef[], startMs: number, endMs: number, t: string): Withdrawn {
  const out: Withdrawn = { posts: [], postAccepts: [], accepts: [] };
  const overlaps = (startsAt: string, minutes: number): boolean => {
    const s = Date.parse(startsAt);
    return s < endMs && s + minutes * 60_000 > startMs;
  };
  const same = (x: SideRef, y: SideRef): boolean => (x.team_id !== null ? x.team_id === y.team_id : y.team_id === null && x.captain_steamid === y.captain_steamid);
  for (const s of sides) {
    const other = sides.find((x) => x !== s);
    const where = (x: string) => (s.team_id !== null ? `${x}team_id = ?` : `${x}team_id IS NULL AND ${x}captain_steamid = ?`);
    const arg = s.team_id ?? s.captain_steamid;
    const posts = db.prepare(`SELECT * FROM scrim_posts WHERE status IN ('open','pending') AND ${where('')} ORDER BY id`).all(arg) as PostRow[];
    for (const p of posts.filter((x) => overlaps(x.starts_at, x.block_minutes))) {
      out.posts.push(p.id);
      // The other booked side's acceptances of this post are that side's own
      // withdrawn acceptances, not the posting side's doing to a stranger.
      for (const a of pendingAccepts(db, p.id)) (other && same(other, a) ? out.accepts : out.postAccepts).push(a.id);
      closePost(db, p.id, t);
    }
    const accepts = db.prepare(
      `SELECT a.id, a.post_id, p.starts_at, p.block_minutes FROM scrim_accepts a JOIN scrim_posts p ON p.id = a.post_id
        WHERE a.status = 'pending' AND ${where('a.')} ORDER BY a.id`,
    ).all(arg) as { id: number; post_id: number; starts_at: string; block_minutes: number }[];
    for (const a of accepts.filter((x) => overlaps(x.starts_at, x.block_minutes))) {
      out.accepts.push(a.id);
      db.prepare("UPDATE scrim_accepts SET status = 'withdrawn', responded_at = ? WHERE id = ?").run(t, a.id);
      reopenIfIdle(db, a.post_id);
    }
  }
  for (const k of ['posts', 'postAccepts', 'accepts'] as const) out[k].sort((x, y) => x - y);
  return out;
}

/**
 * A direct booking (not made through the board) just had both sides confirm:
 * each side's open or pending posts and pending acceptances overlapping its
 * slot are withdrawn, exactly as confirmAccept does (owner ruling
 * 2026-10-11). Empty until both sides have confirmed. The caller sends the
 * notices for what comes back.
 */
export function withdrawForBooking(db: DB, bookingId: number, now: Date = new Date()): Withdrawn {
  return db.transaction((): Withdrawn => {
    const b = getBooking(db, bookingId);
    const sa = sideRow(db, bookingId, 'a');
    const sb = sideRow(db, bookingId, 'b');
    if (!b || !sa || !sb || sa.confirmed_at === null || sb.confirmed_at === null) return { posts: [], postAccepts: [], accepts: [] };
    if (!['scheduled', 'held', 'setup', 'ready', 'active'].includes(b.state)) return { posts: [], postAccepts: [], accepts: [] };
    return withdrawOverlaps(db, [sa, sb], Date.parse(b.starts_at), Date.parse(b.ends_at), now.toISOString());
  })();
}

/** Decline an acceptance a confirm can never book (NEVER_CLEARS), after the
 *  confirm's own transaction rolled back. True when it was still pending. */
function declineRefused(db: DB, acceptId: number, now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare("UPDATE scrim_accepts SET status = 'declined', responded_at = ? WHERE id = ? AND status = 'pending'")
      .run(now.toISOString(), acceptId).changes > 0;
    if (changed) reopenIfIdle(db, getAccept(db, acceptId)!.post_id);
    return changed;
  })();
}

function parseSrRange(raw: unknown): number | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < SR_RANGE_MIN || raw > SR_RANGE_MAX) return undefined;
  return raw;
}
function parseNote(raw: unknown): { ok: true; note: string } | { ok: false; error: ScrimError } {
  if (raw === undefined || raw === null) return { ok: true, note: '' };
  if (typeof raw !== 'string') return { ok: false, error: 'bad_note' };
  const note = raw.trim();
  if ([...note].length > NOTE_MAX) return { ok: false, error: 'bad_note' };
  if (findSlurs(note).length > 0) return { ok: false, error: 'note_slur' };
  return { ok: true, note };
}
/** An accepter's own picks: none, or 1..scrim_accept_campaigns_max pool slugs. */
function parseAcceptCampaigns(db: DB, raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw) && raw.length === 0) return [];
  const max = settingNumber(db, 'scrim_accept_campaigns_max', 2, { integer: true, min: 0, max: 4 });
  if (max === 0) return null;
  return parsePlaylist(db, raw, max);
}
function optionalId(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null) return null;
  return Number.isInteger(raw) ? (raw as number) : undefined;
}

// ---------- posts ----------

/** A post's block is estimated from its campaigns (estimateMinutes,
 *  bookings by campaign Ruling 6); `minutes` is accepted from older callers
 *  and ignored. */
export function createPost(db: DB, o: {
  by: string; teamId?: unknown; startsAt: unknown; minutes?: unknown; campaigns: unknown; srRange: unknown; note: unknown;
  targetTeamId?: unknown; now?: Date;
}): ScrimResult<{ id: number }> {
  const now = o.now ?? new Date();
  const nowMs = now.getTime();
  const limits = bookingLimits(db);
  if (!canUse(db, o.by)) return fail('not_open');
  const startMs = parseStart(o.startsAt, nowMs, limits);
  if (startMs === null) return fail('bad_time');
  // A post starting inside the cutoff could never be accepted (acceptPost
  // refuses it too_late), yet would still show on the board and get a
  // Discord card with a live-looking Accept button. Refuse it up front.
  if (startMs - nowMs <= ACCEPT_CUTOFF_MS) return fail('too_late');
  const campaigns = parsePlaylist(db, o.campaigns, limits.playlistMax);
  if (!campaigns) return fail('bad_playlist');
  const minutes = estimateMinutes(db, campaigns);
  // While scrim_show_sr is off the range is ignored, so a stale client (or a
  // re-post of an older post) cannot set one nobody can see: it is stored open.
  const srRange = showSr(db) ? parseSrRange(o.srRange) : null;
  if (srRange === undefined) return fail('bad_sr_range');
  const note = parseNote(o.note);
  if (!note.ok) return fail(note.error);
  const teamId = optionalId(o.teamId);
  if (teamId === undefined) return fail('not_found');
  const targetId = optionalId(o.targetTeamId);
  if (targetId === undefined) return fail('bad_target');

  return db.transaction((): ScrimResult<{ id: number }> => {
    let region = 'na';
    let captain = o.by;
    if (teamId !== null) {
      const team = getTeam(db, teamId);
      if (!team || team.disbanded_at) return fail('not_found');
      if (!isManagerRole(roleOf(db, team.id, o.by))) return fail('not_manager');
      region = team.region;
      captain = team.captain_steamid;
    }
    if (targetId !== null) {
      // The confirm books the poster against this team, which the booking
      // domain refuses when the poster runs it too (createBooking's bad_opponent).
      const target = getTeam(db, targetId);
      if (!target || target.disbanded_at || target.id === teamId || isManagerRole(roleOf(db, target.id, o.by))) return fail('bad_target');
    }
    const side: SideRef = { team_id: teamId, captain_steamid: captain };
    // A blocked pair cannot challenge each other, whichever side blocked.
    if (targetId !== null && blocked(db, partyOf(side), { teamId: targetId })) return fail('not_available');
    if (openPostAt(db, side, iso(startMs))) return fail('duplicate_post');
    // A side holding a booked slot posts nothing that overlaps it (owner, 2026-10-11).
    if (bookedDuring(db, partyOf(side), startMs, startMs + minutes * 60_000)) return fail('booked_then');
    if (openPostCount(db, side) >= SCRIM_MAX_OPEN_POSTS) return fail('too_many_posts');
    if (capacityProblem(db, { region, startMs, endMs: startMs + minutes * 60_000 }) !== null) return fail('no_capacity');
    if (outOfAllowance(db, partyOf(side), nowMs)) return fail('allowance');
    const id = Number(db.prepare(
      `INSERT INTO scrim_posts (side_kind, team_id, captain_steamid, region, starts_at, block_minutes, campaigns_json, sr_range, note, created_at, target_team_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(teamId !== null ? 'team' : 'pickup', teamId, captain, region, iso(startMs), minutes, JSON.stringify(campaigns),
      srRange, note.note, now.toISOString(), targetId).lastInsertRowid);
    return ok({ id });
  })();
}

/**
 * Re-post a cancelled scrim in one click (plan 2 Ruling 4): either side of a
 * cancelled booking that came from a post (scrim_posts.booking_id) opens a
 * fresh public post for its own side, with the booking's start and its
 * playlist (trimmed to the current post campaign limit; the block is
 * estimated from it again, as for any post), and
 * the original post's sr_range. It goes straight through createPost, so
 * every plan 1 rule (the cutoff, the allowance, the open-posts limit,
 * capacity) applies the same as a hand-made post, and a refusal comes back
 * unchanged. The original post stays booked; nothing is written back to it
 * or to the booking.
 */
export function repostFromBooking(db: DB, o: { bookingId: number; by: string; now?: Date }): ScrimResult<{ id: number }> {
  const now = o.now ?? new Date();
  const b = getBooking(db, o.bookingId);
  if (!b) return fail('not_found');
  const post = db.prepare('SELECT * FROM scrim_posts WHERE booking_id = ?').get(b.id) as PostRow | undefined;
  if (!post || b.purpose !== 'scrim') return fail('not_found');
  if (b.state !== 'cancelled') return fail('wrong_state');
  const side = managedSides(db, b.id, o.by)[0];
  if (!side) return fail('not_manager');
  const s = sideRow(db, b.id, side)!;
  // Only while a post could still be accepted (plan 2 Ruling 4, with the
  // owner's 2026-10-11 fix): later, the click is refused in plain words
  // rather than as createPost's bad_time.
  if (Date.parse(b.starts_at) - ACCEPT_CUTOFF_MS <= now.getTime()) return fail('too_late');
  const campaigns = (JSON.parse(b.playlist_json) as string[]).slice(0, bookingLimits(db).playlistMax);
  return createPost(db, {
    by: o.by, teamId: s.team_id, startsAt: b.starts_at, campaigns, srRange: post.sr_range, note: '', now,
  });
}

/** The poster's side withdraws a post that is not booked yet. Its pending
 *  acceptances are withdrawn with it; their ids come back for notices. */
export function withdrawPost(db: DB, o: { postId: number; by: string; now?: Date }): ScrimResult<{ acceptIds: number[] }> {
  const now = o.now ?? new Date();
  return db.transaction((): ScrimResult<{ acceptIds: number[] }> => {
    const p = getPost(db, o.postId);
    if (!p || hiddenFrom(db, p, o.by)) return fail('not_found');
    if (!managesScrimSide(db, p, o.by)) return fail('not_manager');
    if (p.status !== 'open' && p.status !== 'pending') return fail('wrong_state');
    const acceptIds = pendingAccepts(db, p.id).map((a) => a.id);
    closePost(db, p.id, now.toISOString());
    return ok({ acceptIds });
  })();
}

// ---------- acceptances ----------

export function acceptPost(db: DB, o: {
  postId: number; by: string; teamId?: unknown; campaigns?: unknown; now?: Date;
}): ScrimResult<{ id: number; sr: number; fits: boolean }> {
  const now = o.now ?? new Date();
  const nowMs = now.getTime();
  if (!canUse(db, o.by)) return fail('not_open');
  const teamId = optionalId(o.teamId);
  if (teamId === undefined) return fail('not_found');
  const campaigns = parseAcceptCampaigns(db, o.campaigns);
  if (!campaigns) return fail('bad_campaigns');

  return db.transaction((): ScrimResult<{ id: number; sr: number; fits: boolean }> => {
    const p = getPost(db, o.postId);
    if (!p || postGone(db, p)) return fail('not_found');
    // A direct challenge does not exist for anyone but the target's managers.
    if (p.target_team_id !== null) {
      if (!isManagerRole(roleOf(db, p.target_team_id, o.by))) return fail('not_found');
      if (teamId !== p.target_team_id) return fail('challenge_side');
    }
    if ((p.status !== 'open' && p.status !== 'pending') || Date.parse(p.starts_at) <= nowMs) return fail('wrong_state');
    // An acceptance made now would time out at the next tick, unanswerable.
    if (Date.parse(p.starts_at) - ACCEPT_CUTOFF_MS <= nowMs) return fail('too_late');

    let side: SideRef;
    if (teamId !== null) {
      const team = getTeam(db, teamId);
      if (!team || team.disbanded_at) return fail('not_found');
      if (!isManagerRole(roleOf(db, team.id, o.by))) return fail('not_manager');
      side = { team_id: team.id, captain_steamid: team.captain_steamid };
    } else {
      side = { team_id: null, captain_steamid: o.by };
    }

    // Own side: anyone running both sides, or a member of the posting team
    // accepting as a pickup (the booking would put them on both sides).
    const posterManagers = new Set(managersOf(db, p));
    if (managersOf(db, side).some((m) => posterManagers.has(m))) return fail('own_post');
    if (side.team_id === null && p.team_id !== null && roleOf(db, p.team_id, o.by) !== null) return fail('own_post');
    // A blocked pair never accepts each other, whichever side blocked.
    if (blocked(db, partyOf(side), partyOf(p))) return fail('not_available');

    const already = side.team_id !== null
      ? db.prepare("SELECT 1 FROM scrim_accepts WHERE post_id = ? AND status = 'pending' AND team_id = ?").get(p.id, side.team_id)
      : db.prepare("SELECT 1 FROM scrim_accepts WHERE post_id = ? AND status = 'pending' AND team_id IS NULL AND captain_steamid = ?").get(p.id, o.by);
    if (already) return fail('already_accepted');
    if (declinedLately(db, p.id, side, nowMs)) return fail('accept_cooldown');
    if (pendingAcceptCount(db, side) >= SCRIM_MAX_PENDING_ACCEPTS) return fail('too_many_accepts');
    // Checked against the post's block; the confirm checks the merged
    // playlist's real slot through the booking domain (bookedDuring there).
    const postStart = Date.parse(p.starts_at);
    if (bookedDuring(db, partyOf(side), postStart, postStart + p.block_minutes * 60_000)) return fail('booked_then');
    if (outOfAllowance(db, partyOf(side), nowMs)) return fail('allowance');

    const id = Number(db.prepare(
      `INSERT INTO scrim_accepts (post_id, side_kind, team_id, captain_steamid, campaigns_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(p.id, side.team_id !== null ? 'team' : 'pickup', side.team_id, side.captain_steamid, JSON.stringify(campaigns), now.toISOString()).lastInsertRowid);
    db.prepare("UPDATE scrim_posts SET status = 'pending' WHERE id = ?").run(p.id);
    const sr = sideSr(db, scrimSide(side));
    return ok({ id, sr, fits: srFits(sideSr(db, scrimSide(p)), p.sr_range, sr) });
  })();
}

/** Answer a pending acceptance without booking: the accepter withdraws it,
 *  or the poster declines it. */
function closeAccept(db: DB, o: { acceptId: number; by: string; now?: Date }, as: 'accepter' | 'poster'): ScrimResult<{ postId: number; reopened: boolean }> {
  const now = o.now ?? new Date();
  return db.transaction((): ScrimResult<{ postId: number; reopened: boolean }> => {
    const a = getAccept(db, o.acceptId);
    if (!a) return fail('not_found');
    const p = getPost(db, a.post_id)!;
    if (hiddenFrom(db, p, o.by)) return fail('not_found');
    if (!managesScrimSide(db, as === 'accepter' ? a : p, o.by)) return fail('not_manager');
    if (a.status !== 'pending' || p.status !== 'pending') return fail('wrong_state');
    db.prepare('UPDATE scrim_accepts SET status = ?, responded_at = ? WHERE id = ?')
      .run(as === 'accepter' ? 'withdrawn' : 'declined', now.toISOString(), a.id);
    // Inside the cutoff a reopened post could take no new acceptance (too_late):
    // close it instead, as the tick does.
    if (Date.parse(p.starts_at) - ACCEPT_CUTOFF_MS <= now.getTime()) {
      db.prepare(`UPDATE scrim_posts SET status = 'expired' WHERE id = ? AND status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM scrim_accepts WHERE post_id = scrim_posts.id AND status = 'pending')`).run(p.id);
      return ok({ postId: p.id, reopened: false });
    }
    return ok({ postId: p.id, reopened: reopenIfIdle(db, p.id) });
  })();
}
export function withdrawAccept(db: DB, o: { acceptId: number; by: string; now?: Date }): ScrimResult<{ postId: number; reopened: boolean }> {
  return closeAccept(db, o, 'accepter');
}
export function declineAccept(db: DB, o: { acceptId: number; by: string; now?: Date }): ScrimResult<{ postId: number; reopened: boolean }> {
  return closeAccept(db, o, 'poster');
}

/**
 * The poster picks an acceptance and the server is booked, all in one
 * transaction: the booking is created by the poster's manager with the
 * proposed playlist (never trimmed to the post's block; createBooking
 * estimates the slot from it, Ruling 6) and confirmed by the accepting side's captain, the post
 * becomes booked, this acceptance chosen and every other pending one
 * declined (their ids come back as takenAcceptIds, for notices). If the
 * booking domain refuses either step, nothing is kept and its error comes
 * back; for no_capacity, with the nearest slot that has room for the
 * proposed playlist's slot. Refusals say whose side they are about
 * (REFUSAL_TEXT); one that can never clear also declines the acceptance
 * (NEVER_CLEARS). Both sides' other overlapping posts and acceptances are
 * withdrawn (withdrawOverlaps).
 */
export function confirmAccept(db: DB, o: { acceptId: number; by: string; now?: Date }): ScrimResult<{ bookingId: number; takenAcceptIds: number[]; withdrawn: Withdrawn }> {
  const now = o.now ?? new Date();
  type Out = ScrimResult<{ bookingId: number; takenAcceptIds: number[]; withdrawn: Withdrawn }>;
  try {
    return db.transaction((): Out => {
      const a = getAccept(db, o.acceptId);
      if (!a) return fail('not_found');
      const p = getPost(db, a.post_id)!;
      if (hiddenFrom(db, p, o.by)) return fail('not_found');
      if (p.status !== 'pending' || a.status !== 'pending') return fail('wrong_state');
      if (!managesScrimSide(db, p, o.by)) return fail('not_manager');
      // The poster's own access, here, so a not_open from createBooking below
      // can only be the accepting side's.
      if (!canUse(db, o.by)) return fail('not_open');
      // The tick may not have written it yet; a timed-out acceptance is never booked.
      if (acceptTimedOut(a.created_at, p.starts_at, now.getTime())) return fail('wrong_state');
      // Blocking declines what is pending between the pair, but a player
      // block can start to match after the accept (they are made a
      // co-captain), so a confirm asks again; it never clears by waiting.
      if (blocked(db, partyOf(p), partyOf(a))) throw new Refused('not_available', 'poster');

      const { playlist } = proposedPlaylist(db, campaignsOf(p), campaignsOf(a));
      const created = createBooking(db, {
        by: o.by, teamId: p.team_id, opponent: a.team_id !== null ? { teamId: a.team_id } : { steamid: a.captain_steamid },
        startsAt: p.starts_at, playlist, now,
      });
      if (!created.ok) throw new Refused(created.error, 'poster');
      const bookingId = created.value.id;
      // A team side confirms through its captain now (transferCaptain may
      // have moved it since the acceptance was made).
      const accepter = a.team_id !== null ? (getTeam(db, a.team_id)?.captain_steamid ?? a.captain_steamid) : a.captain_steamid;
      const confirmed = confirmBooking(db, { bookingId, by: accepter, now });
      if (!confirmed.ok) throw new Refused(confirmed.error, 'accepter');

      const t = now.toISOString();
      const takenAcceptIds = pendingAccepts(db, p.id).filter((x) => x.id !== a.id).map((x) => x.id);
      db.prepare("UPDATE scrim_posts SET status = 'booked', booking_id = ? WHERE id = ?").run(bookingId, p.id);
      db.prepare("UPDATE scrim_accepts SET status = 'chosen', responded_at = ? WHERE id = ?").run(t, a.id);
      db.prepare("UPDATE scrim_accepts SET status = 'declined', responded_at = ? WHERE post_id = ? AND status = 'pending'").run(t, p.id);
      const booked = getBooking(db, bookingId)!;
      const withdrawn = withdrawOverlaps(db, [p, a], Date.parse(booked.starts_at), Date.parse(booked.ends_at), t);
      return ok({ bookingId, takenAcceptIds, withdrawn });
    })();
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    const text = REFUSAL_TEXT[e.step][e.code] ?? BOOKING_ERRORS[e.code].text;
    if (NEVER_CLEARS.has(e.code)) {
      return { ok: false, error: e.code, text, ...(declineRefused(db, o.acceptId, now) ? { declined: true } : {}) };
    }
    if (e.code !== 'no_capacity') return { ok: false, error: e.code, text };
    const a = getAccept(db, o.acceptId)!;
    const p = getPost(db, a.post_id)!;
    const { minutes } = proposedPlaylist(db, campaignsOf(p), campaignsOf(a));
    return { ok: false, error: 'no_capacity', text, nearestSlot: nearestFreeSlot(db, p.region, Date.parse(p.starts_at), minutes, now.getTime()) };
  }
}

// ---------- the minute tick ----------

/**
 * Open or pending posts whose posting or challenged team was disbanded are
 * withdrawn first, with their pending acceptances. Then open or pending posts
 * at or past their start expire, with their pending acceptances. Pending
 * acceptances ACCEPT_TTL_MS old expire too, and a post left with none
 * pending is open again. A pending acceptance that instead times out because
 * its post's start has come within ACCEPT_CUTOFF_MS also expires, but its
 * post is closed (expired) rather than reopened: a new acceptance that close
 * to the start would itself be refused too_late, so an Open post with a live
 * Accept button nobody could use would be worse than just closing it early.
 * Returns what expired and what was withdrawn, for notices.
 */
export function expire(db: DB, now: Date): { posts: number[]; accepts: number[]; withdrawn: { posts: number[]; accepts: number[] } } {
  const nowMs = now.getTime();
  const t = now.toISOString();
  return db.transaction(() => {
    const withdrawn = { posts: [] as number[], accepts: [] as number[] };
    const live = db.prepare("SELECT * FROM scrim_posts WHERE status IN ('open','pending') AND (team_id IS NOT NULL OR target_team_id IS NOT NULL) ORDER BY id")
      .all() as PostRow[];
    const everyLive = db.prepare("SELECT * FROM scrim_posts WHERE status IN ('open','pending') ORDER BY id").all() as PostRow[];
    const gone = new Set([...live.filter((x) => postGone(db, x)), ...everyLive.filter((x) => !sideCanPlay(db, x))].map((x) => x.id));
    for (const p of everyLive.filter((x) => gone.has(x.id))) {
      withdrawn.posts.push(p.id);
      withdrawn.accepts.push(...pendingAccepts(db, p.id).map((a) => a.id));
      db.prepare("UPDATE scrim_posts SET status = 'withdrawn' WHERE id = ?").run(p.id);
      db.prepare("UPDATE scrim_accepts SET status = 'withdrawn', responded_at = ? WHERE post_id = ? AND status = 'pending'").run(t, p.id);
    }
    // An acceptance by a team since disbanded, or a side nobody can run any
    // more: withdrawn, and its post reopened (or closed, inside the cutoff,
    // by the timed-out pass below).
    const pendingNow = db.prepare(
      `SELECT a.* FROM scrim_accepts a JOIN scrim_posts p ON p.id = a.post_id WHERE a.status = 'pending' AND p.status = 'pending' ORDER BY a.id`,
    ).all() as AcceptRow[];
    const reopenAfter = new Set<number>();
    for (const a of pendingNow) {
      if ((a.team_id !== null && teamGone(db, a.team_id)) || !sideCanPlay(db, a)) {
        withdrawn.accepts.push(a.id);
        db.prepare("UPDATE scrim_accepts SET status = 'withdrawn', responded_at = ? WHERE id = ?").run(t, a.id);
        reopenAfter.add(a.post_id);
      }
    }
    withdrawn.accepts.sort((x, y) => x - y);
    // Open posts expire at the accept cutoff, not at the start: inside it an
    // Accept is refused too_late, so a live-looking post would only mislead.
    const cutoffIso = new Date(nowMs + ACCEPT_CUTOFF_MS).toISOString();
    const posts = (db.prepare(
      "SELECT id FROM scrim_posts WHERE (status IN ('open','pending') AND starts_at <= ?) OR (status = 'open' AND starts_at <= ?) ORDER BY id",
    ).all(t, cutoffIso) as { id: number }[]).map((r) => r.id);
    const accepts: number[] = [];
    for (const id of posts) {
      accepts.push(...pendingAccepts(db, id).map((a) => a.id));
      db.prepare("UPDATE scrim_posts SET status = 'expired' WHERE id = ?").run(id);
    }
    const stale = db.prepare(
      `SELECT a.id, a.post_id, a.created_at, p.starts_at FROM scrim_accepts a JOIN scrim_posts p ON p.id = a.post_id
        WHERE a.status = 'pending' AND p.status = 'pending'`,
    ).all() as { id: number; post_id: number; created_at: string; starts_at: string }[];
    const touched = new Set<number>(reopenAfter);
    const closesPost = new Set<number>();
    for (const id of reopenAfter) {
      const p = getPost(db, id);
      if (p && Date.parse(p.starts_at) - ACCEPT_CUTOFF_MS <= nowMs) closesPost.add(id);
    }
    for (const a of stale) {
      if (acceptTimedOut(a.created_at, a.starts_at, nowMs)) {
        accepts.push(a.id);
        touched.add(a.post_id);
        if (Date.parse(a.starts_at) - ACCEPT_CUTOFF_MS <= nowMs) closesPost.add(a.post_id);
      }
    }
    const setExpired = db.prepare("UPDATE scrim_accepts SET status = 'expired', responded_at = ? WHERE id = ?");
    for (const id of accepts) setExpired.run(t, id);
    const closePost = db.prepare("UPDATE scrim_posts SET status = 'expired' WHERE id = ? AND status = 'pending'");
    for (const id of touched) {
      if (closesPost.has(id)) {
        if (closePost.run(id).changes > 0) posts.push(id);
      } else {
        reopenIfIdle(db, id);
      }
    }
    posts.sort((x, y) => x - y);
    return { posts, accepts: accepts.sort((x, y) => x - y), withdrawn };
  })();
}

// ---------- the board ----------

export type BoardSide =
  | { kind: 'team'; teamId: number; name: string; tag: string; slug: string; logoKey: string | null }
  | { kind: 'pickup'; steamid: string; name: string };
export interface BoardAccept {
  /** SR and the fit: left out while scrim_show_sr is off (not only hidden by the page). */
  id: number; side: BoardSide; sr?: number; fits?: boolean; campaigns: string[]; createdAt: string;
  proposed: { playlist: string[]; minutes: number };
}
export interface BoardPost {
  id: number; status: PostStatus; side: BoardSide; sr?: number; srRange: number | null; startsAt: string;
  /** The block, estimated from the post's campaigns. */
  minutes: number;
  campaigns: string[]; campaignCount: number; note: string; createdAt: string; challenge: { teamId: number; name: string } | null;
  acceptCount: number;
  /** Plan 2 Ruling 7: whether this post's start falls inside the weekly
   *  scrim night window, for the board row's highlight and tag. */
  night: boolean;
  /** The viewer manages the posting side: `accepts` is then filled in. */
  mine: boolean;
  /** The viewer's side's own pending acceptance of this post, if any. */
  myAcceptId: number | null;
  accepts: BoardAccept[] | null;
  /** The posting side's scrim record (plan 2), only while
   *  scrim_reliability_public is on; never there otherwise, staff included. */
  record?: Reliability;
}

function boardSide(db: DB, s: SideRef): BoardSide {
  if (s.team_id !== null) {
    const t = getTeam(db, s.team_id)!;
    return { kind: 'team', teamId: t.id, name: t.name, tag: t.tag, slug: t.slug, logoKey: t.logo_key };
  }
  return { kind: 'pickup', steamid: s.captain_steamid, name: getPlayer(db, s.captain_steamid)?.name ?? 'Someone' };
}

/**
 * Open and pending posts not yet started, soonest first, leaving out any whose
 * posting or challenged team was disbanded: every public post,
 * direct challenges aimed at a team the viewer manages, and the viewer's own
 * posts. A challenge is never shown to anyone else, staff included. The
 * poster's side also gets each pending acceptance with its proposed playlist
 * and SR fit. `fitsOnly` (ruling 2) keeps posts whose range the viewer's side
 * fits, judging the viewer as the first team they captain, else alone; the
 * viewer's own posts always stay. It is ignored while scrim_show_sr is off.
 */
export function board(
  db: DB, viewer: { steamid: string | null; staff: boolean }, opts: { fitsOnly?: boolean; now?: Date } = {},
): BoardPost[] {
  const now = opts.now ?? new Date();
  const me = viewer.steamid;
  const teams = me ? myTeams(db, me) : [];
  const managed = new Set(teams.filter((t) => isManagerRole(t.role)).map((t) => t.id));
  // Every side the viewer could act as: a post blocked with any of them is
  // left off, whichever side blocked (the viewer's own posts stay).
  const viewerParties: Party[] = me ? [...[...managed].map((teamId) => ({ teamId })), { captain: me }] : [];
  const captained = teams.find((t) => t.role === 'captain');
  const viewerSr = me && opts.fitsOnly && showSr(db) ? sideSr(db, captained ? { teamId: captained.id } : { captain: me }) : null;

  const showRecord = getSetting(db, 'scrim_reliability_public') === 'on';
  const srOn = showSr(db);
  // Inside the accept cutoff nothing on a post can happen any more (accept
  // and confirm both refuse), so it is off the board even before the tick.
  const rows = db.prepare("SELECT * FROM scrim_posts WHERE status IN ('open','pending') AND starts_at > ? ORDER BY starts_at, id")
    .all(new Date(now.getTime() + ACCEPT_CUTOFF_MS).toISOString()) as PostRow[];
  const out: BoardPost[] = [];
  for (const p of rows) {
    if (postGone(db, p) || !sideCanPlay(db, p)) continue;
    const mine = me !== null && managesScrimSide(db, p, me);
    if (p.target_team_id !== null && !mine && !managed.has(p.target_team_id)) continue;
    if (!mine && viewerParties.some((v) => blocked(db, v, partyOf(p)))) continue;
    const sr = srOn ? sideSr(db, scrimSide(p)) : 0;
    if (viewerSr !== null && !mine && !srFits(sr, p.sr_range, viewerSr)) continue;
    const pending = pendingAccepts(db, p.id);
    const campaigns = campaignsOf(p);
    const target = p.target_team_id !== null ? getTeam(db, p.target_team_id) : undefined;
    out.push({
      id: p.id, status: p.status, side: boardSide(db, p), ...(srOn ? { sr } : {}), srRange: p.sr_range, startsAt: p.starts_at, minutes: p.block_minutes,
      campaigns, campaignCount: campaigns.length, note: p.note, createdAt: p.created_at,
      challenge: target ? { teamId: target.id, name: target.name } : null,
      acceptCount: pending.length,
      night: inNight(db, p.starts_at),
      mine,
      myAcceptId: me !== null ? (pending.find((a) => managesScrimSide(db, a, me))?.id ?? null) : null,
      accepts: mine
        ? pending.map((a) => {
          const asr = srOn ? sideSr(db, scrimSide(a)) : 0;
          return {
            id: a.id, side: boardSide(db, a), ...(srOn ? { sr: asr, fits: srFits(sr, p.sr_range, asr) } : {}), campaigns: campaignsOf(a), createdAt: a.created_at,
            proposed: proposedPlaylist(db, campaigns, campaignsOf(a)),
          };
        })
        : null,
      ...(showRecord ? { record: reliability(db, scrimSide(p), now.getTime()) } : {}),
    });
  }
  return out;
}
