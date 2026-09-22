import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { addTicketEvent } from '../tickets/store.js';
import { publishTicketSignal } from '../tickets/signals.js';
import {
  checkChatStaff, checkContactReporter, checkReporterChat, reporterDiscordIdOf, reporterThreadAudience,
  reporterThreadFor, reporterThreadsOf, requestPing, type ChatPlan, type ReporterAsker,
} from '../tickets/reporterChat.js';
import { insertThread, setThreadLocked, setThreadState, type ThreadRow } from '../tickets/threads.js';
import { NotInGuildError } from './transport.js';
import type { BotTransport } from './transport.js';

/** The spec's opening line, word for word. */
export const CHAT_OPENING = 'This is a private chat with the moderators about your report. A moderator will reply here when they can.';
export const CHAT_ENDED_BY_STAFF = 'The moderators have ended this chat. While your report is open you can start it again from My reports on the report message.';
export const CHAT_ENDED_ON_CLOSE = 'Your report is now closed, so this chat has ended. Thank you for telling us.';
const NOT_IN_SERVER_SELF = 'You are not in the Discord server, so there is nowhere to chat. Join it, then try again.';
const NOT_IN_SERVER_STAFF = 'The reporter is not in the Discord server, so there is no way to chat with them there.';
const UNCONFIGURED = 'Chats with the moderators are not set up yet: an admin has to set the tickets channel in Settings.';
const DISCORD_FAILED = 'Discord would not do that just now. Try again in a moment.';

export type ChatResult = { ok: true; url: string; created: boolean; reopened: boolean } | { ok: false; status: number; error: string };
type Done = { ok: true } | { ok: false; status: number; error: string };

export interface ReporterChatsDeps {
  db: DB;
  transport: BotTransport;
  publicUrl: string;
  guildId: string;
  /** GuildMembership.isMember: false for someone known not to be in the
   *  server, null while the member list is unknown (then the add decides). */
  isMember?: (discordId: string) => boolean | null;
  /** TicketSync.serialise: every thread operation here is on the
   *  reconciler's chain, which also unarchives, acts and archives threads.
   *  Left out (tests), the work simply runs. */
  serialise?: (fn: () => Promise<void>) => Promise<void>;
  now?: () => Date;
}

export const threadUrl = (guildId: string, threadId: string) => `https://discord.com/channels/${guildId}/${threadId}`;

const fail = (status: number, error: string) => ({ ok: false as const, status, error });

/** Unarchive first when Discord archived a quiet thread on its own: an
 *  archived thread refuses every write there is. */
async function writable(transport: BotTransport, threadId: string): Promise<void> {
  if (await transport.threads.isArchived(threadId)) await transport.threads.setArchived(threadId, false);
}

/** Whether a previous press already finished opening this specific thread
 *  row: the send, the staff add and the event all happened. Written only
 *  once that whole sequence completes (see openNow's addTicketEvent), so a
 *  press that made the thread and then had Discord refuse the opening
 *  message leaves nothing here, and the very next press is treated as if it
 *  were the original create and finishes the rest. */
function openingDone(db: DB, threadRowId: number): boolean {
  return !!db.prepare(
    "SELECT 1 FROM ticket_events WHERE kind = 'reporter_chat' AND json_extract(detail, '$.threadRowId') = ? LIMIT 1",
  ).get(threadRowId);
}

/**
 * End one reporter chat: say why, take the reporter out, lock, archive.
 * Marked ended only after Discord did it. Shared by staff's End (through
 * ReporterChats, on the reconciler's chain) and by the reconciler itself
 * when a ticket closes, which is why it is a free function: the reconciler
 * must not go through serialise from inside its own chain.
 */
export async function endReporterThread(d: { db: DB; transport: BotTransport }, th: ThreadRow, farewell: string): Promise<void> {
  const { db, transport } = d;
  if (await transport.threads.exists(th.thread_id)) {
    await writable(transport, th.thread_id);
    await transport.send(th.thread_id, { embeds: [{ description: farewell }], components: [], mentionUserIds: [] });
    const reporter = reporterDiscordIdOf(db, { reporterId: th.reporter_id, reporterDiscordId: th.reporter_discord_id });
    if (reporter !== null) {
      try {
        await transport.threads.removeMember(th.thread_id, reporter);
      } catch (err) {
        // Ordinary: they have left the server. The thread is locked below either way.
        console.warn('[discord] could not take the reporter out of an ended chat:', err instanceof Error ? err.message : err);
      }
    }
    await transport.threads.setLocked(th.thread_id, true);
    await transport.threads.setArchived(th.thread_id, true);
  }
  setThreadState(db, th.id, 'ended');
  setThreadLocked(db, th.id, true);
}

/**
 * Reporter chat, in Discord: a private thread under the tickets channel per
 * (ticket, reporter), registered in ticket_threads with kind 'reporter' so
 * the mirror copies it onto the site.
 *
 * Every public method runs on the reconciler's chain and never throws: a
 * Discord failure is an answer (502) for the button or the route to show.
 */
export class ReporterChats {
  constructor(private deps: ReporterChatsDeps) {}

  /** Used only when deps.serialise is not given (every real caller supplies
   *  TicketSync's chain). A fallback of "just run it" would let two presses
   *  for the same ticket and reporter race each other's reporterThreadFor
   *  lookup and each create its own thread; queued on this instead, the
   *  second press always sees the first one's finished row. */
  private chain: Promise<unknown> = Promise.resolve();

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private defaultSerialise = (f: () => Promise<void>): Promise<void> => {
    const started = this.chain.then(f, f);
    // The queue itself must never stall: a step that rejected still frees
    // the next one, whose own result is read from `started`, not from here.
    this.chain = started.then(() => undefined, () => undefined);
    return started;
  };

  /** On the chain, waited for, with any throw turned into DISCORD_FAILED. */
  private async onChain<T extends { ok: boolean }>(fn: () => Promise<T>): Promise<T | { ok: false; status: number; error: string }> {
    const serialise = this.deps.serialise ?? this.defaultSerialise;
    let out: T | undefined;
    try {
      await serialise(async () => { out = await fn(); });
      return out!;
    } catch (err) {
      console.error('[discord] a reporter chat action failed:', err instanceof Error ? err.message : err);
      return fail(502, DISCORD_FAILED);
    }
  }

  openForReporter(reportId: number, asker: ReporterAsker): Promise<ChatResult> {
    return this.onChain(async () => {
      const c = checkReporterChat(this.deps.db, reportId, asker, this.now());
      if (!c.ok) return fail(c.status, c.error);
      return this.openNow(c.plan, { kind: 'reporter' });
    });
  }

  contact(ticketId: number, reportId: number, staff: string): Promise<ChatResult> {
    return this.onChain(async () => {
      const c = checkContactReporter(this.deps.db, ticketId, reportId, staff);
      if (!c.ok) return fail(c.status, c.error);
      return this.openNow(c.plan, { kind: 'staff', steamid: staff });
    });
  }

  join(ticketId: number, staff: string): Promise<ChatResult> {
    return this.onChain(async (): Promise<ChatResult> => {
      const { db, transport, guildId } = this.deps;
      const c = checkChatStaff(db, ticketId, staff);
      if (!c.ok) return fail(c.status, c.error);
      const me = this.discordIdOf(staff);
      if (me === null) return fail(400, 'link your Discord account first');
      const open = reporterThreadsOf(db, ticketId, 'open');
      if (open.length === 0) return fail(409, 'there is no open reporter chat on this ticket');
      // Threads still worth pointing at, in order: everyone the presser was
      // actually put into, plus anyone skipped only because reporterThreadAudience
      // says so (unchanged from before). What Discord itself has already
      // deleted is dropped here, exactly as openNow drops it, so one gone
      // thread does not fail the whole call or leave the URL pointing at it.
      const alive: ThreadRow[] = [];
      for (const th of open) {
        if (!reporterThreadAudience(db, th).includes(me)) { alive.push(th); continue; }
        if (!(await transport.threads.exists(th.thread_id))) {
          setThreadState(db, th.id, 'deleted');
          continue;
        }
        await writable(transport, th.thread_id);
        await transport.threads.addMember(th.thread_id, me);
        alive.push(th);
      }
      if (alive.length === 0) return fail(409, 'there is no open reporter chat on this ticket');
      addTicketEvent(db, ticketId, staff, 'reporter_chat_joined', {}, this.now());
      publishTicketSignal({ kind: 'ticket', ticketId });
      return { ok: true, url: threadUrl(guildId, alive[0].thread_id), created: false, reopened: false };
    });
  }

  end(ticketId: number, threadRowId: number, staff: string): Promise<Done> {
    return this.onChain(async (): Promise<Done> => {
      const { db } = this.deps;
      const t = checkChatStaff(db, ticketId, staff);
      // Ending is allowed on a closed ticket too: the reconciler ends those
      // itself, and a moderator asking first is not wrong.
      if (!t.ok && t.status !== 409) return fail(t.status, t.error);
      const th = db.prepare("SELECT * FROM ticket_threads WHERE id = ? AND ticket_id = ? AND kind = 'reporter'").get(threadRowId, ticketId) as ThreadRow | undefined;
      if (!th || th.state === 'deleted') return fail(404, 'no such chat');
      if (th.state !== 'open') return fail(409, 'that chat has already ended');
      await endReporterThread(this.deps, th, CHAT_ENDED_BY_STAFF);
      addTicketEvent(db, ticketId, staff, 'reporter_chat_ended', { threadRowId }, this.now());
      publishTicketSignal({ kind: 'ticket', ticketId });
      return { ok: true };
    });
  }

  private discordIdOf(steamid: string): string | null {
    return (this.deps.db.prepare('SELECT discord_id FROM players WHERE steamid = ?').get(steamid) as { discord_id: string | null } | undefined)?.discord_id ?? null;
  }

  /**
   * The thread for this plan: made, reopened, or as it is. The reporter is
   * added every time (they may have been taken out, or left and come back).
   * A reporter's own press also adds the claimer and asks for staff to be
   * told; a moderator's press adds that moderator and tells nobody.
   */
  private async openNow(plan: ChatPlan, by: { kind: 'reporter' } | { kind: 'staff'; steamid: string }): Promise<ChatResult> {
    const { db, transport, guildId } = this.deps;
    const now = this.now();
    if (this.deps.isMember?.(plan.reporterDiscordId) === false) return fail(409, by.kind === 'reporter' ? NOT_IN_SERVER_SELF : NOT_IN_SERVER_STAFF);
    let th = reporterThreadFor(db, plan.ticketId, plan.ref);
    if (th && !(await transport.threads.exists(th.thread_id))) {
      // Deleted by hand in Discord. Remembered, and made again.
      setThreadState(db, th.id, 'deleted');
      th = undefined;
    }
    let created = false;
    let reopened = false;
    if (!th) {
      const channelId = getSetting(db, 'discord_tickets_channel_id') ?? '';
      if (!channelId) return fail(503, UNCONFIGURED);
      const made = await transport.threads.createPrivateThread(channelId, { name: 'Chat with the moderators' });
      try {
        th = insertThread(db, {
          ticketId: plan.ticketId, kind: 'reporter', surface: 'private', channelId, threadId: made.threadId,
          reporterId: plan.ref.reporterId, reporterDiscordId: plan.ref.reporterDiscordId,
        }, now);
      } catch (err) {
        // The ticket went (a fold) while the thread was being made: nothing
        // may be left standing that no row knows about. There is no row to
        // mark either way (insertThread never wrote one), so a failed delete
        // here can only be logged: the thread has to be found and cleaned up
        // by hand, since nothing in the database still points at it.
        try {
          await transport.threads.deleteThread(made.threadId);
        } catch (delErr) {
          console.error(`[discord] could not delete orphaned reporter chat thread ${made.threadId} (its row was never written):`, delErr instanceof Error ? delErr.message : delErr);
        }
        throw err;
      }
      created = true;
    } else if (th.state !== 'open' || th.locked === 1) {
      await writable(transport, th.thread_id);
      await transport.threads.setLocked(th.thread_id, false);
      setThreadLocked(db, th.id, false);
      setThreadState(db, th.id, 'open');
      reopened = true;
    } else {
      await writable(transport, th.thread_id);
    }
    try {
      await transport.threads.addMember(th.thread_id, plan.reporterDiscordId);
    } catch (err) {
      // NotInGuildError is Discord's answer for somebody who is not in the
      // server, the one rejection expected here; anything else (a rate
      // limit, a missing permission, Discord being down for a moment) is not
      // the reporter's fault and must not be blamed on them or deleted over.
      if (!(err instanceof NotInGuildError)) throw err;
      console.warn(`[discord] the reporter is not in the Discord server, so chat thread ${th.thread_id} could not be given to them:`, err.message);
      // A thread made for them just now goes again; an old one stays, for
      // the record, either way. Marked deleted only once Discord confirms
      // it: a delete Discord refuses leaves the row exactly as it was, open,
      // so the same orphaned thread is found and retried on the next press
      // rather than losing track of it (there is no dedicated sweep for this
      // yet; the row staying 'open' is what makes it findable later).
      if (created) {
        try {
          await transport.threads.deleteThread(th.thread_id);
          setThreadState(db, th.id, 'deleted');
        } catch (delErr) {
          console.error(`[discord] could not delete orphaned reporter chat thread ${th.thread_id}:`, delErr instanceof Error ? delErr.message : delErr);
        }
      }
      return fail(409, by.kind === 'reporter' ? NOT_IN_SERVER_SELF : NOT_IN_SERVER_STAFF);
    }
    // "Just opened" covers a fresh thread, and also one made by an earlier
    // press whose completion (the message below, the staff add, the event
    // and the ping) never finished because Discord refused something after
    // the row was already written: openingDone is false until that whole
    // sequence has gone through once, so this press does the rest of it
    // rather than silently linking to a chat that never actually opened.
    const justOpened = created || (!reopened && !openingDone(db, th.id));
    if (justOpened) await transport.send(th.thread_id, { content: CHAT_OPENING, embeds: [], components: [], mentionUserIds: [] });
    const allowed = reporterThreadAudience(db, th);
    const staff = by.kind === 'staff' ? this.discordIdOf(by.steamid) : plan.claimedBy ? this.discordIdOf(plan.claimedBy) : null;
    if (staff !== null && allowed.includes(staff)) {
      try {
        await transport.threads.addMember(th.thread_id, staff);
      } catch (err) {
        console.warn('[discord] could not add a moderator to a reporter chat:', err instanceof Error ? err.message : err);
      }
    }
    addTicketEvent(db, plan.ticketId, by.kind === 'staff' ? by.steamid : null, 'reporter_chat', { by: by.kind, created, reopened, threadRowId: th.id }, now);
    if (by.kind === 'reporter' && (justOpened || reopened)) requestPing(db, th.thread_id, now);
    publishTicketSignal({ kind: 'ticket', ticketId: plan.ticketId });
    return { ok: true, url: threadUrl(guildId, th.thread_id), created, reopened };
  }
}
