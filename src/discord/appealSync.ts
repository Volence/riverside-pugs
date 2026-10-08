import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { escapeName } from '../identity.js';
import { getAppeal, listMessages } from '../appeals/store.js';
import { appealIsQuiet } from '../appeals/access.js';
import { dmText, messageDmText, STATE_LABEL } from '../appeals/templates.js';
import { subscribeAppealSignals } from '../appeals/signals.js';
import { OPEN_STATES, type AppealMessageRow, type AppealRow, type AppealState } from '../appeals/types.js';
import type { BotTransport, MessagePayload } from './transport.js';

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const nameOf = (db: DB, steamid: string | null) => (steamid === 'system' ? 'automatic'
  : steamid ? ((db.prepare('SELECT name FROM players WHERE steamid = ?').get(steamid) as { name: string } | undefined)?.name ?? steamid) : '');

/** The forum post's first message: the appeal as filed, and where it
 *  stands. Edited in place on every state change. The conversation after
 *  filing goes into the thread as one line per message (threadLine). */
export function appealCard(db: DB, row: AppealRow, publicUrl: string): MessagePayload {
  const ban = row.ban_id !== null
    ? db.prepare('SELECT reason, created_by, expires_at AS ends FROM bans WHERE id = ?').get(row.ban_id)
    : db.prepare('SELECT reason, created_by, until AS ends FROM discord_sanctions WHERE id = ?').get(row.sanction_id);
  const b = ban as { reason: string; created_by: string; ends: string | null };
  const fields = [
    { name: 'Ban', value: clip(escapeName(b.reason), 1000) },
    { name: 'Issued by', value: escapeName(nameOf(db, b.created_by)), inline: true },
    { name: 'Ends', value: b.ends ? `<t:${Math.floor(Date.parse(b.ends) / 1000)}:f>` : 'never', inline: true },
    { name: 'Status', value: STATE_LABEL[row.state], inline: true },
  ];
  if (row.decided_by) fields.push({ name: 'Decided by', value: escapeName(nameOf(db, row.decided_by)), inline: true });
  return {
    embeds: [{
      title: clip(`Appeal #${row.id}: ${escapeName(row.appellant_name)}`, 250),
      url: `${publicUrl}/admin/people/appeals/${row.id}`,
      description: `**What happened**\n${clip(escapeName(row.what_happened), 1800)}\n\n**Why it should be lifted**\n${clip(escapeName(row.why_lift), 1800)}`,
      fields,
    }],
    components: [],
    mentionUserIds: [],
  };
}

/** One message of the conversation as a line in the forum post. Staff
 *  are named here (it is the staff forum); the player never sees this. */
export function threadLine(db: DB, row: AppealRow, m: AppealMessageRow): string {
  const who = m.from_staff ? `**${escapeName(nameOf(db, m.author))}** to the player:` : `**${escapeName(row.appellant_name)}** (appellant):`;
  return `${who}\n> ${clip(escapeName(m.body), 1800).replace(/\n/g, '\n> ')}`;
}

/** States told in the thread by the message that caused them, so a status
 *  line would only repeat it. */
const TOLD_BY_MESSAGE = new Set<AppealState>(['asked', 'answered']);

export interface AppealSyncDeps {
  db: DB;
  transport: BotTransport;
  publicUrl: string;
  /** The tickets reconciler's chain: its once-per-process orphan sweep lists
   *  the same forum, and a post made between its listing and our row write
   *  would be deleted as an orphan. */
  serialise?: (fn: () => Promise<void>) => Promise<void>;
  intervalMs?: number;
  now?: () => Date;
}

/**
 * Keeps each appeal's forum post and the appellant's DMs in step with the
 * row and its messages. Idempotent, driven by four columns: `forum_state`
 * (the state the post shows), `dm_state` (the last state the appellant was
 * told about), and `forum_message_seen` / `dm_message_seen` (the last
 * message posted to the thread / DMed). A pass changes nothing for a row
 * whose columns are all caught up.
 */
export class AppealSync {
  private timer: NodeJS.Timeout | null = null;
  private off: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private deps: AppealSyncDeps) {}

  start(): void {
    this.off = subscribeAppealSignals(() => { this.kick(); });
    this.kick();
    const every = this.deps.intervalMs ?? 60_000;
    if (every > 0) {
      this.timer = setInterval(() => { this.kick(); }, every);
      this.timer.unref();
    }
  }

  stop(): void {
    this.off?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private kick(): void {
    this.chain = this.chain.then(() => this.reconcile()).catch((err) => console.error('[discord] appeal sync:', err));
  }

  async reconcile(): Promise<void> {
    const ids = (this.deps.db.prepare(
      `SELECT id FROM appeals a WHERE dm_state IS NOT state OR forum_state IS NOT state
         OR EXISTS (SELECT 1 FROM appeal_messages m WHERE m.appeal_id = a.id
                    AND (m.id > a.forum_message_seen OR (m.from_staff = 1 AND m.id > a.dm_message_seen)))
       ORDER BY id`,
    ).all() as { id: number }[]).map((r) => r.id);
    for (const id of ids) {
      // Never throwing, so one broken appeal cannot starve the rest (as
      // TicketSync.one does for tickets): rows run in id order, and a
      // persistently failing one must not block every later appeal forever.
      try {
        const row = getAppeal(this.deps.db, id);
        if (!row) continue;
        await this.dm(row);
        const run = () => this.forum(row.id);
        await (this.deps.serialise ? this.deps.serialise(run) : run());
      } catch (err) {
        console.error(`[discord] appeal #${id} sync failed:`, err);
      }
    }
  }

  /** Charged before the send, so a refused DM is never retried. Each staff
   *  message first, then the state (an outcome), so a last word before a
   *  decision arrives before the decision. */
  private async dm(row: AppealRow): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const to = row.discord_id
      ?? (row.steamid ? (db.prepare('SELECT discord_id FROM players WHERE steamid = ?').get(row.steamid) as { discord_id: string | null } | undefined)?.discord_id : null);
    const send = async (content: string) => {
      if (!to) return;
      try {
        await transport.dm(to, { content, embeds: [], components: [], mentionUserIds: [] });
      } catch (err) {
        console.log(`[discord] appeal #${row.id}: DM refused (${String(err)})`);
      }
    };
    for (const m of listMessages(db, row.id)) {
      if (!m.from_staff || m.id <= row.dm_message_seen) continue;
      const charged = db.prepare('UPDATE appeals SET dm_message_seen = ? WHERE id = ? AND dm_message_seen < ?').run(m.id, row.id, m.id).changes > 0;
      if (charged) await send(messageDmText(db, m, publicUrl));
    }
    if (row.dm_state === row.state) return;
    const charged = db.prepare('UPDATE appeals SET dm_state = ? WHERE id = ? AND dm_state IS NOT ?').run(row.state, row.id, row.state).changes > 0;
    if (!charged) return;
    const content = dmText(db, row, publicUrl, this.deps.now?.());
    if (content) await send(content);
  }

  private async forum(id: number): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const row = getAppeal(db, id);
    if (!row) return;
    const pending = listMessages(db, row.id).filter((m) => m.id > row.forum_message_seen);
    if (row.forum_state === row.state && pending.length === 0) return;
    const lastSeen = pending.at(-1)?.id ?? row.forum_message_seen;
    const mark = () => db.prepare('UPDATE appeals SET forum_state = ?, forum_message_seen = ? WHERE id = ?').run(row.state, lastSeen, row.id);
    // Quiet appeals and a forum-less setup: worked on the site only.
    const forumId = getSetting(db, 'discord_tickets_forum_id') ?? '';
    if (!forumId || appealIsQuiet(db, row)) { mark(); return; }
    const card = appealCard(db, row, publicUrl);

    let threadId = row.forum_thread_id;
    let cardShown = false;
    if (!threadId) {
      const made = await transport.threads.createForumPost(forumId, { name: `Appeal #${row.id}: ${row.appellant_name}`.slice(0, 100), message: card, tags: ['Appeal'] });
      try {
        db.prepare('UPDATE appeals SET forum_thread_id = ?, forum_message_id = ?, forum_state = ? WHERE id = ?')
          .run(made.threadId, made.messageId, row.state, row.id);
      } catch (err) {
        await transport.threads.deleteThread(made.threadId).catch(() => {});
        throw err;
      }
      threadId = made.threadId;
      cardShown = true;
    } else {
      if (!(await transport.threads.exists(threadId))) { mark(); return; }
      if (await transport.threads.isArchived(threadId)) await transport.threads.setArchived(threadId, false);
    }

    // The messages before the status, so the thread reads in order, each
    // marked as it goes so a failure part way never posts one twice.
    for (const m of pending) {
      await transport.send(threadId, { content: threadLine(db, row, m), embeds: [], components: [], mentionUserIds: [] });
      db.prepare('UPDATE appeals SET forum_message_seen = ? WHERE id = ?').run(m.id, row.id);
    }
    if (!cardShown && row.forum_state !== row.state) {
      await transport.edit(threadId, row.forum_message_id ?? threadId, card);
      // A short line too, because an edit notifies nobody.
      if (!TOLD_BY_MESSAGE.has(row.state)) {
        await transport.send(threadId, { content: `Status: ${STATE_LABEL[row.state]}`, embeds: [], components: [], mentionUserIds: [] });
      }
    }
    mark();
    if (!OPEN_STATES.includes(row.state)) await this.close(threadId);
  }

  private async close(threadId: string): Promise<void> {
    await this.deps.transport.threads.setLocked(threadId, true);
    await this.deps.transport.threads.setArchived(threadId, true);
  }
}
