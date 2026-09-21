import type { DB } from './db.js';
import type { LogEvent } from './logParse.js';
import { getSetting } from './settings.js';

/**
 * Who is on the game server, per rostered player of an ongoing match.
 *
 * Three writers feed one table: PLAYER connect, the LEAVE and RETURN lines of
 * plugin/pug-leave.inc, and the plugin's own rcon answer to an admin clock
 * action (src/leaveControl.ts). The last one exists because the log stream is
 * lossy UDP and a Hold the admin just pressed must show as held whether or not
 * its echo arrives; when the echo does arrive it says the same thing and is a
 * no-op here.
 *
 * PLAYER disconnect is deliberately not a writer. The plugin pulses disconnect
 * then connect for every client on every changelevel, and a real departure
 * already has its own line (LEAVE, from the engine's player_disconnect event).
 * Believing the pulse would flash all eight players as dropped on every map
 * load, on the one screen that exists to show who is really missing.
 */

export interface PresenceRow {
  match_id: number;
  steamid: string;
  state: 'connected' | 'dropped';
  /** When the current state began, ISO. */
  since: string;
  /** The reconnect allowance as of remaining_at. Null until the plugin has
   *  said anything about this player's clock. */
  remaining_s: number | null;
  remaining_at: string | null;
  held: number;
  hold_until: string | null;
  low_alert_at: string | null;
  updated_at: string;
}

/** What the plugin says about one player's clock, from a line or an answer. */
export interface LeaveState {
  absent: boolean;
  remaining: number;
  held: boolean;
  /** Seconds until the plugin's own ceiling releases the hold. Null when the
   *  source did not say, and then the setting stands in. */
  holdLeft: number | null;
}

export interface PresenceChange {
  matchId: number;
  /** False for a repeat of what the table already says: no write happened. */
  changed: boolean;
  /** A dropped player's hold ended while they are still dropped. */
  holdReleased: boolean;
}

/** Same emptiness rule as noShow.ts: Number('') is 0, and a blank row must
 *  read as the default, not as zero. */
function num(db: DB, key: string, fallback: number): number {
  const value = getSetting(db, key);
  if (value === undefined || value.trim() === '') return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) ? raw : fallback;
}

export const holdMaxSeconds = (db: DB): number => Math.max(60, num(db, 'clock_hold_max_minutes', 30) * 60);
export const lowAlertSeconds = (db: DB): number => Math.max(0, num(db, 'abandon_low_alert_seconds', 90));

export function ongoingMatchIdOf(db: DB, token: string): number | null {
  const row = db.prepare("SELECT id FROM matches WHERE token = ? AND state IN ('configuring', 'live')")
    .get(token) as { id: number } | undefined;
  return row?.id ?? null;
}

export function isRostered(db: DB, matchId: number, steamid: string): boolean {
  return db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, steamid) !== undefined;
}

export function getPresence(db: DB, matchId: number, steamid: string): PresenceRow | undefined {
  return db.prepare('SELECT * FROM match_presence WHERE match_id = ? AND steamid = ?').get(matchId, steamid) as PresenceRow | undefined;
}

/** The allowance right now. It only runs down for someone who is dropped and
 *  not held; for anyone else the stored figure IS the figure. */
export function remainingNow(
  row: Pick<PresenceRow, 'state' | 'remaining_s' | 'remaining_at' | 'held'>, now: Date,
): number | null {
  if (row.remaining_s === null) return null;
  if (row.state !== 'dropped' || row.held === 1 || row.remaining_at === null) return row.remaining_s;
  const spent = Math.floor((now.getTime() - Date.parse(row.remaining_at)) / 1000);
  return Math.max(0, row.remaining_s - Math.max(0, spent));
}

function write(db: DB, r: PresenceRow): void {
  db.prepare(
    `INSERT INTO match_presence
       (match_id, steamid, state, since, remaining_s, remaining_at, held, hold_until, low_alert_at, updated_at)
     VALUES (@match_id, @steamid, @state, @since, @remaining_s, @remaining_at, @held, @hold_until, @low_alert_at, @updated_at)
     ON CONFLICT (match_id, steamid) DO UPDATE SET
       state = excluded.state, since = excluded.since, remaining_s = excluded.remaining_s,
       remaining_at = excluded.remaining_at, held = excluded.held, hold_until = excluded.hold_until,
       low_alert_at = excluded.low_alert_at, updated_at = excluded.updated_at`,
  ).run(r);
}

/** Take the plugin's word for one player's clock. Null when they are not on
 *  this match's roster, which writes nothing. */
export function applyLeaveState(
  db: DB, matchId: number, steamid: string, s: LeaveState, now = new Date(),
): PresenceChange | null {
  if (!isRostered(db, matchId, steamid)) return null;
  const prev = getPresence(db, matchId, steamid);
  const state = s.absent ? 'dropped' : 'connected';
  const held = s.absent && s.held ? 1 : 0;
  // A duplicated datagram, or the echo of an answer already applied. Skipped
  // outright rather than rewritten, because rewriting would move remaining_at
  // later and make the countdown lag by however late the repeat was.
  if (prev && prev.state === state && prev.remaining_s === s.remaining && prev.held === held) {
    return { matchId, changed: false, holdReleased: false };
  }
  const iso = now.toISOString();
  const sameState = prev !== undefined && prev.state === state;
  write(db, {
    match_id: matchId,
    steamid,
    state,
    since: sameState ? prev.since : iso,
    remaining_s: s.remaining,
    remaining_at: iso,
    held,
    hold_until: held ? new Date(now.getTime() + (s.holdLeft ?? holdMaxSeconds(db)) * 1000).toISOString() : null,
    // Once per drop: kept while the same drop goes on, whatever is held or
    // added, and cleared by the next drop or by coming back.
    low_alert_at: sameState && state === 'dropped' ? prev.low_alert_at : null,
    updated_at: iso,
  });
  return {
    matchId,
    changed: true,
    holdReleased: prev !== undefined && prev.state === 'dropped' && prev.held === 1 && state === 'dropped' && held === 0,
  };
}

/** PLAYER connect: they are in game. Carries no allowance figure, so when the
 *  RETURN that normally follows is lost, the arithmetic is done here. */
export function applyConnect(db: DB, matchId: number, steamid: string, now = new Date()): PresenceChange | null {
  if (!isRostered(db, matchId, steamid)) return null;
  const prev = getPresence(db, matchId, steamid);
  if (prev?.state === 'connected') return { matchId, changed: false, holdReleased: false };
  const iso = now.toISOString();
  const left = prev ? remainingNow(prev, now) : null;
  write(db, {
    match_id: matchId, steamid, state: 'connected', since: iso,
    remaining_s: left, remaining_at: left === null ? null : iso,
    held: 0, hold_until: null, low_alert_at: null, updated_at: iso,
  });
  return { matchId, changed: true, holdReleased: false };
}

export type PresenceLine = Extract<LogEvent, { kind: 'leave' | 'return' | 'player' }>;

/** One log line, already canonicalised. Null when it is ignored: no ongoing
 *  match for the token, an id off the roster, or a PLAYER disconnect. */
export function recordPresenceLine(db: DB, ev: PresenceLine, now = new Date()): PresenceChange | null {
  const matchId = ongoingMatchIdOf(db, ev.token);
  if (matchId === null) return null;
  if (ev.kind === 'player') return ev.event === 'connect' ? applyConnect(db, matchId, ev.steamid, now) : null;
  if (ev.kind === 'return') {
    return applyLeaveState(db, matchId, ev.steamid, { absent: false, remaining: ev.remaining, held: false, holdLeft: null }, now);
  }
  return applyLeaveState(db, matchId, ev.steamid, {
    absent: true, remaining: ev.remaining, held: ev.held === true, holdLeft: ev.holdLeft ?? null,
  }, now);
}
