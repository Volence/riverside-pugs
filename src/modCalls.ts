import type { DB } from './db.js';
import type { LogEvent, ModCallReason } from './logParse.js';
import { resolveAlias } from './aliases.js';
import { hasActiveBan } from './banState.js';
import { getPlayer } from './players.js';
import { getSetting } from './settings.js';
import { fileReport, MAX_TEXT, type FileBody, type ReportCategory } from './tickets/filing.js';

/**
 * In-game /mod calls (spec: docs/superpowers/specs/2026-09-24-mod-call-design.md).
 *
 * Every call is stored. A call about a named player from someone with an
 * account also files a ticket report through fileReport, so the ticket rules
 * (bans, duplicates, one open case per player) are the ticket system's own.
 * Calls close together about the same thing fold into one Discord card and
 * ping once. Posting is ModCallPoster's business; this only decides.
 */

export type ModCallEvent = Extract<LogEvent, { kind: 'call' }>;
export const FOLD_WINDOW_MS = 5 * 60_000;
export const RATE_CAP_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;

export const REASON_LABELS: Record<ModCallReason, string> = {
  cheating: 'Cheating', toxicity: 'Toxic / team fighting', griefing: 'Griefing / throwing',
  afk: 'AFK / no comms', english: 'Not speaking English', broke: 'Something broke', other: 'Other',
};

/** The ticket category a call files under. `broke` is about the server, not
 *  a person, so it never files. */
const CATEGORY: Record<ModCallReason, ReportCategory | null> = {
  cheating: 'cheating', toxicity: 'toxicity', griefing: 'griefing', afk: 'afk', english: 'other', other: 'other', broke: null,
};

export interface ModCallRow {
  id: number; created_at: string; server_id: number | null; match_id: number | null; map: string | null;
  map_ordinal: number | null; half: number | null; t_ms: number | null; caller_steamid: string; caller_team: number | null;
  target_kind: 'player' | 'team' | 'general' | 'none'; target_steamid: string | null; reason: ModCallReason; text: string;
  via: 'game' | 'tv'; ticket_id: number | null; folded_into: number | null; pinged: number;
  post_state: 'pending' | 'posted' | 'skipped' | 'folded'; note: string; discord_message_id: string | null;
  handled_by_discord_id: string | null; handled_at: string | null;
}

const listeners = new Set<(id: number) => void>();

/** Hear about every stored call, by id, once its row has committed. Returns
 *  the unsubscribe. */
export function onModCall(fn: (id: number) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getModCall(db: DB, id: number): ModCallRow | undefined {
  return db.prepare('SELECT * FROM mod_calls WHERE id = ?').get(id) as ModCallRow | undefined;
}

export function foldedCalls(db: DB, parentId: number): ModCallRow[] {
  return db.prepare('SELECT * FROM mod_calls WHERE folded_into = ? ORDER BY id').all(parentId) as ModCallRow[];
}

/** File the ticket report a named call carries. Returns the ticket id, or the
 *  note that says why there is none. */
function fileFor(
  db: DB, caller: string, target: string, ev: ModCallEvent, category: ReportCategory,
  deps: { adminSteamIds: string[]; now: Date },
): { ticketId: number } | { note: string } {
  if (!getPlayer(db, caller)) return { note: 'No ticket: caller has no account' };
  const text = (ev.reason === 'english' ? `Not speaking English: ${ev.text}` : ev.text).trim().slice(0, MAX_TEXT);
  const body: FileBody = { targetId: target, category, text };
  // The match rides along only when fileReport would accept it: the plugin
  // stamps the match the caller is in, and a spectator or a stand-in named by
  // the caller is not on its roster, which would refuse the whole report.
  const onRoster = ev.matchId !== null
    && db.prepare('SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?').get(ev.matchId, target) !== undefined;
  if (onRoster) {
    body.matchId = ev.matchId;
    if (ev.ordinal !== null && ev.half !== null && ev.tMs !== null) {
      body.moment = { ordinal: ev.ordinal, half: ev.half, tMs: ev.tMs };
    }
  }
  const result = fileReport(db, caller, body, { adminSteamIds: deps.adminSteamIds, now: deps.now, source: 'game' });
  return result.ok ? { ticketId: result.ticketId } : { note: `No ticket: ${result.error}` };
}

/**
 * Store one call and decide what happens to it: its ticket, whether it folds
 * into an earlier card, and whether it pings. Listeners hear the new row's id
 * after it commits, folded or not; the poster resolves a fold's parent.
 */
export function handleModCall(
  db: DB, ev: ModCallEvent, serverId: number | null, deps: { adminSteamIds: string[]; map?: string | null; now?: Date },
): ModCallRow {
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const caller = resolveAlias(db, ev.steamid);
  // `broke` is about the server: whoever the line named is not the subject,
  // and keeping them would fold it in with calls about that player.
  const targetKind: ModCallRow['target_kind'] = ev.reason === 'broke'
    ? 'none'
    : ev.target === 'team' || ev.target === 'general' || ev.target === 'none' ? ev.target : 'player';
  const target = targetKind === 'player' ? resolveAlias(db, ev.target) : null;

  let ticketId: number | null = null;
  let foldedInto: number | null = null;
  let pinged = 0;
  let postState: ModCallRow['post_state'] = 'pending';
  const note: string[] = [];

  if (hasActiveBan(db, caller, now)) {
    // Kept for the record, but a banned player gets no ticket, no card and no
    // ping, and cannot join someone else's card either.
    postState = 'skipped';
    note.push('Caller is banned');
  } else {
    const category = CATEGORY[ev.reason];
    if (target !== null && category !== null) {
      // Outside the insert transaction: fileReport commits its own, and a
      // refusal is recorded on the call rather than failing it.
      const filed = fileFor(db, caller, target, ev, category, { adminSteamIds: deps.adminSteamIds, now });
      if ('ticketId' in filed) ticketId = filed.ticketId;
      else note.push(filed.note);
    }

    // `server_id IS ?` so a call with no server folds with others like it.
    // A call about a named player folds into an earlier call about that same
    // player regardless of reason (a second complaint about someone is still
    // one situation to look at). A targetless call (team/general/none) has no
    // player to anchor on, so it only folds with an earlier targetless call
    // that shares the same reason: otherwise unrelated things like a toxic
    // team call and a "server broke" call would fold into one card.
    const since = new Date(now.getTime() - FOLD_WINDOW_MS).toISOString();
    const parent = db.prepare(
      `SELECT id FROM mod_calls
        WHERE folded_into IS NULL AND handled_at IS NULL AND post_state IN ('pending', 'posted')
          AND server_id IS ? AND created_at > ?
          AND ${target !== null ? "target_kind = 'player' AND target_steamid = ?" : "target_kind != 'player' AND reason = ?"}
        ORDER BY id DESC LIMIT 1`,
    ).get(...(target !== null ? [serverId, since, target] : [serverId, since, ev.reason])) as { id: number } | undefined;

    if (parent) {
      foldedInto = parent.id;
      postState = 'folded';
    } else if (getSetting(db, 'mod_calls_enabled') === '0') {
      postState = 'skipped';
      note.push('Calls are turned off');
    } else {
      const hourAgo = new Date(now.getTime() - HOUR_MS).toISOString();
      const recent = (db.prepare(
        'SELECT COUNT(*) AS n FROM mod_calls WHERE caller_steamid = ? AND folded_into IS NULL AND created_at > ?',
      ).get(caller, hourAgo) as { n: number }).n;
      if (recent >= RATE_CAP_PER_HOUR) note.push('Not pinged: rate cap');
      else pinged = 1;
    }
  }

  const id = db.transaction(() => Number(db.prepare(
    `INSERT INTO mod_calls (created_at, server_id, match_id, map, map_ordinal, half, t_ms, caller_steamid, caller_team,
       target_kind, target_steamid, reason, text, via, ticket_id, folded_into, pinged, post_state, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nowIso, serverId, ev.matchId, deps.map ?? null, ev.ordinal, ev.half, ev.tMs, caller, ev.callerTeam,
    targetKind, target, ev.reason, ev.text, ev.via, ticketId, foldedInto, pinged, postState, note.join('. '),
  ).lastInsertRowid))();

  for (const fn of listeners) {
    try { fn(id); } catch (err) { console.error('[modcall] listener failed:', err); }
  }
  return getModCall(db, id)!;
}
