import { dist2d } from '../../integrity/geometry.js';
import type { MetricDef, MetricOut, Phase } from '../types.js';
import { SUB_PHASES } from '../types.js';
import { countByPhase, kind, perMinute, sideStat } from '../kit.js';
import { liveSurvivors } from '../timeline.js';

export const defs: MetricDef[] = [
  {
    id: 'pace.si_damage_per_min', group: 'pace', version: 2,
    description: 'Damage special infected dealt to standing survivors per playing minute.',
    compute: (c) => {
      if (!c.hasStats || !c.timeline) return null;
      const m = c.timeline.minutes('all');
      const dmg = sideStat(c, 'infected', 'damage_as_si') - sideStat(c, 'infected', 'dmg_to_incapped');
      return m > 0 ? { all: { num: dmg, den: m } } : null;
    },
  },
  {
    id: 'pace.ff_per_min', group: 'pace', version: 1,
    description: 'Friendly fire damage per playing minute.',
    compute: (c) => perMinute(c, kind(c, 'ff'), (e) => e.value),
  },
  {
    id: 'pace.incaps_per_min', group: 'pace', version: 1,
    description: 'Survivor incaps per playing minute.',
    compute: (c) => perMinute(c, kind(c, 'incap')),
  },
  {
    id: 'pace.deaths_per_min', group: 'pace', version: 1,
    description: 'Survivor deaths with a player killer per playing minute.',
    compute: (c) => perMinute(c, kind(c, 'death')),
  },
  {
    id: 'pace.revives', group: 'pace', version: 2,
    description: 'Revives per round.',
    compute: (c) => countByPhase(c, kind(c, 'revive')),
  },
  {
    id: 'pace.pin_gap_s', group: 'pace', version: 1,
    description: 'Average seconds between one pin and the next.',
    compute: (c) => {
      const ts = kind(c, 'pinned').map((e) => e.tMs).filter((t) => t >= 0).sort((a, b) => a - b);
      if (ts.length < 2) return null;
      let sum = 0;
      for (let i = 1; i < ts.length; i++) sum += ts[i] - ts[i - 1];
      return { all: { num: sum / 1000, den: ts.length - 1 } };
    },
  },
  {
    id: 'pace.survivor_spread', group: 'pace', version: 1,
    description: 'Average distance in game units between standing survivors.',
    compute: (c) => {
      if (!c.replay || !c.timeline) return null;
      const sum: Record<Phase, number> = { all: 0, tank: 0, witch: 0, event: 0, normal: 0 };
      const n: Record<Phase, number> = { all: 0, tank: 0, witch: 0, event: 0, normal: 0 };
      for (const f of c.replay.frames) {
        const s = liveSurvivors(f);
        if (s.length < 2) continue;
        let d = 0, pairs = 0;
        for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) { d += dist2d(s[i], s[j]); pairs++; }
        const mean = d / pairs;
        const p = c.timeline.phaseAt(f.tMs);
        sum.all += mean; n.all++;
        sum[p] += mean; n[p]++;
      }
      if (n.all === 0) return null;
      const out: MetricOut = { all: { num: sum.all, den: n.all } };
      for (const p of SUB_PHASES) if (n[p] > 0) out[p] = { num: sum[p], den: n[p] };
      return out;
    },
  },
];
