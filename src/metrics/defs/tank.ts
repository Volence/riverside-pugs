import type { MetricDef, RoundCtx } from '../types.js';
import { classAt, kind, ratioByPhase, sideStat, single } from '../kit.js';

const TANK = 5;
const tanks = (c: RoundCtx) => kind(c, 'tank_spawn').length;
const perTank = (num: number, c: RoundCtx) => (tanks(c) > 0 ? single(num, tanks(c)) : null);
const byTank = (c: RoundCtx, k: 'incap' | 'death') =>
  kind(c, k).filter((e) => e.target !== null && e.tMs >= 0 && classAt(c, e.target, e.tMs) === TANK);

export const defs: MetricDef[] = [
  {
    id: 'tank.spawns', group: 'tank', version: 1,
    description: 'Tanks per round.',
    compute: (c) => single(tanks(c)),
  },
  {
    id: 'tank.killed_rate', group: 'tank', version: 1,
    description: 'Share of tanks the survivors killed.',
    compute: (c) => ratioByPhase(c, kind(c, 'tank_death'), kind(c, 'tank_spawn')),
  },
  {
    id: 'tank.lifetime_s', group: 'tank', version: 1,
    description: 'Seconds a tank stayed alive, from spawn to death or round end.',
    compute: (c) => {
      const iv = c.timeline?.tank ?? [];
      if (iv.length === 0) return null;
      return single(iv.reduce((s, x) => s + (x.to - x.from), 0) / 1000, iv.length);
    },
  },
  {
    id: 'tank.damage_per_tank', group: 'tank', version: 1,
    description: 'Damage the tank dealt to survivors, per tank.',
    compute: (c) => (c.hasStats ? perTank(sideStat(c, 'infected', 'dmg_as_tank'), c) : null),
  },
  {
    id: 'tank.punches_per_tank', group: 'tank', version: 1,
    description: 'Tank punches that landed, per tank.',
    compute: (c) => (c.hasStats ? perTank(sideStat(c, 'infected', 'tank_punches'), c) : null),
  },
  {
    id: 'tank.rocks_per_tank', group: 'tank', version: 1,
    description: 'Tank rocks that hit a survivor, per tank.',
    compute: (c) => (c.skillDetect ? perTank(sideStat(c, 'infected', 'tank_rocks_landed'), c) : null),
  },
  {
    id: 'tank.incaps_caused', group: 'tank', version: 1,
    description: 'Survivor incaps caused by the tank player, per tank.',
    compute: (c) => perTank(byTank(c, 'incap').length, c),
  },
  {
    id: 'tank.deaths_caused', group: 'tank', version: 1,
    description: 'Survivor deaths caused by the tank player, per tank.',
    compute: (c) => perTank(byTank(c, 'death').length, c),
  },
  {
    id: 'tank.rock_skeets', group: 'tank', version: 1,
    description: 'Tank rocks shot out of the air, per tank.',
    compute: (c) => (c.skillDetect ? perTank(sideStat(c, 'survivor', 'rock_skeets'), c) : null),
  },
];
