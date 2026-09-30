import type { DB } from '../db.js';
import { completedPug } from '../matchKinds.js';
import { getSetting } from '../settings.js';
import { findSkeetStreaks } from '../skeetStreaks.js';
import { renderSkeetStreak, type SkeetStreakRow } from './skeetStreakCard.js';
import type { BotTransport } from './transport.js';

const TICK_MS = 2 * 60_000;
/** A pending row whose match ended longer ago than this is skipped rather
 *  than sent, so turning the weekly channel on for the first time (or back on
 *  after a long outage) does not flood it with weeks-old bursts nobody is
 *  still talking about. */
const STALE_MS = 7 * 24 * 60 * 60_000;

/** The first moment this feature can announce a match for. Matches that
 *  ended before it shipped are never announced: nobody was watching for
 *  their skeets in real time and a triple from months ago is not news. */
export const SKEET_STREAKS_SINCE = '2026-09-28 02:00:00';

/**
 * Finds triple-or-better skeet bursts in matches as they complete and posts
 * them to the weekly channel, with a link to the moment in the replay
 * viewer.
 *
 * Same shape as ModCallPoster and WeeklyPoster: one promise chain, a timer,
 * and the database is the queue. A match is scanned once (skeet_streak_scans
 * records that) and every streak found is stored in skeet_streaks before
 * anything is sent, so a Discord outage or a restart between finding a burst
 * and posting it loses nothing: the next tick just resumes sending whatever
 * is still pending.
 *
 * A match voided after its burst already went out is retracted: the posted
 * message is deleted and the row is marked 'retracted', never re-sent. A
 * match voided before its burst was ever sent just stays pending forever
 * (nothing public to take down).
 */
export class SkeetStreakPoster {
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
    this.chain = this.chain.then(() => this.tick()).catch((err) => console.error('[skeetstreak] tick failed:', err));
    return this.chain;
  }

  private async tick(): Promise<void> {
    const { db, transport, publicUrl } = this.deps;
    const now = (this.deps.now ?? (() => new Date()))();

    // 1. Scan every completed, non-voided match that ended after the feature
    //    shipped and has not been scanned yet.
    const matches = db.prepare(
      `SELECT id FROM matches
       WHERE ${completedPug()} AND voided_at IS NULL AND ended_at >= ?
         AND id NOT IN (SELECT match_id FROM skeet_streak_scans)`,
    ).all(SKEET_STREAKS_SINCE) as { id: number }[];
    const insertStreak = db.prepare(
      `INSERT OR IGNORE INTO skeet_streaks (match_id, player_id, map_ordinal, half, t_ms, count, span_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertScan = db.prepare('INSERT INTO skeet_streak_scans (match_id, scanned_at) VALUES (?, ?)');
    // matches.ended_at and skeet_streak_scans.scanned_at are both stored as
    // 'YYYY-MM-DD HH:MM:SS' (see reapOrphanedMatches in src/liveView.ts for
    // the same idiom); toISOString()'s 'T...Z' shape compares wrong against
    // them, especially same-day.
    const stamp = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
    for (const { id } of matches) {
      const streaks = findSkeetStreaks(db, id);
      db.transaction(() => {
        for (const s of streaks) insertStreak.run(s.matchId, s.steamid, s.mapOrdinal, s.half, s.tMs, s.count, s.spanMs);
        insertScan.run(id, stamp(now));
      })();
    }

    // 2. A pending row from a match that ended long enough ago is stale news:
    //    marked skipped rather than left to flood the channel the day it is
    //    finally switched on.
    const cutoff = stamp(new Date(now.getTime() - STALE_MS));
    db.prepare(
      `UPDATE skeet_streaks SET posted_at = 'skipped'
       WHERE posted_at IS NULL AND match_id IN (SELECT id FROM matches WHERE ended_at < ?)`,
    ).run(cutoff);

    const channelId = getSetting(db, 'discord_weekly_channel_id') ?? '';

    // 3. Retraction (owner's ruling): a burst that was posted and whose match
    //    is later voided must not stay up in public. Needs the channel it was
    //    posted to, so a blank channel just leaves it for a later tick, same
    //    as everything else here. transport.remove already treats a message
    //    that is gone from Discord as success, not a throw, so that case
    //    falls straight through to being marked retracted too.
    if (channelId) {
      const toRetract = db.prepare(
        `SELECT s.* FROM skeet_streaks s JOIN matches m ON m.id = s.match_id
         WHERE s.message_id IS NOT NULL AND s.posted_at != 'retracted' AND m.voided_at IS NOT NULL`,
      ).all() as SkeetStreakRow[];
      for (const row of toRetract) {
        try {
          await transport.remove(channelId, row.message_id!);
          db.prepare(
            `UPDATE skeet_streaks SET posted_at = 'retracted'
             WHERE match_id = ? AND player_id = ? AND map_ordinal = ? AND half = ? AND t_ms = ?`,
          ).run(row.match_id, row.player_id, row.map_ordinal, row.half, row.t_ms);
        } catch (err) {
          // Left as posted, message_id intact: the next tick tries the
          // removal again.
          console.error('[skeetstreak] retract failed:', err);
        }
      }
    }

    // 4. Send whatever is still pending, oldest match first. A blank channel
    //    leaves every row pending for the next tick. A match voided after it
    //    was scanned but before it was ever sent is never sent at all: it
    //    just stays pending (never became public, so there is nothing to
    //    retract either).
    if (!channelId) return;
    const pending = db.prepare(
      `SELECT s.* FROM skeet_streaks s JOIN matches m ON m.id = s.match_id
       WHERE s.posted_at IS NULL AND m.voided_at IS NULL
       ORDER BY m.ended_at, s.map_ordinal, s.half, s.t_ms`,
    ).all() as SkeetStreakRow[];
    for (const row of pending) {
      try {
        const messageId = await transport.send(channelId, renderSkeetStreak(db, row, publicUrl));
        db.prepare(
          `UPDATE skeet_streaks SET message_id = ?, posted_at = datetime('now')
           WHERE match_id = ? AND player_id = ? AND map_ordinal = ? AND half = ? AND t_ms = ?`,
        ).run(messageId, row.match_id, row.player_id, row.map_ordinal, row.half, row.t_ms);
      } catch (err) {
        // Left pending: the next tick tries it again.
        console.error('[skeetstreak] post failed:', err);
      }
    }
  }
}
