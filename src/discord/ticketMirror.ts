import { rmSync } from 'node:fs';
import type { DB } from '../db.js';
import { playerByDiscordId } from '../players.js';
import { subscribeTicketSignals } from '../tickets/signals.js';
import { threadByDiscordId, type ThreadRow } from '../tickets/threads.js';
import {
  attachmentsOf, insertAttachment, insertMessage, lastMessageId, markDeleted, messageByDiscordId, messageById, recordEdit,
  updateAttachment,
} from '../tickets/messages.js';
import { attachmentPath, type AttachmentStore } from '../tickets/attachments.js';
import { purgeRemovedFiles } from '../tickets/removal.js';
import type { BotTransport, InboundAttachment, InboundMessage } from './transport.js';

export interface TicketMirrorDeps {
  db: DB;
  transport: BotTransport;
  store: AttachmentStore;
  /** "This ticket's page should refetch." Wired to the staff-scoped nudge,
   *  never to hub.broadcast: see src/tickets/nudge.ts. */
  onChange?: (ticketId: number) => void;
  /** Run something on the reconciler's chain: TicketSync.serialise. The one
   *  thing here that writes to Discord is a removal's delete, and both it and
   *  a reconcile pass unarchive a thread, act in it and archive it again.
   *  Left out (tests, and before the reconciler exists) the work simply runs. */
  serialise?: (fn: () => Promise<void>) => Promise<void>;
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
 * All the copying runs on one chain, so a message, its edit and its deletion
 * land in order, and a backfill never interleaves with a live event. Live
 * events are latency; the backfill on every start is what makes the copy
 * complete, because deploys restart the bot often.
 *
 * No live message from a thread whose history this process has not read to
 * the end is ever stored before that history is: the backfill starts after
 * the highest id stored for the thread, so storing today's message first
 * would move that point past everything written while the bot was down and
 * lose it for good.
 *
 * Copying only ever READS from Discord, which is why it never unarchives
 * anything: an archived thread refuses every write there is but answers a
 * history read, and unarchiving is a write that would fight the chain that
 * locks and archives threads on purpose. The one thing here that does write
 * is a removal's delete, and it goes on THAT chain rather than this one
 * (deps.serialise): see sweepRemovals.
 *
 * What a backfill cannot see: an EDIT or a DELETE made while the bot was down
 * to a message that was already stored. Discord has no "changes since" call,
 * so the stored content stays as it was last seen. A message first read after
 * such an edit is stored as it reads now, with no edit noted. Nothing here
 * tries to solve that.
 */
export class TicketMirror {
  private chain: Promise<void> = Promise.resolve();
  /**
   * The Discord half of removals, on a chain of its own.
   *
   * It waits on the reconciler's chain (deps.serialise), and the chain above
   * must never do that: the reconciler waits on the mirror (catchUp), so
   * waiting back would deadlock the pair.
   */
  private removals: Promise<void> = Promise.resolve();
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
    // A removal that committed while the bot was down still owes Discord a
    // deletion. Nothing else finishes it, so every start does.
    void this.sweepRemovals();
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** Resolves once everything asked for so far has been done (tests). */
  idle(): Promise<void> {
    return Promise.all([this.chain, this.removals]).then(() => undefined);
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

  /**
   * The Discord half of every removal that still owes one: removed on the
   * site, its Discord copy not yet known gone. Queued behind any removal
   * already in flight, and resolves when it has run. Called on every start,
   * by the site after a removal, and by the Discord command.
   *
   * Never rejects: a removal is finished on the site whatever Discord says,
   * and what is still owed is owed in the database, for the next start.
   */
  sweepRemovals(): Promise<void> {
    this.removals = this.removals.then(() => this.sweepOwed())
      .catch((err) => console.error('[discord] sweeping removed ticket messages failed:', err));
    return this.removals;
  }

  private async sweepOwed(): Promise<void> {
    const { db } = this.deps;
    const owed = db.prepare('SELECT id, thread_id, discord_message_id FROM ticket_messages WHERE removed_at IS NOT NULL AND discord_gone = 0 ORDER BY id')
      .all() as { id: number; thread_id: string; discord_message_id: string }[];
    for (const m of owed) {
      try {
        await this.removeInDiscord(m.thread_id, m.discord_message_id);
        db.prepare('UPDATE ticket_messages SET discord_gone = 1 WHERE id = ?').run(m.id);
      } catch (err) {
        console.error('[discord] could not delete a removed ticket message; the next start tries again:', err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Delete one message in Discord, on the reconciler's chain so that it
   * cannot interleave with a pass working on the same thread.
   *
   * It rejects when, and only when, the message is still there: the delete
   * itself failed, or the thread could not be opened to do it in. The thread
   * or the message already being gone is not a failure, and neither is
   * failing to archive the thread again afterwards, because by then the
   * message is irreversibly gone and what is left is untidy rather than
   * wrong. Whoever waits on this decides whether a deletion happened, so
   * that distinction is the whole contract.
   */
  removeInDiscord(threadId: string, discordMessageId: string): Promise<void> {
    const serialise = this.deps.serialise ?? ((fn: () => Promise<void>) => fn());
    return serialise(() => this.deleteOne(threadId, discordMessageId));
  }

  private async deleteOne(threadId: string, discordMessageId: string): Promise<void> {
    const { db, transport } = this.deps;
    if (!(await transport.threads.exists(threadId))) return;
    // TicketSync.makeWritable, for the same reason: an archived thread
    // refuses a delete, and Discord archives a quiet one with nothing in the
    // database to say it did.
    if (await transport.threads.isArchived(threadId)) await transport.threads.setArchived(threadId, false);
    try {
      await transport.remove(threadId, discordMessageId);
    } finally {
      // In a finally, as the reconciler does it: a closed ticket's thread must
      // not be left open because the delete failed. The row says what it goes
      // back to; it was never unlocked, so only the archiving is undone.
      //
      // Swallowed on purpose. The message is already gone by here, and a
      // thread left unarchived is repaired by the reconciler's next pass
      // (syncLock locks and archives a closed ticket's thread). Letting this
      // out would report an irreversible deletion as one that never happened.
      try {
        if (threadByDiscordId(db, threadId)?.locked === 1) await transport.threads.setArchived(threadId, true);
      } catch (err) {
        console.error('[discord] could not archive a ticket thread again after deleting a message in it; the next reconcile pass puts it back:', err instanceof Error ? err.message : err);
      }
    }
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
   *  Heard twice (the bot's own delete is announced to the bot) it counts
   *  once, and for a REMOVED message it counts not at all: the delete it is
   *  hearing about is its own, and a removal is past being deleted. */
  private async onRemove(threadId: string, messageId: string): Promise<void> {
    const thread = this.watched(threadId);
    if (!thread) return;
    const before = messageByDiscordId(this.deps.db, messageId);
    if (!before || before.deleted_at !== null || before.removed_at !== null) return;
    markDeleted(this.deps.db, messageId);
    this.deps.onChange?.(thread.ticket_id);
  }

  private async saveOne(ticketId: number, messageId: number, a: InboundAttachment): Promise<void> {
    const { db, store } = this.deps;
    const r = await store.save(ticketId, a);
    let id: number;
    try {
      id = insertAttachment(db, {
        messageId, discordAttachmentId: a.id, filename: a.name, contentType: a.contentType ?? '',
        size: r.size, sha256: r.sha256, storedName: r.storedName, skipReason: r.skipReason,
      });
    } catch (err) {
      this.discard(r.storedName);
      throw err;
    }
    this.removedMeanwhile(messageId, id);
  }

  /**
   * A big file can still be arriving when its message is removed. The removal
   * marked the rows it could see, and this one was not there yet, so it is
   * marked now and its bytes go the way of the rest. The row stays, as every
   * removed file's row does: its name, size and sha256 are the record that
   * something was there.
   *
   * Whether that happened, for a caller deciding whether the page has
   * anything new to show.
   */
  private removedMeanwhile(messageId: number, attachmentId: number): boolean {
    const { db, store } = this.deps;
    const m = messageById(db, messageId);
    if (!m || m.removed_at === null) return false;
    db.prepare('UPDATE ticket_attachments SET removed_at = ? WHERE id = ?').run(m.removed_at, attachmentId);
    purgeRemovedFiles(db, store.dir);
    return true;
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
      `SELECT a.id, a.message_id, a.discord_attachment_id, m.discord_message_id, m.ticket_id FROM ticket_attachments a
         JOIN ticket_messages m ON m.id = a.message_id
       WHERE m.thread_id = ? AND a.skip_reason = 'fetch_failed' AND a.removed_at IS NULL
         AND m.removed_at IS NULL AND m.deleted_at IS NULL
       ORDER BY a.id`,
    ).all(th.thread_id) as { id: number; message_id: number; discord_attachment_id: string; discord_message_id: string; ticket_id: number }[];
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
      // Removed while this retry was in flight: nothing new to show.
      if (!this.removedMeanwhile(f.message_id, f.id)) changed = true;
    }
    if (changed) this.deps.onChange?.(th.ticket_id);
  }
}
