import { groupLabel, roleOf, type Role } from './eventText';
import type { TimelineEntry, TimelineEvent } from './timeline';

/** One mark on the scrub bar or one line in the rail. `role` is which side
 *  the selected player was on, or null when nobody is selected or the entry
 *  is chat (chat has no side). */
export interface Tick {
  entry: TimelineEntry;
  role: Role | null;
}

/**
 * What to show for a selection.
 *
 * Nobody selected: everything, unsided. A player selected: the events they
 * were actor or target of, plus their own chat lines. The follow row is the
 * selector (spec 7.2), so `selected` is the SteamID64 in the followed slot;
 * an empty slot has '' there, which must select nothing rather than match
 * every event with an unrostered actor.
 */
export function tickEntries(timeline: TimelineEntry[], selected: string | null): Tick[] {
  if (selected === null) return timeline.map((entry) => ({ entry, role: null }));
  if (selected === '') return [];
  const out: Tick[] = [];
  for (const entry of timeline) {
    if (entry.kind === 'chat') {
      if (entry.actor === selected) out.push({ entry, role: null });
      continue;
    }
    const role = roleOf(entry, selected);
    if (role) out.push({ entry, role });
  }
  return out;
}

export interface TickGroup {
  key: string;
  label: string;
  role: Role;
  items: { entry: TimelineEvent; role: Role }[];
}

/**
 * The selected player's events by kind and side, for the rail's headings:
 * "Got boomed x3", "Pounces x2". Biggest group first so the thing that
 * happened most is the first thing read; ties keep round order.
 */
export function groupTicks(ticks: Tick[]): TickGroup[] {
  const groups = new Map<string, TickGroup>();
  for (const t of ticks) {
    if (t.entry.kind !== 'event' || t.role === null) continue;
    const key = `${t.entry.event}:${t.role}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, label: groupLabel(t.entry.event, t.role), role: t.role, items: [] };
      groups.set(key, g);
    }
    g.items.push({ entry: t.entry, role: t.role });
  }
  return [...groups.values()].sort(
    (a, b) => b.items.length - a.items.length || a.items[0].entry.seq - b.items[0].entry.seq,
  );
}
