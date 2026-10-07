import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { inGoodStanding } from '../standing.js';
import { hasActiveBan } from '../banState.js';
import { resolveAlias } from '../aliases.js';
import { hasUnsafeChars } from '../profileFields.js';
import { competitiveAccess } from '../teams/access.js';
import { activeMembers, getTeam, roleOf } from '../teams/teams.js';
import { getCampaignPool } from '../settings.js';
import { campaignRegistry } from '../campaignRegistry.js';
import { parseRules, rulesForKind, type MatchRules } from '../rulesets.js';
import { isPug } from '../rulesetStore.js';
import { newLeasePassword } from '../practiceLeases.js';
import { NOT_HELD_SQL } from '../serverHolds.js';
import { getServer } from '../serverPool.js';
import { bookingGames, gamesPlayed, liveBookingGame, type BookingGameView } from './games.js';
import { nearestFreeSlot } from '../scrims/rules.js';
import { castersOf, type CasterView } from './casters.js';
import { canSeeReliability, reliability, type Reliability } from '../scrims/reliability.js';
import { ownReview, reviewable, reviewOpen, staffReviews, type ReviewTag, type StaffReview } from '../scrims/reviews.js';
import { blocked } from '../scrims/blocks.js';
import {
  addCampaignMinutes, allowance, bookingLimits, capacityProblem, estimateMinutes, isLateCancel, iso, upcomingCount, OPEN_STATES_SQL,
  PEOPLE_PER_SIDE, SHOWN_MIN, UNCONFIRMED_CUTOFF_MS, UNCONFIRMED_TTL_MS, type BookingLimits, type BookingState, type Party,
} from './rules.js';

/**
 * Every rule about server bookings (spec part 1 section 3; plan 4a). The
 * routes and the runner call these and nothing else writes the four booking
 * tables, so the surfaces cannot disagree about who may do what.
 *
 * Each write is one better-sqlite3 transaction that re-checks its rules
 * inside and writes a booking_events row, so two requests racing (two
 * confirms, a cancel during setup) cannot both get through.
 *
 * Rights follow CURRENT team roles: a team side is managed by whoever is
 * captain or co-captain of that team now, not by who made the booking. A
 * pickup side is managed by its captain_steamid.
 */

export type Side = 'a' | 'b';
export type PersonRole = 'player' | 'ringer' | 'spectator';
const ROLES: readonly PersonRole[] = ['player', 'ringer', 'spectator'];

export interface BookingRow {
  id: number; purpose: 'scrim' | 'tournament'; region: string; starts_at: string; ends_at: string; state: BookingState;
  server_id: number | null; password: string; tv_password: string; game_config: string; rules_json: string; playlist_json: string;
  extended_minutes: number; created_by: string; created_at: string; held_at: string | null; ready_at: string | null;
  setup_attempts: number; last_human_at: string | null; reminded_60_at: string | null; reminded_15_at: string | null;
  warned_minutes: number | null; ending_at: string | null; ended_at: string | null; end_reason: string | null;
  cancelled_by: string | null; cancel_side: Side | null; cancel_reason: string | null;
  /** The ruleset the booking was made under; null for one made before the
   *  Rulesets editor. rules_json is the snapshot the booking plays by. */
  ruleset_id: number | null;
  playlist_pos: number; next_campaign: string | null; next_at: string | null;
  /** The map of next_campaign to load instead of its first (a tiebreak
   *  chapter, tournaments plan T3b); null loads the campaign from map 1. */
  next_map: string | null;
  /** The campaigns this booking may play (bookings by campaign): the
   *  playlist's length at creation, plus one per +1 campaign. */
  games_allowed: number;
  /** When the box closes after the last allowed campaign (the 5 minute
   *  "gg" grace); null when no close is pending. */
  close_at: string | null;
  /** Crash recovery (plan 5): see src/db.ts. */
  recovering_at: string | null; recover_reason: 'restart' | 'gone' | null; lost_since: string | null;
  a2s_seen_at: string | null; up_alerted_at: string | null; recoveries: number; waiting_since: string | null;
}
export interface SideRow {
  booking_id: number; side: Side; team_id: number | null; captain_steamid: string; confirmed_at: string | null;
  peak_present: number; no_show_at: string | null;
  /** Who of the side was on the box at the last minute watch (T3b): the
   *  locked four only (role player), shown as "N of 4". */
  present_now: number;
  excused_at: string | null; excused_by: string | null; excuse_note: string | null;
  /** A draft entry's name (drafts plan D2a), snapshotted at booking; NULL otherwise. */
  name: string | null;
  /** A draft entry's tag and logo key, snapshotted with the name; NULL on a
   *  team side and when the entry has none. */
  tag: string | null; logo_key: string | null;
}
export interface PersonRow {
  booking_id: number; side: Side; steamid: string; role: PersonRole; status: 'invited' | 'accepted'; added_by: string; added_at: string;
}

export const BOOKING_ERRORS = {
  not_found: { status: 404, text: 'No such booking.' },
  not_open: { status: 409, text: 'That player cannot use scrims yet.' },
  not_player: { status: 400, text: 'That is not an active player.' },
  bad_time: { status: 400, text: 'Pick a start time in the future, inside the booking window.' },
  bad_playlist: { status: 400, text: 'Pick campaigns from the map pool, each once, up to the limit.' },
  bad_ruleset: { status: 400, text: 'Pick one of the listed rule sets.' },
  pug_ruleset: { status: 400, text: 'PUG rules are for PUGs; copy them into a new ruleset for scrims and events.' },
  bad_config: { status: 400, text: 'Pick one of the listed game configs.' },
  bad_opponent: { status: 400, text: 'Pick another team or player to play against.' },
  bad_side: { status: 400, text: 'A side is a or b.' },
  bad_role: { status: 400, text: 'A role is player, ringer or spectator.' },
  not_manager: { status: 403, text: 'Only a captain or co-captain of that side can do that.' },
  no_capacity: { status: 409, text: 'Not enough servers are free for that time. Try another slot.' },
  bad_campaign: { status: 400, text: 'Pick a campaign from the map pool.' },
  no_campaign_room: { status: 409, text: 'No server is free for another campaign after this slot.' },
  allowance: { status: 409, text: 'That side already has as many upcoming bookings as allowed.' },
  wrong_state: { status: 409, text: 'The booking is past that point.' },
  already_confirmed: { status: 409, text: 'Already confirmed.' },
  already_in: { status: 409, text: 'That player is already in this booking.' },
  side_full: { status: 409, text: 'That side is full.' },
  invited_elsewhere: { status: 409, text: 'They have an invite from the other side; they accept it on the site.' },
  not_person: { status: 404, text: 'That player is not in this booking.' },
  no_invite: { status: 410, text: 'That invite is no longer open.' },
  is_captain: { status: 400, text: "A side's captain cannot be removed." },
  too_early: { status: 409, text: 'The other side still has time to arrive.' },
  not_shown: { status: 409, text: 'Your side has to be on the server first.' },
  they_showed: { status: 409, text: 'The other side is on the server.' },
  not_caster: { status: 400, text: 'That player is not a caster.' },
  already_excused: { status: 409, text: 'That is already excused.' },
  bad_review: { status: 400, text: 'A review is a thumbs up or down, with tags from the list, each once.' },
  review_closed: { status: 409, text: 'Reviews close 7 days after the scrim.' },
  // Scrim blocks (Ruling 4): the one refusal a blocked pair gets anywhere,
  // worded so it never says why.
  not_available: { status: 409, text: 'This scrim is not available to you.' },
} as const satisfies Record<string, { status: number; text: string }>;
export type BookingError = keyof typeof BOOKING_ERRORS;
export type Result<T> = { ok: true; value: T } | { ok: false; error: BookingError };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: BookingError): { ok: false; error: BookingError } => ({ ok: false, error });

// ---------- reads ----------

export function getBooking(db: DB, id: number): BookingRow | undefined {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as BookingRow | undefined;
}
export function sidesOf(db: DB, id: number): SideRow[] {
  return db.prepare('SELECT * FROM booking_sides WHERE booking_id = ? ORDER BY side').all(id) as SideRow[];
}
export function sideRow(db: DB, id: number, side: Side): SideRow | undefined {
  return db.prepare('SELECT * FROM booking_sides WHERE booking_id = ? AND side = ?').get(id, side) as SideRow | undefined;
}
export function peopleOf(db: DB, id: number): PersonRow[] {
  return db.prepare('SELECT * FROM booking_people WHERE booking_id = ? ORDER BY side, added_at, rowid').all(id) as PersonRow[];
}
export function acceptedPeople(db: DB, id: number): PersonRow[] {
  return peopleOf(db, id).filter((p) => p.status === 'accepted');
}
/** Still going: an open state and no end started. */
export function isOpen(b: BookingRow): boolean {
  return ['scheduled', 'held', 'setup', 'ready', 'active'].includes(b.state) && b.ending_at === null;
}
/** Every booking still holding something (capacity or a box), oldest start first. */
export function openBookings(db: DB): BookingRow[] {
  return db.prepare('SELECT * FROM bookings WHERE ended_at IS NULL ORDER BY starts_at, id').all() as BookingRow[];
}
export function managesSide(db: DB, s: SideRow, steamid: string): boolean {
  if (s.team_id !== null) {
    const r = roleOf(db, s.team_id, steamid);
    return r === 'captain' || r === 'cocaptain';
  }
  return s.captain_steamid === steamid;
}
export function managedSides(db: DB, id: number, steamid: string): Side[] {
  return sidesOf(db, id).filter((s) => managesSide(db, s, steamid)).map((s) => s.side);
}
/** Sides this steamid manages AND that have confirmed: an invited pickup
 *  captain (side b before it confirms) manages the side in the sense that
 *  they will become its captain, but they act only through confirm or
 *  decline until then, never cancel, extend, end or claim a no-show. */
export function actingSides(db: DB, id: number, steamid: string): Side[] {
  return sidesOf(db, id).filter((s) => managesSide(db, s, steamid) && s.confirmed_at !== null).map((s) => s.side);
}
/** The side's captain right now: for a team side, the team's current captain
 *  (transferCaptain may have moved it since the row was written); for a
 *  pickup side, the stored captain_steamid, which is stable. */
function currentCaptain(db: DB, s: Pick<SideRow, 'team_id' | 'captain_steamid'>): string {
  return s.team_id !== null ? getTeam(db, s.team_id)!.captain_steamid : s.captain_steamid;
}
export function sideName(db: DB, s: SideRow): string {
  if (s.name !== null && s.name !== undefined) return s.name;
  if (s.team_id !== null) return getTeam(db, s.team_id)?.name ?? 'A team';
  return `${getPlayer(db, s.captain_steamid)?.name ?? 'Someone'}'s group`;
}
export function bookingRules(b: BookingRow): MatchRules | null {
  try { return parseRules(b.rules_json); } catch { return null; }
}

/** May use competitive play now: the switch lets them in and they are in good standing. */
export const canUse = (db: DB, steamid: string): boolean => competitiveAccess(db, steamid) && inGoodStanding(db, steamid);

function logEvent(db: DB, id: number, actor: string | null, event: string, detail: object, now: Date): void {
  db.prepare('INSERT INTO booking_events (booking_id, at, actor, event, detail) VALUES (?, ?, ?, ?, ?)')
    .run(id, now.toISOString(), actor, event, JSON.stringify(detail));
}
/** Write one booking audit row from outside this module (a booking game
 *  starting is recorded by the match adopter, src/selfStarted.ts). */
export function logBookingEvent(db: DB, id: number, actor: string | null, event: string, detail: object, now: Date): void {
  logEvent(db, id, actor, event, detail, now);
}
function insertPerson(db: DB, id: number, side: Side, steamid: string, role: PersonRole, status: 'invited' | 'accepted', by: string, now: Date): void {
  db.prepare(`INSERT OR IGNORE INTO booking_people (booking_id, side, steamid, role, status, added_by, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, side, steamid, role, status, by, now.toISOString());
}

// ---------- input parsing ----------

export function parseStart(raw: unknown, nowMs: number, limits: BookingLimits): number | null {
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  const start = Math.floor(t / 60_000) * 60_000;
  if (start <= nowMs || start > nowMs + limits.daysAhead * 86_400_000) return null;
  return start;
}
/** Whether a slug is a campaign a booking may play: in the map pool and known. */
function isPoolCampaign(db: DB, c: unknown): c is string {
  return typeof c === 'string' && getCampaignPool(db).includes(c) && !!campaignRegistry(db).get(c);
}
export function parsePlaylist(db: DB, raw: unknown, max: number): string[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) return null;
  const out: string[] = [];
  for (const c of raw) {
    if (!isPoolCampaign(db, c) || out.includes(c)) return null;
    out.push(c);
  }
  return out;
}
/** The ruleset a booking is made under: its id (kept on the booking so the
 *  Rulesets desk can count it) and the scrim snapshot of its rules. PUG is
 *  never pickable here (it is for PUGs, not scrims): named by id, it is
 *  refused with its own sentence rather than falling through to "no such
 *  ruleset". */
function pickRules(db: DB, raw: unknown): { id: number; json: string } | null | 'pug' {
  if (Number.isInteger(raw)) {
    const named = db.prepare('SELECT template, name FROM rulesets WHERE id = ? AND archived_at IS NULL').get(raw) as
      { template: number; name: string } | undefined;
    if (named && isPug(named)) return 'pug';
  }
  const row = (raw === undefined || raw === null
    ? db.prepare("SELECT id, rules_json FROM rulesets WHERE name = 'Casual Scrim' AND archived_at IS NULL").get()
    : Number.isInteger(raw)
      ? db.prepare('SELECT id, rules_json FROM rulesets WHERE id = ? AND archived_at IS NULL').get(raw)
      : undefined) as { id: number; rules_json: string } | undefined;
  if (!row) return null;
  try {
    return { id: row.id, json: JSON.stringify(rulesForKind('scrim', parseRules(row.rules_json))) };
  } catch {
    return null;
  }
}
function pickConfig(db: DB, raw: unknown): string | null {
  const key = raw === undefined || raw === null ? 'standard' : raw;
  if (typeof key !== 'string') return null;
  return db.prepare('SELECT 1 FROM game_configs WHERE key = ? AND enabled = 1').get(key) ? key : null;
}
type Opponent = { teamId: number } | { steamid: string };
function parseOpponent(raw: unknown): Opponent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (Number.isInteger(r.teamId)) return { teamId: r.teamId as number };
  if (typeof r.steamid === 'string' && /^\d{17}$/.test(r.steamid)) return { steamid: r.steamid };
  return null;
}
const partyOf = (s: Pick<SideRow, 'team_id' | 'captain_steamid'>): Party =>
  s.team_id !== null ? { teamId: s.team_id } : { captain: s.captain_steamid };

// ---------- player writes ----------

/** A booking's slot comes from its campaigns (estimateMinutes); `minutes`
 *  is accepted from older callers and ignored. */
export function createBooking(db: DB, o: {
  by: string; teamId?: unknown; opponent: unknown; startsAt: unknown; minutes?: unknown; playlist: unknown;
  rulesetId?: unknown; gameConfig?: unknown; now?: Date;
}): Result<{ id: number }> {
  const now = o.now ?? new Date();
  const nowMs = now.getTime();
  const limits = bookingLimits(db);
  if (!canUse(db, o.by)) return fail('not_open');
  const startMs = parseStart(o.startsAt, nowMs, limits);
  if (startMs === null) return fail('bad_time');
  const playlist = parsePlaylist(db, o.playlist, limits.playlistMax);
  if (!playlist) return fail('bad_playlist');
  const minutes = estimateMinutes(db, playlist);
  const rules = pickRules(db, o.rulesetId);
  if (rules === 'pug') return fail('pug_ruleset');
  if (!rules) return fail('bad_ruleset');
  const config = pickConfig(db, o.gameConfig);
  if (!config) return fail('bad_config');
  const opp = parseOpponent(o.opponent);
  if (!opp) return fail('bad_opponent');
  const teamId = o.teamId === undefined || o.teamId === null ? null : o.teamId;
  if (teamId !== null && !Number.isInteger(teamId)) return fail('not_found');

  return db.transaction((): Result<{ id: number }> => {
    let region = 'na';
    let aCaptain = o.by;
    let aPeople = [o.by];
    if (teamId !== null) {
      const team = getTeam(db, teamId as number);
      if (!team || team.disbanded_at) return fail('not_found');
      const role = roleOf(db, team.id, o.by);
      if (role !== 'captain' && role !== 'cocaptain') return fail('not_manager');
      region = team.region;
      aCaptain = team.captain_steamid;
      aPeople = activeMembers(db, team.id).map((m) => m.steamid);
    }
    const aParty = partyOf({ team_id: teamId as number | null, captain_steamid: aCaptain });
    if (upcomingCount(db, aParty) >= allowance(db, aParty, nowMs)) return fail('allowance');

    let bTeam: number | null = null;
    let bCaptain: string;
    let bInvitee: string | null = null;
    if ('teamId' in opp) {
      const t = getTeam(db, opp.teamId);
      if (!t || t.disbanded_at || t.id === teamId) return fail('bad_opponent');
      const oppRole = roleOf(db, t.id, o.by);
      if (oppRole === 'captain' || oppRole === 'cocaptain') return fail('bad_opponent');
      if (!canUse(db, t.captain_steamid)) return fail('not_open');
      bTeam = t.id;
      bCaptain = t.captain_steamid;
    } else {
      const p = getPlayer(db, opp.steamid);
      if (!p || p.status !== 'active') return fail('not_player');
      if (aPeople.includes(opp.steamid)) return fail('bad_opponent');
      if (!canUse(db, opp.steamid)) return fail('not_open');
      bCaptain = opp.steamid;
      bInvitee = opp.steamid;
    }

    // A blocked pair never books each other, whichever side blocked.
    if (blocked(db, aParty, bTeam !== null ? { teamId: bTeam } : { captain: bCaptain })) return fail('not_available');

    const endMs = startMs + minutes * 60_000;
    if (capacityProblem(db, { region, startMs, endMs }) !== null) return fail('no_capacity');
    const id = Number(db.prepare(
      `INSERT INTO bookings (purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, ruleset_id, playlist_json, games_allowed, created_by, created_at)
       VALUES ('scrim', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(region, iso(startMs), iso(endMs), newLeasePassword(), newLeasePassword(), config, rules.json, rules.id, JSON.stringify(playlist), playlist.length,
      o.by, now.toISOString()).lastInsertRowid);
    const side = db.prepare('INSERT INTO booking_sides (booking_id, side, team_id, captain_steamid, confirmed_at) VALUES (?, ?, ?, ?, ?)');
    side.run(id, 'a', teamId, aCaptain, now.toISOString());
    side.run(id, 'b', bTeam, bCaptain, null);
    // A member who may not use competitive play (switch, ban) is not put on the booking.
    for (const sid of aPeople) if (canUse(db, sid)) insertPerson(db, id, 'a', sid, 'player', 'accepted', o.by, now);
    if (bInvitee) insertPerson(db, id, 'b', bInvitee, 'player', 'invited', o.by, now);
    logEvent(db, id, o.by, 'created', { minutes, playlist, opponent: opp }, now);
    return ok({ id });
  })();
}

// ---------- tournament bookings (tournaments plan T3b) ----------

export interface TournamentSide {
  teamId: number | null; captain: string; players: readonly string[]; spectators: readonly string[];
  /** A draft entry's name (drafts plan D2a); omitted for a team side. */
  name?: string;
  /** A draft entry's tag and logo key, for the cast overlay; omitted for a team side. */
  tag?: string | null; logoKey?: string | null;
}

/** The series engine's booking (T3b Ruling 2): purpose tournament, starts
 *  now, one campaign (later games and tiebreaks are appended), both sides
 *  confirmed, the locked four as players and the rest of each roster as
 *  spectators, all accepted. None of the scrim gates apply: the teams were
 *  let into the event already, and an event night is planned by staff. The
 *  campaign must be known (a stage pool is poolable, not necessarily in the
 *  PUG map pool) and the game config on. */
export function createTournamentBooking(db: DB, o: {
  region: string; campaign: string; rulesJson: string; rulesetId: number | null; gameConfig: string; createdBy: string;
  sides: readonly [TournamentSide, TournamentSide]; now?: Date;
}): Result<{ id: number }> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<{ id: number }> => {
    if (!campaignRegistry(db).get(o.campaign)) return fail('bad_campaign');
    if (!db.prepare('SELECT 1 FROM game_configs WHERE key = ? AND enabled = 1').get(o.gameConfig)) return fail('bad_config');
    const minutes = estimateMinutes(db, [o.campaign]);
    const startMs = now.getTime();
    const id = Number(db.prepare(
      `INSERT INTO bookings (purpose, region, starts_at, ends_at, password, tv_password, game_config, rules_json, ruleset_id, playlist_json, games_allowed, created_by, created_at)
       VALUES ('tournament', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(o.region, iso(startMs), iso(startMs + minutes * 60_000), newLeasePassword(), newLeasePassword(), o.gameConfig, o.rulesJson, o.rulesetId,
      JSON.stringify([o.campaign]), o.createdBy, now.toISOString()).lastInsertRowid);
    const side = db.prepare('INSERT INTO booking_sides (booking_id, side, team_id, captain_steamid, confirmed_at, name, tag, logo_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    (['a', 'b'] as const).forEach((s, i) => {
      const t = o.sides[i]!;
      side.run(id, s, t.teamId, t.captain, now.toISOString(), t.name ?? null, t.tag || null, t.logoKey || null);
      for (const sid of t.players) insertPerson(db, id, s, sid, 'player', 'accepted', o.createdBy, now);
      for (const sid of t.spectators) insertPerson(db, id, s, sid, 'spectator', 'accepted', o.createdBy, now);
    });
    logEvent(db, id, null, 'created', { purpose: 'tournament', campaign: o.campaign, minutes }, now);
    return ok({ id });
  })();
}

/** One more game of the series on the box (T3b Ruling 2): the campaign
 *  joins the playlist, the count and the slot grow (a single chapter counts
 *  as an unnamed campaign's length), and a pending close is cancelled. Only
 *  on an open tournament booking. */
export function appendTournamentGame(db: DB, o: { bookingId: number; campaign: string; map: string | null; now?: Date }): Result<{ gamesAllowed: number; endsAt: string }> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<{ gamesAllowed: number; endsAt: string }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (b.purpose !== 'tournament' || !isOpen(b)) return fail('wrong_state');
    if (!campaignRegistry(db).get(o.campaign)) return fail('bad_campaign');
    const minutes = addCampaignMinutes(db, o.map === null ? o.campaign : null);
    const endsAt = iso(Date.parse(b.ends_at) + minutes * 60_000);
    const gamesAllowed = b.games_allowed + 1;
    const playlist = [...(JSON.parse(b.playlist_json) as string[]), o.campaign];
    db.prepare(
      `UPDATE bookings SET ends_at = ?, games_allowed = ?, playlist_json = ?, extended_minutes = extended_minutes + ?, warned_minutes = NULL, close_at = NULL WHERE id = ?`,
    ).run(endsAt, gamesAllowed, JSON.stringify(playlist), minutes, b.id);
    logEvent(db, b.id, null, 'game_appended', { campaign: o.campaign, map: o.map, gamesAllowed, minutes, endsAt }, now);
    return ok({ gamesAllowed, endsAt });
  })();
}

/** A substitution on a tournament booking (plan T3c Ruling 5): the sub, an
 *  accepted person of the side already, becomes a player and the replaced
 *  player a spectator, so present_now counts the right four and the
 *  replaced player may stay and watch. */
export function swapPlayer(db: DB, o: { bookingId: number; side: Side; outId: string; inId: string; now?: Date }): Result<null> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<null> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b)) return fail('wrong_state');
    const person = (id: string) => db.prepare("SELECT role FROM booking_people WHERE booking_id = ? AND side = ? AND steamid = ? AND status = 'accepted'")
      .get(b.id, o.side, id) as { role: PersonRole } | undefined;
    const out = person(o.outId);
    const inn = person(o.inId);
    if (!out || out.role !== 'player' || !inn || inn.role === 'player') return fail('not_person');
    const set = db.prepare('UPDATE booking_people SET role = ? WHERE booking_id = ? AND steamid = ?');
    set.run('player', b.id, o.inId);
    set.run('spectator', b.id, o.outId);
    logEvent(db, b.id, null, 'player_swapped', { side: o.side, out: o.outId, in: o.inId }, now);
    return ok(null);
  })();
}

/** A staff replace of a draft player (drafts plan D2c Ruling 5), inside the
 *  replace's transaction: the removed player leaves the booking, so the box's
 *  allow list drops them, and the replacement plays for that side, accepted.
 *  Unlike swapPlayer the replacement need not be a booking person already
 *  (a bench player never was). */
export function replacePlayer(db: DB, o: { bookingId: number; side: Side; outId: string; inId: string; by: string; now?: Date }): Result<null> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<null> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b)) return fail('wrong_state');
    db.prepare('DELETE FROM booking_people WHERE booking_id = ? AND steamid = ?').run(b.id, o.outId);
    db.prepare(`INSERT INTO booking_people (booking_id, side, steamid, role, status, added_by, added_at) VALUES (?, ?, ?, 'player', 'accepted', ?, ?)
      ON CONFLICT (booking_id, steamid) DO UPDATE SET side = excluded.side, role = 'player', status = 'accepted'`).run(b.id, o.side, o.inId, o.by, now.toISOString());
    logEvent(db, b.id, o.by, 'player_replaced', { side: o.side, out: o.outId, in: o.inId }, now);
    return ok(null);
  })();
}

/** A draft team's new captain (drafts plan D2c addendum), inside the
 *  captaincy change's transaction: the pickup side's stored captain moves,
 *  so every booking reader (managesSide, the in-game captain check, the
 *  captains cvar) follows. Only on an open booking, and only on a side with
 *  no site team (a team side's captain is the team's). */
export function setSideCaptain(db: DB, bookingId: number, side: Side, steamid: string, by: string | null = null, now: Date = new Date()): Result<null> {
  return db.transaction((): Result<null> => {
    const b = getBooking(db, bookingId);
    if (!b) return fail('not_found');
    const s = sideRow(db, bookingId, side);
    if (!s || !isOpen(b) || s.team_id !== null) return fail('wrong_state');
    if (s.captain_steamid === steamid) return ok(null);
    db.prepare('UPDATE booking_sides SET captain_steamid = ? WHERE booking_id = ? AND side = ?').run(steamid, b.id, side);
    logEvent(db, b.id, by, 'captain_set', { side, from: s.captain_steamid, to: steamid }, now);
    return ok(null);
  })();
}

export function confirmBooking(db: DB, o: { bookingId: number; by: string; now?: Date }): Result<null> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<null> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (b.state !== 'scheduled' || b.ending_at !== null) return fail('wrong_state');
    const s = sideRow(db, b.id, 'b')!;
    if (s.confirmed_at !== null) return fail('already_confirmed');
    if (!managesSide(db, s, o.by)) return fail('not_manager');
    if (!canUse(db, o.by)) return fail('not_open');
    const party = partyOf(s);
    // A scrim invite sent before a block cannot then be taken up.
    if (b.purpose === 'scrim' && blocked(db, partyOf(sideRow(db, b.id, 'a')!), party)) return fail('not_available');
    if (upcomingCount(db, party) >= allowance(db, party, now.getTime())) return fail('allowance');
    if (capacityProblem(db, { region: b.region, startMs: Date.parse(b.starts_at), endMs: Date.parse(b.ends_at), exceptId: b.id, purpose: b.purpose }) !== null) {
      return fail('no_capacity');
    }
    db.prepare("UPDATE booking_sides SET confirmed_at = ? WHERE booking_id = ? AND side = 'b'").run(now.toISOString(), b.id);
    if (s.team_id !== null) {
      // The team's current roster, minus anyone already on side a (a player
      // may be on both teams; they play for the side that booked).
      const onA = new Set(peopleOf(db, b.id).filter((p) => p.side === 'a').map((p) => p.steamid));
      // Members who may not use competitive play (switch, ban) are left off.
      for (const m of activeMembers(db, s.team_id)) {
        if (!onA.has(m.steamid) && canUse(db, m.steamid)) insertPerson(db, b.id, 'b', m.steamid, 'player', 'accepted', o.by, now);
      }
    } else {
      db.prepare("UPDATE booking_people SET status = 'accepted' WHERE booking_id = ? AND steamid = ?").run(b.id, s.captain_steamid);
    }
    logEvent(db, b.id, o.by, 'confirmed', {}, now);
    return ok(null);
  })();
}

/** Close a booking: the terminal state, why, and the end started. With no box
 *  there is nothing to release, so ended_at is set too, except for a running
 *  booking waiting for a box after its own went down (plan 5): that one may
 *  have a live game to abort, so the runner's settle and wind-down finish it.
 *  False when it was already ending (another end got there first). */
function close(db: DB, id: number, state: 'ended' | 'cancelled' | 'no_show', reason: string, now: Date,
  extra: { cancelledBy?: string | null; cancelSide?: Side | null; cancelReason?: string | null } = {}): boolean {
  const t = now.toISOString();
  return db.prepare(
    `UPDATE bookings SET state = ?, end_reason = ?, ending_at = ?,
       ended_at = CASE WHEN server_id IS NULL AND waiting_since IS NULL THEN ? ELSE NULL END,
       cancelled_by = COALESCE(?, cancelled_by), cancel_side = COALESCE(?, cancel_side), cancel_reason = COALESCE(?, cancel_reason)
     WHERE id = ? AND ending_at IS NULL AND state IN ${OPEN_STATES_SQL}`,
  ).run(state, reason, t, t, extra.cancelledBy ?? null, extra.cancelSide ?? null, extra.cancelReason ?? null, id).changes > 0;
}

export function declineBooking(db: DB, o: { bookingId: number; by: string; now?: Date }): Result<null> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<null> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    const s = sideRow(db, b.id, 'b')!;
    if (b.state !== 'scheduled' || b.ending_at !== null || s.confirmed_at !== null) return fail('wrong_state');
    if (!managesSide(db, s, o.by)) return fail('not_manager');
    close(db, b.id, 'cancelled', 'declined', now, { cancelledBy: o.by, cancelSide: 'b' });
    logEvent(db, b.id, o.by, 'declined', {}, now);
    return ok(null);
  })();
}

export function addPerson(db: DB, o: {
  bookingId: number; by: string; side: unknown; steamid: unknown; role: unknown; staff?: boolean; now?: Date;
}): Result<{ status: 'invited' | 'accepted' }> {
  const now = o.now ?? new Date();
  if (o.side !== 'a' && o.side !== 'b') return fail('bad_side');
  if (typeof o.role !== 'string' || !ROLES.includes(o.role as PersonRole)) return fail('bad_role');
  if (typeof o.steamid !== 'string' || !/^\d{17}$/.test(o.steamid)) return fail('not_player');
  const side = o.side;
  const role = o.role as PersonRole;
  const steamid = o.steamid;
  return db.transaction((): Result<{ status: 'invited' | 'accepted' }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b)) return fail('wrong_state');
    const s = sideRow(db, b.id, side)!;
    if (!o.staff && !managesSide(db, s, o.by)) return fail('not_manager');
    if (s.confirmed_at === null) return fail('wrong_state');
    const p = getPlayer(db, steamid);
    if (!p || p.status !== 'active') return fail('not_player');
    if (!canUse(db, steamid)) return fail('not_open');
    if (db.prepare('SELECT 1 FROM booking_people WHERE booking_id = ? AND steamid = ?').get(b.id, steamid)) return fail('already_in');
    const count = (db.prepare('SELECT COUNT(*) AS n FROM booking_people WHERE booking_id = ? AND side = ?').get(b.id, side) as { n: number }).n;
    if (count >= PEOPLE_PER_SIDE) return fail('side_full');
    const status = s.team_id !== null && roleOf(db, s.team_id, steamid) !== null ? 'accepted' : 'invited';
    insertPerson(db, b.id, side, steamid, role, status, o.by, now);
    logEvent(db, b.id, o.by, 'person_added', { steamid, side, role, status }, now);
    return ok({ status });
  })();
}

/** Kept off a booked box whatever the booking says: merged away into another
 *  account, banned by status, or under an active ban. Unlike inGoodStanding,
 *  a player still `invited` (a ringer let in from the game) is not barred. */
function barredFromBox(db: DB, steamid: string, now: Date): boolean {
  if (resolveAlias(db, steamid) !== steamid) return true;
  return getPlayer(db, steamid)?.status === 'banned' || hasActiveBan(db, steamid, now);
}

/** Who may be on the booked box (plan 4b2): the steamids of the booking's
 *  accepted people who are not barred (barredFromBox), plus every admin and mod in good standing. De-duplicated
 *  and sorted, so the same list is pushed the same way each time. */
export function allowList(db: DB, bookingId: number): string[] {
  const now = new Date();
  const ids = new Set(acceptedPeople(db, bookingId).map((p) => p.steamid).filter((id) => !barredFromBox(db, id, now)));
  const staff = db.prepare('SELECT steamid FROM players WHERE is_admin = 1 OR is_mod = 1').all() as { steamid: string }[];
  for (const { steamid } of staff) if (inGoodStanding(db, steamid)) ids.add(steamid);
  return [...ids].sort();
}

/** Who belongs in each side's private voice channel (plan 4c, ruling 2):
 *  the allowlist's people without staff (staff come in through the staff
 *  role), that is the accepted people who are not barred, and only those with
 *  a linked Discord account. */
export function voiceMembers(db: DB, bookingId: number): { side: Side; discordId: string }[] {
  const now = new Date();
  const out: { side: Side; discordId: string }[] = [];
  for (const p of acceptedPeople(db, bookingId)) {
    if (barredFromBox(db, p.steamid, now)) continue;
    const discordId = getPlayer(db, p.steamid)?.discord_id;
    if (discordId) out.push({ side: p.side, discordId });
  }
  return out;
}

/** The longest name kept for someone a captain lets in from the game. */
const GAME_NAME_MAX = 32;

/** A name from the game, made safe to store: trimmed, cut to 32
 *  characters, and the steamid when it is empty or has unsafe characters
 *  (the same rule players' own text goes through). */
export function gameName(steamid: string, raw: unknown): string {
  const trimmed = typeof raw === 'string' ? [...raw.trim()].slice(0, GAME_NAME_MAX).join('').trim() : '';
  return trimmed === '' || hasUnsafeChars(trimmed) ? steamid : trimmed;
}

/** A captain's in-game `!allow` (plan 4b2): the person connecting joins the
 *  captain's side as an accepted ringer, or, holding an open invite to a side
 *  this captain runs, has it accepted. Already accepted is `added: false`. Only a manager of a confirmed side of
 *  an open booking that is ready or active, and only through the runner's
 *  signed PUGBOOK line. It touches nothing but `players` (a row inserted if
 *  absent, status invited, never an admin) and `booking_people`. The name
 *  comes from the game and is untrusted: trimmed, cut to 32 characters, and
 *  replaced by the steamid when it is empty or has unsafe characters. */
export function allowInGame(db: DB, o: { bookingId: number; by: string; steamid: unknown; name: unknown; now?: Date }): Result<{ side: Side; added: boolean }> {
  const now = o.now ?? new Date();
  if (typeof o.steamid !== 'string' || !/^\d{17}$/.test(o.steamid)) return fail('not_player');
  const steamid = o.steamid;
  const name = gameName(steamid, o.name);
  return db.transaction((): Result<{ side: Side; added: boolean }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b) || (b.state !== 'ready' && b.state !== 'active')) return fail('wrong_state');
    const side = actingSides(db, b.id, o.by)[0];
    if (!side) return fail('not_manager');
    if (barredFromBox(db, steamid, now)) return fail('not_player');
    const row = db.prepare('SELECT * FROM booking_people WHERE booking_id = ? AND steamid = ?').get(b.id, steamid) as PersonRow | undefined;
    if (row?.status === 'accepted') return ok({ side, added: false });
    if (row) {
      // An open invite: a captain of that side letting them in accepts it
      // for them (role kept); the other side's invite is theirs to answer.
      if (!actingSides(db, b.id, o.by).includes(row.side)) return fail('invited_elsewhere');
      db.prepare("UPDATE booking_people SET status = 'accepted' WHERE booking_id = ? AND steamid = ?").run(b.id, steamid);
      logEvent(db, b.id, o.by, 'person_allowed_in_game', { steamid, side: row.side, accepted: true }, now);
      return ok({ side: row.side, added: true });
    }
    const count = (db.prepare('SELECT COUNT(*) AS n FROM booking_people WHERE booking_id = ? AND side = ?').get(b.id, side) as { n: number }).n;
    if (count >= PEOPLE_PER_SIDE) return fail('side_full');
    db.prepare("INSERT OR IGNORE INTO players (steamid, name, status) VALUES (?, ?, 'invited')").run(steamid, name);
    insertPerson(db, b.id, side, steamid, 'ringer', 'accepted', o.by, now);
    logEvent(db, b.id, o.by, 'person_allowed_in_game', { steamid, side }, now);
    return ok({ side, added: true });
  })();
}

export function respondPerson(db: DB, o: { bookingId: number; steamid: string; accept: boolean; now?: Date }): Result<null> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<null> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b)) return fail('wrong_state');
    const row = db.prepare("SELECT * FROM booking_people WHERE booking_id = ? AND steamid = ? AND status = 'invited'").get(b.id, o.steamid) as PersonRow | undefined;
    if (!row) return fail('no_invite');
    // Side b's invited captain answers through confirm/decline, not here.
    const s = sideRow(db, b.id, row.side)!;
    if (s.confirmed_at === null) return fail('wrong_state');
    if (o.accept) {
      if (!canUse(db, o.steamid)) return fail('not_open');
      db.prepare("UPDATE booking_people SET status = 'accepted' WHERE booking_id = ? AND steamid = ?").run(b.id, o.steamid);
    } else {
      db.prepare('DELETE FROM booking_people WHERE booking_id = ? AND steamid = ?').run(b.id, o.steamid);
    }
    logEvent(db, b.id, o.steamid, o.accept ? 'person_accepted' : 'person_declined', {}, now);
    return ok(null);
  })();
}

export function removePerson(db: DB, o: { bookingId: number; by: string; steamid: string; staff?: boolean; now?: Date }): Result<null> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<null> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b)) return fail('wrong_state');
    const row = db.prepare('SELECT * FROM booking_people WHERE booking_id = ? AND steamid = ?').get(b.id, o.steamid) as PersonRow | undefined;
    if (!row) return fail('not_person');
    const s = sideRow(db, b.id, row.side)!;
    if (currentCaptain(db, s) === o.steamid) return fail('is_captain');
    if (!o.staff && o.by !== o.steamid && !managesSide(db, s, o.by)) return fail('not_manager');
    db.prepare('DELETE FROM booking_people WHERE booking_id = ? AND steamid = ?').run(b.id, o.steamid);
    logEvent(db, b.id, o.by, o.by === o.steamid ? 'person_left' : 'person_removed', { steamid: o.steamid }, now);
    return ok(null);
  })();
}

export function cancelBooking(db: DB, o: { bookingId: number; by: string; staff?: boolean; reason?: unknown; now?: Date }): Result<{ hadServer: boolean }> {
  const now = o.now ?? new Date();
  const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim().slice(0, 300) : null;
  return db.transaction((): Result<{ hadServer: boolean }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (!isOpen(b)) return fail('wrong_state');
    const mine = actingSides(db, b.id, o.by);
    if (!o.staff && mine.length === 0) return fail('not_manager');
    // Staff cancels belong to no side (scrim spec 3a: never counted against anyone).
    const side = o.staff ? null : mine[0];
    close(db, b.id, 'cancelled', o.staff ? 'staff' : 'cancelled', now, { cancelledBy: o.by, cancelSide: side, cancelReason: reason });
    logEvent(db, b.id, o.by, 'cancelled', { side, reason, staff: !!o.staff }, now);
    return ok({ hadServer: b.server_id !== null });
  })();
}

/** The reason a bumped scrim carries on its page (Ruling 5); the DM says
 *  the same. The time is written as whenUtc does (src/bookings/messages.ts
 *  imports this module, so the format is repeated rather than imported). */
export function bumpReason(nearestSlot: string | null): string {
  const slot = nearestSlot
    ? `The nearest free slot is ${nearestSlot.slice(0, 10)} ${nearestSlot.slice(11, 16)} UTC.`
    : 'No other slot is free within 3 hours of the start.';
  return `A tournament match needed the server. ${slot}`;
}

/**
 * A scrim bumped by a tournament match (server priority, Rulings 4 to 6):
 * closed as cancelled with end_reason 'bumped' and a side of nobody, so it is
 * never a late cancel, a no-show or a short side and nothing lands on either
 * record. Once the row no longer counts, the nearest free slot of the same
 * length (src/scrims/rules.ts) is worked out for the reason, the event and
 * the DM. Only an open scrim that has not started: never a tournament
 * booking, never one that is active, has a live game or is in crash
 * recovery. The runner winds the box down and tells both sides.
 */
export function bumpBooking(db: DB, o: { bookingId: number; byBookingId: number; now?: Date }): Result<{ hadServer: boolean; nearestSlot: string | null }> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<{ hadServer: boolean; nearestSlot: string | null }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (b.purpose !== 'scrim' || !isOpen(b) || b.state === 'active' || b.recovering_at !== null || liveBookingGame(db, b.id)) return fail('wrong_state');
    if (!close(db, b.id, 'cancelled', 'bumped', now)) return fail('wrong_state');
    const minutes = Math.round((Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 60_000);
    const nearestSlot = nearestFreeSlot(db, b.region, Date.parse(b.starts_at), minutes, now.getTime());
    db.prepare('UPDATE bookings SET cancel_reason = ? WHERE id = ?').run(bumpReason(nearestSlot), b.id);
    logEvent(db, b.id, null, 'bumped', { byBookingId: o.byBookingId, nearestSlot }, now);
    return ok({ hadServer: b.server_id !== null, nearestSlot });
  })();
}

/** The longest excuse note kept. */
const EXCUSE_NOTE_MAX = 200;

/**
 * A confirmed side of a booking that closed as ended or no_show and never had
 * SHOWN_MIN people on the box: the record counts it booked but not shown,
 * whether or not anyone claimed the no-show (an idle end nobody joined, or a
 * scrim the two sides moved between themselves), so staff may excuse it.
 */
export function shortSide(b: BookingRow, s: SideRow): boolean {
  return (b.state === 'ended' || b.state === 'no_show') && s.confirmed_at !== null && s.peak_present < SHOWN_MIN;
}

/**
 * Excuse a side's mark on a booking (plan 2 Ruling 2): excused marks never
 * count, not in the record and not in the allowance. A side's manager may
 * excuse the OTHER side's late cancel ("All good, no hard feelings"), and only
 * that, and never while they also manage the cancelling side; staff name the
 * side and may excuse its late cancel, its no-show (a crash that was nobody's
 * fault), or a short side (shortSide) nobody claimed. One excuse per side per
 * booking.
 */
export function excuseMark(db: DB, o: {
  bookingId: number; by: string; staff?: boolean; side?: unknown; note?: unknown; now?: Date;
}): Result<{ side: Side }> {
  const now = o.now ?? new Date();
  const note = typeof o.note === 'string' && o.note.trim() ? o.note.trim().slice(0, EXCUSE_NOTE_MAX) : null;
  if (o.staff && o.side !== 'a' && o.side !== 'b') return fail('bad_side');
  return db.transaction((): Result<{ side: Side }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    const late = isLateCancel(db, b);
    let side: Side;
    if (o.staff) {
      side = o.side as Side;
      const row = sideRow(db, b.id, side)!;
      const marked = (late && b.cancel_side === side) || row.no_show_at !== null || shortSide(b, row);
      if (!marked) return fail('wrong_state');
    } else {
      if (!late) return fail('wrong_state');
      side = b.cancel_side!;
      const other: Side = side === 'a' ? 'b' : 'a';
      // Someone who manages both sides would be excusing their own cancel.
      const mine = actingSides(db, b.id, o.by);
      if (!mine.includes(other) || mine.includes(side)) return fail('not_manager');
    }
    if (sideRow(db, b.id, side)!.excused_at !== null) return fail('already_excused');
    db.prepare('UPDATE booking_sides SET excused_at = ?, excused_by = ?, excuse_note = ? WHERE booking_id = ? AND side = ?')
      .run(now.toISOString(), o.by, note, b.id, side);
    logEvent(db, b.id, o.by, 'excused', { side, staff: !!o.staff }, now);
    return ok({ side });
  })();
}

/**
 * +1 campaign (bookings by campaign, Ruling 5), which replaced Extend: one
 * more game allowed, and the slot's end moved out by addCampaignMinutes,
 * capacity-checked from the current end. A named campaign must be a pool
 * campaign and is appended to the playlist (it may repeat one already
 * there: a replay is still a game); without one the captains pick it in
 * game when the time comes. Any pending close is cancelled. A captain adds
 * only to a ready or active booking, as a confirmed side; staff to any open
 * booking. Each call is its own transaction, so two at once add two, each
 * checked against the capacity the other left.
 */
export function addCampaign(db: DB, o: {
  bookingId: number; by: string; staff?: boolean; campaign?: unknown; now?: Date;
}): Result<{ gamesAllowed: number; endsAt: string; campaign: string | null }> {
  const now = o.now ?? new Date();
  const campaign = o.campaign === undefined || o.campaign === null ? null : o.campaign;
  return db.transaction((): Result<{ gamesAllowed: number; endsAt: string; campaign: string | null }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if (o.staff) {
      if (!isOpen(b)) return fail('wrong_state');
    } else {
      if ((b.state !== 'ready' && b.state !== 'active') || b.ending_at !== null) return fail('wrong_state');
      if (actingSides(db, b.id, o.by).length === 0) return fail('not_manager');
    }
    // After the gate, so a stranger learns nothing from a bad slug.
    if (campaign !== null && !isPoolCampaign(db, campaign)) return fail('bad_campaign');
    const minutes = addCampaignMinutes(db, campaign);
    const from = Date.parse(b.ends_at);
    if (capacityProblem(db, { region: b.region, startMs: from, endMs: from + minutes * 60_000, exceptId: b.id, purpose: b.purpose }) !== null) {
      return fail('no_campaign_room');
    }
    const endsAt = iso(from + minutes * 60_000);
    const gamesAllowed = b.games_allowed + 1;
    const playlist = JSON.parse(b.playlist_json) as string[];
    // A +1 may take the playlist past booking_playlist_max on purpose: that
    // cap is for booking up front, and +1 is how a running booking goes on.
    if (campaign !== null) playlist.push(campaign);
    db.prepare(
      `UPDATE bookings SET ends_at = ?, games_allowed = ?, playlist_json = ?, extended_minutes = extended_minutes + ?,
         warned_minutes = NULL, close_at = NULL WHERE id = ?`,
    ).run(endsAt, gamesAllowed, JSON.stringify(playlist), minutes, b.id);
    logEvent(db, b.id, o.by, 'campaign_added', { campaign, gamesAllowed, minutes, endsAt, staff: !!o.staff }, now);
    return ok({ gamesAllowed, endsAt, campaign });
  })();
}

export function claimNoShow(db: DB, o: { bookingId: number; by: string; now?: Date }): Result<{ absent: Side }> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<{ absent: Side }> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if ((b.state !== 'ready' && b.state !== 'active') || b.ending_at !== null) return fail('wrong_state');
    const mine = actingSides(db, b.id, o.by)[0];
    if (!mine) return fail('not_manager');
    const absent: Side = mine === 'a' ? 'b' : 'a';
    const grace = bookingRules(b)?.noShowGraceMinutes ?? 15;
    if (now.getTime() < Date.parse(b.starts_at) + grace * 60_000) return fail('too_early');
    if (sideRow(db, b.id, mine)!.peak_present < SHOWN_MIN) return fail('not_shown');
    if (sideRow(db, b.id, absent)!.peak_present >= SHOWN_MIN) return fail('they_showed');
    db.prepare('UPDATE booking_sides SET no_show_at = ? WHERE booking_id = ? AND side = ?').run(now.toISOString(), b.id, absent);
    close(db, b.id, 'no_show', 'no_show', now);
    logEvent(db, b.id, o.by, 'no_show', { absent }, now);
    return ok({ absent });
  })();
}

export function endBooking(db: DB, o: { bookingId: number; by: string; staff?: boolean; now?: Date }): Result<null> {
  const now = o.now ?? new Date();
  return db.transaction((): Result<null> => {
    const b = getBooking(db, o.bookingId);
    if (!b) return fail('not_found');
    if ((b.state !== 'ready' && b.state !== 'active') || b.ending_at !== null) return fail('wrong_state');
    if (!o.staff && actingSides(db, b.id, o.by).length === 0) return fail('not_manager');
    close(db, b.id, 'ended', o.staff ? 'staff' : 'captain', now);
    logEvent(db, b.id, o.by, 'ended', { staff: !!o.staff }, now);
    return ok(null);
  })();
}

// ---------- runner writes ----------

/** Take this box for the booking: only an idle, enabled box nothing holds,
 *  and only while the booking is scheduled with no box. The check and the
 *  write are one statement, so a claimIdle in between cannot race it. */
export function holdBox(db: DB, id: number, serverId: number, now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare(
      `UPDATE bookings SET server_id = ?, state = 'held', held_at = ?
        WHERE id = ? AND state = 'scheduled' AND server_id IS NULL AND ending_at IS NULL
          AND ? IN (SELECT id FROM servers WHERE status = 'idle' AND enabled = 1 AND ${NOT_HELD_SQL})`,
    ).run(serverId, now.toISOString(), id, serverId).changes > 0;
    if (changed) logEvent(db, id, null, 'held', { serverId }, now);
    return changed;
  })();
}

/** A web restart must not spend a setup try: bookkeeping only (no audit
 *  row), called by the runner's resume() before it re-runs setup. */
export function resetSetupAttempts(db: DB, id: number): void {
  db.prepare("UPDATE bookings SET setup_attempts = 0 WHERE id = ? AND state IN ('held','setup') AND ending_at IS NULL").run(id);
}

/** Start (or restart) setup; the attempt number, or null when the booking is
 *  not held or ending. */
export function markSetup(db: DB, id: number, now: Date): number | null {
  return db.transaction(() => {
    const changed = db.prepare(
      "UPDATE bookings SET state = 'setup', setup_attempts = setup_attempts + 1 WHERE id = ? AND state IN ('held','setup') AND ending_at IS NULL",
    ).run(id).changes > 0;
    if (!changed) return null;
    const n = (db.prepare('SELECT setup_attempts AS n FROM bookings WHERE id = ?').get(id) as { n: number }).n;
    logEvent(db, id, null, 'setup_started', { attempt: n }, now);
    return n;
  })();
}

export function markReady(db: DB, id: number, now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare("UPDATE bookings SET state = 'ready', ready_at = ? WHERE id = ? AND state = 'setup' AND ending_at IS NULL")
      .run(now.toISOString(), id).changes > 0;
    if (changed) logEvent(db, id, null, 'ready', {}, now);
    return changed;
  })();
}

export function markActive(db: DB, id: number, now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare("UPDATE bookings SET state = 'active' WHERE id = ? AND state = 'ready' AND ending_at IS NULL").run(id).changes > 0;
    if (changed) logEvent(db, id, null, 'active', {}, now);
    return changed;
  })();
}

/** The runner's own ends: time, idle, setup_failed, no_server, unconfirmed. */
export function closeBooking(db: DB, id: number, state: 'ended' | 'cancelled', reason: string, now: Date, actor: string | null = null): boolean {
  return db.transaction(() => {
    const changed = close(db, id, state, reason, now);
    if (changed) logEvent(db, id, actor, state === 'ended' ? 'ended' : 'cancelled', { reason }, now);
    return changed;
  })();
}

/** The box is back in the pool (or there was none): the booking holds nothing. */
export function markReleased(db: DB, id: number, now: Date): void {
  db.transaction(() => {
    if (db.prepare('UPDATE bookings SET ended_at = ? WHERE id = ? AND ended_at IS NULL AND ending_at IS NOT NULL').run(now.toISOString(), id).changes > 0) {
      logEvent(db, id, null, 'released', {}, now);
    }
  })();
}

/** The campaign the box loads next and when it is due (both null clears
 *  it). `map` (plan T3b): load this map of the campaign instead of its
 *  first, for a tiebreak chapter. Only on a running booking: ready or
 *  active, no end started. */
export function setNext(db: DB, id: number, campaign: string | null, atIso: string | null, now: Date = new Date(), actor: string | null = null, map: string | null = null): boolean {
  return db.transaction(() => {
    const nextMap = campaign === null ? null : map;
    const changed = db.prepare(
      "UPDATE bookings SET next_campaign = ?, next_at = ?, next_map = ? WHERE id = ? AND state IN ('ready','active') AND ending_at IS NULL",
    ).run(campaign, atIso, nextMap, id).changes > 0;
    if (changed) logEvent(db, id, actor, 'next_set', { campaign, at: atIso, map: nextMap }, now);
    return changed;
  })();
}

/** The box has been sent the next campaign: the playlist position moves to
 *  `pos` and nothing is due any more. Only on a running booking. */
export function advancePlaylist(db: DB, id: number, pos: number, now: Date = new Date()): boolean {
  return db.transaction(() => {
    const b = getBooking(db, id);
    const changed = db.prepare(
      "UPDATE bookings SET playlist_pos = ?, next_campaign = NULL, next_at = NULL, next_map = NULL WHERE id = ? AND state IN ('ready','active') AND ending_at IS NULL",
    ).run(pos, id).changes > 0;
    if (changed) logEvent(db, id, null, 'campaign_loaded', { campaign: b?.next_campaign ?? null, pos }, now);
    return changed;
  })();
}

/** One look at who is on the box: each side's count of its people present,
 *  kept as a running peak, and when anyone was last there. `playersNow`
 *  (plan T3b) is each side's count of its players (role player) present,
 *  kept as present_now; it defaults to `present`. */
export function recordPresence(db: DB, id: number, present: Record<Side, number>, anyHuman: boolean, now: Date, playersNow: Record<Side, number> = present): void {
  db.transaction(() => {
    const peak = db.prepare('UPDATE booking_sides SET peak_present = MAX(peak_present, ?), present_now = ? WHERE booking_id = ? AND side = ?');
    peak.run(present.a, playersNow.a, id, 'a');
    peak.run(present.b, playersNow.b, id, 'b');
    if (anyHuman) db.prepare('UPDATE bookings SET last_human_at = ? WHERE id = ?').run(now.toISOString(), id);
  })();
}

export function setReminded(db: DB, id: number, which: 60 | 15, now: Date): void {
  db.prepare(`UPDATE bookings SET reminded_${which}_at = ? WHERE id = ?`).run(now.toISOString(), id);
}

export function setWarned(db: DB, id: number, minutes: number): void {
  db.prepare('UPDATE bookings SET warned_minutes = ? WHERE id = ?').run(minutes, id);
}

/** Bookings by campaign, Ruling 3: `played` finished games have reached
 *  games_allowed, so the booking closes at `atIso` unless +1 campaign
 *  (addCampaign, which clears close_at) comes first. Only on a running
 *  booking whose count has really been reached. ending_at stays null through
 *  the grace, so a captain can still add a campaign. */
export function setCloseAt(db: DB, id: number, played: number, atIso: string, now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare(
      "UPDATE bookings SET close_at = ? WHERE id = ? AND state IN ('ready','active') AND ending_at IS NULL AND games_allowed <= ?",
    ).run(atIso, id, played).changes > 0;
    if (changed) logEvent(db, id, null, 'close_set', { at: atIso, played }, now);
    return changed;
  })();
}

/** Invites nobody confirmed in time (rules.ts UNCONFIRMED_*), cancelled. */
export function expireUnconfirmed(db: DB, now: Date): number[] {
  const nowMs = now.getTime();
  const rows = db.prepare(
    `SELECT b.id, b.created_at, b.starts_at FROM bookings b JOIN booking_sides s ON s.booking_id = b.id AND s.side = 'b'
      WHERE b.state = 'scheduled' AND b.ending_at IS NULL AND s.confirmed_at IS NULL ORDER BY b.id`,
  ).all() as { id: number; created_at: string; starts_at: string }[];
  const out: number[] = [];
  for (const r of rows) {
    const startMs = Date.parse(r.starts_at);
    // A booking made the cutoff or less ahead was already at or inside it when it
    // was made: it gets until its start to be confirmed instead.
    const lateMade = Date.parse(r.created_at) >= startMs - UNCONFIRMED_CUTOFF_MS;
    const cutoff = lateMade ? startMs : startMs - UNCONFIRMED_CUTOFF_MS;
    if (Date.parse(r.created_at) + UNCONFIRMED_TTL_MS <= nowMs || cutoff <= nowMs) {
      if (closeBooking(db, r.id, 'cancelled', 'unconfirmed', now)) out.push(r.id);
    }
  }
  return out;
}

// ---------- crash recovery (plan 5) ----------

/** The first moment of the current outage (rcon stopped answering); kept
 *  across calls so the gone clock never restarts while the box stays silent. */
export function noteLost(db: DB, id: number, now: Date): string {
  db.prepare('UPDATE bookings SET lost_since = ? WHERE id = ? AND lost_since IS NULL').run(now.toISOString(), id);
  return (db.prepare('SELECT lost_since FROM bookings WHERE id = ?').get(id) as { lost_since: string }).lost_since;
}

/** rcon answered: the outage, if any, is over. Bookkeeping only. */
export function noteAlive(db: DB, id: number): void {
  db.prepare('UPDATE bookings SET lost_since = NULL, a2s_seen_at = NULL, up_alerted_at = NULL WHERE id = ? AND lost_since IS NOT NULL').run(id);
}

/** The box answered an A2S query during the outage. */
export function noteA2s(db: DB, id: number, now: Date): void {
  db.prepare('UPDATE bookings SET a2s_seen_at = ? WHERE id = ?').run(now.toISOString(), id);
}

/** True the first time in an outage: staff are told once that the box is up
 *  but rcon is not answering. */
export function markUpAlerted(db: DB, id: number, now: Date): boolean {
  return db.prepare('UPDATE bookings SET up_alerted_at = ? WHERE id = ? AND up_alerted_at IS NULL').run(now.toISOString(), id).changes > 0;
}

export function beginRecovery(db: DB, id: number, reason: 'restart' | 'gone', now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare(
      `UPDATE bookings SET recovering_at = ?, recover_reason = ?
        WHERE id = ? AND state IN ('ready','active') AND ending_at IS NULL AND recovering_at IS NULL AND server_id IS NOT NULL`,
    ).run(now.toISOString(), reason, id).changes > 0;
    if (changed) {
      const serverId = (db.prepare('SELECT server_id FROM bookings WHERE id = ?').get(id) as { server_id: number }).server_id;
      logEvent(db, id, null, 'recovery_started', { reason, serverId }, now);
    }
    return changed;
  })();
}

/** The box is gone (plan 5 ruling 4): the booking lets go of it and waits for
 *  another, and the box goes offline so nothing else is handed it. Returns
 *  the box given up, or null when there was nothing to give up. */
export function dropBox(db: DB, id: number, now: Date): number | null {
  return db.transaction(() => {
    const b = db.prepare("SELECT server_id FROM bookings WHERE id = ? AND recovering_at IS NOT NULL AND ending_at IS NULL AND server_id IS NOT NULL")
      .get(id) as { server_id: number } | undefined;
    if (!b) return null;
    db.prepare('UPDATE bookings SET server_id = NULL, waiting_since = ? WHERE id = ?').run(now.toISOString(), id);
    db.prepare("UPDATE servers SET status = 'offline', gone_since = ? WHERE id = ?").run(now.toISOString(), b.server_id);
    logEvent(db, id, null, 'box_dropped', { serverId: b.server_id }, now);
    return b.server_id;
  })();
}

/** A waiting booking takes another box: idle, enabled, held by nothing. The
 *  live game (if any) moves with it, so the dump is pulled from the right box. */
export function reholdBox(db: DB, id: number, serverId: number, now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare(
      `UPDATE bookings SET server_id = ?, waiting_since = NULL
        WHERE id = ? AND server_id IS NULL AND waiting_since IS NOT NULL AND recovering_at IS NOT NULL AND ending_at IS NULL
          AND ? IN (SELECT id FROM servers WHERE status = 'idle' AND enabled = 1 AND ${NOT_HELD_SQL})`,
    ).run(serverId, id, serverId).changes > 0;
    if (!changed) return false;
    db.prepare("UPDATE matches SET server_id = ? WHERE booking_id = ? AND state = 'live'").run(serverId, id);
    logEvent(db, id, null, 'box_moved', { serverId }, now);
    return true;
  })();
}

/** Staff move the booking to another box (plan T3c Ruling 13): the same
 *  shape a gone box leaves behind (so relocate, recover and the give-up
 *  apply unchanged), except the box itself is left alone: the runner gives
 *  it back through the releaser. Returns the box let go of, or null when
 *  the booking is not running on one or is already recovering. */
export function beginMove(db: DB, id: number, now: Date): number | null {
  return db.transaction(() => {
    const b = db.prepare(
      "SELECT server_id FROM bookings WHERE id = ? AND state IN ('ready','active') AND ending_at IS NULL AND recovering_at IS NULL AND server_id IS NOT NULL",
    ).get(id) as { server_id: number } | undefined;
    if (!b) return null;
    db.prepare("UPDATE bookings SET server_id = NULL, waiting_since = ?, recovering_at = ?, recover_reason = 'gone' WHERE id = ?")
      .run(now.toISOString(), now.toISOString(), id);
    logEvent(db, id, null, 'box_moved_by_staff', { serverId: b.server_id }, now);
    return b.server_id;
  })();
}

/** The recovery is done: the outage fields clear and the idle clock restarts,
 *  since everyone is reconnecting (Review Focus: no idle end right after).
 *  Refused once an end has come in: the caller winds the booking down instead.
 *
 *  The live game's heartbeat clock restarts too. The orphan reaper skips a
 *  game only while its booking is recovering; after a long wait for a box the
 *  last heartbeat is long past the reaper's limit, and the fresh plugin's
 *  first one can land up to 30 s after this. Written as datetime('now'), the
 *  clock and form the heartbeat writer and the reaper use. */
export function finishRecovery(db: DB, id: number, now: Date): boolean {
  return db.transaction(() => {
    const changed = db.prepare(
      `UPDATE bookings SET recovering_at = NULL, recover_reason = NULL, lost_since = NULL, a2s_seen_at = NULL,
              up_alerted_at = NULL, waiting_since = NULL, recoveries = recoveries + 1, last_human_at = ?
        WHERE id = ? AND recovering_at IS NOT NULL AND ending_at IS NULL AND server_id IS NOT NULL`,
    ).run(now.toISOString(), id).changes > 0;
    if (!changed) return false;
    db.prepare(
      "UPDATE match_live SET last_seen = datetime('now') WHERE match_id IN (SELECT id FROM matches WHERE booking_id = ? AND state = 'live')",
    ).run(id);
    logEvent(db, id, null, 'recovered', {}, now);
    return true;
  })();
}

// ---------- views ----------

export interface BookingPersonView { steamid: string; name: string; avatar: string | null; role: PersonRole; status: 'invited' | 'accepted' }
export interface BookingSideView {
  side: Side; name: string; team: { id: number; slug: string; name: string; tag: string; logoKey: string | null } | null;
  captain: { steamid: string; name: string }; confirmed: boolean; peakPresent: number; noShow: boolean; people: BookingPersonView[];
  /** This side cancelled late (plan 2), and whether its mark is excused. */
  lateCancel: boolean; excused: boolean;
  /** The viewer manages the other side (and not this one) and may excuse
   *  this side's late cancel. */
  canExcuse: boolean;
  /** shortSide: closed as ended or no_show with this side under SHOWN_MIN,
   *  claimed or not, so staff may excuse it. */
  short: boolean;
  /** The side's record, only for those canSeeReliability lets see it. */
  record?: Reliability;
}
export interface BookingView {
  id: number; purpose: 'scrim' | 'tournament'; state: BookingState; ending: boolean;
  /** The close has finished (ended_at set): ending stays true for ever after. */
  ended: boolean;
  startsAt: string; endsAt: string;
  extendedMinutes: number; createdAt: string;
  /** Campaigns this booking may play, finished booking games so far (an
   *  aborted one is not a game), and when the box closes after the last one
   *  (null when no close is pending). */
  gamesAllowed: number; gamesPlayed: number; closeAt: string | null; playlist: { slug: string; name: string }[]; rules: MatchRules | null;
  gameConfig: { key: string; label: string }; sides: BookingSideView[]; server: { name: string } | null;
  connect: { host: string; port: number; password: string } | null;
  cancel: { side: Side | null; reason: string | null } | null; endReason: string | null;
  noShowFrom: string;
  /** Crash recovery (plan 5): present while the booking's box is being set up
   *  again after a restart, or while it waits for another box after the old
   *  one was lost. `moved` is true for the latter (recover_reason 'gone');
   *  `waiting` is true once the old box has been let go and a new one has not
   *  yet been found (server_id is null, so `connect` above is also null). */
  recovery: { since: string; moved: boolean; waiting: boolean } | null;
  viewer: { side: Side | null; manages: Side[]; staff: boolean; invited: boolean };
  games: BookingGameView[];
  /** Casters either side invited, and which halves are set (plan 4c). */
  casters: CasterView[];
  /** Re-posting a cancelled scrim in one click (plan 2 Ruling 4): true only
   *  when the booking is cancelled, its purpose is scrim, it came from a
   *  post, and the viewer manages a side. The time is never pre-checked
   *  here; a start too close to post again comes back as the click's own
   *  refusal. */
  repost: { allowed: boolean };
  /** Plan 2 Ruling 5: present only when the viewer manages exactly one
   *  confirmed side of a scrim that closed as ended or no_show (managing both
   *  would be reviewing yourself). open says whether the 7 day
   *  window still takes a review; mine is the viewer's own side's review. The
   *  other side's review is never here. */
  review?: { open: boolean; mine: { thumbs: 1 | -1; tags: ReviewTag[] } | null };
  /** Both sides' single reviews, for staff only. */
  reviews?: StaffReview[];
}

/** Whether bookingView would answer this viewer at all: staff, anyone on
 *  the booking's people list (invited or accepted), or a manager of either
 *  side. A team member who is none of these sees the booking's games
 *  (src/matchVisibility.ts) but not the booking page itself. */
export function seesBooking(db: DB, id: number, viewer: { steamid: string; staff: boolean }): boolean {
  if (viewer.staff) return true;
  if (db.prepare('SELECT 1 FROM booking_people WHERE booking_id = ? AND steamid = ?').get(id, viewer.steamid)) return true;
  return managedSides(db, id, viewer.steamid).length > 0;
}

export function bookingView(db: DB, id: number, viewer: { steamid: string; staff: boolean }, nowMs: number = Date.now()): BookingView | null {
  const b = getBooking(db, id);
  if (!b) return null;
  if (!seesBooking(db, id, viewer)) return null;
  const people = peopleOf(db, id);
  const me = people.find((p) => p.steamid === viewer.steamid);
  const manages = managedSides(db, id, viewer.steamid);
  const registry = campaignRegistry(db);
  const server = b.server_id !== null ? getServer(db, b.server_id) : undefined;
  const running = (b.state === 'ready' || b.state === 'active') && b.ending_at === null;
  const canConnect = viewer.staff || me?.status === 'accepted';
  const config = db.prepare('SELECT key, label FROM game_configs WHERE key = ?').get(b.game_config) as { key: string; label: string } | undefined;
  const rules = bookingRules(b);
  const late = isLateCancel(db, b);
  const acting = actingSides(db, id, viewer.steamid);
  // The games follow canViewMatch's rule for a booking game (src/matchVisibility.ts)
  // as far as this page's viewers go: staff, an accepted person, or a manager
  // of a confirmed side. A plain team member who is none of these sees the
  // games from the team's Scrims section instead, never this page.
  const seesGames = viewer.staff || me?.status === 'accepted'
    || sidesOf(db, id).some((s) => s.confirmed_at !== null && manages.includes(s.side));
  return {
    id: b.id, purpose: b.purpose, state: b.state, ending: b.ending_at !== null, ended: b.ended_at !== null, startsAt: b.starts_at, endsAt: b.ends_at,
    extendedMinutes: b.extended_minutes, createdAt: b.created_at,
    gamesAllowed: b.games_allowed, gamesPlayed: gamesPlayed(db, id), closeAt: b.close_at,
    playlist: (JSON.parse(b.playlist_json) as string[]).map((slug) => ({ slug, name: registry.get(slug)?.name ?? slug })),
    rules, gameConfig: config ?? { key: b.game_config, label: b.game_config },
    sides: sidesOf(db, id).map((s) => {
      const t = s.team_id !== null ? getTeam(db, s.team_id) : undefined;
      const captainId = t ? t.captain_steamid : s.captain_steamid;
      const lateCancel = late && b.cancel_side === s.side;
      return {
        side: s.side, name: sideName(db, s),
        team: t ? { id: t.id, slug: t.slug, name: t.name, tag: t.tag, logoKey: t.logo_key } : null,
        captain: { steamid: captainId, name: getPlayer(db, captainId)?.name ?? captainId },
        confirmed: s.confirmed_at !== null, peakPresent: s.peak_present, noShow: s.no_show_at !== null,
        people: people.filter((p) => p.side === s.side).map((p) => {
          const pl = getPlayer(db, p.steamid);
          return { steamid: p.steamid, name: pl?.name ?? p.steamid, avatar: pl?.avatar ?? null, role: p.role, status: p.status };
        }),
        lateCancel, excused: s.excused_at !== null,
        canExcuse: lateCancel && s.excused_at === null && acting.includes(s.side === 'a' ? 'b' : 'a') && !acting.includes(s.side),
        short: shortSide(b, s),
        ...(viewer.staff || canSeeReliability(db, partyOf(s), viewer.steamid) ? { record: reliability(db, partyOf(s)) } : {}),
      };
    }),
    server: server ? { name: server.name } : null,
    connect: running && canConnect && server ? { host: server.host, port: server.port, password: b.password } : null,
    cancel: b.state === 'cancelled' ? { side: b.cancel_side, reason: b.cancel_reason } : null,
    endReason: b.end_reason,
    noShowFrom: iso(Date.parse(b.starts_at) + (rules?.noShowGraceMinutes ?? 15) * 60_000),
    recovery: b.recovering_at !== null && b.ending_at === null
      ? { since: b.recovering_at, moved: b.recover_reason === 'gone', waiting: b.server_id === null } : null,
    viewer: { side: me?.side ?? manages[0] ?? null, manages, staff: viewer.staff, invited: me?.status === 'invited' },
    games: seesGames ? bookingGames(db, id) : [],
    casters: castersOf(db, id),
    repost: {
      allowed: b.state === 'cancelled' && b.purpose === 'scrim' && manages.length > 0
        && !!db.prepare('SELECT 1 FROM scrim_posts WHERE booking_id = ?').get(b.id),
    },
    ...(acting.length === 1 && reviewable(b) ? { review: { open: reviewOpen(b, nowMs), mine: ownReview(db, b.id, acting[0]) } } : {}),
    ...(viewer.staff ? { reviews: staffReviews(db, b.id) } : {}),
  };
}

export interface BookingSummary {
  id: number; state: BookingState; ending: boolean; startsAt: string; endsAt: string; aName: string; bName: string;
  mySide: Side | null; needs: 'confirm' | 'accept' | null;
}

/** The bookings this player is in or manages a side of: still open, and the
 *  last ten finished. */
export function myBookings(db: DB, steamid: string): { open: BookingSummary[]; recent: BookingSummary[] } {
  const ids = (db.prepare(
    `SELECT booking_id AS id FROM booking_people WHERE steamid = ?
     UNION SELECT booking_id FROM booking_sides WHERE team_id IS NULL AND captain_steamid = ?
     UNION SELECT s.booking_id FROM booking_sides s JOIN team_members m ON m.team_id = s.team_id
       WHERE m.steamid = ? AND m.left_at IS NULL AND m.role IN ('captain','cocaptain')`,
  ).all(steamid, steamid, steamid) as { id: number }[]).map((r) => r.id);
  const rows = ids.map((id) => getBooking(db, id)!).sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  const summary = (b: BookingRow): BookingSummary => {
    const [a, bSide] = sidesOf(db, b.id);
    const me = db.prepare('SELECT side, status FROM booking_people WHERE booking_id = ? AND steamid = ?').get(b.id, steamid) as { side: Side; status: string } | undefined;
    const manages = managedSides(db, b.id, steamid);
    const needs = isOpen(b) && bSide.confirmed_at === null && manages.includes('b') ? 'confirm'
      : isOpen(b) && me?.status === 'invited' && bSide.confirmed_at !== null ? 'accept' : null;
    return {
      id: b.id, state: b.state, ending: b.ending_at !== null, startsAt: b.starts_at, endsAt: b.ends_at,
      aName: sideName(db, a), bName: sideName(db, bSide), mySide: me?.side ?? manages[0] ?? null, needs,
    };
  };
  return {
    open: rows.filter((b) => b.ending_at === null).map(summary),
    recent: rows.filter((b) => b.ending_at !== null).reverse().slice(0, 10).map(summary),
  };
}
