import type { DB } from './db.js';
import type { QueueStint } from './queue.js';

/**
 * When people play, and how long the queue takes to pop.
 *
 * Two sources. Pops come from `matches` (every queue match row is one pop that
 * reached a campaign), which goes back to the first match, so the heatmap is
 * useful from the day this ships. Waits come from `queue_stints`, which only
 * starts filling when this ships, so every wait figure is null until there is
 * enough of it to say something (MIN_WAIT_SAMPLES).
 *
 * Everything is bucketed by UTC weekday and hour. The browser shifts the grid
 * into the viewer's own time zone, which the server has no business guessing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** The window the heatmap and waits are read over: four whole weeks, so
 *  every weekday is counted the same number of times. */
export const ACTIVITY_DAYS = 28;
/** Stint rows older than this are deleted as new ones arrive. Far longer than
 *  anything read, so a later question about waits can still be answered. */
const STINT_KEEP_DAYS = 180;
/** A median of fewer waits than this is noise, and is reported as null. */
export const MIN_WAIT_SAMPLES = 5;

export function recordQueueStint(db: DB, stint: QueueStint): void {
  try {
    db.prepare(
      'INSERT INTO queue_stints (player_id, joined_at, ended_at, outcome, requeued) VALUES (?, ?, ?, ?, ?)',
    ).run(stint.steamid, stint.joinedAt, stint.endedAt, stint.outcome, stint.requeued ? 1 : 0);
    db.prepare('DELETE FROM queue_stints WHERE ended_at < ?').run(stint.endedAt - STINT_KEEP_DAYS * DAY_MS);
  } catch (err) {
    // A stats row must never break the queue.
    console.error('[queueActivity] could not record a queue stint:', err);
  }
}

export interface QueueActivity {
  days: number;
  /** pops[utcWeekday][utcHour]: queue pops that became matches in the window.
   *  Weekday 0 is Sunday, as JavaScript's getUTCDay. */
  pops: number[][];
  totalPops: number;
  waits: {
    /** Median seconds from joining to the pop, for fresh stints that popped. */
    medianSec: number | null;
    /** The same, by the UTC hour the player joined. Null where too few. */
    byHourSec: (number | null)[];
    /** Fresh stints that popped, and that were abandoned, in the window. */
    popped: number;
    left: number;
    /** Median seconds someone who gave up waited before leaving. */
    leftMedianSec: number | null;
  };
}

function median(xs: number[]): number | null {
  if (xs.length < MIN_WAIT_SAMPLES) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

export function queueActivity(db: DB, now: number = Date.now()): QueueActivity {
  const since = now - ACTIVITY_DAYS * DAY_MS;
  // matches.created_at is SQLite's datetime('now'): UTC, 'YYYY-MM-DD HH:MM:SS'.
  const sinceText = new Date(since).toISOString().slice(0, 19).replace('T', ' ');
  const pops = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let totalPops = 0;
  const rows = db.prepare(
    `SELECT CAST(strftime('%w', created_at) AS INTEGER) AS dow, CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS n
     FROM matches WHERE origin = 'queue' AND created_at >= ? GROUP BY dow, hour`,
  ).all(sinceText) as { dow: number; hour: number; n: number }[];
  for (const r of rows) {
    if (r.dow >= 0 && r.dow < 7 && r.hour >= 0 && r.hour < 24) {
      pops[r.dow][r.hour] = r.n;
      totalPops += r.n;
    }
  }

  const stints = db.prepare(
    `SELECT joined_at, ended_at, outcome FROM queue_stints
     WHERE requeued = 0 AND ended_at >= ? AND ended_at >= joined_at`,
  ).all(since) as { joined_at: number; ended_at: number; outcome: 'popped' | 'left' }[];
  const all: number[] = [];
  const left: number[] = [];
  const byHour: number[][] = Array.from({ length: 24 }, () => []);
  for (const s of stints) {
    const sec = (s.ended_at - s.joined_at) / 1000;
    if (s.outcome === 'popped') {
      all.push(sec);
      byHour[new Date(s.joined_at).getUTCHours()].push(sec);
    } else {
      left.push(sec);
    }
  }
  return {
    days: ACTIVITY_DAYS,
    pops,
    totalPops,
    waits: {
      medianSec: median(all),
      byHourSec: byHour.map(median),
      popped: all.length,
      left: left.length,
      leftMedianSec: median(left),
    },
  };
}
