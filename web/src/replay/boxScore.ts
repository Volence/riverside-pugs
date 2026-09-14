import { roleOf, type Role } from './eventText';
import type { TimelineEntry } from './timeline';

/** One column of the running box score: an event kind seen from one side of
 *  it. `sum` columns add the event's value (damage) instead of counting. */
export interface BoxColumn {
  key: string;
  label: string;
  event: string;
  role: Role;
  sum?: boolean;
}

export type BoxSide = 'survivor' | 'infected';

/**
 * What each side's table can show. A round keeps a player on one side the
 * whole way through, so the survivor columns are what a survivor does and
 * has done to them, and the infected columns the same from the other chair.
 * Counts come from the round's events only (spec: events carry timing,
 * never totals), so a dropped datagram is a count one short, and the
 * authoritative numbers stay the match page's dump-derived tables.
 */
export const BOX_COLUMNS: Record<BoxSide, readonly BoxColumn[]> = {
  survivor: [
    { key: 'skeet', label: 'Skeets', event: 'skeet', role: 'did' },
    { key: 'cleared', label: 'Clears', event: 'cleared', role: 'did' },
    { key: 'tank_death', label: 'Tank kills', event: 'tank_death', role: 'did' },
    { key: 'revive', label: 'Revives', event: 'revive', role: 'did' },
    { key: 'ff', label: 'FF dmg', event: 'ff', role: 'did', sum: true },
    { key: 'pinned', label: 'Pinned', event: 'pinned', role: 'suffered' },
    { key: 'incap', label: 'Incaps', event: 'incap', role: 'suffered' },
    { key: 'death', label: 'Deaths', event: 'death', role: 'suffered' },
  ],
  infected: [
    { key: 'pinned', label: 'Pins', event: 'pinned', role: 'did' },
    { key: 'dp', label: 'Pounces', event: 'dp', role: 'did' },
    { key: 'dp_dmg', label: 'DP dmg', event: 'dp', role: 'did', sum: true },
    { key: 'boom', label: 'Booms', event: 'boom', role: 'did' },
    { key: 'incap', label: 'Incaps', event: 'incap', role: 'did' },
    { key: 'death', label: 'Kills', event: 'death', role: 'did' },
    { key: 'skeet', label: 'Skeeted', event: 'skeet', role: 'suffered' },
    { key: 'cleared', label: 'Cleared', event: 'cleared', role: 'suffered' },
  ],
};

/** One player's tallies at the playhead (inclusive), keyed by column. Every
 *  column is present, zero when nothing happened, so a table cell never
 *  reads undefined. */
export function boxScore(
  timeline: readonly TimelineEntry[], tMs: number, steamid: string, side: BoxSide,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of BOX_COLUMNS[side]) out[c.key] = 0;
  for (const e of timeline) {
    if (e.kind !== 'event' || e.tMs > tMs) continue;
    const role = roleOf(e, steamid);
    if (!role) continue;
    for (const c of BOX_COLUMNS[side]) {
      if (c.event !== e.event || c.role !== role) continue;
      out[c.key] += c.sum ? Math.max(0, e.value) : 1;
    }
  }
  return out;
}

/** The side's columns whose kind occurs anywhere in the round. Decided from
 *  the whole timeline, not the part behind the playhead, so the table's
 *  shape is fixed for the round and numbers fill in rather than columns
 *  appearing mid-play. */
export function columnsPresent(timeline: readonly TimelineEntry[], side: BoxSide): BoxColumn[] {
  const kinds = new Set<string>();
  for (const e of timeline) if (e.kind === 'event') kinds.add(e.event);
  return BOX_COLUMNS[side].filter((c) => kinds.has(c.event));
}
