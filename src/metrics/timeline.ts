import { ENTITY_KIND, STATE, type EntitySample, type Frame, type PlayerSample } from '../replayFormat.js';
import { dist2d, isLiveSurvivor } from '../integrity/geometry.js';
import { FRAME_DT_CAP_MS } from './replayRound.js';
import type { Interval, Phase, RoundReplay, SubPhase, Timeline } from './types.js';

export const WITCH_NEAR_UNITS = 1000;
export const MERGE_GAP_MS = 2000;
export const PANIC_WINDOW_MS = 45_000;
const TANK_CLS = 5;
const LAST_FRAME_MS = 100;

export function tankAlive(f: Frame): boolean {
  if (f.entities.some((e) => e.kind === ENTITY_KIND.TANK_AI)) return true;
  return f.players.some((p) => p.infected === true && p.cls === TANK_CLS
    && (p.state & STATE.ALIVE) !== 0 && (p.state & STATE.GHOST) === 0);
}

export function liveSurvivors(f: Frame): PlayerSample[] {
  return f.players.filter((p) => p.infected === false && isLiveSurvivor(p));
}

export function witchesIn(f: Frame): EntitySample[] {
  return f.entities.filter((e) => e.kind === ENTITY_KIND.WITCH);
}

function witchNear(f: Frame): boolean {
  const ws = witchesIn(f);
  if (ws.length === 0) return false;
  const ss = liveSurvivors(f);
  return ws.some((w) => ss.some((s) => dist2d(w, s) <= WITCH_NEAR_UNITS));
}

/** Intervals where `flag` holds, from frame times, merged across short gaps. */
function intervalsOf(fs: Frame[], flag: (f: Frame) => boolean): Interval[] {
  const out: Interval[] = [];
  for (let i = 0; i < fs.length; i++) {
    if (!flag(fs[i])) continue;
    const from = fs[i].tMs;
    const to = i + 1 < fs.length ? fs[i + 1].tMs : fs[i].tMs + LAST_FRAME_MS;
    const last = out[out.length - 1];
    if (last && from - last.to <= MERGE_GAP_MS) last.to = Math.max(last.to, to);
    else out.push({ from, to });
  }
  return out;
}

function mergeAll(xs: Interval[]): Interval[] {
  const s = [...xs].sort((a, b) => a.from - b.from);
  const out: Interval[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.from <= last.to) last.to = Math.max(last.to, x.to);
    else out.push({ ...x });
  }
  return out;
}

const inAny = (xs: Interval[], t: number) => xs.some((x) => t >= x.from && t < x.to);

export function buildTimeline(replay: RoundReplay, marks: { kind: string; tMs: number }[]): Timeline {
  const fs = replay.frames;
  const end = fs[fs.length - 1].tMs + LAST_FRAME_MS;
  const tank = intervalsOf(fs, tankAlive);
  const witch = intervalsOf(fs, witchNear);
  const event = mergeAll(marks.filter((m) => m.tMs >= 0).map((m) => (
    m.kind === 'panic' ? { from: m.tMs, to: m.tMs + PANIC_WINDOW_MS } : { from: m.tMs, to: end })));

  const phaseAt = (t: number): SubPhase =>
    inAny(tank, t) ? 'tank' : inAny(witch, t) ? 'witch' : inAny(event, t) ? 'event' : 'normal';

  const ms: Record<SubPhase, number> = { tank: 0, witch: 0, event: 0, normal: 0 };
  for (let i = 0; i < fs.length; i++) {
    const dt = i + 1 < fs.length ? Math.min(fs[i + 1].tMs - fs[i].tMs, FRAME_DT_CAP_MS) : LAST_FRAME_MS;
    ms[phaseAt(fs[i].tMs)] += dt;
  }
  return {
    durationMs: replay.durationMs, tank, witch, event, phaseAt,
    minutes: (p: Phase) => (p === 'all' ? replay.durationMs : ms[p]) / 60_000,
  };
}
