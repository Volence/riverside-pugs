import { STATE } from '../../replayFormat.js';
import type { MetricDef, RoundCtx } from '../types.js';
import { classAt, countByPhase, kind, perMinute, ratioByPhase, sideStat, single } from '../kit.js';

const SMOKER = 1, BOOMER = 2, HUNTER = 3;
const spawnsOf = (c: RoundCtx, cls: number) => kind(c, 'si_spawn').filter((e) => e.value === cls);
const pinsBy = (c: RoundCtx, cls: number) =>
  kind(c, 'pinned').filter((e) => e.tMs >= 0 && classAt(c, e.actor, e.tMs) === cls);
const CLEAR_WINDOW_MS = 30_000;

function lifetimesOf(c: RoundCtx, cls: number): number[] | null {
  if (!c.replay) return null;
  const lives: number[] = [];
  for (let slot = 0; slot < 8; slot++) {
    let start: number | null = null;
    for (const f of c.replay.frames) {
      const p = f.players[slot];
      const up = p.infected === true && p.cls === cls && (p.state & STATE.ALIVE) !== 0 && (p.state & STATE.GHOST) === 0;
      if (up && start === null) start = f.tMs;
      if (!up && start !== null) { lives.push(f.tMs - start); start = null; }
    }
    if (start !== null) lives.push(c.replay.frames[c.replay.frames.length - 1].tMs - start);
  }
  return lives;
}

export const defs: MetricDef[] = [
  { id: 'hunter.spawns', group: 'hunter', version: 1, description: 'Hunter spawns per round.',
    compute: (c) => countByPhase(c, spawnsOf(c, HUNTER)) },
  { id: 'hunter.skeet_rate', group: 'hunter', version: 1, description: 'Skeets per hunter spawn.',
    compute: (c) => ratioByPhase(c, kind(c, 'skeet'), spawnsOf(c, HUNTER)) },
  { id: 'hunter.dp_rate', group: 'hunter', version: 1, description: 'Damage pounces per hunter spawn.',
    compute: (c) => ratioByPhase(c, kind(c, 'dp'), spawnsOf(c, HUNTER)) },
  { id: 'hunter.dp_avg_damage', group: 'hunter', version: 1, description: 'Average damage of a damage pounce.',
    compute: (c) => ratioByPhase(c, kind(c, 'dp'), kind(c, 'dp'), (e) => e.value) },
  { id: 'hunter.pounce_rate', group: 'hunter', version: 1, description: 'Pounces that pinned a survivor, per hunter spawn.',
    compute: (c) => ratioByPhase(c, pinsBy(c, HUNTER), spawnsOf(c, HUNTER)) },
  { id: 'hunter.damage_per_spawn', group: 'hunter', version: 1, description: 'Damage hunters dealt to standing survivors, per hunter spawn.',
    compute: (c) => {
      const n = spawnsOf(c, HUNTER).length;
      return c.hasStats && n > 0 ? single(sideStat(c, 'infected', 'dmg_as_hunter'), n) : null;
    } },
  { id: 'hunter.lifetime_s', group: 'hunter', version: 1, description: 'Seconds a hunter stayed alive after spawning.',
    compute: (c) => { const l = lifetimesOf(c, HUNTER); return l && l.length ? single(l.reduce((a, b) => a + b, 0) / 1000, l.length) : null; } },
  { id: 'smoker.spawns', group: 'smoker', version: 1, description: 'Smoker spawns per round.',
    compute: (c) => countByPhase(c, spawnsOf(c, SMOKER)) },
  { id: 'smoker.pull_rate', group: 'smoker', version: 1, description: 'Pulls that pinned a survivor, per smoker spawn.',
    compute: (c) => ratioByPhase(c, pinsBy(c, SMOKER), spawnsOf(c, SMOKER)) },
  { id: 'smoker.clear_time_s', group: 'smoker', version: 1, description: 'Seconds until a pulled survivor was freed by a teammate.',
    compute: (c) => {
      const clears = kind(c, 'cleared');
      let sum = 0, n = 0;
      for (const p of pinsBy(c, SMOKER)) {
        const cl = clears.find((e) => e.target === p.target && e.tMs >= p.tMs && e.tMs - p.tMs <= CLEAR_WINDOW_MS);
        if (cl) { sum += cl.tMs - p.tMs; n++; }
      }
      return n ? single(sum / 1000, n) : null;
    } },
  { id: 'boomer.spawns', group: 'boomer', version: 1, description: 'Boomer spawns per round.',
    compute: (c) => countByPhase(c, spawnsOf(c, BOOMER)) },
  { id: 'boomer.boomed_per_spawn', group: 'boomer', version: 1, description: 'Survivors covered in bile, per boomer spawn.',
    compute: (c) => ratioByPhase(c, kind(c, 'boom'), spawnsOf(c, BOOMER)) },
  { id: 'boomer.pop_rate', group: 'boomer', version: 1, description: 'Boomers popped before they could vomit, per boomer spawn.',
    compute: (c) => {
      const n = spawnsOf(c, BOOMER).length;
      return c.skillDetect && n > 0 ? single(sideStat(c, 'survivor', 'boomer_pops'), n) : null;
    } },
  { id: 'si.pins_per_min', group: 'si', version: 1, description: 'Pins (pounces and pulls) per playing minute.',
    compute: (c) => perMinute(c, kind(c, 'pinned')) },
  { id: 'si.kills_per_min', group: 'si', version: 1, description: 'Special infected killed by survivors per playing minute.',
    compute: (c) => {
      if (!c.hasStats || !c.timeline) return null;
      const m = c.timeline.minutes('all');
      return m > 0 ? { all: { num: sideStat(c, 'survivor', 'sikill'), den: m } } : null;
    } },
  { id: 'si.quad_caps', group: 'si', version: 1, description: 'Rounds where all four survivors were pinned at once and nobody recovered.',
    compute: (c) => (c.hasStats ? single(sideStat(c, 'infected', 'quad_caps')) : null) },
];
