import type { DB } from './db.js';

/** A skeet 5 seconds after the one before it is not the same burst as three
 *  in one; MIN is what turns a burst into something worth telling anyone
 *  about (a plain double happens too often to be an announcement). */
export const STREAK_WINDOW_MS = 5000;
export const STREAK_MIN = 3;

export interface SkeetStreak {
  matchId: number;
  steamid: string;
  mapOrdinal: number;
  half: number;
  tMs: number;
  count: number;
  spanMs: number;
}

/**
 * Triple-or-better skeet bursts in one match, read straight from
 * match_live_events. Pure: no writes, and safe to call on a match repeatedly.
 *
 * Skeets are grouped by (actor, map_ordinal, half): a burst never crosses a
 * half or a map, and never crosses players. Within a group, sorted by time,
 * a greedy scan anchors a window on the first skeet of a candidate run and
 * grows it while the next skeet still lands inside STREAK_WINDOW_MS of that
 * anchor. Once a run is long enough it is reported once (never as several
 * overlapping triples) and the scan resumes after it, so a run whose overall
 * span outgrows the window before six skeets can still close into two
 * triples rather than one. A run that never reaches STREAK_MIN just advances
 * one skeet at a time. Events with t_ms = -1 (time unknown) are skipped.
 */
export function findSkeetStreaks(db: DB, matchId: number): SkeetStreak[] {
  const rows = db.prepare(
    `SELECT actor, map_ordinal AS mapOrdinal, half, t_ms AS tMs FROM match_live_events
     WHERE match_id = ? AND kind = 'skeet' AND t_ms != -1
     ORDER BY actor, map_ordinal, half, t_ms`,
  ).all(matchId) as { actor: string; mapOrdinal: number; half: number; tMs: number }[];

  const streaks: SkeetStreak[] = [];
  let groupKey = '';
  let times: number[] = [];
  let current: { actor: string; mapOrdinal: number; half: number } | null = null;

  const flush = (): void => {
    if (!current) return;
    for (const [i, j] of streakRuns(times, STREAK_MIN)) {
      streaks.push({
        matchId, steamid: current.actor, mapOrdinal: current.mapOrdinal, half: current.half,
        tMs: times[i]!, count: j - i + 1, spanMs: times[j]! - times[i]!,
      });
    }
  };

  for (const r of rows) {
    const key = `${r.actor}\u0000${r.mapOrdinal}\u0000${r.half}`;
    if (key !== groupKey) {
      flush();
      groupKey = key;
      times = [];
      current = { actor: r.actor, mapOrdinal: r.mapOrdinal, half: r.half };
    }
    times.push(r.tMs);
  }
  flush();

  return streaks;
}

/**
 * The greedy scan findSkeetStreaks uses, on one player's sorted skeet times in
 * one map half: [first, last] index pairs of each run of at least `min`
 * skeets, every one within STREAK_WINDOW_MS of the run's first. Exported so
 * the caster studio's DOUBLE / TRIPLE SKEET cards count exactly as the
 * Discord post does.
 */
export function streakRuns(times: readonly number[], min: number): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < times.length) {
    let j = i;
    while (j + 1 < times.length && times[j + 1]! - times[i]! <= STREAK_WINDOW_MS) j++;
    if (j - i + 1 >= min) {
      out.push([i, j]);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}
