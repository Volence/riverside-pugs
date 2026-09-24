import type { MetricDef, RoundCtx } from '../types.js';
import { kind, sideStat, single } from '../kit.js';
import { MERGE_GAP_MS, witchesIn } from '../timeline.js';

/** Witch appearances: rising edges of "this witch entity is present", merged
 *  across short gaps and summed per entity ref, so two witches present at
 *  once (different refs) count as two, not one. */
export function witchCount(c: RoundCtx): number | null {
  if (!c.replay) return null;
  const lastSeen = new Map<number, number>();
  let n = 0;
  for (const f of c.replay.frames) {
    for (const w of witchesIn(f)) {
      const last = lastSeen.get(w.ref) ?? -Infinity;
      if (f.tMs - last > MERGE_GAP_MS) n++;
      lastSeen.set(w.ref, f.tMs);
    }
  }
  return n;
}

const perWitch = (c: RoundCtx, num: number) => {
  const w = witchCount(c);
  return w ? single(num, w) : null;
};

export const defs: MetricDef[] = [
  {
    id: 'witch.count', group: 'witch', version: 2,
    description: 'Witches per round.',
    compute: (c) => { const w = witchCount(c); return w === null ? null : single(w); },
  },
  {
    id: 'witch.crown_rate', group: 'witch', version: 2,
    description: 'Crowns (one-shot witch kills) per witch.',
    compute: (c) => (c.skillDetect ? perWitch(c, sideStat(c, 'survivor', 'crowns')) : null),
  },
  {
    id: 'witch.draw_crown_rate', group: 'witch', version: 2,
    description: 'Draw crowns (witch killed after chip damage) per witch.',
    compute: (c) => (c.skillDetect ? perWitch(c, sideStat(c, 'survivor', 'draw_crowns')) : null),
  },
  {
    id: 'witch.startle_rate', group: 'witch', version: 2,
    description: 'Share of witches that got startled.',
    compute: (c) => perWitch(c, kind(c, 'witch_aggro').length),
  },
  {
    id: 'witch.kill_rate', group: 'witch', version: 2,
    description: 'Share of witches killed.',
    compute: (c) => perWitch(c, kind(c, 'witch_killed').length),
  },
  {
    id: 'witch.incaps', group: 'witch', version: 2,
    description: 'Survivor incaps with no player attacker while a witch was near, per witch.',
    compute: (c) => {
      if (!c.timeline) return null;
      const n = kind(c, 'incap').filter((e) => e.target === null && e.tMs >= 0 && c.timeline!.phaseAt(e.tMs) === 'witch').length;
      return perWitch(c, n);
    },
  },
];
