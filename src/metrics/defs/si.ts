import { STATE } from '../../replayFormat.js';
import type { MetricDef, RoundCtx, RoundEvent } from '../types.js';
import { FRAME_DT_CAP_MS } from '../replayRound.js';
import { classAt, countByPhase, kind, perMinute, ratioByPhase, sideStat, single } from '../kit.js';

const SMOKER = 1, BOOMER = 2, HUNTER = 3;
const spawnsOf = (c: RoundCtx, cls: number) => kind(c, 'si_spawn').filter((e) => e.value === cls);
const pinsBy = (c: RoundCtx, cls: number) =>
  kind(c, 'pinned').filter((e) => e.tMs >= 0 && classAt(c, e.actor, e.tMs) === cls);
const CLEAR_WINDOW_MS = 30_000;

/** skill_detect adds a `target` on `skeet` and emits `dp` (a 400-unit-plus
 *  pounce) at all. Before the feed existed, neither can be trusted, so
 *  metrics built on them fall back to the round's start date when the round
 *  itself has no stats to say skill_detect was loaded. */
export const SKEET_FEED_SINCE = '2026-09-19 00:00:00';
const skillEvents = (c: RoundCtx): boolean =>
  c.hasStats ? c.skillDetect : (c.startedAt !== null && c.startedAt >= SKEET_FEED_SINCE);

/** For each smoker pin, whether (and how fast) it was answered: a `cleared`
 *  on the same survivor before the survivor was pinned again (or 30 s
 *  passed), whichever comes first. A clear that lands after the survivor
 *  was re-pinned belongs to that later pin, not this one. */
function smokerClears(c: RoundCtx): { pin: RoundEvent; clearMs: number | null }[] {
  const allPins = kind(c, 'pinned');
  const clears = kind(c, 'cleared');
  return pinsBy(c, SMOKER).map((p) => {
    const nextPin = allPins
      .filter((e) => e.target === p.target && e.tMs > p.tMs)
      .reduce<RoundEvent | null>((min, e) => (min === null || e.tMs < min.tMs ? e : min), null);
    const windowEnd = Math.min(p.tMs + CLEAR_WINDOW_MS, nextPin ? nextPin.tMs : Infinity);
    const cl = clears.find((e) => e.target === p.target && e.tMs >= p.tMs && e.tMs < windowEnd);
    return { pin: p, clearMs: cl ? cl.tMs - p.tMs : null };
  });
}

/** Seconds a hunter stayed alive, one entry per life. Sums per-frame gaps
 *  (capped at FRAME_DT_CAP_MS, same cap the replay's own duration uses) while
 *  the slot holds the class, alive and not a ghost. A life still open at the
 *  last frame is dropped: its true end is unknown. */
function lifetimesOf(c: RoundCtx, cls: number): number[] | null {
  if (!c.replay) return null;
  const fs = c.replay.frames;
  const lives: number[] = [];
  for (let slot = 0; slot < 8; slot++) {
    let sum = 0;
    let alive = false;
    for (let i = 0; i < fs.length; i++) {
      const p = fs[i].players[slot];
      const up = p.infected === true && p.cls === cls && (p.state & STATE.ALIVE) !== 0 && (p.state & STATE.GHOST) === 0;
      if (up) {
        alive = true;
        if (i + 1 < fs.length) sum += Math.min(fs[i + 1].tMs - fs[i].tMs, FRAME_DT_CAP_MS);
      } else if (alive) {
        lives.push(sum);
        sum = 0;
        alive = false;
      }
    }
  }
  return lives;
}

export const defs: MetricDef[] = [
  { id: 'hunter.spawns', group: 'hunter', version: 1, description: 'Hunter spawns per round.',
    compute: (c) => countByPhase(c, spawnsOf(c, HUNTER)) },
  { id: 'hunter.skeet_rate', group: 'hunter', version: 2, description: 'Skeets per hunter spawn.',
    public: { label: 'Hunters skeeted' },
    compute: (c) => (skillEvents(c)
      ? ratioByPhase(c, kind(c, 'skeet').filter((e) => e.target !== null), spawnsOf(c, HUNTER))
      : null) },
  { id: 'hunter.high_pounce_rate', group: 'hunter', version: 1,
    description: "Pounces from 400 units up or higher (skill_detect's height rule), per hunter spawn.",
    compute: (c) => (skillEvents(c) ? ratioByPhase(c, kind(c, 'dp'), spawnsOf(c, HUNTER)) : null) },
  { id: 'hunter.high_pounce_avg_damage', group: 'hunter', version: 1,
    description: "skill_detect's estimated damage of a 400-unit-plus pounce.",
    compute: (c) => (skillEvents(c) ? ratioByPhase(c, kind(c, 'dp'), kind(c, 'dp'), (e) => e.value) : null) },
  { id: 'hunter.pounce_rate', group: 'hunter', version: 1, description: 'Pounces that pinned a survivor, per hunter spawn.',
    compute: (c) => ratioByPhase(c, pinsBy(c, HUNTER), spawnsOf(c, HUNTER)) },
  { id: 'hunter.damage_per_spawn', group: 'hunter', version: 1, description: 'Damage hunters dealt to standing survivors, per hunter spawn.',
    public: { label: 'Hunter damage per spawn' },
    compute: (c) => {
      const n = spawnsOf(c, HUNTER).length;
      return c.hasStats && n > 0 ? single(sideStat(c, 'infected', 'dmg_as_hunter'), n) : null;
    } },
  { id: 'hunter.lifetime_s', group: 'hunter', version: 2, description: 'Seconds a hunter stayed alive after spawning.',
    compute: (c) => { const l = lifetimesOf(c, HUNTER); return l && l.length ? single(l.reduce((a, b) => a + b, 0) / 1000, l.length) : null; } },
  { id: 'smoker.spawns', group: 'smoker', version: 1, description: 'Smoker spawns per round.',
    compute: (c) => countByPhase(c, spawnsOf(c, SMOKER)) },
  { id: 'smoker.pull_rate', group: 'smoker', version: 2,
    description: 'Pulls that pinned a survivor, per smoker spawn (can exceed 1: smokers re-grab after a broken tongue).',
    public: { label: 'Smoker pulls per spawn' },
    compute: (c) => ratioByPhase(c, pinsBy(c, SMOKER), spawnsOf(c, SMOKER)) },
  { id: 'smoker.clear_time_s', group: 'smoker', version: 2,
    description: 'Seconds until a pulled survivor was freed by a teammate killing the smoker.',
    compute: (c) => {
      let sum = 0, n = 0;
      for (const r of smokerClears(c)) if (r.clearMs !== null) { sum += r.clearMs; n++; }
      return n ? single(sum / 1000, n) : null;
    } },
  { id: 'smoker.kill_clear_share', group: 'smoker', version: 1,
    description: 'Pulls where the survivor was freed by a teammate killing the smoker, per smoker pull.',
    compute: (c) => {
      const rows = smokerClears(c);
      return rows.length ? single(rows.filter((r) => r.clearMs !== null).length, rows.length) : null;
    } },
  { id: 'boomer.spawns', group: 'boomer', version: 1, description: 'Boomer spawns per round.',
    compute: (c) => countByPhase(c, spawnsOf(c, BOOMER)) },
  { id: 'boomer.boomed_per_spawn', group: 'boomer', version: 2, description: 'Survivors covered in bile, per boomer spawn.',
    public: { label: 'Survivors boomed per boomer' },
    compute: (c) => ratioByPhase(c, kind(c, 'boom').filter((e) => classAt(c, e.actor, e.tMs) === BOOMER), spawnsOf(c, BOOMER)) },
  { id: 'boomer.pop_rate', group: 'boomer', version: 1, description: 'Boomers popped before they could vomit, per boomer spawn.',
    public: { label: 'Boomers popped before vomiting' },
    compute: (c) => {
      const n = spawnsOf(c, BOOMER).length;
      return c.skillDetect && n > 0 ? single(sideStat(c, 'survivor', 'boomer_pops'), n) : null;
    } },
  { id: 'si.pins_per_min', group: 'si', version: 1, description: 'Pins (pounces and pulls) per playing minute.',
    public: { label: 'Pins per minute' },
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
