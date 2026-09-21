import type { DB } from '../db.js';

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
