import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { escapeName } from '../identity.js';
import { getAppeal } from '../appeals/store.js';
import { appealIsQuiet } from '../appeals/access.js';
import { dmText, STATE_LABEL } from '../appeals/templates.js';
import { subscribeAppealSignals } from '../appeals/signals.js';
import { OPEN_STATES, type AppealRow } from '../appeals/types.js';
import type { BotTransport, MessagePayload } from './transport.js';

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const nameOf = (db: DB, steamid: string | null) => (steamid === 'system' ? 'automatic'
  : steamid ? ((db.prepare('SELECT name FROM players WHERE steamid = ?').get(steamid) as { name: string } | undefined)?.name ?? steamid) : '');

/** The forum post's first message: the whole appeal as it stands now. It is
 *  edited in place on every change, so a skipped intermediate state (asked
 *  and answered between two passes) is never lost from the post. */
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
  if (row.question) fields.push({ name: `Question from ${escapeName(nameOf(db, row.asked_by))}`, value: clip(escapeName(row.question), 1000) });
  if (row.answer) fields.push({ name: 'Answer', value: clip(escapeName(row.answer), 1000) });
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
 * row. Idempotent, driven by two columns: `forum_state` (the state the post
 * shows) and `dm_state` (the last state the appellant was told about). A
 * pass changes nothing for a row whose columns already equal its state.
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
      'SELECT id FROM appeals WHERE dm_state IS NOT state OR forum_state IS NOT state ORDER BY id',
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

  /** Charged before the send, so a refused DM is never retried. */
  private async dm(row: AppealRow): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    if (row.dm_state === row.state) return;
    const charged = db.prepare('UPDATE appeals SET dm_state = ? WHERE id = ? AND dm_state IS NOT ?').run(row.state, row.id, row.state).changes > 0;
    if (!charged) return;
    const content = dmText(db, row, publicUrl, this.deps.now?.());
    const to = row.discord_id
      ?? (row.steamid ? (db.prepare('SELECT discord_id FROM players WHERE steamid = ?').get(row.steamid) as { discord_id: string | null } | undefined)?.discord_id : null);
    if (!content || !to) return;
    try {
      await transport.dm(to, { content, embeds: [], components: [], mentionUserIds: [] });
    } catch (err) {
      console.log(`[discord] appeal #${row.id}: DM refused (${String(err)})`);
    }
  }

  private async forum(id: number): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const row = getAppeal(db, id);
    if (!row || row.forum_state === row.state) return;
    const forumId = getSetting(db, 'discord_tickets_forum_id') ?? '';
    const mark = () => db.prepare('UPDATE appeals SET forum_state = ? WHERE id = ?').run(row.state, row.id);
    // Quiet appeals and a forum-less setup: worked on the site only.
    if (!forumId || appealIsQuiet(db, row)) { mark(); return; }
    const card = appealCard(db, row, publicUrl);

    if (!row.forum_thread_id) {
      const made = await transport.threads.createForumPost(forumId, { name: `Appeal #${row.id}: ${row.appellant_name}`.slice(0, 100), message: card, tags: ['Appeal'] });
      try {
        db.prepare('UPDATE appeals SET forum_thread_id = ?, forum_message_id = ?, forum_state = ? WHERE id = ?')
          .run(made.threadId, made.messageId, row.state, row.id);
      } catch (err) {
        await transport.threads.deleteThread(made.threadId).catch(() => {});
        throw err;
      }
      if (!OPEN_STATES.includes(row.state)) await this.close(made.threadId);
      return;
    }

    if (!(await transport.threads.exists(row.forum_thread_id))) { mark(); return; }
    if (await transport.threads.isArchived(row.forum_thread_id)) await transport.threads.setArchived(row.forum_thread_id, false);
    await transport.edit(row.forum_thread_id, row.forum_message_id ?? row.forum_thread_id, card);
    // A short line too, because an edit notifies nobody.
    await transport.send(row.forum_thread_id, { content: `Status: ${STATE_LABEL[row.state]}`, embeds: [], components: [], mentionUserIds: [] });
    mark();
    if (!OPEN_STATES.includes(row.state)) await this.close(row.forum_thread_id);
  }

  private async close(threadId: string): Promise<void> {
    await this.deps.transport.threads.setLocked(threadId, true);
    await this.deps.transport.threads.setArchived(threadId, true);
  }
}
