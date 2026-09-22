import { rmSync } from 'node:fs';
import type { DB } from '../db.js';
import { playerByDiscordId } from '../players.js';
import { subscribeTicketSignals } from '../tickets/signals.js';
import { threadByDiscordId, type ThreadRow } from '../tickets/threads.js';
import {
  attachmentsOf, insertAttachment, insertMessage, lastMessageId, markDeleted, messageByDiscordId, recordEdit, updateAttachment,
} from '../tickets/messages.js';
import { attachmentPath, type AttachmentStore } from '../tickets/attachments.js';
import type { BotTransport, InboundAttachment, InboundMessage } from './transport.js';

export interface TicketMirrorDeps {
  db: DB;
  transport: BotTransport;
  store: AttachmentStore;
  /** "This ticket's page should refetch." Wired to the staff-scoped nudge,
   *  never to hub.broadcast: see src/tickets/nudge.ts. */
  onChange?: (ticketId: number) => void;
}

/** Threads whose history is still worth reading: every state but 'deleted'.
 *  A folded or an ended thread is one the bot retired, and it can still hold
 *  what was written in it before that happened. */
const READABLE = "state != 'deleted'";

/**
 * Copies what people write in ticket threads onto the site.
 *
 * Only threads listed in ticket_threads are read. The transport asks
 * `watches` before it hands anything over, and every handler here looks the
 * thread up again before it reads a field off the message, so neither a bug
 * in the transport nor a stale event can turn somebody's conversation into
 * ticket content.
 *
 * Everything runs on one chain, so a message, its edit and its deletion land
 * in order, and a backfill never interleaves with a live event. Live events
 * are latency; the backfill on every start is what makes the copy complete,
 * because deploys restart the bot often.
 *
 * It only ever READS from Discord, which is why it never unarchives anything:
 * an archived thread refuses every write there is but answers a history read,
 * and unarchiving is a write that would fight the two chains that lock and
 * archive threads on purpose.
 *
 * What a backfill cannot see: an EDIT or a DELETE made while the bot was down
 * to a message that was already stored. Discord has no "changes since" call,
 * so the stored content stays as it was last seen. A message first read after
 * such an edit is stored as it reads now, with no edit noted. Nothing here
 * tries to solve that.
 */
export class TicketMirror {
  private chain: Promise<void> = Promise.resolve();
  private offs: (() => void)[] = [];
  private stopped = false;

  constructor(private deps: TicketMirrorDeps) {}

  start(): void {
    this.deps.transport.watchMessages({
      watches: (threadId) => !this.stopped && this.watched(threadId) !== undefined,
      // Both to the same place: either can be the first the bot hears of a
      // message. A create for one already stored is a duplicate delivery, and
      // an update for one that is not is the first sight of it.
      create: (m) => { void this.enqueue(() => this.onMessage(m)); },
      update: (m) => { void this.enqueue(() => this.onMessage(m)); },
      remove: (threadId, messageId) => { void this.enqueue(() => this.onRemove(threadId, messageId)); },
    });
    // A ticket signal is "something about this ticket changed". One of those
    // things is a reopen, after which the thread may hold messages written
    // while it was locked. One REST call per ticket action is cheap, and it
    // keeps this free of knowing WHAT changed.
    this.offs.push(subscribeTicketSignals((s) => {
      if (s.kind === 'ticket') void this.enqueue(() => this.backfillTicket(s.ticketId));
    }));
    void this.backfill();
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** Resolves once everything asked for so far has been done (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Every thread that can still be written in, caught up. Never throws, and
   *  one thread Discord refuses does not stop the rest. */
  backfill(): Promise<void> {
    // A locked thread is one the bot closed: nothing is expected in it, and
    // reading every one of them on every start would be a REST call each for
    // every ticket ever closed. Somebody who can write in one anyway waits
    // for that ticket's next signal, which reads its threads whatever their
    // lock state, and a reopen is one of those. Nothing is lost by waiting:
    // a locked thread still stands in Discord, and only a deleted post takes
    // its messages with it (see catchUp).
    return this.enqueue(() => this.backfillThreads(`WHERE ${READABLE} AND locked = 0`));
  }

  /**
   * One thread, caught up now, for a caller that is about to lose it: the
   * reconciler deletes a forum post that must not exist, and what was written
   * in it while the bot was down goes with the post.
   *
   * Resolves when the copy is done (or has failed), and never throws.
   */
  catchUp(threadId: string): Promise<void> {
    return this.enqueue(async () => {
      const th = this.watched(threadId);
      if (th) await this.backfillSafely(th);
    });
  }

  /** On the chain, and resolving with it. The chain swallows what a step
   *  throws, so waiting on one of these can never reject. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn).catch((err) => console.error('[discord] ticket mirror failed:', err));
    return this.chain;
  }

  /** The ticket thread with this Discord id, if it is one the bot still
   *  stands behind. A thread the bot deleted is nobody's. */
  private watched(threadId: string): ThreadRow | undefined {
    const th = threadByDiscordId(this.deps.db, threadId);
    return th && th.state !== 'deleted' ? th : undefined;
  }

  /**
   * A message as Discord has it now: stored if this is the first sight of it,
   * applied as an edit if it is already stored.
   *
   * The insert comes first and decides which it is, so a live event and a
   * backfill delivering the same message cannot make two rows, and the second
   * of them downloads nothing.
   */
  private async onMessage(m: InboundMessage): Promise<void> {
    // The thread first. Nothing else about `m` is read before this passes.
    const thread = this.watched(m.threadId);
    if (!thread) return;
    // The timeline already has the events the bot's own lines describe. Both
    // hooks need this: Discord announces the bot's own edits as well as its
    // own sends, and every card refresh is one.
    if (m.authorIsBot) return;
    const { db } = this.deps;
    const row = insertMessage(db, {
      ticketId: thread.ticket_id, threadId: m.threadId, channel: thread.kind === 'reporter' ? 'reporter' : 'staff',
      discordMessageId: m.id, authorDiscordId: m.authorId,
      // Unknown to the site is fine: the Discord name is kept and the
      // message is never turned away for it.
      authorPlayerId: playerByDiscordId(db, m.authorId)?.steamid ?? null,
      authorName: m.authorName, content: m.content, createdAt: m.createdAt,
    });
    if (!row) {
      await this.applyEdit(thread, m);
      return;
    }
    for (const a of m.attachments) await this.saveOne(thread.ticket_id, row.id, a);
    this.deps.onChange?.(thread.ticket_id);
  }

  /** A message that is already stored, as Discord has it now. */
  private async applyEdit(thread: ThreadRow, m: InboundMessage): Promise<void> {
    const { db } = this.deps;
    const row = messageByDiscordId(db, m.id)!;
    // A removed message stays blank whatever Discord says afterwards.
    if (row.removed_at !== null) return;
    let changed = recordEdit(db, row.id, m.content, m.editedAt ?? new Date().toISOString());
    // Files already recorded are never fetched a second time: that is what
    // makes a duplicate delivery cost nothing. One with no row at all was
    // never fetched even once, which is where a bot killed between a message
    // and its files ends up, so it is fetched now. Discord cannot add a file
    // to a message by editing it, so this is that case and no other.
    const known = new Set(attachmentsOf(db, row.id).map((a) => a.discord_attachment_id));
    for (const a of m.attachments) {
      if (known.has(a.id)) continue;
      await this.saveOne(thread.ticket_id, row.id, a);
      changed = true;
    }
    if (changed) this.deps.onChange?.(thread.ticket_id);
  }

  /** A delete in Discord is soft here: the content and the files are kept.
   *  Heard twice (the bot's own delete is announced to the bot, and Task 7's
   *  Remove deletes the Discord message itself) it counts once. */
  private async onRemove(threadId: string, messageId: string): Promise<void> {
    const thread = this.watched(threadId);
    if (!thread) return;
    const before = messageByDiscordId(this.deps.db, messageId);
    if (!before || before.deleted_at !== null) return;
    markDeleted(this.deps.db, messageId);
    this.deps.onChange?.(thread.ticket_id);
  }

  private async saveOne(ticketId: number, messageId: number, a: InboundAttachment): Promise<void> {
    const { db, store } = this.deps;
    const r = await store.save(ticketId, a);
    try {
      insertAttachment(db, {
        messageId, discordAttachmentId: a.id, filename: a.name, contentType: a.contentType ?? '',
        size: r.size, sha256: r.sha256, storedName: r.storedName, skipReason: r.skipReason,
      });
    } catch (err) {
      // The row is the only thing that knows this file is there: with no row
      // nothing will ever serve it, count it or remove it, so it goes now
      // rather than sitting on disk for the life of the box.
      const path = r.storedName ? attachmentPath(store.dir, r.storedName) : null;
      if (path) rmSync(path, { force: true });
      throw err;
    }
  }

  private async backfillTicket(ticketId: number): Promise<void> {
    // Every thread of this ticket, locked or not: the signal may be the
    // reopen that unlocks it, and the row still says locked until the
    // reconciler has told Discord.
    await this.backfillThreads(`WHERE ${READABLE} AND ticket_id = ?`, ticketId);
  }

  private async backfillThreads(where: string, ...params: unknown[]): Promise<void> {
    const threads = this.deps.db.prepare(`SELECT * FROM ticket_threads ${where} ORDER BY id`).all(...params) as ThreadRow[];
    for (const th of threads) await this.backfillSafely(th);
  }

  private async backfillSafely(th: ThreadRow): Promise<void> {
    try {
      await this.backfillThread(th);
    } catch (err) {
      console.error(`[discord] backfilling ticket thread ${th.thread_id} failed; the next start tries again:`, err instanceof Error ? err.message : err);
    }
  }

  private async backfillThread(th: ThreadRow): Promise<void> {
    const { db, transport } = this.deps;
    // After the last STORED id. The bot's own lines are never stored, so any
    // after that point are read again each time and dropped again.
    let after = lastMessageId(db, th.thread_id);
    for (;;) {
      const page = await transport.threads.fetchAfter(th.thread_id, after);
      if (page.length === 0) break;
      for (const m of page) await this.onMessage(m);
      after = page[page.length - 1].id;
    }
    await this.retryFailed(th);
  }

  /** Downloads that failed, tried again. The message is fetched afresh
   *  because its links are signed and the old ones may have expired. */
  private async retryFailed(th: ThreadRow): Promise<void> {
    const { db, transport, store } = this.deps;
    const failed = db.prepare(
      `SELECT a.id, a.discord_attachment_id, m.discord_message_id, m.ticket_id FROM ticket_attachments a
         JOIN ticket_messages m ON m.id = a.message_id
       WHERE m.thread_id = ? AND a.skip_reason = 'fetch_failed' AND a.removed_at IS NULL
         AND m.removed_at IS NULL AND m.deleted_at IS NULL
       ORDER BY a.id`,
    ).all(th.thread_id) as { id: number; discord_attachment_id: string; discord_message_id: string; ticket_id: number }[];
    const fresh = new Map<string, InboundMessage | null>();
    let changed = false;
    for (const f of failed) {
      if (!fresh.has(f.discord_message_id)) fresh.set(f.discord_message_id, await transport.threads.fetchMessage(th.thread_id, f.discord_message_id));
      const a = fresh.get(f.discord_message_id)?.attachments.find((x) => x.id === f.discord_attachment_id);
      if (!a) continue;
      const r = await store.save(f.ticket_id, a);
      if (r.skipReason === 'fetch_failed') continue;
      updateAttachment(db, f.id, r);
      changed = true;
    }
    if (changed) this.deps.onChange?.(th.ticket_id);
  }
}
