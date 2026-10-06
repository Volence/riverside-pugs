import type { DB } from '../db.js';
import { settingNumber } from '../settings.js';
import * as E from './events.js';
import * as N from './entries.js';
import * as P from './play.js';
import * as V from './validate.js';
import { applyVeto, isHumanStep, vetoState, type Side, type VetoAction, type VetoActionKind, type VetoInput, type VetoState } from './veto.js';

/**
 * The match room (tournaments plan T3a): the only writer of the room
 * columns of event_matches and of event_vetoes, event_games, event_lineups,
 * event_entry_prefs and event_campaign_prefs. Same shape as play.ts: each
 * mutation is one synchronous transaction that re-reads, checks, writes and
 * adds exactly one event_log row; a refusal writes nothing
 * (tests/eventLogGuard.test.ts). Timers come in as RoomTimers so tests fix
 * them; src/events/roomClock.ts reads them from settings.
 */

export interface RoomTimers { readyMinutes: number; stepSeconds: number; lineupMinutes: number }
export interface GameRow {
  id: number; event_match_id: number; ordinal: number; campaign: string; picked_by: number | null; side_by: number | null;
  first_survivors: number | null; match_id: number | null; tiebreak_of: number | null; created_at: string;
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
  };
}

export const entryOn = (m: P.MatchRow, side: Side): number => (side === 'a' ? m.entry_a! : m.entry_b!);

export function vetoActions(db: DB, matchId: number): VetoAction[] {
  return (db.prepare('SELECT side, action, campaign, auto FROM event_vetoes WHERE event_match_id = ? ORDER BY step').all(matchId) as
    { side: Side; action: VetoAction['action']; campaign: string | null; auto: number }[])
    .map((r) => ({ side: r.side, action: r.action, campaign: r.campaign, auto: r.auto === 1 }));
}

/** T3a has no game results yet, so winners is always empty (Ruling 8). */
export function vetoInput(db: DB, m: P.MatchRow): VetoInput {
  const s = E.stageSettingsOf(E.getStage(db, m.stage_id)!);
  return { config: s.veto, pool: s.campaignPool, higher: m.room_higher ?? 'a', seed: m.room_seed ?? 0, actions: vetoActions(db, m.id), winners: [] };
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
 *  deadline, or the lineups once nothing is left for a person to do. */
function advance(db: DB, matchId: number, timers: RoomTimers, now: Date): void {
  const m = P.getMatch(db, matchId)!;
  const st = roomState(db, m);
  syncGames(db, m, st, iso(now));
  if (isHumanStep(st.next)) {
    db.prepare('UPDATE event_matches SET deadline = ? WHERE id = ?').run(plus(now, timers.stepSeconds * 1000), m.id);
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

const HOLDABLE: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['veto', 'lineup', 'booking']);

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

const RESETTABLE: ReadonlySet<P.MatchStatus> = new Set<P.MatchStatus>(['veto', 'lineup', 'booking', 'admin_hold']);

/** by is null when the engine resets it (a bracket correction, flow.ts). */
export function resetRoom(db: DB, o: { matchId: number; by: string | null; now?: Date }): V.Checked<P.MatchRow> {
  const at = iso(o.now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const m = P.getMatch(db, o.matchId);
    if (!m) return V.fail('match_not_found');
    if (!RESETTABLE.has(m.status)) return V.fail('wrong_status');
    db.prepare('DELETE FROM event_vetoes WHERE event_match_id = ?').run(m.id);
    db.prepare('DELETE FROM event_games WHERE event_match_id = ?').run(m.id);
    db.prepare('DELETE FROM event_lineups WHERE event_match_id = ?').run(m.id);
    db.prepare(
      `UPDATE event_matches SET status = 'waiting', room_opened_at = NULL, room_higher = NULL, room_seed = NULL, ready_a_at = NULL,
         ready_b_at = NULL, deadline = NULL, hold_reason = NULL WHERE id = ?`,
    ).run(m.id);
    E.logEvent(db, m.event_id, o.by, 'room_reset', at, { matchId: m.id, from: m.status });
    return V.ok(P.getMatch(db, m.id)!);
  })();
}

/** Ruling 16: an overdue deadline found at start gets its phase's full
 *  length from now; anything else is refused as 'changed' and left alone. */
export function resumeDeadline(db: DB, o: { matchId: number; timers: RoomTimers; now?: Date }): V.Checked<P.MatchRow> {
  const now = o.now ?? new Date();
  const at = iso(now);
  return db.transaction((): V.Checked<P.MatchRow> => {
    const m = P.getMatch(db, o.matchId);
    if (!m || (m.status !== 'veto' && m.status !== 'lineup') || m.deadline === null || m.deadline > at) return V.fail('changed');
    const ready = m.status === 'veto' && (m.ready_a_at === null || m.ready_b_at === null);
    const ms = m.status === 'lineup' ? o.timers.lineupMinutes * 60_000 : ready ? o.timers.readyMinutes * 60_000 : o.timers.stepSeconds * 1000;
    db.prepare('UPDATE event_matches SET deadline = ? WHERE id = ?').run(plus(now, ms), m.id);
    E.logEvent(db, m.event_id, null, 'room_resumed', at, { matchId: m.id, was: m.deadline });
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
    if (m.status !== 'veto' || m.ready_a_at === null || m.ready_b_at === null) return V.fail('not_veto_phase');
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
