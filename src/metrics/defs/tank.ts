import { STATE, type Frame } from '../../replayFormat.js';
import type { MetricDef, RoundCtx, RoundEvent } from '../types.js';
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

/** The frame closest in time to `tMs` (frames are in time order). */
function frameNearest(fs: Frame[], tMs: number): Frame {
  let lo = 0, hi = fs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fs[mid].tMs < tMs) lo = mid + 1; else hi = mid;
  }
  return lo > 0 && tMs - fs[lo - 1].tMs <= fs[lo].tMs - tMs ? fs[lo - 1] : fs[lo];
}

/** Was `steamid` playing a live tank at `tMs`? With a replay that has a slot
 *  for the player, the replay decides: a frustration pass gives the new
 *  holder the tank with no tank_spawn or tank_take event, so the event rule
 *  alone misses everything the second holder does. Without a replay, or when
 *  the replay has no slot for the player, fall back to the event rule. */
function isTankAt(c: RoundCtx, steamid: string, tMs: number): boolean {
  const slot = c.replay && c.replay.frames.length > 0 ? c.replay.slots.indexOf(steamid) : -1;
  if (slot >= 0) {
    const f = frameNearest(c.replay!.frames, tMs);
    const p = f.players.find((x) => x.slot === slot) ?? f.players[slot];
    return p !== undefined && p.infected === true && p.cls === TANK
      && (p.state & STATE.ALIVE) !== 0 && (p.state & STATE.GHOST) === 0;
  }
  return classAt(c, steamid, tMs) === TANK;
}

const byTank = (c: RoundCtx, k: 'incap' | 'death') =>
  kind(c, k).filter((e) => e.target !== null && e.tMs >= 0 && isTankAt(c, e.target, e.tMs));

/** `tank_death` events that were survivor kills. The event also fires with
 *  the tank player himself as the actor when the tank is passed to another
 *  player on frustration (plugin/pug-match.sp, Event_PlayerDeath around line
 *  4034); only actors on the survivor side are actual kills. */
const survivorKills = (c: RoundCtx): RoundEvent[] => kind(c, 'tank_death').filter((e) => onSide(c, e.actor, 'survivor'));

/** How close (ms) a tank interval's end must be to a survivor kill to count
 *  as that kill. */
export const KILL_MATCH_MS = 1500;

export const defs: MetricDef[] = [
  {
    id: 'tank.spawns', group: 'tank', version: 2,
    description: 'Tanks per round.',
    compute: (c) => single(tankCount(c)),
  },
  {
    id: 'tank.killed_rate', group: 'tank', version: 4,
    description: 'Share of tanks the survivors killed.',
    compute: (c) => {
      const n = tankCount(c);
      if (n === 0) return null;
      // Capped at the tank count: without a replay an AI tank has no
      // tank_spawn, so its kill can outnumber the tanks the events show.
      return single(Math.min(survivorKills(c).length, n), n);
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
    id: 'tank.lifetime_killed_s', group: 'tank', version: 1,
    description: 'Seconds a tank lived, counting only tanks the survivors killed (not cut short by the round ending).',
    compute: (c) => {
      const iv = c.timeline?.tank ?? [];
      const kills = survivorKills(c).filter((e) => e.tMs >= 0);
      let sum = 0, n = 0;
      for (const x of iv) {
        if (!kills.some((e) => Math.abs(e.tMs - x.to) <= KILL_MATCH_MS)) continue;
        sum += x.to - x.from;
        n++;
      }
      return n > 0 ? single(sum / 1000, n) : null;
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
    id: 'tank.incaps_caused', group: 'tank', version: 3,
    description: 'Survivor incaps caused by the tank player, per tank.',
    compute: (c) => perTank(byTank(c, 'incap').length, c),
  },
  {
    id: 'tank.deaths_caused', group: 'tank', version: 3,
    description: 'Survivor deaths caused by the tank player, per tank.',
    compute: (c) => perTank(byTank(c, 'death').length, c),
  },
  {
    id: 'tank.rock_skeets', group: 'tank', version: 2,
    description: 'Tank rocks shot out of the air, per tank.',
    compute: (c) => (c.skillDetect ? perTank(sideStat(c, 'survivor', 'rock_skeets'), c) : null),
  },
];
