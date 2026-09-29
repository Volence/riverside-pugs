import type { DB } from './db.js';
import type { LogEvent } from './logParse.js';
import { publishAdminEvent } from './adminFeed.js';
import { inGoodStanding } from './standing.js';

/**
 * Live server chat for staff (spec 2026-09-28-staff-server-chat-design.md).
 * Every human chat line pug-match reports is kept here with the server it came
 * from; so are players' /staff messages and what staff sent back. The page
 * reads it through src/routes/serverChat.ts.
 */

export interface ChatLineRow {
  id: number; server_id: number; at: number; steamid: string | null; name: string | null;
  team: number | null; scope: 'all' | 'team' | null; kind: 'say' | 'staff_in' | 'staff_out';
  message: string; match_id: number | null; to_kind: 'all' | 'team' | 'player' | null;
  to_value: string | null; sent_by: string | null; delivered: number | null;
}

/** The in-game name each SteamID last connected or renamed with (PUGNAME).
 *  In memory: after a restart the site name stands in until they rename or
 *  reconnect. */
const names = new Map<string, string>();

export function noteName(steamid: string, name: string): void { names.set(steamid, name); }
export function _resetNames(): void { names.clear(); }

function nameOf(db: DB, steamid: string): string | null {
  const seen = names.get(steamid);
  if (seen) return seen;
  const row = db.prepare('SELECT name FROM players WHERE steamid = ?').get(steamid) as { name: string | null } | undefined;
  return row?.name ?? null;
}

/** The match live on this server right now, if any. */
export function liveMatchOn(db: DB, serverId: number): number | null {
  const row = db.prepare("SELECT id FROM matches WHERE server_id = ? AND state = 'live' ORDER BY id DESC LIMIT 1")
    .get(serverId) as { id: number } | undefined;
  return row?.id ?? null;
}

const INSERT = `INSERT INTO server_chat
  (server_id, at, steamid, name, team, scope, kind, message, match_id, to_kind, to_value, sent_by, delivered)
  VALUES (@server_id, @at, @steamid, @name, @team, @scope, @kind, @message, @match_id, @to_kind, @to_value, @sent_by, NULL)`;

function insert(db: DB, row: Omit<ChatLineRow, 'id' | 'delivered'>): number {
  return Number(db.prepare(INSERT).run(row).lastInsertRowid);
}

export function recordSay(
  db: DB, serverId: number,
  ev: { steamid: string; team: number | null; scope: 'all' | 'team' | null; message: string },
  now = Date.now(),
): number {
  return insert(db, {
    server_id: serverId, at: now, steamid: ev.steamid, name: nameOf(db, ev.steamid), team: ev.team,
    scope: ev.scope, kind: 'say', message: ev.message, match_id: liveMatchOn(db, serverId),
    to_kind: null, to_value: null, sent_by: null,
  });
}

export function recordStaffIn(
  db: DB, serverId: number, ev: { steamid: string; team: number | null; message: string }, now = Date.now(),
): number {
  return insert(db, {
    server_id: serverId, at: now, steamid: ev.steamid, name: nameOf(db, ev.steamid), team: ev.team,
    scope: null, kind: 'staff_in', message: ev.message, match_id: liveMatchOn(db, serverId),
    to_kind: null, to_value: null, sent_by: null,
  });
}

export function recordStaffOut(
  db: DB, serverId: number,
  row: { sentBy: string; name: string; toKind: 'all' | 'team' | 'player'; toValue: string | null; message: string },
  now = Date.now(),
): number {
  return insert(db, {
    server_id: serverId, at: now, steamid: null, name: row.name, team: null, scope: null, kind: 'staff_out',
    message: row.message, match_id: liveMatchOn(db, serverId), to_kind: row.toKind, to_value: row.toValue,
    sent_by: row.sentBy,
  });
}

/** A delivery report is believed only from the server the send went to, and
 *  only for a staff_out row: a line from another box cannot touch it. */
export function markDelivered(db: DB, serverId: number, sendId: number, delivered: number): boolean {
  return db.prepare("UPDATE server_chat SET delivered = ? WHERE id = ? AND server_id = ? AND kind = 'staff_out'")
    .run(delivered, sendId, serverId).changes > 0;
}

/** Oldest first. `after = 0` means "the newest `limit` lines". */
export function listLines(db: DB, serverId: number, after: number, limit: number): ChatLineRow[] {
  if (after > 0) {
    return db.prepare('SELECT * FROM server_chat WHERE server_id = ? AND id > ? ORDER BY id LIMIT ?')
      .all(serverId, after, limit) as ChatLineRow[];
  }
  return (db.prepare('SELECT * FROM server_chat WHERE server_id = ? ORDER BY id DESC LIMIT ?')
    .all(serverId, limit) as ChatLineRow[]).reverse();
}

/** One admin feed line per player per this long; the page has the rest. */
export const STAFF_FEED_QUIET_MS = 10 * 60_000;
const lastFeed = new Map<string, number>();
export function _resetFeedQuiet(): void { lastFeed.clear(); }

/** Who may read server chat: checked per event, so a demotion or a ban takes
 *  effect on the next line rather than when the tab reloads. */
export function isActiveStaff(db: DB, steamid: string): boolean {
  const p = db.prepare('SELECT is_admin, is_mod FROM players WHERE steamid = ?').get(steamid) as
    { is_admin: number; is_mod: number } | undefined;
  return !!p && (p.is_admin === 1 || p.is_mod === 1) && inGoodStanding(db, steamid);
}

type ChatEvent = Extract<LogEvent, { kind: 'say' | 'name' | 'staff_in' | 'staff_sent' }>;

export function handleServerChatEvent(
  db: DB, ev: ChatEvent, serverId: number | null, notify: () => void, now = Date.now(),
): void {
  if (ev.kind === 'name') { noteName(ev.steamid, ev.name); return; }
  if (serverId === null) return;
  if (ev.kind === 'say') { recordSay(db, serverId, ev, now); notify(); return; }
  if (ev.kind === 'staff_sent') { if (markDelivered(db, serverId, ev.sendId, ev.delivered)) notify(); return; }
  recordStaffIn(db, serverId, ev, now);
  notify();
  const last = lastFeed.get(ev.steamid);
  if (last === undefined || now - last > STAFF_FEED_QUIET_MS) {
    lastFeed.set(ev.steamid, now);
    publishAdminEvent({ kind: 'staff_message', steamid: ev.steamid, serverId, text: ev.message });
  }
}
