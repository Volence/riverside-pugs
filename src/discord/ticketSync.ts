import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { getSetting } from '../settings.js';
import { subscribeBanChanges } from '../banEvents.js';
import { subscribeTicketSignals } from '../tickets/signals.js';
import { getTicketRow, type TicketRow } from '../tickets/store.js';
import {
  forbiddenForumThreads, forumAudience, insertThread, privateThreadAudience, setThreadCard, setThreadLocked,
  setThreadState, staffThread, surfaceFor, threadsInState, type ThreadRow, type ThreadSurface,
} from '../tickets/threads.js';
import { accessDm, reportLine, ticketCard } from './ticketCard.js';
import type { BotTransport } from './transport.js';

/** The spec's figure: "A reconciler on bot ready and every five minutes". */
const RECONCILE_MS = 5 * 60_000;

/** Every private staff thread that still stands, for the ejection sweep. */
const PRIVATE_THREADS = `SELECT th.* FROM ticket_threads th JOIN tickets t ON t.id = th.ticket_id
   WHERE th.kind = 'staff' AND th.surface = 'private' AND th.state != 'deleted'`;

export interface TicketSyncDeps {
  db: DB;
  transport: BotTransport;
  publicUrl: string;
  /** Milliseconds between full passes. 0 means no timer (tests). */
  intervalMs?: number;
  /**
   * A last chance to copy a forum post's messages onto the site before it is
   * deleted for good (the mirror's backfill). Awaited, because the post is
   * gone the moment after.
   *
   * The deletion happens whether or not this works: a post the whole
   * moderation team can read about a restricted ticket, or about somebody who
   * now holds a staff flag, must never stand because a copy failed.
   */
  saveBeforeDelete?: (threadId: string) => Promise<void>;
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
  /** Whether the staff forum has been checked for posts with no ticket behind
   *  them. Until it has, nobody is let into the forum: see sweepOrphanPosts. */
  private orphansSwept = false;

  constructor(private deps: TicketSyncDeps) {}

  start(): void {
    this.offs.push(subscribeTicketSignals((s) => {
      this.enqueue(() => (s.kind === 'ticket' ? this.one(s.ticketId) : this.reconcile()));
    }));
    const every = this.deps.intervalMs ?? RECONCILE_MS;
    if (every > 0) {
      // The timer pass leaves the threads of settled tickets alone: see
      // reconcile's `scope`.
      this.timer = setInterval(() => this.enqueue(() => this.reconcile('open')), every);
      this.timer.unref();
    }
    // A banned moderator stops being active staff at once, not in five
    // minutes: out of the forum, and out of every private thread they were on,
    // the threads of closed tickets included.
    this.offs.push(subscribeBanChanges(() => this.enqueue(async () => {
      await this.step(() => this.ejectOutsiders());
      await this.step(() => this.syncAccess());
    })));
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
   *   0. take out of every private thread whoever is not entitled to be in
   *      it, whatever that thread's lock state;
   *   1. delete forum posts that must not exist, BEFORE anything can widen
   *      who reads the forum;
   *   2. retire threads left behind by a fold;
   *   3. every open ticket, and every closed one not yet locked;
   *   4. sweep the forum for posts with no ticket behind them, while that has
   *      never yet worked;
   *   5. last, sync the forum's access list, so a post that step 1 or the
   *      per-ticket pass failed to delete still keeps its subject out.
   *
   * `scope` is step 0's reach, and cost: reading a thread's members is a REST
   * call each, so the sweep over every private thread there has ever been
   * runs where it is worth paying for (the first pass after a restart, a
   * staff change, a ban) and the five minute timer asks for the threads of
   * open tickets only.
   */
  async reconcile(scope: 'all' | 'open' = 'all'): Promise<void> {
    await this.step(() => this.ejectOutsiders(undefined, scope));
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
    await this.step(() => this.sweepOrphanPosts());
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
    // Its own stage, as in a full pass: an ejection Discord refuses must not
    // stop the deletion of a forum post that must not exist.
    await this.step(() => this.ejectOutsiders(id));
    await this.removeForbiddenPosts(id);
    await this.retireFolded(id);
    await this.notifyAccess(t);
    const where = surfaceFor(db, t);
    const { surface } = where;
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
    if (!thread) {
      this.announceInFeed(t, where.why);
      return;
    }
    // A reopened ticket is unarchived BEFORE anything is written into it:
    // Discord refuses a send or an edit in an archived thread.
    if (t.status === 'open') await this.syncLock(t, thread);
    if (thread.locked === 0) {
      // The row says this thread is open for business, so whatever Discord
      // did to it while nobody was talking is undone before the first write.
      await this.makeWritable(thread.thread_id);
      // Members before the card, so the card arrives as a new message for
      // the people it is meant for.
      if (thread.surface === 'private') await this.syncMembers(t, thread);
      await this.announceReports(t, thread);
      await this.refreshCard(t, thread);
    }
    // A closed ticket is locked AFTER its card said so, for the same reason.
    await this.syncLock(t, thread);
  }

  /**
   * The interim line in the admin channel, for a ticket that has no thread
   * because no forum is set. Once a forum is set the post is the
   * announcement and this says nothing.
   *
   * Never for a restricted ticket and never for a ticket about staff
   * (`why` is then 'about_staff'): every admin reads the feed, and one of
   * them may be who the ticket is about. The event carries no reporter.
   *
   * Marked before it is published: publishing cannot fail, and a report must
   * never be said twice.
   */
  private announceInFeed(t: TicketRow, why: 'ok' | 'unconfigured' | 'about_staff'): void {
    if (t.restricted === 1 || why !== 'unconfigured' || t.status !== 'open') return;
    const { db } = this.deps;
    const rows = db.prepare(
      'SELECT id, category, feed_held FROM ticket_reports WHERE ticket_id = ? AND announced_at IS NULL ORDER BY id',
    ).all(t.id) as { id: number; category: string; feed_held: number }[];
    for (const r of rows) {
      // Marked whether or not it is said: announced_at means "never
      // reconsidered", and a held report must never be reconsidered either.
      db.prepare('UPDATE ticket_reports SET announced_at = ? WHERE id = ?').run(new Date().toISOString(), r.id);
      if (r.feed_held === 1) continue;
      // "New ticket" for the report that opened it, "Another report" after,
      // counted only over reports that could ever be said: a held sibling
      // (one filed, or that arrived, while the ticket was restricted or
      // about staff) does not count, so the first sayable report reads as a
      // new ticket rather than hinting at a case the feed never heard of.
      const first = t.opened_by === null
        && !db.prepare('SELECT 1 FROM ticket_reports WHERE ticket_id = ? AND id < ? AND feed_held = 0').get(t.id, r.id);
      publishAdminEvent({ kind: 'report', ticketId: t.id, targetId: t.target_id, category: r.category, created: first });
    }
  }

  private async createThread(t: TicketRow, surface: ThreadSurface): Promise<ThreadRow> {
    const { db, transport, publicUrl } = this.deps;
    const card = ticketCard(db, t.id, publicUrl)!;
    let row: ThreadRow;
    if (surface === 'forum') {
      const forumId = getSetting(db, 'discord_tickets_forum_id') ?? '';
      const made = await transport.threads.createForumPost(forumId, { name: card.name, message: card.payload, tags: card.tags });
      row = await this.rememberThread(made.threadId, () => insertThread(db, {
        ticketId: t.id, kind: 'staff', surface, channelId: forumId, threadId: made.threadId,
        cardMessageId: made.messageId, cardHash: card.hash,
      }));
    } else {
      const channelId = getSetting(db, 'discord_tickets_channel_id') ?? '';
      const made = await transport.threads.createPrivateThread(channelId, { name: card.name });
      // The row goes in with no card: refreshCard sends it, after the members
      // are in. If that send fails, the next pass finds this row and sends
      // the card then, instead of making a second thread.
      row = await this.rememberThread(made.threadId, () => insertThread(db, { ticketId: t.id, kind: 'staff', surface, channelId, threadId: made.threadId }));
    }
    // The card counts every report there is, so none of them needs a line.
    db.prepare('UPDATE ticket_reports SET announced_at = ? WHERE ticket_id = ? AND announced_at IS NULL')
      .run(new Date().toISOString(), t.id);
    return row;
  }

  /**
   * The row for a thread Discord has just made, and the thread itself back
   * again when that row cannot be written.
   *
   * A request handler can fold the ticket away while the REST call is in
   * flight: a promotion with a restricted sibling waiting, or a player merge.
   * The insert then fails on its foreign key and leaves a thread nothing
   * knows about, which is the worst kind of forum post there is:
   * forbiddenForumThreads cannot see it to delete it and forumAudience cannot
   * see it to keep its subject out, so the next access sync would hand the
   * accused their own case to read.
   */
  private async rememberThread(threadId: string, insert: () => ThreadRow): Promise<ThreadRow> {
    try {
      return insert();
    } catch (err) {
      console.error('[discord] a ticket thread outlived its ticket; deleting it:', err);
      try {
        await this.deps.transport.threads.deleteThread(threadId);
      } catch (undeleted) {
        // It is standing there with nothing pointing at it. The sweep goes
        // back on the books, and until it has run the forum's access list
        // does not move.
        this.orphansSwept = false;
        this.problem(`Could not delete a Discord thread whose ticket disappeared while it was being made: ${undeleted instanceof Error ? undeleted.message : String(undeleted)}. It is swept up on a later pass, and nobody new is let into the tickets forum until it is.`);
      }
      throw err;
    }
  }

  /**
   * Posts in the staff forum that the bot made and the database has no row
   * for: one whose row was lost to the race rememberThread covers, or to a
   * hard kill in the same moment. Invisible to forbiddenForumThreads and to
   * forumAudience alike, so the forum must never grow around one.
   *
   * Once per process, on the first pass that manages it: from then on every
   * post the bot makes has its row written in the same tick, or is deleted
   * again. Until it has managed it, syncAccess lets nobody new in but keeps taking people out.
   */
  private async sweepOrphanPosts(): Promise<void> {
    if (this.orphansSwept) return;
    const { db, transport } = this.deps;
    const forumId = getSetting(db, 'discord_tickets_forum_id') ?? '';
    // No forum: nothing to sweep, and nothing for syncAccess to do either.
    // Left unswept on purpose, so configuring one later still gets a sweep.
    if (!forumId) return;
    const known = new Set((db.prepare("SELECT thread_id FROM ticket_threads WHERE surface = 'forum'")
      .all() as { thread_id: string }[]).map((r) => r.thread_id));
    let posts: { threadId: string; ownerId: string | null }[];
    try {
      posts = await transport.threads.listThreads(forumId);
    } catch (err) {
      // Its own line, not the generic one: this failure has a consequence
      // that goes on until somebody fixes it, and a cause worth naming.
      console.error('[discord] could not list the tickets forum posts:', err);
      this.problem(`Could not list the posts in the tickets forum: ${err instanceof Error ? err.message : String(err)}. Until that works, nobody new is let into the staff forum, because a post with no ticket behind it could be standing in there; anyone who should lose access is still taken out of it every few minutes. The usual cause is the bot missing Read Message History or Manage Threads on the tickets forum.`);
      return;
    }
    for (const th of posts) {
      if (known.has(th.threadId)) continue;
      await transport.threads.deleteThread(th.threadId);
      console.log('[discord] deleted a tickets forum post with no ticket behind it');
    }
    this.orphansSwept = true;
  }

  /**
   * Everyone in a private staff thread who is not entitled to be there:
   * privateThreadAudience is the whole rule, and whoever is in the thread and
   * not in it goes.
   *
   * It runs on threads syncMembers never touches, which is why it exists. A
   * merge can repoint a restricted ticket's target_id onto one of its own
   * thread's members (an admin merged into the person they were
   * investigating), and a moderator on the list can be demoted or banned;
   * neither deletes anything Discord would notice, and syncMembers only ever
   * runs on the unlocked thread of a ticket still being worked. So this runs
   * first and whatever the lock state, and puts a locked thread back exactly
   * as it found it.
   */
  private async ejectOutsiders(ticketId?: number, scope: 'all' | 'open' = 'all'): Promise<void> {
    const { db, transport } = this.deps;
    const rows = (ticketId !== undefined
      ? db.prepare(`${PRIVATE_THREADS} AND th.ticket_id = ? ORDER BY th.id`).all(ticketId)
      : scope === 'open'
        ? db.prepare(`${PRIVATE_THREADS} AND t.status = 'open' ORDER BY th.id`).all()
        : db.prepare(`${PRIVATE_THREADS} ORDER BY th.id`).all()) as ThreadRow[];
    for (const th of rows) {
      // Each thread on its own: one Discord refuses must not leave the
      // accused of the next one sitting in their own case.
      try {
        if (!(await transport.threads.exists(th.thread_id))) continue;
        const members = await transport.threads.memberIds(th.thread_id);
        if (!members) continue;
        const entitled = new Set(privateThreadAudience(db, th.ticket_id).map((m) => m.discord_id));
        const outsiders = members.filter((id) => !entitled.has(id));
        if (outsiders.length === 0) continue;
        // Whatever state Discord has this thread in, it has to take a removal
        // now: a closed ticket's thread is archived, and so is one nobody has
        // written in for a week. The row says what it goes back to.
        await this.makeWritable(th.thread_id);
        try {
          for (const id of outsiders) await transport.threads.removeMember(th.thread_id, id);
        } finally {
          // In a finally: a removal that fails must not leave a closed
          // ticket's thread unlocked and unarchived until the next pass.
          if (th.locked === 1) {
            await transport.threads.setLocked(th.thread_id, true);
            await transport.threads.setArchived(th.thread_id, true);
          }
        }
      } catch (err) {
        console.error('[discord] taking someone out of a ticket thread failed:', err);
        this.problem(`Could not take someone out of a ticket's Discord thread: ${err instanceof Error ? err.message : String(err)}. It is tried again every few minutes.`);
      }
    }
  }

  /** Rule 2. Marked 'deleted' only after Discord deleted it, so a failure is
   *  retried, and Task 6 keeps the accused out of the forum until it works. */
  private async removeForbiddenPosts(ticketId?: number): Promise<void> {
    const { db, transport, saveBeforeDelete } = this.deps;
    for (const th of forbiddenForumThreads(db, ticketId)) {
      // What people wrote in it while the bot was down is only in Discord,
      // and in a moment it will be nowhere. Copied first, and deleted anyway
      // if that fails: see saveBeforeDelete.
      if (saveBeforeDelete) {
        try {
          await saveBeforeDelete(th.thread_id);
        } catch (err) {
          console.error('[discord] could not copy a ticket thread before deleting it:', err);
          // Names no ticket and no player: every admin reads the feed, and
          // this post is about someone who must not be named to them.
          this.problem(`Could not copy a ticket thread's messages onto the site before deleting the Discord post that must not exist: ${err instanceof Error ? err.message : String(err)}. The post was deleted anyway, so anything written in it that the site had not already copied is lost.`);
        }
      }
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
          // Writable first: the survivor is archived when its own ticket is
          // closed, and Discord archives a quiet one whether it is or not.
          await this.makeWritable(survivor.thread_id);
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

  /**
   * Discord archives a thread on its own once its auto-archive time passes,
   * and an archived thread refuses every write there is: no send, no edit, no
   * tag, no lock, nobody added or removed. Nothing in the database says it
   * happened, so every write path asks here before its first write of a pass.
   *
   * It decides nothing about what the thread SHOULD be: a caller that
   * unarchives a thread its row says is locked is the one that puts it back.
   */
  private async makeWritable(threadId: string): Promise<void> {
    const { transport } = this.deps;
    if (await transport.threads.isArchived(threadId)) await transport.threads.setArchived(threadId, false);
  }

  /** Lock and archive a thread that is no longer the ticket's, saying why
   *  first when there is something to say. */
  private async endThread(th: ThreadRow, farewell: string | null): Promise<void> {
    const { db, transport } = this.deps;
    if (await transport.threads.exists(th.thread_id)) {
      // Writable first: an archived thread takes no message and no lock.
      await this.makeWritable(th.thread_id);
      if (farewell) await transport.send(th.thread_id, { embeds: [{ description: farewell }], components: [], mentionUserIds: [] });
      await transport.threads.setLocked(th.thread_id, true);
      await transport.threads.setArchived(th.thread_id, true);
    }
    setThreadState(db, th.id, 'ended');
    setThreadLocked(db, th.id, true);
  }

  /** Rule 1: the thread's members are privateThreadAudience, no more and no
   *  fewer. Someone on the list with no Discord linked simply is not in the
   *  thread; the next pass after they link adds them. */
  private async syncMembers(t: TicketRow, thread: ThreadRow): Promise<void> {
    const { db, transport } = this.deps;
    const have = await transport.threads.memberIds(thread.thread_id);
    if (have === null) return;
    const want = privateThreadAudience(db, t.id).map((m) => m.discord_id);
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
    // The same audience the thread has: someone demoted between being put on
    // the list and this pass is never told about a ticket they cannot open.
    const rows = privateThreadAudience(db, t.id).filter((m) => m.notified_at === null);
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

  /** The forum's member overwrites are exactly forumAudience, or, while the
   *  orphan sweep has never worked, forumAudience minus everyone not already
   *  in: the revocations still happen, the grants wait. */
  private async syncAccess(): Promise<void> {
    const { db, transport } = this.deps;
    const forumId = getSetting(db, 'discord_tickets_forum_id') ?? '';
    if (!forumId) return;
    const want = forumAudience(db);
    // While a post nothing in the database knows about may be standing in the
    // forum, NOBODY IS LET IN: forumAudience cannot leave out the subject of
    // a post it cannot see, so a grant could be a grant to someone's own
    // case. Taking access away is never held back for that, or a bot that
    // cannot read the forum would leave a banned moderator in it for the life
    // of the process. The sweep runs ahead of this in every pass.
    const revokeOnly = !this.orphansSwept;
    const r = await transport.threads.syncMemberAccess(forumId, want, { revokeOnly });
    if (r.added.length || r.removed.length || r.failed.length) {
      console.log(`[discord] tickets forum access: +${r.added.length} -${r.removed.length}, ${r.failed.length} refused`);
    }
    // Someone who could not be ADDED has simply left the server. Someone who
    // could not be REMOVED still reads the forum, which is a different thing
    // entirely and the one worth waking an admin for. Named by number only:
    // every admin reads the feed.
    const kept = r.failed.filter((id) => !want.includes(id));
    if (kept.length > 0) {
      this.problem(`${kept.length === 1 ? 'Someone who' : `${kept.length} people who`} should no longer see the tickets forum can still read it: Discord refused to take their access away. Check the bot's permissions on the forum. It is tried again every few minutes.`);
    }
  }
}
