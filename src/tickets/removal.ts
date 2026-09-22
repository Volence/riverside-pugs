import { unlinkSync } from 'node:fs';
import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { attachmentPath } from './attachments.js';
import { messageById } from './messages.js';
import { publishTicketSignal } from './signals.js';
import { addTicketEvent, canSeeTicket, getTicketRow } from './store.js';

export type RemoveResult = { ok: true; files: number } | { ok: false; status: number; error: string };

const fail = (status: number, error: string): RemoveResult => ({ ok: false, status, error });
const MAX_REASON = 200;

/**
 * Unlink every file whose attachment row says it was removed, and forget its
 * name once it is gone. Returns how many could NOT be deleted; those keep
 * their stored_name and are tried again on the next call, which the server
 * makes at every start. A file that is already missing counts as deleted.
 */
export function purgeRemovedFiles(db: DB, dir: string): number {
  const rows = db.prepare('SELECT id, stored_name FROM ticket_attachments WHERE removed_at IS NOT NULL AND stored_name IS NOT NULL')
    .all() as { id: number; stored_name: string }[];
  let left = 0;
  for (const r of rows) {
    const path = attachmentPath(dir, r.stored_name);
    try {
      if (path) unlinkSync(path);
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') {
        console.error('[tickets] a removed attachment could not be deleted from disk:', err instanceof Error ? err.message : err);
        left++;
        continue;
      }
    }
    // Whether the file went or was never there, nothing points at it now, so
    // the serving route can never hand it out again.
    db.prepare('UPDATE ticket_attachments SET stored_name = NULL WHERE id = ?').run(r.id);
  }
  return left;
}

/**
 * Remove a mirrored message for good. It cannot be undone.
 *
 * The caller has already established that `by` is active staff (requireMod
 * on the site, the same check by hand in the Discord command). This adds the
 * per-ticket rule: missing and invisible are the same answer.
 *
 * The database first, in one transaction, so that from the moment it commits
 * the detail shows a tombstone and the serving route answers 404. Then the
 * files. Then the signal, which nudges open pages and wakes the bot's sweep
 * for the Discord half. Nothing here talks to Discord, so nothing here can
 * be slowed or failed by it.
 *
 * What is kept is the tombstone: who wrote it, who removed it, when, the
 * reason if one was given, and for each file its name, size and sha256. The
 * event carries an id and a count, never a word of what was removed.
 */
export function removeMessage(
  db: DB, dir: string, ticketId: number, messageId: number, by: string, reason: unknown, now = new Date(),
): RemoveResult {
  const t = getTicketRow(db, ticketId);
  if (!t || !canSeeTicket(db, t, by)) return fail(404, 'no such ticket');
  const m = messageById(db, messageId);
  // The same 404 for a message of another ticket: the id alone proves nothing.
  if (!m || m.ticket_id !== ticketId) return fail(404, 'no such ticket');
  if (m.removed_at !== null) return fail(409, 'that message was already removed');
  const text = typeof reason === 'string' ? reason.trim().slice(0, MAX_REASON) : '';
  const at = now.toISOString();
  const files = db.transaction(() => {
    db.prepare("UPDATE ticket_messages SET content = '', history = '[]', removed_at = ?, removed_by = ?, removed_reason = ? WHERE id = ?")
      .run(at, by, text, messageId);
    const n = db.prepare('UPDATE ticket_attachments SET removed_at = ? WHERE message_id = ? AND removed_at IS NULL').run(at, messageId).changes;
    addTicketEvent(db, ticketId, by, 'removed', { messageId, files: n }, now);
    return n;
  })();
  if (purgeRemovedFiles(db, dir) > 0) {
    publishAdminEvent({ kind: 'problem', text: 'A file attached to a removed ticket message could not be deleted from disk. It is no longer served and is tried again at the next restart. Check the permissions on the ticket attachments directory.' });
  }
  // The words are out of the table, but until the write-ahead log is folded
  // back into the database file they are still sitting in it. secure_delete
  // (src/db.ts) then overwrites the pages the removal freed, so after this
  // the removed text is nowhere on disk.
  db.pragma('wal_checkpoint(TRUNCATE)');
  publishTicketSignal({ kind: 'ticket', ticketId });
  return { ok: true, files };
}
