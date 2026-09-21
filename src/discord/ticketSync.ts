import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { getSetting } from '../settings.js';
import { subscribeTicketSignals } from '../tickets/signals.js';
import { getTicketRow, hasStaffFlag, type TicketRow } from '../tickets/store.js';
import {
  insertThread, setThreadCard, setThreadLocked, setThreadState, staffThread, type ThreadRow, type ThreadSurface,
} from '../tickets/threads.js';
import { reportLine, ticketCard } from './ticketCard.js';
import type { BotTransport } from './transport.js';

/** The spec's figure: "A reconciler on bot ready and every five minutes". */
const RECONCILE_MS = 5 * 60_000;

export interface TicketSyncDeps {
  db: DB;
  transport: BotTransport;
  publicUrl: string;
  /** Milliseconds between full passes. 0 means no timer (tests). */
  intervalMs?: number;
}

/**
 * Keeps Discord in step with the tickets table.
 *
 * It is never told WHAT to do, only where to look: "ticket 12 changed". It
 * then reads the database and makes Discord match, which is what makes it
 * safe to call again, from a signal, from the timer, or after a restart. The
 * website never calls into it and never waits for it; a signal is published
 * after the commit and the work happens here, one ticket at a time, on a
 * chain of promises so Discord sees things in order (as AdminFeedPoster does).
 *
 * Signals are latency. The timer is correctness: whatever was missed while
 * the bot was down, or failed because Discord was, is made on the next pass.
 */
export class TicketSync {
  private chain: Promise<void> = Promise.resolve();
  private offs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Problems already told to the admin feed by this process. A permissions
   *  fault would otherwise post the same line every five minutes. */
  private reported = new Set<string>();

  constructor(private deps: TicketSyncDeps) {}

  start(): void {
    this.offs.push(subscribeTicketSignals((s) => {
      this.enqueue(() => (s.kind === 'ticket' ? this.one(s.ticketId) : this.reconcile()));
    }));
    const every = this.deps.intervalMs ?? RECONCILE_MS;
    if (every > 0) {
      this.timer = setInterval(() => this.enqueue(() => this.reconcile()), every);
      this.timer.unref();
    }
    // "On bot ready": this is constructed once the transport is connected.
    this.enqueue(() => this.reconcile());
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves once everything asked for so far has been done (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((err) => console.error('[discord] ticket sync failed:', err));
  }

  private problem(text: string): void {
    if (this.reported.has(text)) return;
    this.reported.add(text);
    publishAdminEvent({ kind: 'problem', text });
  }

  /** One ticket, never throwing, so one broken ticket cannot starve the rest.
   *  The line for the admin feed names no ticket and no player: the ticket
   *  may be restricted, and every admin reads the feed. */
  private async one(id: number): Promise<void> {
    try {
      await this.reconcileTicket(id);
    } catch (err) {
      console.error(`[discord] syncing ticket ${id} failed:`, err);
      this.problem(`Could not update a ticket's Discord thread: ${err instanceof Error ? err.message : String(err)}. It is tried again every few minutes. If it keeps failing, check the bot's permissions on the tickets forum and the tickets channel.`);
    }
  }

  /** A full pass: every open ticket, and every closed one whose thread the
   *  bot has not locked yet. A closed and locked ticket costs nothing. */
  async reconcile(): Promise<void> {
    const ids = (this.deps.db.prepare(
      `SELECT id FROM tickets WHERE status = 'open'
       UNION
       SELECT th.ticket_id FROM ticket_threads th JOIN tickets t ON t.id = th.ticket_id
        WHERE th.kind = 'staff' AND th.state = 'open' AND th.locked = 0 AND t.status = 'closed'
       ORDER BY 1`,
    ).all() as { id: number }[]).map((r) => r.id);
    for (const id of ids) await this.one(id);
  }

  /** Where this ticket's staff thread belongs, or null for nowhere. */
  private surfaceFor(t: TicketRow): ThreadSurface | null {
    const { db } = this.deps;
    // Task 5 gives a restricted ticket its private thread.
    if (t.restricted === 1) return null;
    // A normal ticket about staff has no Discord thread at all: the forum is
    // readable by the accused, and with no access list there is nobody to put
    // in a private one. It is worked on the site.
    if (hasStaffFlag(db, t.target_id)) return null;
    return (getSetting(db, 'discord_tickets_forum_id') ?? '') ? 'forum' : null;
  }

  async reconcileTicket(id: number): Promise<void> {
    const { db, transport } = this.deps;
    const t = getTicketRow(db, id);
    if (!t) return;
    const surface = this.surfaceFor(t);
    let thread = staffThread(db, id);
    if (thread && !(await transport.threads.exists(thread.thread_id))) {
      // Deleted by hand in Discord. Remember that, and make another.
      setThreadState(db, thread.id, 'deleted');
      thread = undefined;
    }
    if (!thread && t.status === 'open' && surface) thread = await this.createThread(t, surface);
    if (!thread) return;
    // A reopened ticket is unarchived BEFORE anything is written into it:
    // Discord refuses a send or an edit in an archived thread.
    if (t.status === 'open') await this.syncLock(t, thread);
    if (thread.locked === 0) {
      await this.announceReports(t, thread);
      await this.refreshCard(t, thread);
    }
    // A closed ticket is locked AFTER its card said so, for the same reason.
    await this.syncLock(t, thread);
  }

  private async createThread(t: TicketRow, surface: ThreadSurface): Promise<ThreadRow> {
    const { db, transport, publicUrl } = this.deps;
    const card = ticketCard(db, t.id, publicUrl)!;
    const forumId = getSetting(db, 'discord_tickets_forum_id') ?? '';
    const made = await transport.threads.createForumPost(forumId, { name: card.name, message: card.payload, tags: card.tags });
    const row = insertThread(db, {
      ticketId: t.id, kind: 'staff', surface, channelId: forumId, threadId: made.threadId,
      cardMessageId: made.messageId, cardHash: card.hash,
    });
    // The card counts every report there is, so none of them needs a line.
    db.prepare('UPDATE ticket_reports SET announced_at = ? WHERE ticket_id = ? AND announced_at IS NULL')
      .run(new Date().toISOString(), t.id);
    return row;
  }

  /** One line per report the thread has not heard about, oldest first. Marked
   *  after the send, so a failed send is retried on the next pass. */
  private async announceReports(t: TicketRow, thread: ThreadRow): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const rows = db.prepare('SELECT id FROM ticket_reports WHERE ticket_id = ? AND announced_at IS NULL ORDER BY id').all(t.id) as { id: number }[];
    for (const r of rows) {
      await transport.send(thread.thread_id, reportLine(db, r.id, publicUrl));
      db.prepare('UPDATE ticket_reports SET announced_at = ? WHERE id = ?').run(new Date().toISOString(), r.id);
    }
  }

  private async refreshCard(t: TicketRow, thread: ThreadRow): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const card = ticketCard(db, t.id, publicUrl);
    if (!card || card.hash === thread.card_hash) return;
    let messageId = thread.card_message_id;
    const edited = messageId ? await transport.edit(thread.thread_id, messageId, card.payload) : false;
    // False means the card is gone (deleted by hand): say it again.
    if (!edited) messageId = await transport.send(thread.thread_id, card.payload);
    if (thread.surface === 'forum') await transport.threads.setTags(thread.thread_id, card.tags);
    // Only now. Everything above throws on failure, and a hash stored ahead
    // of a failed edit would make this method return early for ever after.
    setThreadCard(db, thread.id, messageId!, card.hash);
    thread.card_message_id = messageId;
    thread.card_hash = card.hash;
  }

  /** Closed means locked and archived; open means neither. `locked` on the
   *  row is what the bot last did, so this is a no-op on almost every pass. */
  private async syncLock(t: TicketRow, thread: ThreadRow): Promise<void> {
    const { db, transport } = this.deps;
    const want = t.status === 'closed';
    if ((thread.locked === 1) === want) return;
    if (want) {
      await transport.threads.setLocked(thread.thread_id, true);
      await transport.threads.setArchived(thread.thread_id, true);
    } else {
      await transport.threads.setArchived(thread.thread_id, false);
      await transport.threads.setLocked(thread.thread_id, false);
    }
    setThreadLocked(db, thread.id, want);
    thread.locked = want ? 1 : 0;
  }
}
