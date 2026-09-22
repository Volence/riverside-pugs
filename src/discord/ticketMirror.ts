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
 * No live message from a thread whose history this process has not read to
 * the end is ever stored before that history is: the backfill starts after
 * the highest id stored for the thread, so storing today's message first
 * would move that point past everything written while the bot was down and
 * lose it for good.
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
  /** Discord threads whose history this process has read to the end, and is
   *  therefore up to date with. Added to while a read is in flight as well,
   *  because a read hands every page back through onMessage and that must not
   *  start another one. */
  private caughtUp = new Set<string>();

  constructor(private deps: TicketMirrorDeps) {}

  start(): void {
    this.deps.transport.watchMessages({
      watches: (threadId) => !this.stopped && this.watched(threadId) !== undefined,
      // Both to the same place: either can be the first the bot hears of a
      // message. A create for one already stored is a duplicate delivery, and
      // an update for one that is not is the first sight of it.
      create: (m) => this.enqueue(() => this.onMessage(m)),
      update: (m) => this.enqueue(() => this.onMessage(m)),
      remove: (threadId, messageId) => this.enqueue(() => this.onRemove(threadId, messageId)),
    });
    // A ticket signal is "something about this ticket changed". One of those
    // things is a reopen, after which the thread may hold messages written
    // while it was locked. One REST call per ticket action is cheap, and it
    // keeps this free of knowing WHAT changed.
    this.offs.push(subscribeTicketSignals((s) => {
      if (s.kind === 'ticket') this.enqueue(() => this.backfillTicket(s.ticketId));
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
    // every ticket ever closed. Nothing is lost by leaving them: the first
    // live message from one reads its history before storing itself
    // (onMessage), a ticket signal reads its threads whatever their lock
    // state, and only a deleted post takes its messages with it (catchUp).
    return this.run(() => this.backfillThreads(`WHERE ${READABLE} AND locked = 0`))
      .catch((err) => console.error('[discord] ticket mirror failed:', err));
  }

  /**
   * One thread, caught up now, for a caller that is about to lose it: the
   * reconciler deletes a forum post that must not exist, and what was written
   * in it while the bot was down goes with the post.
   *
   * The one method here that REJECTS when it fails, because its caller is the
   * only one that can say what was lost, and it deletes the post either way.
   * Nothing else on the chain is disturbed by that.
   */
  catchUp(threadId: string): Promise<void> {
    return this.run(async () => {
      const th = this.watched(threadId);
      // Not backfillSafely: the failure has to travel back to the caller.
      if (th) await this.backfillThread(th);
    });
  }

  /** Queue work and wait for it: the promise rejects with whatever the work
   *  threw, and the chain carries on regardless (nothing after it is skipped
   *  and nothing else hears about it). Whoever waits is the one that reports. */
  private run(fn: () => Promise<void>): Promise<void> {
    const link = this.chain.then(fn);
    this.chain = link.catch(() => {});
    return link;
  }

  /** Queue work and forget it: nobody is waiting, so what it throws is logged
   *  here. */
  private enqueue(fn: () => Promise<void>): void {
    void this.run(fn).catch((err) => console.error('[discord] ticket mirror failed:', err));
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
    // Nothing from a thread whose history has not been read to the end can be
    // stored ahead of that history: the next backfill starts after the
    // highest id stored for the thread, so this one would move that point
    // past everything written while the bot was down. The history first, and
    // if Discord refuses it, this message is left where it is, in Discord, for
    // a later backfill to bring in with the rest: late is recoverable, and
    // moving the starting point over a gap is not.
    if (!this.caughtUp.has(m.threadId) && !(await this.backfillSafely(thread))) return;
    const { db } = this.deps;
    const row = insertMessage(db, {
      ticketId: thread.ticket_id, threadId: m.threadId, channel: thread.kind === 'reporter' ? 'reporter' : 'staff',
      discordMessageId: m.id, authorDiscordId: m.authorId,
      // Unknown to the site is fine: the Discord name is kept and the
      // message is never turned away for it.
      authorPlayerId: playerByDiscordId(db, m.authorId)?.steamid ?? null,
      authorName: m.authorName, content: m.content, createdAt: m.createdAt, editedAt: m.editedAt,
    });
    if (!row) {
      await this.applyEdit(thread, m);
      return;
    }
    try {
      for (const a of m.attachments) await this.saveOne(thread.ticket_id, row.id, a);
    } finally {
      // The message is stored whatever became of its files, so the page has
      // something new to show either way.
      this.deps.onChange?.(thread.ticket_id);
    }
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
    try {
      for (const a of m.attachments) {
        if (known.has(a.id)) continue;
        await this.saveOne(thread.ticket_id, row.id, a);
        changed = true;
      }
    } finally {
      if (changed) this.deps.onChange?.(thread.ticket_id);
    }
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
      this.discard(r.storedName);
      throw err;
    }
  }

  /** A file the database does not point at is a file nothing will ever serve,
   *  count or remove, so it goes now rather than sitting on disk for the life
   *  of the box. */
  private discard(storedName: string | null): void {
    const path = storedName ? attachmentPath(this.deps.store.dir, storedName) : null;
    if (path) rmSync(path, { force: true });
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

  /** Whether it worked. Everything but catchUp goes through here: one thread
   *  Discord refuses must not stop the rest of a pass. */
  private async backfillSafely(th: ThreadRow): Promise<boolean> {
    try {
      await this.backfillThread(th);
      return true;
    } catch (err) {
      console.error(`[discord] backfilling ticket thread ${th.thread_id} failed; the next start tries again:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  private async backfillThread(th: ThreadRow): Promise<void> {
    const { db, transport } = this.deps;
    // Marked before the first page rather than after the last, because every
    // page goes back through onMessage, which reads the history of a thread
    // that is not marked. Unmarked again if this throws, so a live message
    // does not go in on top of a gap this never closed.
    this.caughtUp.add(th.thread_id);
    try {
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
    } catch (err) {
      this.caughtUp.delete(th.thread_id);
      throw err;
    }
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
      try {
        updateAttachment(db, f.id, r);
      } catch (err) {
        this.discard(r.storedName);
        throw err;
      }
      changed = true;
    }
    if (changed) this.deps.onChange?.(th.ticket_id);
  }
}
