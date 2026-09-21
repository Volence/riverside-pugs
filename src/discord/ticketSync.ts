import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { getSetting } from '../settings.js';
import { subscribeBanChanges } from '../banEvents.js';
import { subscribeTicketSignals } from '../tickets/signals.js';
import { getTicketRow, hasStaffFlag, type TicketRow } from '../tickets/store.js';
import {
  forbiddenForumThreads, forumAudience, insertThread, setThreadCard, setThreadLocked, setThreadState, staffThread,
  surfaceFor, threadsInState, type ThreadRow, type ThreadSurface,
} from '../tickets/threads.js';
import { accessDm, reportLine, ticketCard } from './ticketCard.js';
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
    // A banned moderator stops being active staff at once, not in five minutes.
    this.offs.push(subscribeBanChanges(() => this.enqueue(() => this.step(() => this.syncAccess()))));
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

  /**
   * A full pass. The order is the point:
   *   0. eject the accused from their own private thread if a merge left
   *      them a member, whatever that thread's lock state;
   *   1. delete forum posts that must not exist, BEFORE anything can widen
   *      who reads the forum;
   *   2. retire threads left behind by a fold;
   *   3. every open ticket, and every closed one not yet locked;
   *   4. last, sync the forum's access list, so a post that step 1 or the
   *      per-ticket pass failed to delete still keeps its subject out.
   */
  async reconcile(): Promise<void> {
    await this.step(() => this.ejectAccused());
    await this.step(() => this.removeForbiddenPosts());
    await this.step(() => this.retireFolded());
    const ids = (this.deps.db.prepare(
      `SELECT id FROM tickets WHERE status = 'open'
       UNION
       SELECT th.ticket_id FROM ticket_threads th JOIN tickets t ON t.id = th.ticket_id
        WHERE th.kind = 'staff' AND th.state = 'open' AND th.locked = 0 AND t.status = 'closed'
       ORDER BY 1`,
    ).all() as { id: number }[]).map((r) => r.id);
    for (const id of ids) await this.one(id);
    // Last, on purpose: by now every post that must not exist is gone, or
    // forumAudience is still leaving its subject out.
    await this.step(() => this.syncAccess());
  }

  /** One stage of a pass, never throwing, so a failure in it cannot stop the
   *  stages after it. */
  private async step(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      console.error('[discord] ticket sync step failed:', err);
      this.problem(`Could not tidy the ticket threads in Discord: ${err instanceof Error ? err.message : String(err)}. It is tried again every few minutes.`);
    }
  }

  async reconcileTicket(id: number): Promise<void> {
    const { db, transport } = this.deps;
    const t = getTicketRow(db, id);
    if (!t) return;
    await this.ejectAccused(id);
    await this.removeForbiddenPosts(id);
    await this.retireFolded(id);
    await this.notifyAccess(t);
    const { surface } = surfaceFor(db, t);
    let thread = staffThread(db, id);
    if (thread && !(await transport.threads.exists(thread.thread_id))) {
      // Deleted by hand in Discord. Remember that, and make another.
      setThreadState(db, thread.id, 'deleted');
      thread = undefined;
    }
    // Only a private thread can be on the wrong surface here: a forum thread
    // on a restricted ticket was deleted above. The restriction was lifted,
    // so the thread's members are no longer the audience. `surface &&`: a
    // null surface means a channel id was blanked in Settings, and a blanked
    // setting ends nothing. The thread that exists is simply kept up.
    if (thread && surface && thread.surface !== surface) {
      await this.endThread(thread, 'This ticket is no longer restricted. Its discussion continues in the staff forum.');
      thread = undefined;
    }
    if (!thread && t.status === 'open' && surface) thread = await this.createThread(t, surface);
    if (!thread) return;
    // A reopened ticket is unarchived BEFORE anything is written into it:
    // Discord refuses a send or an edit in an archived thread.
    if (t.status === 'open') await this.syncLock(t, thread);
    if (thread.locked === 0) {
      // Members before the card, so the card arrives as a new message for
      // the people it is meant for.
      if (thread.surface === 'private') await this.syncMembers(t, thread);
      await this.announceReports(t, thread);
      await this.refreshCard(t, thread);
    }
    // A closed ticket is locked AFTER its card said so, for the same reason.
    await this.syncLock(t, thread);
  }

  private async createThread(t: TicketRow, surface: ThreadSurface): Promise<ThreadRow> {
    const { db, transport, publicUrl } = this.deps;
    const card = ticketCard(db, t.id, publicUrl)!;
    let row: ThreadRow;
    if (surface === 'forum') {
      const forumId = getSetting(db, 'discord_tickets_forum_id') ?? '';
      const made = await transport.threads.createForumPost(forumId, { name: card.name, message: card.payload, tags: card.tags });
      row = insertThread(db, {
        ticketId: t.id, kind: 'staff', surface, channelId: forumId, threadId: made.threadId,
        cardMessageId: made.messageId, cardHash: card.hash,
      });
    } else {
      const channelId = getSetting(db, 'discord_tickets_channel_id') ?? '';
      const made = await transport.threads.createPrivateThread(channelId, { name: card.name });
      // The row goes in with no card: refreshCard sends it, after the members
      // are in. If that send fails, the next pass finds this row and sends
      // the card then, instead of making a second thread.
      row = insertThread(db, { ticketId: t.id, kind: 'staff', surface, channelId, threadId: made.threadId });
    }
    // The card counts every report there is, so none of them needs a line.
    db.prepare('UPDATE ticket_reports SET announced_at = ? WHERE ticket_id = ? AND announced_at IS NULL')
      .run(new Date().toISOString(), t.id);
    return row;
  }

  /**
   * A merge can repoint a restricted ticket's target_id onto someone who was
   * already a member of its private thread (an admin merged into the person
   * they were investigating), and the database's own tidy-up only drops
   * that person's now-self-referential ticket_access row: nothing else
   * touches Discord for a thread the ticket's own closedness has already
   * locked and archived, since syncMembers only ever runs on an unlocked
   * one. So this runs first and unconditionally, whatever the lock state,
   * and puts a locked thread back exactly as it found it. Bounded to
   * hasStaffFlag targets: only staff can ever have been on an access list,
   * so only they can end up the accused this way.
   */
  private async ejectAccused(ticketId?: number): Promise<void> {
    const { db, transport } = this.deps;
    const rows = (ticketId === undefined
      ? db.prepare(
        `SELECT th.*, t.target_id AS accused FROM ticket_threads th JOIN tickets t ON t.id = th.ticket_id
         WHERE th.kind = 'staff' AND th.surface = 'private' AND th.state != 'deleted'`,
      ).all()
      : db.prepare(
        `SELECT th.*, t.target_id AS accused FROM ticket_threads th JOIN tickets t ON t.id = th.ticket_id
         WHERE th.kind = 'staff' AND th.surface = 'private' AND th.state != 'deleted' AND th.ticket_id = ?`,
      ).all(ticketId)) as (ThreadRow & { accused: string })[];
    for (const th of rows) {
      if (!hasStaffFlag(db, th.accused)) continue;
      const p = db.prepare('SELECT discord_id FROM players WHERE steamid = ?').get(th.accused) as { discord_id: string | null } | undefined;
      if (!p?.discord_id) continue;
      if (!(await transport.threads.exists(th.thread_id))) continue;
      const members = await transport.threads.memberIds(th.thread_id);
      if (!members || !members.includes(p.discord_id)) continue;
      const wasLocked = th.locked === 1;
      // Unarchive first: an archived thread refuses removeMember too.
      if (wasLocked) await transport.threads.setArchived(th.thread_id, false);
      await transport.threads.removeMember(th.thread_id, p.discord_id);
      if (wasLocked) {
        await transport.threads.setLocked(th.thread_id, true);
        await transport.threads.setArchived(th.thread_id, true);
      }
    }
  }

  /** Rule 2. Marked 'deleted' only after Discord deleted it, so a failure is
   *  retried, and Task 6 keeps the accused out of the forum until it works. */
  private async removeForbiddenPosts(ticketId?: number): Promise<void> {
    const { db, transport } = this.deps;
    for (const th of forbiddenForumThreads(db, ticketId)) {
      await transport.threads.deleteThread(th.thread_id);
      setThreadState(db, th.id, 'deleted');
    }
  }

  /** Rule 3. foldTicket marked these; say where the other discussion was,
   *  then lock and archive it. Each is its own try/catch: one thread Discord
   *  refuses must not strand the rest of the pass, and is simply found
   *  'folded' again on the next one. */
  private async retireFolded(ticketId?: number): Promise<void> {
    const { db, transport } = this.deps;
    for (const th of threadsInState(db, 'folded', ticketId)) {
      try {
        const survivor = staffThread(db, th.ticket_id);
        if (survivor && (await transport.threads.exists(survivor.thread_id))) {
          // Unarchive first: Discord may have auto-archived the survivor
          // after a quiet week, whether or not its own ticket is closed.
          await transport.threads.setArchived(survivor.thread_id, false);
          await transport.send(survivor.thread_id, {
            embeds: [{ description: `Another ticket about this player was folded into this one. Its discussion was in <#${th.thread_id}>, which is now locked.` }],
            components: [], mentionUserIds: [],
          });
          // Put back whatever the survivor's own thread should be: a closed
          // ticket's thread stays locked and archived.
          if (survivor.locked === 1) {
            await transport.threads.setLocked(survivor.thread_id, true);
            await transport.threads.setArchived(survivor.thread_id, true);
          }
        }
        await this.endThread(th, null);
      } catch (err) {
        console.error('[discord] retiring a folded ticket thread failed:', err);
        this.problem(`Could not tidy a folded ticket's Discord thread: ${err instanceof Error ? err.message : String(err)}. It is tried again every few minutes.`);
      }
    }
  }

  /** Lock and archive a thread that is no longer the ticket's, saying why
   *  first when there is something to say. */
  private async endThread(th: ThreadRow, farewell: string | null): Promise<void> {
    const { db, transport } = this.deps;
    if (await transport.threads.exists(th.thread_id)) {
      // Unarchive first: Discord may have auto-archived it after a quiet
      // week, and an archived thread takes no message and no lock.
      await transport.threads.setArchived(th.thread_id, false);
      if (farewell) await transport.send(th.thread_id, { embeds: [{ description: farewell }], components: [], mentionUserIds: [] });
      await transport.threads.setLocked(th.thread_id, true);
      await transport.threads.setArchived(th.thread_id, true);
    }
    setThreadState(db, th.id, 'ended');
    setThreadLocked(db, th.id, true);
  }

  /** Rule 1: the thread's members are the access list, no more and no fewer.
   *  Someone on the list with no Discord linked simply is not in the thread;
   *  the next pass after they link adds them. */
  private async syncMembers(t: TicketRow, thread: ThreadRow): Promise<void> {
    const { db, transport } = this.deps;
    const have = await transport.threads.memberIds(thread.thread_id);
    if (have === null) return;
    const want = (db.prepare(
      `SELECT p.discord_id FROM ticket_access a JOIN players p ON p.steamid = a.steamid
       WHERE a.ticket_id = ? AND p.discord_id IS NOT NULL`,
    ).all(t.id) as { discord_id: string }[]).map((r) => r.discord_id);
    for (const id of want) {
      if (have.includes(id)) continue;
      try {
        await transport.threads.addMember(thread.thread_id, id);
      } catch (err) {
        // Ordinary: they have left the server. They still have the site.
        console.warn('[discord] could not add someone to a restricted ticket thread:', err instanceof Error ? err.message : err);
      }
    }
    for (const id of have) {
      if (want.includes(id)) continue;
      try {
        await transport.threads.removeMember(thread.thread_id, id);
      } catch (err) {
        // Ordinary: they, or the bot, have left the server. Retried next pass.
        console.warn('[discord] could not remove someone from a restricted ticket thread:', err instanceof Error ? err.message : err);
      }
    }
  }

  /** One DM per person per ticket, with the site link. Charged before the
   *  send, as signonDropNotify charges its hour: a DM Discord refuses (closed
   *  DMs, left the server) is dropped silently and never tried again. Sent
   *  whether or not a tickets channel is set: the link is to the site. */
  private async notifyAccess(t: TicketRow): Promise<void> {
    if (t.restricted !== 1 || t.status !== 'open') return;
    const { db, transport, publicUrl } = this.deps;
    const rows = db.prepare(
      `SELECT a.steamid, p.discord_id FROM ticket_access a JOIN players p ON p.steamid = a.steamid
       WHERE a.ticket_id = ? AND a.notified_at IS NULL AND p.discord_id IS NOT NULL`,
    ).all(t.id) as { steamid: string; discord_id: string }[];
    for (const r of rows) {
      db.prepare('UPDATE ticket_access SET notified_at = ? WHERE ticket_id = ? AND steamid = ?')
        .run(new Date().toISOString(), t.id, r.steamid);
      try {
        await transport.dm(r.discord_id, accessDm(t.id, publicUrl));
      } catch { /* refused: dropped, like every other DM this bot sends */ }
    }
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

  /** The forum's member overwrites are exactly forumAudience. */
  private async syncAccess(): Promise<void> {
    const { db, transport } = this.deps;
    const forumId = getSetting(db, 'discord_tickets_forum_id') ?? '';
    if (!forumId) return;
    const r = await transport.threads.syncMemberAccess(forumId, forumAudience(db));
    if (r.added.length || r.removed.length || r.failed.length) {
      console.log(`[discord] tickets forum access: +${r.added.length} -${r.removed.length}, ${r.failed.length} not in the server`);
    }
  }
}
