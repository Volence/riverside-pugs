import { createHash } from 'node:crypto';
import type { DB } from '../db.js';
import type { MessageRow } from '../tickets/messages.js';
import { messageById } from '../tickets/messages.js';
import { getTicketRow, type TicketRow } from '../tickets/store.js';
import type { ThreadRow } from '../tickets/threads.js';
import { escapeName } from './presenter.js';
import type { BotTransport, MessagePayload } from './transport.js';

export interface RelayDeps { db: DB; transport: BotTransport; publicUrl: string }

const hashOf = (p: MessagePayload) => createHash('sha1').update(JSON.stringify(p)).digest('hex');

/**
 * The copy of one reporter message on the forum post. Headed with the name
 * Discord showed for them. Their words verbatim, with no mention able to
 * ping anyone (mentionUserIds is empty, which the transport enforces). A
 * file is never re-uploaded and never linked where Discord keeps it: those
 * links expire, and on the site a reporter's file is click-to-reveal.
 */
export function relayPayload(m: Pick<MessageRow, 'author_name' | 'content'>, files: number, ticketId: number, publicUrl: string): MessagePayload {
  const lines: string[] = [];
  if (m.content) lines.push(m.content.slice(0, 3800));
  if (files > 0) {
    lines.push(`${files} file${files === 1 ? '' : 's'} attached. [Open the ticket on the site](${publicUrl}/admin/people/tickets/${ticketId}) to see ${files === 1 ? 'it' : 'them'}.`);
  }
  return {
    embeds: [{ title: `From the reporter, ${escapeName(m.author_name)}`.slice(0, 256), description: lines.join('\n\n') || '(no text)' }],
    components: [],
    mentionUserIds: [],
  };
}

/**
 * Every message a reporter wrote in a chat on this ticket, copied onto the
 * forum post, or its copy edited to match. Never on a restricted ticket (it
 * has no post), never staff's own replies (they wrote them in the chat), and
 * never a removed or deleted message: the mirror's removal sweep deletes
 * those copies. Runs inside the reconciler's pass, on the unlocked post.
 */
export async function syncRelay(d: RelayDeps, t: TicketRow, post: ThreadRow): Promise<void> {
  const { db, transport, publicUrl } = d;
  // `t` was captured near the start of the reconciler's long async pass for
  // this ticket; a moderator can restrict it while that pass is still on its
  // way here. Read fresh rather than trust the stale flag, so nothing ever
  // relays a reporter's words once a restrict has landed.
  const fresh = getTicketRow(db, t.id);
  if (!fresh || fresh.restricted === 1 || post.surface !== 'forum') return;
  const rows = db.prepare(
    `SELECT m.*, (SELECT COUNT(*) FROM ticket_attachments a WHERE a.message_id = m.id) AS files,
            rm.relay_message_id, rm.relay_thread_id, rm.hash AS relay_hash
     FROM ticket_messages m
       JOIN ticket_threads th ON th.thread_id = m.thread_id AND th.kind = 'reporter'
       LEFT JOIN relay_messages rm ON rm.source_message_id = m.discord_message_id
     WHERE m.ticket_id = ? AND m.removed_at IS NULL AND m.deleted_at IS NULL
       AND ((th.reporter_discord_id IS NOT NULL AND m.author_discord_id = th.reporter_discord_id)
         OR (th.reporter_id IS NOT NULL AND m.author_player_id = th.reporter_id))
     ORDER BY m.created_at, m.id`,
  ).all(t.id) as (MessageRow & { files: number; relay_message_id: string | null; relay_thread_id: string | null; relay_hash: string | null })[];
  const upsert = db.prepare(
    `INSERT INTO relay_messages (source_message_id, relay_message_id, relay_thread_id, hash) VALUES (?, ?, ?, ?)
     ON CONFLICT(source_message_id) DO UPDATE SET relay_message_id = excluded.relay_message_id,
       relay_thread_id = excluded.relay_thread_id, hash = excluded.hash`,
  );
  for (const m of rows) {
    const payload = relayPayload(m, m.files, t.id, publicUrl);
    const hash = hashOf(payload);
    if (m.relay_thread_id === post.thread_id && m.relay_message_id !== null) {
      if (m.relay_hash === hash) continue;
      if (await transport.edit(post.thread_id, m.relay_message_id, payload)) {
        db.prepare('UPDATE relay_messages SET hash = ? WHERE source_message_id = ?').run(hash, m.discord_message_id);
        continue;
      }
      // False: the copy was deleted by hand. Sent again below.
    }
    // A row for another thread is a copy on a post that has since gone (a
    // reopen made a new one): this post gets its own.
    const copyId = await transport.send(post.thread_id, payload);
    upsert.run(m.discord_message_id, copyId, post.thread_id, hash);
    // Removed while the copy was on its way: take it back now rather than
    // leave it for the next sweep.
    const now = messageById(db, m.id);
    if (now && (now.removed_at !== null || now.deleted_at !== null)) {
      await transport.remove(post.thread_id, copyId);
      db.prepare('DELETE FROM relay_messages WHERE source_message_id = ?').run(m.discord_message_id);
    }
  }
}
