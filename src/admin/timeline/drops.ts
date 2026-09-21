import type { DB } from '../../db.js';
import { STREAK_WINDOW_MS } from '../../signonDrops.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

export interface DropRow {
  id: number; steamid: string; name: string; secs_connected: number;
  forced_count: number; at: string; entered_after_at: string | null;
}

/** Rows of signon_drops, newest last per player, as both callers want them. */
const SELECT = `SELECT id, steamid, name, secs_connected, forced_count, at, entered_after_at FROM signon_drops`;

/**
 * Which of these drops are repeats.
 *
 * One connect drop is retry noise: a cancelled loading screen looks exactly
 * like a rejected file, and listing everybody who ever cancelled one would
 * bury the thing this is for. A repeat is what the admin feed already calls
 * one: a second drop inside ten minutes with no clean entry between them.
 *
 * entered_after_at is stamped on every pending drop the moment the steamid
 * is seen in game, so an earlier drop whose stamp falls before this one had
 * an entry in between and the run is broken.
 */
export function repeatDropIds(rows: DropRow[]): Set<number> {
  const out = new Set<number>();
  const byPlayer = new Map<string, DropRow[]>();
  for (const r of rows) byPlayer.set(r.steamid, [...(byPlayer.get(r.steamid) ?? []), r]);
  for (const list of byPlayer.values()) {
    const sorted = [...list].sort((a, b) => Date.parse(toIso(a.at)) - Date.parse(toIso(b.at)));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const at = Date.parse(toIso(sorted[i].at));
      const entryBetween = prev.entered_after_at !== null
        && Date.parse(toIso(prev.entered_after_at)) < at;
      if (at - Date.parse(toIso(prev.at)) <= STREAK_WINDOW_MS && !entryBetween) out.add(sorted[i].id);
    }
  }
  return out;
}

/** Connects that ended before the player was in game on a map that forced
 *  files. A hint at a rejected modified file, never proof of one, and the
 *  summary carries the other reading rather than leaving it to be known. */
export const dropsAdapter: TimelineAdapter = {
  source: 'drop',
  items({ db, ids }): TimelineItem[] {
    const rows = db.prepare(
      `${SELECT} WHERE steamid IN (${marks(ids)}) ORDER BY at DESC, id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as DropRow[];
    const repeats = repeatDropIds(rows);
    return rows.map((r) => ({
      at: toIso(r.at),
      source: 'drop' as const,
      kind: repeats.has(r.id) ? 'repeat' : 'drop',
      summary: `Dropped while connecting as ${r.name}`
        + `${r.secs_connected < 0 ? '' : ` after ${r.secs_connected} s`}`
        + `, ${r.forced_count} files enforced.`
        + (repeats.has(r.id)
          ? ' Second drop inside ten minutes with no clean entry between: likely a rejected game file.'
          : ' A cancelled loading screen looks the same, so one of these says nothing.')
        + (r.entered_after_at === null ? ' They have not got in since.' : ''),
      matchId: null,
      replay: null,
      ref: { type: 'signon_drop', id: r.id },
    }));
  },
  evidence(db: DB) {
    // Bounded rather than the whole table: only the newest repeat per player
    // can be newer than a review, and this runs on every Needs a look.
    const rows = db.prepare(`${SELECT} ORDER BY id DESC LIMIT 5000`).all() as DropRow[];
    const repeats = repeatDropIds(rows);
    const newest = new Map<string, string>();
    for (const r of rows.filter((x) => repeats.has(x.id))) {
      const at = toIso(r.at);
      if (!newest.has(r.steamid) || newest.get(r.steamid)! < at) newest.set(r.steamid, at);
    }
    return [...newest].map(([steamid, at]) => ({ steamid, at }));
  },
};
