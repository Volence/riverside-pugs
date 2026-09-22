import type { DB } from '../db.js';

export type MessageChannel = 'staff' | 'reporter';
export type SkipReason = 'too_large' | 'type' | 'quota' | 'disabled' | 'fetch_failed';

export interface MessageRow {
  id: number;
  ticket_id: number;
  thread_id: string;
  channel: MessageChannel;
  discord_message_id: string;
  author_discord_id: string;
  author_player_id: string | null;
  author_name: string;
  content: string;
  /** JSON array of earlier contents, oldest first. */
  history: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  removed_at: string | null;
  removed_by: string | null;
  removed_reason: string | null;
  discord_gone: number;
}

export interface AttachmentRow {
  id: number;
  message_id: number;
  discord_attachment_id: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string | null;
  stored_name: string | null;
  skip_reason: SkipReason | null;
  removed_at: string | null;
}

export interface NewMessage {
  ticketId: number; threadId: string; channel: MessageChannel; discordMessageId: string;
  authorDiscordId: string; authorPlayerId: string | null; authorName: string; content: string; createdAt: string;
}

export interface NewAttachment {
  messageId: number; discordAttachmentId: string; filename: string; contentType: string; size: number;
  sha256: string | null; storedName: string | null; skipReason: SkipReason | null;
}

/** An edit war must not grow a row without bound. The newest are kept. */
const HISTORY_MAX = 50;

export function messageById(db: DB, id: number): MessageRow | undefined {
  return db.prepare('SELECT * FROM ticket_messages WHERE id = ?').get(id) as MessageRow | undefined;
}

export function messageByDiscordId(db: DB, discordMessageId: string): MessageRow | undefined {
  return db.prepare('SELECT * FROM ticket_messages WHERE discord_message_id = ?').get(discordMessageId) as MessageRow | undefined;
}

/** Null when this Discord message is already stored: a live event and a
 *  backfill can both deliver it, and the second is not a second message. */
export function insertMessage(db: DB, m: NewMessage): MessageRow | null {
  const r = db.prepare(
    `INSERT OR IGNORE INTO ticket_messages
       (ticket_id, thread_id, channel, discord_message_id, author_discord_id, author_player_id, author_name, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(m.ticketId, m.threadId, m.channel, m.discordMessageId, m.authorDiscordId, m.authorPlayerId, m.authorName.slice(0, 100), m.content, m.createdAt);
  return r.changes === 0 ? null : messageByDiscordId(db, m.discordMessageId)!;
}

/** False when nothing changed: the content is the same, or the message has
 *  been removed and must stay blank whatever Discord says afterwards. */
export function recordEdit(db: DB, id: number, content: string, editedAt: string): boolean {
  const m = messageById(db, id);
  if (!m || m.removed_at !== null || m.content === content) return false;
  const history = [...(JSON.parse(m.history) as string[]), m.content].slice(-HISTORY_MAX);
  db.prepare('UPDATE ticket_messages SET content = ?, history = ?, edited_at = ? WHERE id = ?')
    .run(content, JSON.stringify(history), editedAt, id);
  return true;
}

/** A delete in Discord. Soft on purpose: the case file survives someone
 *  tidying up after themselves. The first deletion time is the one kept. */
export function markDeleted(db: DB, discordMessageId: string, now = new Date()): MessageRow | undefined {
  db.prepare('UPDATE ticket_messages SET deleted_at = COALESCE(deleted_at, ?), discord_gone = 1 WHERE discord_message_id = ?')
    .run(now.toISOString(), discordMessageId);
  return messageByDiscordId(db, discordMessageId);
}

/** The newest stored message in a thread. Snowflakes are decimal strings of
 *  growing length, so the longest wins and then the largest. */
export function lastMessageId(db: DB, threadId: string): string | null {
  const r = db.prepare(
    'SELECT discord_message_id AS id FROM ticket_messages WHERE thread_id = ? ORDER BY LENGTH(discord_message_id) DESC, discord_message_id DESC LIMIT 1',
  ).get(threadId) as { id: string } | undefined;
  return r?.id ?? null;
}

export function insertAttachment(db: DB, a: NewAttachment): number {
  return Number(db.prepare(
    `INSERT INTO ticket_attachments (message_id, discord_attachment_id, filename, content_type, size, sha256, stored_name, skip_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(a.messageId, a.discordAttachmentId, a.filename.slice(0, 255), a.contentType.slice(0, 100), a.size, a.sha256, a.storedName, a.skipReason).lastInsertRowid);
}

/** The outcome of a retried download. */
export function updateAttachment(
  db: DB, id: number, r: { size: number; sha256: string | null; storedName: string | null; skipReason: SkipReason | null },
): void {
  db.prepare('UPDATE ticket_attachments SET size = ?, sha256 = ?, stored_name = ?, skip_reason = ? WHERE id = ?')
    .run(r.size, r.sha256, r.storedName, r.skipReason, id);
}

export function attachmentsOf(db: DB, messageId: number): AttachmentRow[] {
  return db.prepare('SELECT * FROM ticket_attachments WHERE message_id = ? ORDER BY id').all(messageId) as AttachmentRow[];
}

/** Bytes on disk right now, for one ticket or for all of them. A file that
 *  was not kept, or has been removed, has no stored_name and counts nothing. */
export function storedBytes(db: DB, ticketId?: number): number {
  const sql = `SELECT COALESCE(SUM(a.size), 0) AS n FROM ticket_attachments a JOIN ticket_messages m ON m.id = a.message_id
               WHERE a.stored_name IS NOT NULL`;
  const r = ticketId === undefined
    ? db.prepare(sql).get() as { n: number }
    : db.prepare(`${sql} AND m.ticket_id = ?`).get(ticketId) as { n: number };
  return r.n;
}
