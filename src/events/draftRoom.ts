// src/events/draftRoom.ts
import { randomInt } from 'node:crypto';
import type { DB } from '../db.js';
import * as E from './events.js';
import * as D from './drafts.js';
import * as V from './validate.js';
import { currentSeasonId } from '../players.js';
import { seasonSr } from '../rating.js';
import { autoPickChoice, cleanPickList, firstRoundOrder, roomSettingsOf, snakeSlots, type RankedPlayer, type Slot } from './draftRules.js';

/**
 * The live draft room (drafts plan D2b1, spec section 4). Every write to
 * draft_rooms, draft_picks and draft_pick_lists, and the draft_team of a
 * picked pool player (the captain's signup id, so D2a's draftTeamsOf,
 * draftFairness and createDraftEntries read a live draft exactly as they
 * read an auto-balanced one). Same shape as src/events/drafts.ts: each
 * mutation is one transaction that re-reads, checks inside, writes and adds
 * exactly one event_log row; a refusal writes nothing. The room keeps no
 * timer of its own: every running pick has a stored deadline_at and
 * src/events/draftClock.ts calls autoPickDue once it has passed, so a
 * restart resumes exactly (Ruling 7). Presence comes in as a Present
 * function, so this module never holds in-memory state.
 */

export type RoomStatus = 'ready' | 'running' | 'paused' | 'done';
export interface RoomRow {
  event_id: number; status: RoomStatus; order_json: string; pick_seconds: number; deadline_at: string | null;
  paused_left_ms: number | null; started_at: string | null; finished_at: string | null; delegates_json: string;
}
export interface PickRow {
  id: number; event_id: number; round: number; pick_no: number; captain_steamid: string; steamid: string;
  auto: 0 | 1; at: string; undone_at: string | null;
}
/** Ruling 8: an absent picker's clock, long enough for viewers to see who is up. */
export const ABSENT_SECONDS = 5;
/** Whether the person picking for a team is in the room (DraftClock's heartbeats). */
export type Present = (steamid: string) => boolean;

export interface RoomState {
  room: RoomRow; order: string[]; slots: Slot[]; picks: PickRow[]; delegates: Record<string, string>;
  /** The first open slot; null before Start, after done, or in a reset room. */
  next: Slot | null;
  /** Who picks for next: that captain's delegate when set, else the captain. */
  picker: string | null;
  signups: D.SignupRow[]; pool: D.SignupRow[]; available: D.SignupRow[];
}
export interface PickResult {
  pickNo: number; captain: string; steamid: string; auto: boolean;
  /** The final pick, when this pick left one player and the site made it (Ruling 9). */
  last: { pickNo: number; steamid: string } | null;
  done: boolean;
}

export function roomOf(db: DB, eventId: number): RoomRow | null {
  return (db.prepare('SELECT * FROM draft_rooms WHERE event_id = ?').get(eventId) as RoomRow | undefined) ?? null;
}

/** Picks not undone, in pick order. */
export function livePicks(db: DB, eventId: number): PickRow[] {
  return db.prepare('SELECT * FROM draft_picks WHERE event_id = ? AND undone_at IS NULL ORDER BY pick_no').all(eventId) as PickRow[];
}

export function roomState(db: DB, eventId: number): RoomState | null {
  const room = roomOf(db, eventId);
  if (!room) return null;
  const order = JSON.parse(room.order_json) as string[];
  const slots = snakeSlots(order);
  const picks = livePicks(db, eventId);
  const filled = new Set(picks.map((p) => p.pick_no));
  const next = room.status === 'ready' ? null : slots.find((s) => !filled.has(s.pickNo)) ?? null;
  const delegates = JSON.parse(room.delegates_json) as Record<string, string>;
  const signups = D.activeSignups(db, eventId);
  const pool = signups.filter((s) => s.role === 'pool');
  const taken = new Set(picks.map((p) => p.steamid));
  return {
    room, order, slots, picks, delegates, next, picker: next ? delegates[next.captain] ?? next.captain : null,
    signups, pool, available: pool.filter((s) => !taken.has(s.steamid)),
  };
}

/** A captain's saved list, current pool players only (Ruling 2). */
export function pickListOf(db: DB, eventId: number, captain: string): string[] {
  const row = db.prepare('SELECT list_json FROM draft_pick_lists WHERE event_id = ? AND captain_steamid = ?').get(eventId, captain) as { list_json: string } | undefined;
  if (!row) return [];
  const pool = new Set(D.activeSignups(db, eventId).filter((s) => s.role === 'pool').map((s) => s.steamid));
  return (JSON.parse(row.list_json) as string[]).filter((s) => pool.has(s));
}

/** The checks every room action and pick-list save share: the event exists
 *  (not a draft), is a draft, and its cut is published. */
function cutEvent(db: DB, eventId: number): V.Checked<E.EventRow> {
  const ev = E.getEvent(db, eventId);
  if (!ev || ev.status === 'draft') return V.fail('not_found');
  if (ev.entry_kind !== 'draft') return V.fail('not_draft');
  if (ev.cut_at === null) return V.fail('cut_not_published');
  return V.ok(ev);
}

/** A draft in live mode whose cut is published and whose teams are not, before its event starts. */
function liveEvent(db: DB, eventId: number): V.Checked<E.EventRow> {
  const found = cutEvent(db, eventId);
  if (!found.ok) return found;
  const ev = found.value;
  if (ev.teams_made_at !== null) return V.fail('teams_made');
  if (ev.status !== 'registration' && ev.status !== 'checkin') return V.fail('wrong_status');
  if (ev.team_mode !== 'live') return V.fail('not_live_mode');
  return V.ok(ev);
}

/** Current-season SR and signup order, the room's one ranking. */
function ranker(db: DB, signups: D.SignupRow[]): (s: D.SignupRow) => RankedPlayer {
  const season = currentSeasonId(db);
  const order = new Map(signups.map((s, i) => [s.id, i]));
  return (s) => ({ steamid: s.steamid, sr: seasonSr(db, s.steamid, season), order: order.get(s.id)! });
}

const deadlineFor = (now: Date, pickSeconds: number, here: boolean): string =>
  new Date(now.getTime() + (here ? pickSeconds : ABSENT_SECONDS) * 1000).toISOString();

/** Start (Ruling 5): the order from the settings, every draft_team cleared,
 *  the room running with pick 1 on the clock. A reset room ('ready' row)
 *  starts again the same way. */
export function startRoom(
  db: DB, o: { eventId: number; actor: string; now: Date; present: Present; rand?: (n: number) => number },
): V.Checked<{ order: string[] }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ order: string[] }> => {
    const found = liveEvent(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    const room = roomOf(db, ev.id);
    if (room && room.status !== 'ready') return V.fail('room_not_ready');
    const all = D.activeSignups(db, ev.id);
    const captains = all.filter((s) => s.role === 'captain');
    const pool = all.filter((s) => s.role === 'pool');
    if (captains.length < 2 || pool.length !== captains.length * 3) return V.fail('teams_changed');
    const settings = roomSettingsOf(ev.draft_json);
    const order = firstRoundOrder(captains.map(ranker(db, all)), settings.firstPick, o.rand ?? ((n) => randomInt(n)));
    db.prepare('UPDATE draft_signups SET draft_team = NULL WHERE event_id = ? AND draft_team IS NOT NULL').run(ev.id);
    db.prepare(
      `INSERT INTO draft_rooms (event_id, status, order_json, pick_seconds, deadline_at, paused_left_ms, started_at, finished_at, delegates_json)
       VALUES (?, 'running', ?, ?, ?, NULL, ?, NULL, '{}')
       ON CONFLICT(event_id) DO UPDATE SET status = 'running', order_json = excluded.order_json, pick_seconds = excluded.pick_seconds,
         deadline_at = excluded.deadline_at, paused_left_ms = NULL, started_at = excluded.started_at, finished_at = NULL, delegates_json = '{}'`,
    ).run(ev.id, JSON.stringify(order), settings.pickSeconds, deadlineFor(o.now, settings.pickSeconds, o.present(order[0]!)), at);
    E.logEvent(db, ev.id, o.actor, 'draft_room_started', at, { order, firstPick: settings.firstPick, pickSeconds: settings.pickSeconds });
    return V.ok({ order });
  })();
}

/** Inside the caller's transaction: the pick for st.next, then either the
 *  forced final pick and done (Ruling 9) or the next slot's clock (full when
 *  its picker is present, ABSENT_SECONDS when not). */
function pickAndAdvance(db: DB, st: RoomState, player: string, auto: boolean, now: Date, present: Present): PickResult {
  const at = now.toISOString();
  const slot = st.next!;
  const eventId = st.room.event_id;
  const idOf = new Map(st.signups.map((s) => [s.steamid, s.id]));
  const insert = db.prepare('INSERT INTO draft_picks (event_id, round, pick_no, captain_steamid, steamid, auto, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const team = db.prepare('UPDATE draft_signups SET draft_team = ? WHERE id = ?');
  insert.run(eventId, slot.round, slot.pickNo, slot.captain, player, auto ? 1 : 0, at);
  team.run(idOf.get(slot.captain)!, idOf.get(player)!);
  const filled = new Set([...st.picks.map((p) => p.pick_no), slot.pickNo]);
  const after = st.slots.find((s) => !filled.has(s.pickNo)) ?? null;
  const rest = st.available.filter((s) => s.steamid !== player);
  let last: PickResult['last'] = null;
  if (after && rest.length === 1) {
    const only = rest[0]!.steamid;
    insert.run(eventId, after.round, after.pickNo, after.captain, only, 1, at);
    team.run(idOf.get(after.captain)!, idOf.get(only)!);
    last = { pickNo: after.pickNo, steamid: only };
  }
  const done = after === null || last !== null;
  if (done) {
    db.prepare("UPDATE draft_rooms SET status = 'done', deadline_at = NULL, paused_left_ms = NULL, finished_at = ? WHERE event_id = ?").run(at, eventId);
  } else {
    const picker = st.delegates[after!.captain] ?? after!.captain;
    db.prepare('UPDATE draft_rooms SET deadline_at = ? WHERE event_id = ?').run(deadlineFor(now, st.room.pick_seconds, present(picker)), eventId);
  }
  return { pickNo: slot.pickNo, captain: slot.captain, steamid: player, auto, last, done };
}

/** A captain's (or delegate's) pick for the slot they saw (Ruling 18): a
 *  stale pickNo is pick_moved, checked before anything else, so a double
 *  click at a snake turn never takes two players (Review Focus 1). */
export function makePick(
  db: DB, o: { eventId: number; steamid: string; player: string; pickNo: number; now: Date; present: Present },
): V.Checked<PickResult> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<PickResult> => {
    const found = liveEvent(db, o.eventId);
    if (!found.ok) return found;
    const st = roomState(db, o.eventId);
    if (!st || st.room.status !== 'running' || !st.next) return V.fail('room_not_running');
    if (o.pickNo !== st.next.pickNo) return V.fail('pick_moved');
    if (o.steamid !== st.picker) return V.fail('not_your_pick');
    if (!st.available.some((s) => s.steamid === o.player)) return V.fail('not_available');
    const r = pickAndAdvance(db, st, o.player, false, o.now, o.present);
    E.logEvent(db, o.eventId, o.steamid, 'draft_pick', at, r);
    return V.ok(r);
  })();
}

/** The clock's pick (Ruling 7): only for a running room whose deadline has
 *  passed; from the captain's list, else by SR. not_due writes nothing. */
export function autoPickDue(db: DB, o: { eventId: number; now: Date; present: Present }): V.Checked<PickResult> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<PickResult> => {
    const found = liveEvent(db, o.eventId);
    if (!found.ok) return found;
    const st = roomState(db, o.eventId);
    if (!st || st.room.status !== 'running' || !st.next || st.room.deadline_at === null
      || Date.parse(st.room.deadline_at) > o.now.getTime()) return V.fail('not_due');
    const choice = autoPickChoice(st.available.map(ranker(db, st.signups)), pickListOf(db, o.eventId, st.next.captain));
    const r = pickAndAdvance(db, st, choice, true, o.now, o.present);
    E.logEvent(db, o.eventId, null, 'draft_pick', at, r);
    return V.ok(r);
  })();
}

/** A live draft whose room has started (any status but 'ready'). */
function startedRoom(db: DB, eventId: number): V.Checked<RoomState> {
  const found = liveEvent(db, eventId);
  if (!found.ok) return found;
  const st = roomState(db, eventId);
  if (!st || st.room.status === 'ready') return V.fail('room_not_running');
  return V.ok(st);
}

/** Staff pause (Ruling 6): the time left is kept, the deadline cleared, so
 *  the clock never auto-picks a paused room. */
export function pauseRoom(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<{ leftMs: number }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ leftMs: number }> => {
    const found = startedRoom(db, o.eventId);
    if (!found.ok) return found;
    const st = found.value;
    if (st.room.status !== 'running') return V.fail('room_not_running');
    const leftMs = Math.max(0, Date.parse(st.room.deadline_at!) - o.now.getTime());
    db.prepare("UPDATE draft_rooms SET status = 'paused', paused_left_ms = ?, deadline_at = NULL WHERE event_id = ?").run(leftMs, o.eventId);
    E.logEvent(db, o.eventId, o.actor, 'draft_room_paused', at, { leftMs });
    return V.ok({ leftMs });
  })();
}

/** Staff resume (Ruling 17): now + the time left, never under ABSENT_SECONDS. */
export function resumeRoom(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<{ deadlineAt: string }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ deadlineAt: string }> => {
    const found = startedRoom(db, o.eventId);
    if (!found.ok) return found;
    const st = found.value;
    if (st.room.status !== 'paused') return V.fail('room_not_paused');
    const deadlineAt = new Date(o.now.getTime() + Math.max(st.room.paused_left_ms ?? 0, ABSENT_SECONDS * 1000)).toISOString();
    db.prepare("UPDATE draft_rooms SET status = 'running', deadline_at = ?, paused_left_ms = NULL WHERE event_id = ?").run(deadlineAt, o.eventId);
    E.logEvent(db, o.eventId, o.actor, 'draft_room_resumed', at, { deadlineAt });
    return V.ok({ deadlineAt });
  })();
}

/** Staff undo (Ruling 6, Review Focus 4): the last live pick is flagged
 *  undone and its player freed. When it is the final pick (always made by
 *  the site with the pick before it) both are taken back, or the final pick
 *  would be forced again at once. The reopened pick gets a full clock; a
 *  done room runs again, a paused one stays paused with the full clock
 *  waiting. A delegate whose pick was undone is dropped. */
export function undoPick(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<{ undone: number[] }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ undone: number[] }> => {
    const found = startedRoom(db, o.eventId);
    if (!found.ok) return found;
    const st = found.value;
    const lastPick = st.picks.at(-1);
    if (!lastPick) return V.fail('no_picks');
    const back = lastPick.pick_no === st.slots.length && st.picks.length >= 2 ? st.picks.slice(-2).reverse() : [lastPick];
    const undo = db.prepare('UPDATE draft_picks SET undone_at = ? WHERE id = ?');
    const free = db.prepare('UPDATE draft_signups SET draft_team = NULL WHERE event_id = ? AND steamid = ? AND withdrawn_at IS NULL');
    for (const p of back) {
      undo.run(at, p.id);
      free.run(o.eventId, p.steamid);
    }
    const gone = new Set(back.map((p) => p.steamid));
    const delegates = JSON.stringify(Object.fromEntries(Object.entries(st.delegates).filter(([, d]) => !gone.has(d))));
    const full = st.room.pick_seconds * 1000;
    if (st.room.status === 'paused') {
      db.prepare('UPDATE draft_rooms SET paused_left_ms = ?, delegates_json = ? WHERE event_id = ?').run(full, delegates, o.eventId);
    } else {
      db.prepare("UPDATE draft_rooms SET status = 'running', deadline_at = ?, finished_at = NULL, delegates_json = ? WHERE event_id = ?")
        .run(new Date(o.now.getTime() + full).toISOString(), delegates, o.eventId);
    }
    E.logEvent(db, o.eventId, o.actor, 'draft_pick_undone', at, { picks: back.map((p) => ({ pickNo: p.pick_no, steamid: p.steamid })) });
    return V.ok({ undone: back.map((p) => p.pick_no) });
  })();
}

/** Staff hand a team's picking to its first drafted player, or give it
 *  back (Ruling 16). The clock is not touched: the delegate gets the time
 *  left, as a captain arriving mid-clock does. */
export function setDelegate(
  db: DB, o: { eventId: number; captain: string; on: boolean; actor: string; now: Date },
): V.Checked<{ delegate: string | null }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ delegate: string | null }> => {
    const found = startedRoom(db, o.eventId);
    if (!found.ok) return found;
    const st = found.value;
    if (!st.order.includes(o.captain)) return V.fail('bad_captain');
    const delegates = { ...st.delegates };
    let delegate: string | null = null;
    if (o.on) {
      const first = st.picks.find((p) => p.captain_steamid === o.captain);
      if (!first) return V.fail('no_delegate');
      delegate = first.steamid;
      delegates[o.captain] = delegate;
    } else {
      delete delegates[o.captain];
    }
    db.prepare('UPDATE draft_rooms SET delegates_json = ? WHERE event_id = ?').run(JSON.stringify(delegates), o.eventId);
    E.logEvent(db, o.eventId, o.actor, 'draft_delegate_set', at, { captain: o.captain, delegate });
    return V.ok({ delegate });
  })();
}

/** Staff Reset room (Ruling 6): every live pick flagged undone, every
 *  draft_team cleared, the room back to 'ready' with no order, so the next
 *  Start recomputes it and the method may change again. */
export function resetRoom(db: DB, o: { eventId: number; actor: string; now: Date }): V.Checked<{ undone: number }> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<{ undone: number }> => {
    const found = startedRoom(db, o.eventId);
    if (!found.ok) return found;
    const st = found.value;
    db.prepare('UPDATE draft_picks SET undone_at = ? WHERE event_id = ? AND undone_at IS NULL').run(at, o.eventId);
    db.prepare('UPDATE draft_signups SET draft_team = NULL WHERE event_id = ? AND draft_team IS NOT NULL').run(o.eventId);
    db.prepare(
      `UPDATE draft_rooms SET status = 'ready', order_json = '[]', deadline_at = NULL, paused_left_ms = NULL,
         started_at = NULL, finished_at = NULL, delegates_json = '{}' WHERE event_id = ?`,
    ).run(o.eventId);
    E.logEvent(db, o.eventId, o.actor, 'draft_room_reset', at, { undone: st.picks.length });
    return V.ok({ undone: st.picks.length });
  })();
}

/** The captain a viewer picks for (Ruling 16): their own team as a
 *  captain, or the team whose delegate they are; null otherwise. */
export function captainFor(db: DB, eventId: number, steamid: string): string | null {
  if (D.signupOf(db, eventId, steamid)?.role === 'captain') return steamid;
  const room = roomOf(db, eventId);
  if (!room) return null;
  const delegates = JSON.parse(room.delegates_json) as Record<string, string>;
  return Object.entries(delegates).find(([, d]) => d === steamid)?.[0] ?? null;
}

/** A captain saves their ordered list (Rulings 1, 2; captain only, a
 *  delegate can pick for the team but never reads or writes the list):
 *  any method, from the cut until the draft is done or teams are published.
 *  Unknown and non-pool entries are dropped; the log keeps only the size. */
export function savePickList(db: DB, o: { eventId: number; steamid: string; list: unknown; now: Date }): V.Checked<string[]> {
  const at = o.now.toISOString();
  return db.transaction((): V.Checked<string[]> => {
    const found = cutEvent(db, o.eventId);
    if (!found.ok) return found;
    const ev = found.value;
    if (ev.teams_made_at !== null || (ev.status !== 'registration' && ev.status !== 'checkin')) return V.fail('lists_closed');
    if (roomOf(db, ev.id)?.status === 'done') return V.fail('lists_closed');
    if (D.signupOf(db, ev.id, o.steamid)?.role !== 'captain') return V.fail('not_a_captain');
    const captain = o.steamid;
    const pool = new Set(D.activeSignups(db, ev.id).filter((s) => s.role === 'pool').map((s) => s.steamid));
    const list = cleanPickList(o.list, pool);
    if (!list) return V.fail('bad_list');
    db.prepare(
      `INSERT INTO draft_pick_lists (event_id, captain_steamid, list_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id, captain_steamid) DO UPDATE SET list_json = excluded.list_json, updated_at = excluded.updated_at`,
    ).run(ev.id, captain, JSON.stringify(list), at);
    E.logEvent(db, ev.id, o.steamid, 'draft_list_saved', at, { captain, size: list.length });
    return V.ok(list);
  })();
}
