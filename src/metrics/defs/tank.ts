import type { MetricDef, RoundCtx } from '../types.js';
import { classAt, kind, onSide, sideStat, single } from '../kit.js';

const TANK = 5;

/** Tanks in the round. With a replay, the timeline's tank-alive intervals
 *  are the ground truth (an AI tank, or a passed tank, or a repeated
 *  `tank_spawn` from a frustration pass, all just extend or don't extend
 *  that interval). Without a replay, walk events in order: `tank_spawn` or
 *  `tank_take` starts a tank only if one isn't already alive (so a passed
 *  tank, or a duplicate spawn event, doesn't get double-counted), and
 *  `tank_death` ends it. */
export function tankCount(c: RoundCtx): number {
  if (c.timeline) return c.timeline.tank.length;
  let n = 0;
  let alive = false;
  for (const e of c.events) {
    if (e.kind === 'tank_spawn' || e.kind === 'tank_take') {
      if (!alive) { n++; alive = true; }
    } else if (e.kind === 'tank_death') {
      alive = false;
    }
  }
  return n;
}

const perTank = (num: number, c: RoundCtx) => (tankCount(c) > 0 ? single(num, tankCount(c)) : null);
const byTank = (c: RoundCtx, k: 'incap' | 'death') =>
  kind(c, k).filter((e) => e.target !== null && e.tMs >= 0 && classAt(c, e.target, e.tMs) === TANK);

export const defs: MetricDef[] = [
  {
    id: 'tank.spawns', group: 'tank', version: 2,
    description: 'Tanks per round.',
    compute: (c) => single(tankCount(c)),
  },
  {
    id: 'tank.killed_rate', group: 'tank', version: 3,
    description: 'Share of tanks the survivors killed.',
    compute: (c) => {
      const n = tankCount(c);
      if (n === 0) return null;
      // `tank_death` also fires with the tank player himself as the actor when
      // the tank is passed to another player on frustration (plugin/pug-match.sp,
      // Event_PlayerDeath around line 4034). Only actors on the survivor side
      // are actual kills.
      const kills = kind(c, 'tank_death').filter((e) => onSide(c, e.actor, 'survivor')).length;
      return single(kills, n);
    },
  },
  {
    id: 'tank.lifetime_s', group: 'tank', version: 2,
    description: 'Seconds a tank stayed alive, from spawn to death or round end.',
    compute: (c) => {
      const iv = c.timeline?.tank ?? [];
      if (iv.length === 0) return null;
      return single(iv.reduce((s, x) => s + (x.to - x.from), 0) / 1000, iv.length);
    },
  },
  {
    id: 'tank.damage_per_tank', group: 'tank', version: 2,
    description: 'Damage the tank dealt to survivors, per tank.',
    compute: (c) => (c.hasStats ? perTank(sideStat(c, 'infected', 'dmg_as_tank'), c) : null),
  },
  {
    id: 'tank.punches_per_tank', group: 'tank', version: 2,
    description: 'Tank punches that landed, per tank.',
    compute: (c) => (c.hasStats ? perTank(sideStat(c, 'infected', 'tank_punches'), c) : null),
  },
  {
    id: 'tank.rocks_per_tank', group: 'tank', version: 2,
    description: 'Tank rocks that hit a survivor, per tank.',
    compute: (c) => (c.skillDetect ? perTank(sideStat(c, 'infected', 'tank_rocks_landed'), c) : null),
  },
  {
    id: 'tank.incaps_caused', group: 'tank', version: 2,
    description: 'Survivor incaps caused by the tank player, per tank.',
    compute: (c) => perTank(byTank(c, 'incap').length, c),
  },
  {
    id: 'tank.deaths_caused', group: 'tank', version: 2,
    description: 'Survivor deaths caused by the tank player, per tank.',
    compute: (c) => perTank(byTank(c, 'death').length, c),
  },
  {
    id: 'tank.rock_skeets', group: 'tank', version: 2,
    description: 'Tank rocks shot out of the air, per tank.',
    compute: (c) => (c.skillDetect ? perTank(sideStat(c, 'survivor', 'rock_skeets'), c) : null),
  },
];
