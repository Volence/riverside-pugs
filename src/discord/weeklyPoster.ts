import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { addWeeks, weekStartOf } from '../weeklyAwards.js';
import { freezeWeek, frozenWeek } from '../weeklyStore.js';
import type { BotTransport } from './transport.js';
import { renderAwards, renderRecap } from './weeklyCard.js';

const TICK_MS = 60 * 60_000;

/**
 * Freezes the week that just closed and posts it: the recap, then the awards.
 *
 * Same shape as ModCallPoster: one promise chain, a timer, and the database
 * is the queue. Each message id is stored the moment Discord accepts it and
 * posted_at only once both are in, so a restart or an outage between the two
 * sends resends only the missing one and never posts a week twice.
 *
 * Only the week before the current one is ever frozen here, so weeks from
 * before this shipped are left alone (scripts/weekly-awards.ts freezes one by
 * hand).
 */
export class WeeklyPoster {
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: { db: DB; transport: BotTransport; publicUrl: string; tickMs?: number; now?: () => Date }) {}

  start(): void {
    void this.tickNow();
    const every = this.deps.tickMs ?? TICK_MS;
    if (every > 0) {
      this.timer = setInterval(() => { void this.tickNow(); }, every);
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

  tickNow(): Promise<void> {
    this.chain = this.chain.then(() => this.tick()).catch((err) => console.error('[weekly] tick failed:', err));
    return this.chain;
  }

  private async tick(): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const week = addWeeks(weekStartOf((this.deps.now ?? (() => new Date()))()), -1);
    freezeWeek(db, week);
    const channelId = getSetting(db, 'discord_weekly_channel_id') ?? '';
    if (!channelId) return;
    const row = db.prepare(
      'SELECT recap_message_id, awards_message_id, posted_at FROM weekly_award_weeks WHERE week_start = ?',
    ).get(week) as { recap_message_id: string | null; awards_message_id: string | null; posted_at: string | null } | undefined;
    if (!row || row.posted_at) return;
    const f = frozenWeek(db, week)!;
    try {
      if (!row.recap_message_id) {
        const id = await transport.send(channelId, renderRecap(f, publicUrl));
        db.prepare('UPDATE weekly_award_weeks SET recap_message_id = ? WHERE week_start = ?').run(id, week);
      }
      if (!row.awards_message_id) {
        const awards = renderAwards(f, publicUrl);
        // A week with no awards has nothing to send; mark it done.
        const id = awards ? await transport.send(channelId, awards) : '';
        db.prepare('UPDATE weekly_award_weeks SET awards_message_id = ? WHERE week_start = ?').run(id, week);
      }
      db.prepare("UPDATE weekly_award_weeks SET posted_at = datetime('now') WHERE week_start = ?").run(week);
    } catch (err) {
      console.error('[weekly] post failed:', err);
    }
  }
}
