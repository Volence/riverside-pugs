import { burstMaxTicks } from '../../src/inputStats.js';
import { rng } from '../inputSim.js';
import type { StoredSample } from './wheelSamples.js';

/**
 * What a real 100 tick sample would have looked like on a server at another
 * tick rate, for the tickrate tests. Deterministic: the same seed gives the
 * same burst.
 *
 * A reading is a window, not a time: a press seen on tick k happened in the
 * 10 ms before it. So each press and each release is put back at a real time
 * inside its window, moved to milliseconds, and sampled again on the new
 * rate's grid. Intervals and holds are rebuilt from those times, never by
 * scaling a tick count and rounding it.
 *
 * Which time inside the window: the one nearest a five-press moving average
 * of the readings. Picking uniformly at random would add a second 10 ms of
 * quantisation noise on top of the one already in the reading, which turns a
 * device that really was flat into a jittery one no 128 tick server would
 * ever have seen. The moving average keeps a device as flat as it was and a
 * hand as irregular as it was (a hand's spread is far wider than the window).
 * The jitter that IS realistic is added: where the new grid falls against the
 * presses (one random phase per seed) and a millisecond either way per press
 * for client frame timing.
 *
 * One exception, on purpose: a one-tick hold stays one tick. It is a wheel
 * notch or a script tap, down for exactly one usercmd whatever the rate, not
 * 10 ms of finger.
 *
 * A value at the 100 tick cap means "30 or more" and stays at the new cap.
 */
export function atRate(sample: StoredSample, rate: number, seed: number): StoredSample {
  const r = rng(seed);
  const msPerTick = 1000 / rate;
  const cap100 = burstMaxTicks(100);
  const cap = burstMaxTicks(rate);
  const phase = r() * msPerTick;
  const jitter = (): number => (r() - 0.5) * 2;
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo + 0.01, v));
  // Press i was seen on 100 tick tick seen[i]: it happened in (seen - 1, seen] ticks.
  const seen: number[] = [0];
  for (const t of sample.intervals) seen.push(seen[seen.length - 1] + t);
  const mid = seen.map((s) => s * 10 - 5);
  // The hold a press was meant to have, from its neighbours, as a time.
  const typical = sample.holds.map((h) => (h >= cap100 || h === 1 ? NaN : h * 10));
  const want = sample.holds.map((_, i) => {
    const near = typical.slice(Math.max(0, i - 2), i + 3).filter((v) => !Number.isNaN(v));
    return near.length ? near.reduce((a, b) => a + b, 0) / near.length : NaN;
  });
  // A press's window, narrowed by its release when that leaves anything: a
  // 3 tick reading of a 35 ms hold says the press came late in its tick.
  const pressWindow = (s: number, i: number): [number, number] => {
    const lo = (s - 1) * 10, hi = s * 10, h = sample.holds[i];
    if (h === undefined || h === 1 || h >= cap100 || Number.isNaN(want[i])) return [lo, hi];
    const rlo = (s + h - 1) * 10 - want[i], rhi = (s + h) * 10 - want[i];
    return Math.max(lo, rlo) < Math.min(hi, rhi) ? [Math.max(lo, rlo), Math.min(hi, rhi)] : [lo, hi];
  };
  // The burst's own clock: each gap is one beat of the median or, for a
  // skipped beat, two. Each press is then pulled toward where its neighbours'
  // beat puts it, never out of its window, until it settles.
  const sorted = [...sample.intervals].sort((x, y) => x - y);
  const med = sorted[Math.floor(sorted.length / 2)];
  const beats: number[] = [0];
  for (const t of sample.intervals) beats.push(beats[beats.length - 1] + Math.max(1, Math.round(t / med)));
  const windows = seen.map((s, i) => pressWindow(s, i));
  const p = seen.map((_, i) => clamp(mid[i], windows[i][0], windows[i][1]));
  for (let pass = 0; pass < 40; pass++) {
    for (let i = 0; i < p.length; i++) {
      const a = Math.max(0, i - 3), z = Math.min(p.length - 1, i + 3);
      if (beats[z] === beats[a]) continue;
      const period = (p[z] - p[a]) / (beats[z] - beats[a]);
      let sum = 0, n = 0;
      for (let j = a; j <= z; j++) if (j !== i) { sum += p[j] + (beats[i] - beats[j]) * period; n++; }
      p[i] = clamp(sum / n, windows[i][0], windows[i][1]);
    }
  }
  const pressMs = seen.map((s, i) => clamp(p[i] + jitter(), (s - 1) * 10, s * 10));
  const tickOf = (ms: number): number => Math.ceil((ms + phase) / msPerTick);
  const ticks: number[] = [];
  for (const ms of pressMs) {
    // Two presses need a released usercmd between them, so at least a tick.
    ticks.push(ticks.length ? Math.max(tickOf(ms), ticks[ticks.length - 1] + 1) : tickOf(ms));
  }
  const intervals = sample.intervals.map((t100, i) =>
    t100 >= cap100 ? cap : Math.min(cap, ticks[i + 1] - ticks[i]));
  const holds = sample.holds.map((h100, i) => {
    if (h100 === 1) return 1;
    if (h100 >= cap100) return cap;
    const k = Math.min(i, seen.length - 1);
    // Released in the 10 ms before the 100 tick sample h100 ticks after the press was seen.
    const lo = (seen[k] + h100 - 1) * 10, hi = (seen[k] + h100) * 10;
    const releaseMs = clamp(clamp(pressMs[k] + want[i], lo, hi) + jitter(), lo, hi);
    return Math.min(cap, Math.max(1, tickOf(releaseMs) - ticks[k]));
  });
  return { intervals, holds };
}

/** Holds of one tick for every press, the shape a wheel or a tapping script
 *  sends: for samples stored without holds. */
export const tapped = (intervals: number[]): StoredSample => ({ intervals, holds: intervals.map(() => 1).concat(1) });

/** A stall gap (server ticks with no usercmd) at another rate: the stall
 *  lasted somewhere inside the half tick either side of its reading. */
export function gapAtRate(gap100: number, rate: number, r: () => number): number {
  return Math.max(1, Math.round((gap100 - 0.5 + r()) * rate / 100));
}

/** A bhop line at another rate: the server tick scales, ground 0 (a jump on
 *  the landing usercmd) stays 0, any other ground time is time. */
export function hopAtRate([g, t]: readonly [number, number], rate: number, r: () => number): [number, number] {
  const ground = g === 0 ? 0 : Math.max(1, Math.round((g - 0.5 + r()) * rate / 100));
  return [ground, Math.round((t + r()) * rate / 100)];
}
