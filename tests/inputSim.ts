/**
 * Seeded input simulator for the signature calibration tests.
 *
 * Every number in here traces to the owner's real-client measurements in
 * docs/superpowers/specs/2026-09-21-input-macro-detection-design.md: a hand
 * clicking the pistol peaks near 8 presses/s (mean interval 125 ms, cv 0.39),
 * a macro holds 13/s, and 25 ms of gaussian jitter takes the macro's cv to
 * 0.32. The server samples buttons once per usercmd, so press times are
 * quantised to 10 ms ticks exactly as the plugin sees them.
 *
 * It is a model, not a recording. Its job is to make a threshold change show
 * its false positive and detection rates before it ships, not to prove them.
 */

import { burstMaxTicks } from '../src/inputStats.js';

const TICK_MS = 10;

/** mulberry32: tiny, seedable, and good enough for a Monte Carlo. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

export interface Presser { nextMs(r: () => number): number }

/** A hand: lognormal intervals (strictly positive, right skewed like the
 *  measured sample, whose min was 49 ms against a 125 ms mean). */
export function human(ratePerSec: number, cv = 0.39): Presser {
  const mean = 1000 / ratePerSec;
  const s2 = Math.log(1 + cv * cv);
  const mu = Math.log(mean) - s2 / 2;
  const s = Math.sqrt(s2);
  return { nextMs: (r) => Math.max(40, Math.exp(mu + s * gauss(r))) };
}

/** A script: a fixed period plus optional gaussian jitter on each sleep. */
export function macro(ratePerSec: number, jitterMs = 0): Presser {
  const period = 1000 / ratePerSec;
  return { nextMs: (r) => Math.max(TICK_MS, period + jitterMs * gauss(r)) };
}

/** Tick intervals between presses over `durationMs`, as the plugin records
 *  them: press times floored to ticks, zero-tick intervals impossible because
 *  a press edge needs a released sample in between. `rate` is the server's
 *  tick rate; at 100 this is exactly the calibrated simulator. */
export function burst(p: Presser, durationMs: number, r: () => number, rate = 100): number[] {
  const tickMs = rate === 100 ? TICK_MS : 1000 / rate;
  const cap = burstMaxTicks(rate);
  const out: number[] = [];
  let t = r() * tickMs + r() * p.nextMs(r);
  let lastTick = -1;
  while (t < durationMs) {
    const tick = Math.floor(t / tickMs);
    if (lastTick >= 0) {
      const d = tick - lastTick;
      if (d >= 1 && d <= cap) out.push(d);
    }
    lastTick = tick;
    t += p.nextMs(r);
  }
  return out;
}

export const uniform = (r: () => number, lo: number, hi: number): number => lo + r() * (hi - lo);
