import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { hasStaffFlag } from './store.js';

export type ThreadSurface = 'forum' | 'private';
export type ThreadState = 'open' | 'ended' | 'folded' | 'deleted';

export interface ThreadRow {
  id: number;
  ticket_id: number;
  kind: 'staff' | 'reporter';
  reporter_id: string | null;
  channel_id: string;
  thread_id: string;
  state: ThreadState;
  created_at: string;
  surface: ThreadSurface;
  card_message_id: string | null;
  card_hash: string;
  locked: number;
}

/** The ticket's current staff thread, if it has one. */
export function staffThread(db: DB, ticketId: number): ThreadRow | undefined {
  return db.prepare("SELECT * FROM ticket_threads WHERE ticket_id = ? AND kind = 'staff' AND state = 'open' ORDER BY id DESC LIMIT 1")
    .get(ticketId) as ThreadRow | undefined;
}

export function threadByDiscordId(db: DB, threadId: string): ThreadRow | undefined {
  return db.prepare('SELECT * FROM ticket_threads WHERE thread_id = ?').get(threadId) as ThreadRow | undefined;
}

export function insertThread(db: DB, t: {
  ticketId: number; kind: 'staff' | 'reporter'; surface: ThreadSurface; channelId: string; threadId: string;
  reporterId?: string | null; cardMessageId?: string | null; cardHash?: string;
}, now = new Date()): ThreadRow {
  db.prepare(
    `INSERT INTO ticket_threads (ticket_id, kind, reporter_id, channel_id, thread_id, created_at, surface, card_message_id, card_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(t.ticketId, t.kind, t.reporterId ?? null, t.channelId, t.threadId, now.toISOString(), t.surface, t.cardMessageId ?? null, t.cardHash ?? '');
  return threadByDiscordId(db, t.threadId)!;
}

export function setThreadState(db: DB, id: number, state: ThreadState): void {
  db.prepare('UPDATE ticket_threads SET state = ? WHERE id = ?').run(state, id);
}

/** Only ever called after Discord accepted the message this hash stands for. */
export function setThreadCard(db: DB, id: number, messageId: string, hash: string): void {
  db.prepare('UPDATE ticket_threads SET card_message_id = ?, card_hash = ? WHERE id = ?').run(messageId, hash, id);
}

export function setThreadLocked(db: DB, id: number, locked: boolean): void {
  db.prepare('UPDATE ticket_threads SET locked = ? WHERE id = ?').run(locked ? 1 : 0, id);
}

export function threadsInState(db: DB, state: ThreadState, ticketId?: number): ThreadRow[] {
  return ticketId === undefined
    ? db.prepare('SELECT * FROM ticket_threads WHERE state = ? ORDER BY id').all(state) as ThreadRow[]
    : db.prepare('SELECT * FROM ticket_threads WHERE state = ? AND ticket_id = ? ORDER BY id').all(state, ticketId) as ThreadRow[];
}

/**
 * Forum threads that must not exist: the forum is readable by every
 * moderator and admin, so a thread there about a restricted ticket, or about
 * someone who now holds a staff flag, is readable by people who must not see
 * it, in the worst case by the accused. Open or closed makes no difference:
 * an archived post is still a post anyone in the forum can open.
 */
export function forbiddenForumThreads(db: DB, ticketId?: number): ThreadRow[] {
  const rows = db.prepare(
    `SELECT th.* FROM ticket_threads th
       JOIN tickets t ON t.id = th.ticket_id JOIN players p ON p.steamid = t.target_id
     WHERE th.surface = 'forum' AND th.state != 'deleted'
       AND (t.restricted = 1 OR p.is_admin = 1 OR p.is_mod = 1)
     ORDER BY th.id`,
  ).all() as ThreadRow[];
  return ticketId === undefined ? rows : rows.filter((r) => r.ticket_id === ticketId);
}

/**
 * Where a ticket's staff thread belongs, and why nowhere when it is nowhere.
 * One function, used by the reconciler to act and by the ticket page to
 * explain, so the two cannot disagree.
 */
export function surfaceFor(
  db: DB, t: { restricted: number; target_id: string },
): { surface: ThreadSurface | null; why: 'ok' | 'unconfigured' | 'about_staff' } {
  if (t.restricted === 1) {
    return (getSetting(db, 'discord_tickets_channel_id') ?? '') ? { surface: 'private', why: 'ok' } : { surface: null, why: 'unconfigured' };
  }
  // A normal ticket about staff has no Discord thread at all: the forum is
  // readable by the accused, and with no access list there is nobody to put
  // in a private one. This is the ticket restrictOpenTicketAbout answered
  // 'nobody' for. It is worked on the site.
  if (hasStaffFlag(db, t.target_id)) return { surface: null, why: 'about_staff' };
  return (getSetting(db, 'discord_tickets_forum_id') ?? '') ? { surface: 'forum', why: 'ok' } : { surface: null, why: 'unconfigured' };
}

export interface PrivateThreadMember { steamid: string; discord_id: string; notified_at: string | null }

/**
 * Who may be in a restricted ticket's private staff thread: on its access
 * list, active, still holding a staff flag, linked to Discord, and never the
 * ticket's own target.
 *
 * One definition, for adding people, for telling them, and for taking out
 * whoever is in there and should not be. The site asks the same question in
 * two halves (makeRequireMod, then canSeeTicket), and nothing deletes an
 * access row when somebody is demoted, banned or merged, so a membership
 * built from the access list alone would leave a demoted moderator reading a
 * case the site no longer opens for them.
 */
export function privateThreadAudience(db: DB, ticketId: number): PrivateThreadMember[] {
  return db.prepare(
    `SELECT a.steamid, p.discord_id, a.notified_at FROM ticket_access a
       JOIN players p ON p.steamid = a.steamid
       JOIN tickets t ON t.id = a.ticket_id
     WHERE a.ticket_id = ? AND p.status = 'active' AND (p.is_admin = 1 OR p.is_mod = 1)
       AND p.discord_id IS NOT NULL AND p.steamid != t.target_id
     ORDER BY a.steamid`,
  ).all(ticketId) as PrivateThreadMember[];
}

/**
 * The Discord ids that may read the staff forum: linked, active moderators
 * and admins. Minus anyone a forum post is still about: forbiddenForumThreads
 * lists such posts for deletion, and until Discord has confirmed it (state
 * 'deleted') that person is kept out, so a failed deletion can never become
 * the accused reading their own case.
 */
export function forumAudience(db: DB): string[] {
  return (db.prepare(
    `SELECT p.discord_id FROM players p
     WHERE p.status = 'active' AND (p.is_admin = 1 OR p.is_mod = 1) AND p.discord_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM ticket_threads th JOIN tickets t ON t.id = th.ticket_id
         WHERE t.target_id = p.steamid AND th.surface = 'forum' AND th.state != 'deleted')
     ORDER BY p.discord_id`,
  ).all() as { discord_id: string }[]).map((r) => r.discord_id);
}
