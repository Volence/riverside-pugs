import type { DB } from '../db.js';
import { NEWS_CHANNEL_SETTING, type NewsRow } from '../news.js';
import { getSetting } from '../settings.js';
import { newsPayload } from './newsCard.js';
import type { BotTransport } from './transport.js';

const TICK_MS = 5 * 60_000;

/**
 * Keeps the news channel in step with news_posts (src/news.ts has the state
 * each row carries).
 *
 * Same shape as the other posters: one promise chain, a timer, and the
 * database is the queue. A route writes the row and asks for a pass on that
 * one post, so the editor usually sees the result straight away; the timer
 * retries whatever Discord refused. A Discord failure is written to the row
 * for the editor and never undoes the publish.
 */
export class NewsPoster {
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: { db: DB; transport: BotTransport; publicUrl: string; tickMs?: number }) {}

  start(): void {
    void this.sync();
    const every = this.deps.tickMs ?? TICK_MS;
    if (every > 0) {
      this.timer = setInterval(() => { void this.sync(); }, every);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  idle(): Promise<void> {
    return this.chain;
  }

  /** One pass, over one post or every post with work waiting. Never rejects. */
  sync(id?: number): Promise<void> {
    this.chain = this.chain.then(() => this.pass(id)).catch((err) => console.error('[news] pass failed:', err));
    return this.chain;
  }

  private async pass(id?: number): Promise<void> {
    const { db } = this.deps;
    const rows = (id === undefined
      ? db.prepare("SELECT * FROM news_posts WHERE discord_state IN ('pending', 'remove') ORDER BY id").all()
      : db.prepare("SELECT * FROM news_posts WHERE id = ? AND discord_state IN ('pending', 'remove')").all(id)) as NewsRow[];
    for (const row of rows) {
      try {
        if (row.discord_state === 'remove') await this.remove(row);
        else await this.post(row);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[news] post ${row.id} failed:`, err);
        db.prepare('UPDATE news_posts SET discord_error = ? WHERE id = ?').run(msg.slice(0, 300), row.id);
      }
    }
  }

  private async post(row: NewsRow): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const payload = newsPayload(row, publicUrl);
    // The state is only cleared when the row has not changed since it was
    // read: an edit saved while Discord was answering keeps it pending for
    // another pass, and an unpublish or delete in that window takes the new
    // message straight back down.
    const done = (messageId: string, channelId: string) => db.prepare(
      `UPDATE news_posts SET discord_message_id = ?, discord_channel_id = ?, discord_error = NULL,
         discord_state = CASE
           WHEN published_at IS NULL THEN 'remove'
           WHEN updated_at = ? AND published_at IS ? THEN NULL
           ELSE discord_state END
       WHERE id = ?`,
    ).run(messageId, channelId, row.updated_at, row.published_at, row.id);
    if (row.discord_message_id && row.discord_channel_id) {
      if (await transport.edit(row.discord_channel_id, row.discord_message_id, payload)) {
        done(row.discord_message_id, row.discord_channel_id);
        return;
      }
      // Deleted by hand. The post is being edited or published again, so
      // it goes back up as a new message in the channel set now.
    }
    const channel = (getSetting(db, NEWS_CHANNEL_SETTING) ?? '').trim();
    if (!channel) {
      db.prepare("UPDATE news_posts SET discord_state = 'skipped', discord_message_id = NULL, discord_channel_id = NULL WHERE id = ?").run(row.id);
      return;
    }
    const messageId = await transport.send(channel, payload);
    done(messageId, channel);
  }

  private async remove(row: NewsRow): Promise<void> {
    const { db, transport } = this.deps;
    if (row.discord_message_id && row.discord_channel_id) {
      // A message already gone from Discord is not an error to remove().
      await transport.remove(row.discord_channel_id, row.discord_message_id);
    }
    if (row.deleted_at) {
      db.prepare("DELETE FROM news_posts WHERE id = ? AND discord_state = 'remove'").run(row.id);
      return;
    }
    db.prepare(
      `UPDATE news_posts SET discord_message_id = NULL, discord_channel_id = NULL, discord_error = NULL,
         discord_state = CASE WHEN discord_state = 'remove' THEN NULL ELSE discord_state END
       WHERE id = ?`,
    ).run(row.id);
  }
}
