import type { StatDef, MatchPlayerStats } from './api';

/**
 * One team's stats, split into what they did as survivors and what they did as
 * infected.
 *
 * This needs no round data, which is why it works on matches recorded long
 * before round capture existed. A survivor-side stat can only accrue while its
 * owner is playing survivor, so the registry's `side` field already partitions
 * the bag. Same argument that let sub-project 6a cut its snapshot table.
 *
 * A key with no side in the registry is dropped rather than assigned one. An
 * unrecognised key has no side to reason about, and filing it under the wrong
 * half would be worse than leaving it out.
 */
export interface SideTotals {
  survivor: Record<string, number>;
  infected: Record<string, number>;
}

export function sideTotals(
  players: MatchPlayerStats[], team: 'a' | 'b', defs: StatDef[],
): SideTotals {
  const sideOf = new Map(defs.map((d) => [d.key, d.side]));
  const out: SideTotals = { survivor: {}, infected: {} };
  for (const p of players) {
    if (p.team !== team) continue;
    for (const [key, value] of Object.entries(p.stats ?? {})) {
      const side = sideOf.get(key);
      if (!side) continue;
      const bucket = side === 'survivor' ? out.survivor : out.infected;
      bucket[key] = (bucket[key] ?? 0) + value;
    }
  }
  return out;
}
