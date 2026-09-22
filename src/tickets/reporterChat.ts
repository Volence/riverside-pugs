import type { DB } from '../db.js';
import { inGoodStanding } from '../standing.js';
import { discordReporterBlocked } from './filing.js';
import type { MessageRow } from './messages.js';
import { canSeeTicket, getTicketRow, type TicketRow } from './store.js';
import type { ThreadRow } from './threads.js';

/**
 * Reporter chat: the rules, as database functions. The Discord half is
 * src/discord/reporterChats.ts; the reconciler's half is in ticketSync.ts.
 *
 * A reporter is exactly one of a player (reporter_id) or a Discord-only
 * member (reporter_discord_id), on ticket_reports and on ticket_threads
 * alike. Every comparison here is written for both, NULL-safely.
 */

export const CHAT_CLOSED = 'This report is closed. File a new one if something has happened since.';
export const CHAT_REFUSED = 'You cannot open a chat right now.';
export const CHAT_NO_DISCORD = 'Link your Discord account on your profile first: the chat happens in Discord.';
/** The spec's cap: staff are told about a chat at most once an hour per thread. */
export const PING_GAP_MS = 60 * 60_000;

export interface ReporterRef { reporterId: string | null; reporterDiscordId: string | null }
export type ReporterAsker = { kind: 'player'; steamid: string } | { kind: 'discord'; discordId: string; timedOutUntil: string | null };
export interface ChatPlan { ticketId: number; reportId: number; ref: ReporterRef; reporterDiscordId: string; restricted: boolean; claimedBy: string | null }
export type Checked<T> = { ok: true; plan: T } | { ok: false; status: number; error: string };

const fail = (status: number, error: string) => ({ ok: false as const, status, error });

/** The Discord id a reporter is reached on: their own, or their player's. */
export function reporterDiscordIdOf(db: DB, ref: ReporterRef): string | null {
  if (ref.reporterDiscordId !== null) return ref.reporterDiscordId;
  if (ref.reporterId === null) return null;
  return (db.prepare('SELECT discord_id FROM players WHERE steamid = ?').get(ref.reporterId) as { discord_id: string | null } | undefined)?.discord_id ?? null;
}

/** Whether this stored message is the reporter's own, rather than a
 *  moderator's reply in the same thread. By player for a player (the
 *  adoption in phase 3b1 fills author_player_id in), by Discord id for a
 *  Discord-only reporter. */
export function isReporterMessage(
  th: Pick<ThreadRow, 'reporter_id' | 'reporter_discord_id'>, m: Pick<MessageRow, 'author_discord_id' | 'author_player_id'>,
): boolean {
  return (th.reporter_discord_id !== null && m.author_discord_id === th.reporter_discord_id)
    || (th.reporter_id !== null && m.author_player_id === th.reporter_id);
}

/** A reporter's name as staff see it: the player's name, or the snapshot
 *  taken when a Discord-only member filed. A blank name (a player whose name
 *  is the empty string, not merely unset) falls back the same as a missing
 *  one: an empty button label is not just ugly, Discord rejects the whole
 *  reply over it. */
export function reporterLabel(db: DB, ticketId: number, ref: ReporterRef): string {
  if (ref.reporterId !== null) {
    const name = (db.prepare('SELECT name FROM players WHERE steamid = ?').get(ref.reporterId) as { name: string } | undefined)?.name;
    return name || 'a reporter';
  }
  const r = db.prepare("SELECT NULLIF(reporter_name, '') AS name FROM ticket_reports WHERE ticket_id = ? AND reporter_discord_id = ? ORDER BY id DESC LIMIT 1")
    .get(ticketId, ref.reporterDiscordId) as { name: string | null } | undefined;
  return r?.name || 'a Discord member';
}

interface ReportJoin {
  id: number; ticket_id: number; reporter_id: string | null; reporter_discord_id: string | null;
  status: string; restricted: number; claimed_by: string | null; target_id: string | null; target_discord_id: string | null;
}

const reportOf = (db: DB, reportId: number) => db.prepare(
  `SELECT r.id, r.ticket_id, r.reporter_id, r.reporter_discord_id, t.status, t.restricted, t.claimed_by, t.target_id, t.target_discord_id
   FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id WHERE r.id = ?`,
).get(reportId) as ReportJoin | undefined;

/** A merge can leave a report filed by what is now the accused's own
 *  account. That person never gets a chat about their own case. */
const reporterIsAccused = (r: ReportJoin) =>
  (r.reporter_id !== null && r.reporter_id === r.target_id) || (r.reporter_discord_id !== null && r.reporter_discord_id === r.target_discord_id);

function planOf(db: DB, r: ReportJoin): Checked<ChatPlan> {
  const ref = { reporterId: r.reporter_id, reporterDiscordId: r.reporter_discord_id };
  const d = reporterDiscordIdOf(db, ref);
  if (d === null) return fail(400, CHAT_NO_DISCORD);
  return { ok: true, plan: { ticketId: r.ticket_id, reportId: r.id, ref, reporterDiscordId: d, restricted: r.restricted === 1, claimedBy: r.claimed_by } };
}

/**
 * May this person open a chat about this report? Only its own reporter, only
 * while its ticket is open, and only in good standing. Not yours, no such
 * report and closed are the same answer: a report id must not be a probe.
 */
export function checkReporterChat(db: DB, reportId: number, asker: ReporterAsker, now = new Date()): Checked<ChatPlan> {
  const r = reportOf(db, reportId);
  const mine = !!r && (asker.kind === 'player' ? r.reporter_id === asker.steamid : r.reporter_discord_id === asker.discordId);
  if (!r || !mine || r.status !== 'open' || reporterIsAccused(r)) return fail(404, CHAT_CLOSED);
  const blocked = asker.kind === 'player'
    ? !inGoodStanding(db, asker.steamid, now)
    : discordReporterBlocked(db, asker.discordId, asker.timedOutUntil, now);
  if (blocked) return fail(403, CHAT_REFUSED);
  const p = planOf(db, r);
  return p.ok ? p : fail(p.status, p.error);
}

/** Staff, visible ticket, open. The shared first half of every staff action
 *  on a chat. Missing and invisible are the same 404. */
export function checkChatStaff(db: DB, ticketId: number, staff: string): Checked<TicketRow> {
  const t = getTicketRow(db, ticketId);
  if (!t || !canSeeTicket(db, t, staff)) return fail(404, 'no such ticket');
  if (t.status !== 'open') return fail(409, 'reopen the ticket first');
  return { ok: true, plan: t };
}

/** Contact reporter: a member of staff opens the chat for a report on a
 *  ticket they can see. */
export function checkContactReporter(db: DB, ticketId: number, reportId: number, staff: string): Checked<ChatPlan> {
  const t = checkChatStaff(db, ticketId, staff);
  if (!t.ok) return t;
  const r = reportOf(db, reportId);
  if (!r || r.ticket_id !== ticketId) return fail(404, 'no such report on this ticket');
  if (reporterIsAccused(r)) return fail(400, 'that report was filed by the person this ticket is about');
  const p = planOf(db, r);
  if (!p.ok) return fail(400, 'this reporter has no Discord account linked, so there is no way to reach them there');
  return p;
}

/** The newest chat for this reporter on this ticket that the bot still
 *  stands behind. A fold can leave two; the newest is the one used. */
export function reporterThreadFor(db: DB, ticketId: number, ref: ReporterRef): ThreadRow | undefined {
  return db.prepare(
    `SELECT * FROM ticket_threads WHERE ticket_id = ? AND kind = 'reporter' AND state != 'deleted'
       AND reporter_id IS ? AND reporter_discord_id IS ? ORDER BY id DESC LIMIT 1`,
  ).get(ticketId, ref.reporterId, ref.reporterDiscordId) as ThreadRow | undefined;
}

export function reporterThreadsOf(db: DB, ticketId: number, state?: 'open' | 'ended'): ThreadRow[] {
  return (state === undefined
    ? db.prepare("SELECT * FROM ticket_threads WHERE ticket_id = ? AND kind = 'reporter' AND state != 'deleted' ORDER BY id").all(ticketId)
    : db.prepare("SELECT * FROM ticket_threads WHERE ticket_id = ? AND kind = 'reporter' AND state = ? ORDER BY id").all(ticketId, state)) as ThreadRow[];
}

/**
 * Who may be in a reporter thread: the reporter, and any linked, active
 * member of staff who can see the ticket (for a restricted ticket, the access
 * list). Never the accused, and never a reporter who has since become the
 * accused. The 2b handoff asked for this apart from privateThreadAudience.
 *
 * Who MAY be there, not who is: nobody is added from this list. The reporter
 * and the claimer are added when a chat opens, and staff by Join. The
 * ejection sweep takes out anyone in the thread who is not on it.
 */
export function reporterThreadAudience(db: DB, th: ThreadRow): string[] {
  const t = getTicketRow(db, th.ticket_id);
  if (!t) return [];
  const out = new Set<string>();
  const accused = (th.reporter_id !== null && th.reporter_id === t.target_id)
    || (th.reporter_discord_id !== null && th.reporter_discord_id === t.target_discord_id);
  const reporter = reporterDiscordIdOf(db, { reporterId: th.reporter_id, reporterDiscordId: th.reporter_discord_id });
  if (reporter !== null && !accused) out.add(reporter);
  const staff = db.prepare(
    `SELECT p.discord_id FROM players p
     WHERE p.status = 'active' AND (p.is_admin = 1 OR p.is_mod = 1) AND p.discord_id IS NOT NULL
       AND p.steamid IS NOT @target
       AND (@restricted = 0 OR EXISTS (SELECT 1 FROM ticket_access a WHERE a.ticket_id = @ticket AND a.steamid = p.steamid))`,
  ).all({ target: t.target_id, restricted: t.restricted, ticket: t.id }) as { discord_id: string }[];
  for (const s of staff) out.add(s.discord_id);
  return [...out];
}

/** Ask for staff to be told about this chat. A second ask while one waits
 *  keeps the first one's time. */
export function requestPing(db: DB, threadId: string, now = new Date()): void {
  db.prepare(
    `INSERT INTO reporter_chat_pings (thread_id, wanted_at) VALUES (?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET wanted_at = COALESCE(reporter_chat_pings.wanted_at, excluded.wanted_at)`,
  ).run(threadId, now.toISOString());
}

/** The chats on this ticket whose ping is owed and allowed now, charged
 *  before anything is sent: a ping Discord refuses is not tried again. */
export function takeDuePings(db: DB, ticketId: number, now = new Date()): string[] {
  const cutoff = new Date(now.getTime() - PING_GAP_MS).toISOString();
  const due = (db.prepare(
    `SELECT p.thread_id FROM reporter_chat_pings p JOIN ticket_threads th ON th.thread_id = p.thread_id
     WHERE th.ticket_id = ? AND th.kind = 'reporter' AND p.wanted_at IS NOT NULL
       AND (p.last_ping_at IS NULL OR p.last_ping_at <= ?)
     ORDER BY th.id`,
  ).all(ticketId, cutoff) as { thread_id: string }[]).map((r) => r.thread_id);
  const mark = db.prepare('UPDATE reporter_chat_pings SET last_ping_at = ?, wanted_at = NULL WHERE thread_id = ?');
  for (const id of due) mark.run(now.toISOString(), id);
  return due;
}

/** One close DM owed to each reporter reachable on Discord, never to a
 *  reporter who is the accused. Runs inside closeTicket's transaction. */
export function queueCloseNotices(db: DB, ticketId: number, now = new Date()): number {
  return db.prepare(
    `INSERT INTO ticket_notices (ticket_id, discord_id, kind, created_at)
     SELECT DISTINCT @ticket, d, 'closed', @now FROM (
       SELECT COALESCE(r.reporter_discord_id, p.discord_id) AS d
       FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id LEFT JOIN players p ON p.steamid = r.reporter_id
       WHERE r.ticket_id = @ticket
         AND NOT ((r.reporter_id IS NOT NULL AND r.reporter_id IS t.target_id)
               OR (r.reporter_discord_id IS NOT NULL AND r.reporter_discord_id IS t.target_discord_id))
     ) WHERE d IS NOT NULL`,
  ).run({ ticket: ticketId, now: now.toISOString() }).changes;
}

/** The notices owed on this ticket, charged as sent. */
export function takeNotices(db: DB, ticketId: number, now = new Date()): { id: number; discord_id: string }[] {
  const rows = db.prepare('SELECT id, discord_id FROM ticket_notices WHERE ticket_id = ? AND sent_at IS NULL ORDER BY id').all(ticketId) as { id: number; discord_id: string }[];
  const mark = db.prepare('UPDATE ticket_notices SET sent_at = ? WHERE id = ?');
  for (const r of rows) mark.run(now.toISOString(), r.id);
  return rows;
}

export interface OpenReport { reportId: number; targetName: string; category: string }

/** The presser's open reports, newest first, for My reports. Never one
 *  about themselves (a merge can make one). */
export function openReportsOf(db: DB, asker: ReporterAsker, limit = 5): OpenReport[] {
  const mine = asker.kind === 'player'
    ? 'r.reporter_id = @who AND t.target_id IS NOT r.reporter_id'
    : 'r.reporter_discord_id = @who AND t.target_discord_id IS NOT r.reporter_discord_id';
  return db.prepare(
    `SELECT r.id AS reportId, COALESCE(p.name, NULLIF(t.target_name, ''), 'someone') AS targetName, r.category
     FROM ticket_reports r JOIN tickets t ON t.id = r.ticket_id LEFT JOIN players p ON p.steamid = t.target_id
     WHERE t.status = 'open' AND ${mine}
     ORDER BY r.id DESC LIMIT @limit`,
  ).all({ who: asker.kind === 'player' ? asker.steamid : asker.discordId, limit }) as OpenReport[];
}
