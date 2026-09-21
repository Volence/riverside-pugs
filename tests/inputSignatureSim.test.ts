import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THRESHOLDS, MIN_POUNCE_INTERVALS, burstStats, matchDetections, type SignatureBurst,
} from '../src/inputStats.js';
import { burst, human, macro, rng, uniform, type Presser } from './inputSim.js';

/**
 * Calibration by simulation, seeded so a failure reproduces.
 *
 * The thresholds were first set by argument and were wrong twice, so they are
 * now pinned by a Monte Carlo built on the owner's real-client measurements
 * (tests/inputSim.ts): a hand peaks near 8 presses/s at cv 0.39, a macro holds
 * 13/s, and 25 ms of jitter buys the macro a human-looking cv but not a human
 * rate. A "match" here is deliberately the worst legitimate case: the player
 * mashes at their PEAK through every airborne phase of the match.
 */

const claw = (intervals: number[]): SignatureBurst => ({ kind: 'pounce', weapon: 'weapon_hunter_claw', intervals });

/** Hunter airborne phases run from a short hop to a long leap: the measured
 *  ones were 0.57 s to 2.03 s, plus one freak 3.81 s. */
const phase = (p: Presser, r: () => number): number[] => burst(p, uniform(r, 500, 2000), r);

function flaggedMatches(p: Presser, phasesPerMatch: number, matches: number, seed: number): number {
  const r = rng(seed);
  let flagged = 0;
  for (let m = 0; m < matches; m++) {
    const bursts = Array.from({ length: phasesPerMatch }, () => claw(phase(p, r)));
    if (matchDetections(bursts, DEFAULT_THRESHOLDS).some((d) => d.signature === 'pounce_spam')) flagged++;
  }
  return flagged / matches;
}

describe('pounce_spam calibration', () => {
  // What shipped first: mean interval <= 12 ticks (8.3/s) over 4 intervals, one
  // phase enough, severity high. 8.3/s IS the measured human peak, so a legit
  // fast clicker tripped it on close to half of their airborne phases. Kept as
  // a test so nobody moves the threshold back toward the hand.
  it('the old 12 tick rule flagged a legit 8/s clicker on a large share of phases', () => {
    const r = rng(1);
    let hit = 0;
    const trials = 5000;
    for (let i = 0; i < trials; i++) {
      const iv = phase(human(8), r);
      if (iv.length >= 4 && burstStats(iv).meanTicks <= 12) hit++;
    }
    expect(hit / trials).toBeGreaterThan(0.3);
  });

  it('flags a legit 8/s, cv 0.39 clicker in well under 1% of matches', () => {
    // 60 airborne phases, every one mashed at peak rate: far more than a real
    // half as hunter produces, which is the point.
    expect(flaggedMatches(human(8), 60, 2000, 2)).toBeLessThan(0.005);
  });

  it('keeps a margin above the measured peak: a 9/s hand stays under 2%', () => {
    expect(flaggedMatches(human(9), 60, 1000, 3)).toBeLessThan(0.02);
  });

  it('flags a perfect 13/s macro in nearly every match, on only ten pounces', () => {
    expect(flaggedMatches(macro(13), 10, 1000, 4)).toBeGreaterThan(0.99);
  });

  it('flags a 13/s macro with 25 ms of jitter in nearly every match too', () => {
    expect(flaggedMatches(macro(13, 25), 10, 1000, 5)).toBeGreaterThan(0.99);
  });

  it('never fires on a single phase, however fast', () => {
    const one = [claw(Array.from({ length: 40 }, () => 7))];
    expect(matchDetections(one, DEFAULT_THRESHOLDS)).toEqual([]);
  });

  it('the simulator reproduces the measured cv, so the rates above mean something', () => {
    const r = rng(6);
    const h = burstStats(burst(human(8), 60_000, r));
    expect(h.ratePerSec).toBeGreaterThan(7.5);
    expect(h.ratePerSec).toBeLessThan(8.5);
    expect(h.cv).toBeGreaterThan(0.33);
    expect(h.cv).toBeLessThan(0.45);
    const j = burstStats(burst(macro(13, 25), 12_000, r));
    expect(j.cv).toBeGreaterThan(0.25);      // measured 0.320
    expect(j.cv).toBeLessThan(0.4);
    expect(MIN_POUNCE_INTERVALS).toBeGreaterThanOrEqual(6);
  });
});
