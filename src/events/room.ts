import type { DB } from '../db.js';
import { settingNumber } from '../settings.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as V from './validate.js';
import { applyVeto, isHumanStep, vetoState, type Side, type VetoAction, type VetoActionKind, type VetoInput, type VetoState } from './veto.js';
import { seriesVerdict, tiebreakOrdinal, winnerOf, type SeriesGame } from './seriesRules.js';

/**
 * The match room (tournaments plan T3a): the only writer of the room
 * columns of event_matches and of event_vetoes, event_games, event_lineups,
 * event_entry_prefs and event_campaign_prefs. Same shape as play.ts: each
 * mutation is one synchronous transaction that re-reads, checks, writes and
 * adds exactly one event_log row; a refusal writes nothing
 * (tests/eventLogGuard.test.ts). Timers come in as RoomTimers so tests fix
 * them; src/events/roomClock.ts reads them from settings.
 */

export interface RoomTimers { readyMinutes: number; stepSeconds: number; lineupMinutes: number; confirmMinutes: number }
export interface GameRow {
  id: number; event_match_id: number; ordinal: number; campaign: string; picked_by: number | null; side_by: number | null;
  first_survivors: number | null; match_id: number | null; tiebreak_of: number | null; created_at: string;
  /** Plan T3b. forfeit_side is the side that typed !gg on this game; winner
   *  (an entry id) is derived from it or the scores when the game is
   *  recorded, a convenience for views only. */
  score_a: number | null; score_b: number | null; forfeit_side: Side | null; winner: number | null; map: string | null; ended_at: string | null;
}
export interface LineupRow { id: number; event_match_id: number; game: number; entry_id: number; steamids: string; locked_by: string | null; auto: number; locked_at: string }

const iso = (now?: Date): string => (now ?? new Date()).toISOString();
const plus = (now: Date, ms: number): string => new Date(now.getTime() + ms).toISOString();
/** Statuses where an entry counts as busy for opening another room, built
 *  from P.ROOM_OPEN so the two cannot drift apart. */
const BUSY_SQL = `(${[...P.ROOM_OPEN].map((s) => `'${s}'`).join(',')})`;

/** A WHERE fragment over event_matches aliased m: its event and its stage
 *  are both live. Every query the room's clock runs over rooms uses it, so a
 *  cancelled or finished event's rooms never tick. */
export const ROOM_LIVE_SQL = `EXISTS (SELECT 1 FROM events le JOIN event_stages ls ON ls.event_id = le.id
  WHERE le.id = m.event_id AND ls.id = m.stage_id AND le.status = 'live' AND ls.status = 'live')`;

export function roomTimers(db: DB): RoomTimers {
  return {
    readyMinutes: settingNumber(db, 'event_ready_minutes', 10, { min: 2, max: 30, integer: true }),
    stepSeconds: settingNumber(db, 'event_veto_step_seconds', 60, { min: 20, max: 300, integer: true }),
    lineupMinutes: settingNumber(db, 'event_lineup_minutes', 5, { min: 1, max: 15, integer: true }),
    confirmMinutes: settingNumber(db, 'event_confirm_minutes', 15, { min: 5, max: 60, integer: true }),
  };
}

export const entryOn = (m: P.MatchRow, side: Side): number => (side === 'a' ? m.entry_a! : m.entry_b!);

export function vetoActions(db: DB, matchId: number): VetoAction[] {
  return (db.prepare('SELECT side, action, campaign, auto FROM event_vetoes WHERE event_match_id = ? ORDER BY step').all(matchId) as
    { side: Side; action: VetoAction['action']; campaign: string | null; auto: number }[])
    .map((r) => ({ side: r.side, action: r.action, campaign: r.campaign, auto: r.auto === 1 }));
}

/** The series so far as the pure rules see it (plan T3b). Sides are the
 *  match's entry_a and entry_b. */
export function seriesGames(db: DB, m: P.MatchRow): SeriesGame[] {
  return gamesOf(db, m.id).map((g) => ({
    id: g.id, ordinal: g.ordinal, tiebreakOf: g.tiebreak_of, scoreA: g.score_a, scoreB: g.score_b,
    forfeit: g.forfeit_side, started: g.match_id !== null,
  }));
}

/** The winners of the games played so far feed "loser picks" (T3a Ruling 8). */
export function vetoInput(db: DB, m: P.MatchRow): VetoInput {
  const s = E.stageSettingsOf(E.getStage(db, m.stage_id)!);
  return {
    config: s.veto, pool: s.campaignPool, higher: m.room_higher ?? 'a', seed: m.room_seed ?? 0, actions: vetoActions(db, m.id),
    winners: seriesVerdict(s.veto, seriesGames(db, m)).decided,
  };
}
export function roomState(db: DB, m: P.MatchRow): VetoState {
  return vetoState(vetoInput(db, m));
}
export function gamesOf(db: DB, matchId: number): GameRow[] {
  return db.prepare('SELECT * FROM event_games WHERE event_match_id = ? ORDER BY ordinal').all(matchId) as GameRow[];
}
export function lineupsOf(db: DB, matchId: number): LineupRow[] {
  return db.prepare('SELECT * FROM event_lineups WHERE event_match_id = ? ORDER BY game, id').all(matchId) as LineupRow[];
}
/** The four a team locked for this match (game 1 carries the series, Ruling 6). */
export function lineupFour(db: DB, matchId: number, entryId: number): string[] | null {
  const row = lineupsOf(db, matchId).find((l) => l.game === 1 && l.entry_id === entryId);
  return row ? JSON.parse(row.steamids) as string[] : null;
}
export function matchOfBooking(db: DB, bookingId: number): P.MatchRow | undefined {
  return db.prepare('SELECT * FROM event_matches WHERE booking_id = ?').get(bookingId) as P.MatchRow | undefined;
}
/** The side this player manages in this match, or null (Ruling 10). */
export function sideOf(db: DB, m: P.MatchRow, steamid: string): Side | null {
  for (const side of ['a', 'b'] as const) {
    const id = side === 'a' ? m.entry_a : m.entry_b;
    const e = id !== null ? N.getEntry(db, id) : undefined;
    if (e && N.managersOf(db, e.team_id).includes(steamid)) return side;
  }
  return null;
}
/** Who may play: the entry's starters, then its subs (never the coach). */
export function playableOf(db: DB, entryId: number): string[] {
  const r = N.rosterOf(db, entryId);
  return [...r.starters, ...r.subs];
}
/** Anyone on either roster (coach included): who hears the room's pushes. */
export function isParticipant(db: DB, m: P.MatchRow, steamid: string): boolean {
  return [m.entry_a, m.entry_b].some((id) => {
    if (id === null) return false;
    const r = N.rosterOf(db, id);
    return [...r.starters, ...r.subs, ...(r.coach ? [r.coach] : [])].includes(steamid);
  });
}
export function busyEntries(db: DB, eventId: number): Set<number> {
  const rows = db.prepare(`SELECT entry_a, entry_b FROM event_matches WHERE event_id = ? AND status IN ${BUSY_SQL}`).all(eventId) as
    { entry_a: number | null; entry_b: number | null }[];
  return new Set(rows.flatMap((r) => [r.entry_a, r.entry_b]).filter((x): x is number => x !== null));
}

/** The match, its event and stage, both live, both teams known and in. */
function liveMatch(db: DB, matchId: number): V.Checked<{ m: P.MatchRow; ev: E.EventRow }> {
  const m = P.getMatch(db, matchId);
  if (!m) return V.fail('match_not_found');
  const ev = E.getEvent(db, m.event_id)!;
  const stage = E.getStage(db, m.stage_id)!;
  if (ev.status !== 'live' || stage.status !== 'live') return V.fail('not_live');
  if (m.entry_a === null || m.entry_b === null) return V.fail('match_not_open');
  if (![m.entry_a, m.entry_b].every((id) => N.isActive(N.getEntry(db, id)!))) return V.fail('entry_out');
  return V.ok({ m, ev });
}

/** event_games from the replay: one row per settled game, updated as sides
 *  are chosen. Inside the caller's transaction. */
function syncGames(db: DB, m: P.MatchRow, st: VetoState, at: string): void {
  const up = db.prepare(
    `INSERT INTO event_games (event_match_id, ordinal, campaign, picked_by, side_by, first_survivors, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (event_match_id, ordinal) DO UPDATE SET campaign = excluded.campaign, picked_by = excluded.picked_by,
       side_by = excluded.side_by, first_survivors = excluded.first_survivors`,
  );
  const id = (s: Side | null) => (s === null ? null : entryOn(m, s));
  for (const g of st.games) up.run(m.id, g.game, g.campaign, id(g.pickedBy), id(g.sideBy), id(g.firstSurvivors), at);
}

/** After both teams are ready or after a veto action: the next step's
 *  deadline; the lineups once nothing is left for a person to do; on a live
 *  match (a between-game pick, plan T3b Ruling 4) the deadline clears and
 *  the series engine schedules the game. */
function advance(db: DB, matchId: number, timers: RoomTimers, now: Date): void {
  const m = P.getMatch(db, matchId)!;
  const st = roomState(db, m);
  syncGames(db, m, st, iso(now));
  if (isHumanStep(st.next)) {
    db.prepare('UPDATE event_matches SET deadline = ? WHERE id = ?').run(plus(now, timers.stepSeconds * 1000), m.id);
  } else if (m.status === 'live') {
    db.prepare('UPDATE event_matches SET deadline = NULL WHERE id = ?').run(m.id);
  } else {
    db.prepare("UPDATE event_matches SET status = 'lineup', deadline = ? WHERE id = ?").run(plus(now, timers.lineupMinutes * 60_000), m.id);
  }
}

export function openRoom(db: DB, o: { matchId: number; by: string | null; higher: Side; seed: number; timers: RoomTimers; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'waiting') return V.fail('wrong_status');
    const busy = busyEntries(db, ev.id);
    if (busy.has(m.entry_a!) || busy.has(m.entry_b!)) return V.fail('entry_busy');
    db.prepare(
      `UPDATE event_matches SET status = 'veto', room_opened_at = ?, room_higher = ?, room_seed = ?, ready_a_at = NULL, ready_b_at = NULL,
         deadline = ?, hold_reason = NULL WHERE id = ?`,
    ).run(at, o.higher, o.seed, plus(now, o.timers.readyMinutes * 60_000), m.id);
    E.logEvent(db, ev.id, o.by, 'room_opened', at, { matchId: m.id, higher: o.higher });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

export function readyUp(db: DB, o: { matchId: number; steamid: string; timers: RoomTimers; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'veto' || (m.ready_a_at !== null && m.ready_b_at !== null)) return V.fail('not_ready_phase');
    if (m.deadline !== null && at >= m.deadline) return V.fail('room_closed');
    const side = sideOf(db, m, o.steamid);
    if (!side) return V.fail('not_manager');
    if ((side === 'a' ? m.ready_a_at : m.ready_b_at) !== null) return V.fail('already_ready');
    db.prepare(`UPDATE event_matches SET ${side === 'a' ? 'ready_a_at' : 'ready_b_at'} = ? WHERE id = ?`).run(at, m.id);
    if ((side === 'a' ? m.ready_b_at : m.ready_a_at) !== null) advance(db, m.id, o.timers, now);
    E.logEvent(db, ev.id, o.steamid, 'room_ready', at, { matchId: m.id, side });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

const HOLDABLE: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['veto', 'lineup', 'booking', 'connect', 'live', 'confirming']);

export function holdMatch(db: DB, o: { matchId: number; by: string | null; reason: string; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const m = P.getMatch(db, o.matchId);
    if (!m) return V.fail('match_not_found');
    // Like liveMatch, but a team that is out may still be held over.
    if (E.getEvent(db, m.event_id)!.status !== 'live' || E.getStage(db, m.stage_id)!.status !== 'live') return V.fail('not_live');
    if (!HOLDABLE.has(m.status)) return V.fail('wrong_status');
    const reason = o.reason.slice(0, 300);
    db.prepare("UPDATE event_matches SET status = 'admin_hold', hold_reason = ?, deadline = NULL WHERE id = ?").run(reason, m.id);
    E.logEvent(db, m.event_id, o.by, 'match_held', at, { matchId: m.id, reason });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** The statuses a room may be reset from (the series engine checks them before it cancels a booking). */
export const RESETTABLE: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['veto', 'lineup', 'booking', 'connect', 'live', 'confirming', 'admin_hold']);

/** by is null when the engine resets it (a bracket correction, flow.ts). */
export function resetRoom(db: DB, o: { matchId: number; by: string | null; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const m = P.getMatch(db, o.matchId);
    if (!m) return V.fail('match_not_found');
    if (!RESETTABLE.has(m.status)) return V.fail('wrong_status');
    // Plan T3b: a booked match is reset only once its booking is ending
    // (the series engine cancels it first), so no box keeps running a
    // series the room no longer knows.
    if (m.booking_id !== null) {
      const b = db.prepare('SELECT ending_at FROM bookings WHERE id = ?').get(m.booking_id) as { ending_at: string | null } | undefined;
      if (b && b.ending_at === null) return V.fail('booking_open');
    }
    db.prepare('DELETE FROM event_vetoes WHERE event_match_id = ?').run(m.id);
    db.prepare('DELETE FROM event_games WHERE event_match_id = ?').run(m.id);
    db.prepare('DELETE FROM event_lineups WHERE event_match_id = ?').run(m.id);
    db.prepare(
      `UPDATE event_matches SET status = 'waiting', room_opened_at = NULL, room_higher = NULL, room_seed = NULL, ready_a_at = NULL,
         ready_b_at = NULL, deadline = NULL, hold_reason = NULL, booking_id = NULL, booked_at = NULL, server_alerted_at = NULL,
         confirm_a_at = NULL, confirm_b_at = NULL, dispute_side = NULL, dispute_by = NULL, dispute_reason = NULL, disputed_at = NULL
       WHERE id = ?`,
    ).run(m.id);
    E.logEvent(db, m.event_id, o.by, 'room_reset', at, { matchId: m.id, from: m.status });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** Ruling 16 (T3a) and T3b Ruling 18: an overdue deadline found at start
 *  gets its phase's full length from now (a live match's deadline is a
 *  between-game pick step); connect is left alone (presence decides);
 *  anything else is refused as 'changed' and left alone. */
export function resumeDeadline(db: DB, o: { matchId: number; timers: RoomTimers; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const m = P.getMatch(db, o.matchId);
    const resumable = m && (m.status === 'veto' || m.status === 'lineup' || m.status === 'live' || m.status === 'confirming');
    if (!m || !resumable || m.deadline === null || m.deadline > at) return V.fail('changed');
    const ready = m.status === 'veto' && (m.ready_a_at === null || m.ready_b_at === null);
    const ms = m.status === 'lineup' ? o.timers.lineupMinutes * 60_000
      : m.status === 'confirming' ? o.timers.confirmMinutes * 60_000
        : ready ? o.timers.readyMinutes * 60_000 : o.timers.stepSeconds * 1000;
    db.prepare('UPDATE event_matches SET deadline = ? WHERE id = ?').run(plus(now, ms), m.id);
    E.logEvent(db, m.event_id, null, 'room_resumed', at, { matchId: m.id, was: m.deadline });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

// ---------- the series (plan T3b) ----------

/** A match's booking, made by the series engine the moment lineups lock (Ruling 2). */
export function attachBooking(db: DB, o: { matchId: number; bookingId: number; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'booking' || m.booking_id !== null) return V.fail('wrong_status');
    db.prepare('UPDATE event_matches SET booking_id = ?, booked_at = ? WHERE id = ?').run(o.bookingId, at, m.id);
    E.logEvent(db, ev.id, null, 'match_booked', at, { matchId: m.id, bookingId: o.bookingId });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** Staff were told the match has waited 10 minutes for a server (Ruling 8); once. */
export function noteServerAlert(db: DB, o: { matchId: number; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const m = P.getMatch(db, o.matchId);
    if (!m || m.status !== 'booking' || m.booking_id === null || m.server_alerted_at !== null) return V.fail('changed');
    db.prepare('UPDATE event_matches SET server_alerted_at = ? WHERE id = ?').run(at, m.id);
    E.logEvent(db, m.event_id, null, 'server_wait_alerted', at, { matchId: m.id, bookingId: m.booking_id });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** The server is ready: the teams have the grace to connect (Ruling 7). */
export function startConnect(db: DB, o: { matchId: number; graceMinutes: number; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'booking' || m.booking_id === null) return V.fail('wrong_status');
    db.prepare("UPDATE event_matches SET status = 'connect', deadline = ? WHERE id = ?").run(plus(now, o.graceMinutes * 60_000), m.id);
    E.logEvent(db, ev.id, null, 'match_connect', at, { matchId: m.id, graceMinutes: o.graceMinutes });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** The first game went live. */
export function startLive(db: DB, o: { matchId: number; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'connect') return V.fail('not_connect_phase');
    db.prepare("UPDATE event_matches SET status = 'live', deadline = NULL WHERE id = ?").run(m.id);
    E.logEvent(db, ev.id, null, 'match_live', at, { matchId: m.id });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

function gameIn(db: DB, m: P.MatchRow, gameId: number): GameRow | undefined {
  return gamesOf(db, m.id).find((g) => g.id === gameId);
}

/** A game was pushed to the box as this matches row (Ruling 15). */
export function linkGame(db: DB, o: { matchId: number; gameId: number; gameMatchId: number; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    // Game 1 is pushed during setup, before the connect phase (Ruling 3).
    if (m.status !== 'booking' && m.status !== 'connect' && m.status !== 'live') return V.fail('wrong_status');
    const g = gameIn(db, m, o.gameId);
    if (!g) return V.fail('game_not_found');
    if (g.match_id !== null) return V.fail('changed');
    db.prepare('UPDATE event_games SET match_id = ? WHERE id = ?').run(o.gameMatchId, g.id);
    E.logEvent(db, ev.id, null, 'game_started', at, { matchId: m.id, gameId: g.id, ordinal: g.ordinal, campaign: g.campaign, gameMatchId: o.gameMatchId });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** A game's result from our capture (Ruling 5): its campaign totals, or the
 *  side that typed !gg (forfeit, scores optional then). The stored winner
 *  is derived by seriesRules' winnerOf, null for a tie. */
export function recordGame(
  db: DB, o: { matchId: number; gameId: number; scoreA: number | null; scoreB: number | null; forfeit: Side | null; now?: Date },
): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'live') return V.fail('not_live_phase');
    const g = gameIn(db, m, o.gameId);
    if (!g) return V.fail('game_not_found');
    if (g.match_id === null || g.ended_at !== null) return V.fail('changed');
    const score = (n: number | null) => n === null || (Number.isInteger(n) && n >= 0);
    if (!score(o.scoreA) || !score(o.scoreB) || (o.forfeit === null && (o.scoreA === null || o.scoreB === null))) return V.fail('bad_request');
    const winner = winnerOf({ id: g.id, ordinal: g.ordinal, tiebreakOf: g.tiebreak_of, scoreA: o.scoreA, scoreB: o.scoreB, forfeit: o.forfeit, started: true });
    db.prepare('UPDATE event_games SET score_a = ?, score_b = ?, forfeit_side = ?, winner = ?, ended_at = ? WHERE id = ?')
      .run(o.scoreA, o.scoreB, o.forfeit, winner === null ? null : entryOn(m, winner), at, g.id);
    E.logEvent(db, ev.id, null, 'game_recorded', at, {
      matchId: m.id, gameId: g.id, ordinal: g.ordinal, scoreA: o.scoreA, scoreB: o.scoreB, forfeit: o.forfeit, winner,
    });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** Ruling 5: one chapter, replayed; sides as the rules say. A series game
 *  has nine tiebreak slots (10 * game + 1 .. + 9); past them, or on an
 *  ordinal already taken, it is refused as 'changed' and the unique index
 *  is never hit. */
export function addTiebreak(db: DB, o: { matchId: number; ofGameId: number; map: string; firstSurvivors: Side; now?: Date }): V.Checked<GameRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<GameRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'live') return V.fail('not_live_phase');
    const parent = gameIn(db, m, o.ofGameId);
    if (!parent || parent.tiebreak_of !== null) return V.fail('game_not_found');
    const ordinal = tiebreakOrdinal(parent, seriesGames(db, m));
    if (ordinal === null || gamesOf(db, m.id).some((g) => g.ordinal === ordinal)) return V.fail('changed');
    const id = Number(db.prepare(
      `INSERT INTO event_games (event_match_id, ordinal, campaign, picked_by, side_by, first_survivors, tiebreak_of, map, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    ).run(m.id, ordinal, parent.campaign, entryOn(m, o.firstSurvivors), parent.id, o.map, at).lastInsertRowid);
    E.logEvent(db, ev.id, null, 'tiebreak_added', at, { matchId: m.id, gameId: id, ofGame: parent.ordinal, map: o.map, firstSurvivors: o.firstSurvivors });
    return V.ok(gameIn(db, m, id)!);
  })();
}

/** Ruling 4: the loser's pick (and the side choice after it) runs on the
 *  live match with the veto step's timer. */
export function openPick(db: DB, o: { matchId: number; timers: RoomTimers; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'live') return V.fail('not_live_phase');
    // A pick already open (its deadline running) is not opened again.
    if (m.deadline !== null) return V.fail('changed');
    const st = roomState(db, m);
    if (!isHumanStep(st.next)) return V.fail('changed');
    db.prepare('UPDATE event_matches SET deadline = ? WHERE id = ?').run(plus(now, o.timers.stepSeconds * 1000), m.id);
    E.logEvent(db, ev.id, null, 'pick_opened', at, { matchId: m.id, step: st.used, kind: st.next.kind, by: st.next.by });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** The series is over: the confirm window opens (Ruling 9). Refused as
 *  'changed' while the recorded games do not make a finished series. */
export function startConfirm(db: DB, o: { matchId: number; timers: RoomTimers; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'live') return V.fail('not_live_phase');
    if (!seriesVerdict(E.stageSettingsOf(E.getStage(db, m.stage_id)!).veto, seriesGames(db, m)).over) return V.fail('changed');
    db.prepare("UPDATE event_matches SET status = 'confirming', deadline = ?, confirm_a_at = NULL, confirm_b_at = NULL WHERE id = ?")
      .run(plus(now, o.timers.confirmMinutes * 60_000), m.id);
    E.logEvent(db, ev.id, null, 'match_confirming', at, { matchId: m.id });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** A captain or co-captain confirms the result for their team (Ruling 9). */
export function confirmResult(db: DB, o: { matchId: number; steamid: string; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'confirming') return V.fail('not_confirm_phase');
    const side = sideOf(db, m, o.steamid);
    if (!side) return V.fail('not_manager');
    if ((side === 'a' ? m.confirm_a_at : m.confirm_b_at) !== null) return V.fail('already_confirmed');
    db.prepare(`UPDATE event_matches SET ${side === 'a' ? 'confirm_a_at' : 'confirm_b_at'} = ? WHERE id = ?`).run(at, m.id);
    E.logEvent(db, ev.id, o.steamid, 'result_confirmed', at, { matchId: m.id, side });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

const REASON_MIN = 3;

/** Ruling 9: a dispute holds the match for staff. Refused at or after the
 *  deadline. The reason shows on the room page and in the staff alert, so
 *  it goes through V.normalizeReason (one clean line, at most 300
 *  characters) plus the same 3 character minimum as an admin hold (T3a). */
export function disputeMatch(db: DB, o: { matchId: number; steamid: string; reason: unknown; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'confirming') return V.fail('not_confirm_phase');
    if (m.deadline !== null && at >= m.deadline) return V.fail('confirm_closed');
    const side = sideOf(db, m, o.steamid);
    if (!side) return V.fail('not_manager');
    const nr = V.normalizeReason(o.reason);
    const reason = nr.ok ? nr.value ?? '' : '';
    if (reason.length < REASON_MIN) return V.fail('bad_reason');
    db.prepare(
      `UPDATE event_matches SET status = 'admin_hold', hold_reason = 'dispute', deadline = NULL,
         dispute_side = ?, dispute_by = ?, dispute_reason = ?, disputed_at = ? WHERE id = ?`,
    ).run(side, o.steamid, reason, at, m.id);
    E.logEvent(db, ev.id, o.steamid, 'match_disputed', at, { matchId: m.id, side, reason });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

const ACTIONS: ReadonlySet<string> = new Set(['first', 'second', 'ban', 'pick', 'survivors', 'infected']);

export function actVeto(
  db: DB, o: { matchId: number; steamid: string | null; step: number; action: unknown; campaign: unknown; timers: RoomTimers; now?: Date },
): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    // A live match runs the between-game picks (plan T3b Ruling 4).
    const inVeto = m.status === 'veto' && m.ready_a_at !== null && m.ready_b_at !== null;
    if (!inVeto && m.status !== 'live') return V.fail('not_veto_phase');
    const inp = vetoInput(db, m);
    const st = vetoState(inp);
    if (o.step !== inp.actions.length || !isHumanStep(st.next)) return V.fail('step_taken');
    let side: Side;
    if (o.steamid === null) {
      side = st.next.by;
    } else {
      const s = sideOf(db, m, o.steamid);
      if (!s) return V.fail('not_manager');
      side = s;
    }
    if (typeof o.action !== 'string' || !ACTIONS.has(o.action) || !(o.campaign === null || o.campaign === undefined || typeof o.campaign === 'string')) {
      return V.fail('bad_veto_action');
    }
    const a: VetoAction = { side, action: o.action as VetoActionKind, campaign: (o.campaign as string | null | undefined) ?? null, auto: o.steamid === null };
    const r = applyVeto(inp, a);
    if (!r.ok) return V.fail(r.code);
    db.prepare(
      `INSERT INTO event_vetoes (event_match_id, step, side, entry_id, action, campaign, by_steamid, auto, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.id, o.step, side, entryOn(m, side), a.action, a.campaign, o.steamid, a.auto ? 1 : 0, at);
    advance(db, m.id, o.timers, now);
    E.logEvent(db, ev.id, o.steamid, 'veto_action', at, { matchId: m.id, step: o.step, side, action: a.action, campaign: a.campaign, auto: a.auto });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** Exactly four different players from the playable list, or null. */
function readFour(raw: unknown, playable: string[]): string[] | null {
  if (!Array.isArray(raw) || raw.length !== 4 || new Set(raw).size !== 4) return null;
  return raw.every((s) => typeof s === 'string' && playable.includes(s)) ? (raw as string[]) : null;
}

export function lastFour(db: DB, entryId: number): string[] | null {
  const row = db.prepare('SELECT steamids FROM event_lineups WHERE entry_id = ? ORDER BY locked_at DESC, id DESC LIMIT 1').get(entryId) as
    { steamids: string } | undefined;
  return row ? JSON.parse(row.steamids) as string[] : null;
}

/** Ruling 9: the default four, else the last four, else the roster order.
 *  May return fewer than four when the roster is short; lockLineup then
 *  refuses it and the clock holds the match. */
export function autoFour(o: { defaultFour: string[] | null; lastFour: string[] | null; playable: string[] }): string[] {
  for (const four of [o.defaultFour, o.lastFour]) if (four && four.length === 4 && four.every((s) => o.playable.includes(s))) return four;
  return o.playable.slice(0, 4);
}

export function lockLineup(
  db: DB, o: { matchId: number; steamid: string | null; side?: Side; steamids: unknown; timers: RoomTimers; now?: Date },
): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const c = liveMatch(db, o.matchId);
    if (!c.ok) return c;
    const { m, ev } = c.value;
    if (m.status !== 'lineup') return V.fail('not_lineup_phase');
    const side = o.steamid === null ? o.side ?? null : sideOf(db, m, o.steamid);
    if (!side) return V.fail('not_manager');
    const entryId = entryOn(m, side);
    if (lineupsOf(db, m.id).some((l) => l.game === 1 && l.entry_id === entryId)) return V.fail('lineup_locked');
    const four = readFour(o.steamids, playableOf(db, entryId));
    if (!four) return V.fail('bad_lineup');
    db.prepare('INSERT INTO event_lineups (event_match_id, game, entry_id, steamids, locked_by, auto, locked_at) VALUES (?, 1, ?, ?, ?, ?, ?)')
      .run(m.id, entryId, JSON.stringify(four), o.steamid, o.steamid === null ? 1 : 0, at);
    if (lineupsOf(db, m.id).filter((l) => l.game === 1).length === 2) {
      db.prepare("UPDATE event_matches SET status = 'booking', deadline = NULL WHERE id = ?").run(m.id);
    }
    E.logEvent(db, ev.id, o.steamid, 'lineup_locked', at, { matchId: m.id, side, auto: o.steamid === null });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

export function entryPrefs(db: DB, entryId: number): { defaultFour: string[] | null; side: 'survivors' | 'infected' | null } {
  const row = db.prepare('SELECT default_four, side FROM event_entry_prefs WHERE entry_id = ?').get(entryId) as
    { default_four: string | null; side: 'survivors' | 'infected' | null } | undefined;
  return { defaultFour: row?.default_four ? JSON.parse(row.default_four) as string[] : null, side: row?.side ?? null };
}
export function campaignPrefs(db: DB, entryId: number, stageId: number): string[] {
  const row = db.prepare('SELECT campaigns FROM event_campaign_prefs WHERE entry_id = ? AND stage_id = ?').get(entryId, stageId) as
    { campaigns: string } | undefined;
  return row ? JSON.parse(row.campaigns) as string[] : [];
}

const PREFS_OPEN: ReadonlySet<string> = new Set(['announced', 'registration', 'checkin', 'live']);

/** A team's managers (or staff) save what the timers act from. Stages not
 *  named keep their saved order. */
export function savePrefs(db: DB, o: { entryId: number; by: string; staff: boolean; prefs: unknown; now?: Date }): V.Checked<null> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<null> => {
    const entry = N.getEntry(db, o.entryId);
    if (!entry) return V.fail('entry_not_found');
    const ev = E.getEvent(db, entry.event_id)!;
    if (!PREFS_OPEN.has(ev.status) || !N.isActive(entry)) return V.fail('entry_out');
    if (!o.staff && !N.managersOf(db, entry.team_id).includes(o.by)) return V.fail('not_manager');
    const p = o.prefs as { defaultFour?: unknown; side?: unknown; campaigns?: unknown } | null;
    if (typeof p !== 'object' || p === null) return V.fail('bad_prefs');
    const four = p.defaultFour === null || p.defaultFour === undefined ? null : readFour(p.defaultFour, playableOf(db, entry.id));
    if (four === null && p.defaultFour !== null && p.defaultFour !== undefined) return V.fail('bad_prefs');
    const side = p.side ?? null;
    if (side !== null && side !== 'survivors' && side !== 'infected') return V.fail('bad_prefs');
    const campaigns = p.campaigns ?? {};
    if (typeof campaigns !== 'object' || campaigns === null || Array.isArray(campaigns)) return V.fail('bad_prefs');
    const stages = new Map(E.stagesOf(db, ev.id).map((s) => [String(s.id), E.stageSettingsOf(s).campaignPool]));
    const orders: [number, string[]][] = [];
    for (const [key, list] of Object.entries(campaigns as Record<string, unknown>)) {
      const pool = stages.get(key);
      if (!pool || !Array.isArray(list) || new Set(list).size !== list.length || !list.every((c) => typeof c === 'string' && pool.includes(c))) {
        return V.fail('bad_prefs');
      }
      orders.push([Number(key), list as string[]]);
    }
    db.prepare(
      `INSERT INTO event_entry_prefs (entry_id, default_four, side, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (entry_id) DO UPDATE SET default_four = excluded.default_four, side = excluded.side,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(entry.id, four ? JSON.stringify(four) : null, side, o.by, at);
    const up = db.prepare(
      `INSERT INTO event_campaign_prefs (entry_id, stage_id, campaigns, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (entry_id, stage_id) DO UPDATE SET campaigns = excluded.campaigns, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    );
    for (const [stageId, list] of orders) up.run(entry.id, stageId, JSON.stringify(list), o.by, at);
    E.logEvent(db, ev.id, o.by, 'prefs_saved', at, { entryId: entry.id, stages: orders.map(([s]) => s) });
    return V.ok(null);
  })();
}
