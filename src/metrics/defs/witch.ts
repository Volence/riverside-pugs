import type { MetricDef, RoundCtx } from '../types.js';
import { kind, sideStat, single } from '../kit.js';
import { MERGE_GAP_MS, witchesIn } from '../timeline.js';

/** Witch appearances: rising edges of "a witch exists", merged across short gaps. */
export function witchCount(c: RoundCtx): number | null {
  if (!c.replay) return null;
  let n = 0;
  let lastSeen = -Infinity;
  for (const f of c.replay.frames) {
    if (witchesIn(f).length === 0) continue;
    if (f.tMs - lastSeen > MERGE_GAP_MS) n++;
    lastSeen = f.tMs;
  }
  return n;
}

const perWitch = (c: RoundCtx, num: number) => {
  const w = witchCount(c);
  return w ? single(num, w) : null;
};

export const defs: MetricDef[] = [
  {
    id: 'witch.count', group: 'witch', version: 1,
    description: 'Witches per round.',
    compute: (c) => { const w = witchCount(c); return w === null ? null : single(w); },
  },
  {
    id: 'witch.crown_rate', group: 'witch', version: 1,
    description: 'Crowns (one-shot witch kills) per witch.',
    compute: (c) => (c.skillDetect ? perWitch(c, sideStat(c, 'survivor', 'crowns')) : null),
  },
  {
    id: 'witch.draw_crown_rate', group: 'witch', version: 1,
    description: 'Draw crowns (witch killed after chip damage) per witch.',
    compute: (c) => (c.skillDetect ? perWitch(c, sideStat(c, 'survivor', 'draw_crowns')) : null),
  },
  {
    id: 'witch.startle_rate', group: 'witch', version: 1,
    description: 'Share of witches that got startled.',
    compute: (c) => perWitch(c, kind(c, 'witch_aggro').length),
  },
  {
    id: 'witch.kill_rate', group: 'witch', version: 1,
    description: 'Share of witches killed.',
    compute: (c) => perWitch(c, kind(c, 'witch_killed').length),
  },
  {
    id: 'witch.incaps', group: 'witch', version: 1,
    description: 'Survivor incaps with no player attacker while a witch was near, per witch.',
    compute: (c) => {
      if (!c.timeline) return null;
      const n = kind(c, 'incap').filter((e) => e.target === null && e.tMs >= 0 && c.timeline!.phaseAt(e.tMs) === 'witch').length;
      return perWitch(c, n);
    },
  },
];
