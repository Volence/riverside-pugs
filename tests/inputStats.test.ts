import { describe, it, expect } from 'vitest';
import { ICY_WHEEL, BELLINGHAM_TAPS, ICY_FAST_PISTOL, ICY_FAST_POUNCES, CARAMELLOW_SKIPS, MIRA_180 } from './fixtures/wheelSamples.js';
import { burstLabel, detectionLabel, isSteadyBurst } from '../src/inputStats.js';
import {
  BURST_MAX_TICKS, DEFAULT_THRESHOLDS, MAX_INTERVALS, PISTOL_REPEATS, POUNCE_REPEATS, burstStats, decodeIntervals,
  encodeIntervals, holdAnnotation, holdStats, matchDetections, pistolRate, pounceSpam,
} from '../src/inputStats.js';

describe('encodeIntervals / decodeIntervals', () => {
  it('round trips the whole legal range', () => {
    const all = Array.from({ length: BURST_MAX_TICKS }, (_, i) => i + 1);
    expect(decodeIntervals(encodeIntervals(all))).toEqual(all);
  });

  it('uses exactly one character per interval', () => {
    expect(encodeIntervals([1, 30, 15])).toHaveLength(3);
  });

  // The line travels on the same UDP stream as quoted chat, so the alphabet
  // must not contain a quote, a space or a backslash ANYWHERE in its range.
  // Base 33 passed a spot check on three values and still emitted a double
  // quote for 2 ticks and a single quote for 7.
  it('never emits a quote, space or backslash across the whole range', () => {
    const every = encodeIntervals(Array.from({ length: BURST_MAX_TICKS }, (_, i) => i + 1));
    expect(every).not.toMatch(/["'\s\\]/);
    expect(every).toMatch(/^[0-9:;<=>?@A-M]+$/);
  });

  // A burst closes at BURST_MAX_TICKS by definition, so nothing outside 1..30
  // can ever be produced by the plugin. A line carrying one is malformed or
  // forged, and must be refused rather than clamped into a plausible value.
  it('refuses characters outside the range a burst can produce', () => {
    expect(decodeIntervals(' ')).toBeNull();       // chr(32), far below 1 tick
    expect(decodeIntervals('/')).toBeNull();       // chr(47), one below 1 tick
    expect(decodeIntervals('N')).toBeNull();       // chr(78), one above 30 ticks
    expect(decodeIntervals('00~')).toBeNull();
    expect(decodeIntervals('')).toBeNull();
  });

  it('refuses more intervals than the plugin is capped at', () => {
    expect(decodeIntervals('0'.repeat(MAX_INTERVALS))).toHaveLength(MAX_INTERVALS);
    expect(decodeIntervals('0'.repeat(MAX_INTERVALS + 1))).toBeNull();
  });
});

describe('burstStats', () => {
  // The three runs below are the REAL measurements taken on the local server
  // 2026-09-20, reduced to tick intervals at 100 tick. They are fixtures rather
  // than invented numbers so that a change in the statistics is checked against
  // a human hand and a real macro, not against someone's intuition.
  const human = [5, 12, 9, 25, 7, 14, 11, 8, 19, 6, 13, 22, 10, 16, 9, 12, 7, 18, 11, 15];
  const perfect = [8, 7, 8, 8, 7, 8, 8, 7, 8, 8, 7, 8, 8, 7, 8, 8, 7, 8, 8, 7];
  const jittered = [6, 9, 7, 11, 5, 8, 10, 6, 9, 7, 12, 4, 8, 10, 6, 9, 7, 11, 5, 8];

  it('separates a machine-perfect macro from a hand by variance', () => {
    const h = burstStats(human), p = burstStats(perfect);
    expect(p.cv).toBeLessThan(0.15);
    expect(h.cv).toBeGreaterThan(0.3);
  });

  // The measurement that shaped the design: 25ms of jitter puts cv within reach
  // of a human, so a cv-only detector would catch nobody who tried. This test
  // exists to keep anyone from "fixing" it by tightening the threshold.
  it('does NOT separate a jittered macro from a hand by variance alone', () => {
    const h = burstStats(human), j = burstStats(jittered);
    expect(Math.abs(h.cv - j.cv)).toBeLessThan(0.15);
  });

  it('separates a jittered macro from a hand by sustained rate', () => {
    const h = burstStats(human), j = burstStats(jittered);
    expect(j.meanTicks).toBeLessThan(h.meanTicks);
    expect(j.ratePerSec).toBeGreaterThan(12);
    expect(h.ratePerSec).toBeLessThan(11);
  });

  it('counts the order dependent shape Oryx uses', () => {
    // sameAsNext only exists because the raw ordered intervals are stored; a
    // summary or a histogram could not produce it.
    expect(burstStats([8, 8, 8, 8]).sameAsNext).toBe(3);
    expect(burstStats([5, 20, 5, 20]).sameAsNext).toBe(0);
    expect(burstStats([8, 9, 8, 9]).closeToNext).toBe(3);
  });

  it('reports nothing useful for a burst too short to judge', () => {
    expect(burstStats([7]).n).toBe(1);
    expect(burstStats([7]).cv).toBe(0);
  });
});

describe('pounceSpam', () => {
  // Every array below is a REAL burst captured from a live client 2026-09-21.
  const claw = (intervals: number[]) => ({ kind: 'pounce', weapon: 'weapon_hunter_claw', intervals });
  const HUMAN_NORMAL = [18, 13];                       // 3 presses over 2.03s
  const HUMAN_MASHING = [21, 21, 19, 24, 20, 17, 15];  // 8 presses over 1.61s, as fast as a hand goes
  const MACRO_SHORT = [7, 8, 8, 7, 8, 8];              // 7 presses over 0.57s
  const MACRO_LONG = [8, 7, 8, 8, 7, 8, 8, 7, 8, 9, 5, 8, 7, 8, 8, 8];
  const RATE = DEFAULT_THRESHOLDS.pounceMinRate;

  it('does not mark a hand, even mashing as fast as it can', () => {
    expect(pounceSpam(claw(HUMAN_MASHING), RATE)).toBe(false);
    expect(pounceSpam(claw(HUMAN_NORMAL), RATE)).toBe(false);
  });

  // The threshold that shipped first was 12 ticks, 8.3/s, which is the measured
  // human PEAK on the pistol. A legit fast clicker sits right on it.
  it('does not mark a hand at the measured human peak of 8 presses a second', () => {
    expect(pounceSpam(claw([12, 13, 12, 13, 12, 13, 12, 13]), RATE)).toBe(false);
    expect(pounceSpam(claw([11, 11, 11, 11, 11, 11, 11, 11]), RATE)).toBe(false);   // 9.1/s
  });

  it('marks a macro on a SHORT pounce, which a count threshold missed', () => {
    // This is the case that killed the original design: 7 presses, under any
    // sane count threshold, but the interval gives it away regardless of how
    // long the player was airborne.
    expect(pounceSpam(claw(MACRO_SHORT), RATE)).toBe(true);
  });

  it('marks a macro on a long pounce too', () => {
    expect(pounceSpam(claw(MACRO_LONG), RATE)).toBe(true);
  });

  it('sits exactly on the rate: 12/s is a mean of 8.33 ticks', () => {
    expect(pounceSpam(claw([8, 8, 9, 8, 8, 9]), 12)).toBe(true);     // 50 ticks / 6 = 8.33
    expect(pounceSpam(claw([8, 9, 9, 8, 8, 9]), 12)).toBe(false);    // 51 ticks / 6 = 8.5
  });

  it('needs enough presses for the mean to mean anything', () => {
    expect(pounceSpam(claw([7, 8, 8, 7, 8]), RATE)).toBe(false);
  });

  it('only applies to the pounce anchor', () => {
    expect(pounceSpam({ kind: 'fire', weapon: 'weapon_hunter_claw', intervals: MACRO_LONG }, RATE)).toBe(false);
  });

  // The pounce anchor fires for anyone airborne. A survivor shooting while
  // falling logged a pounce burst on a live client, so without this filter a
  // survivor with a fire macro would be flagged for a hunter cheat.
  it('never marks a survivor who was merely airborne', () => {
    expect(pounceSpam({ kind: 'pounce', weapon: 'weapon_pistol', intervals: MACRO_LONG }, RATE)).toBe(false);
    expect(pounceSpam({ kind: 'pounce', weapon: '', intervals: MACRO_LONG }, RATE)).toBe(false);
  });
});

describe('matchDetections', () => {
  const fast = { kind: 'pounce', weapon: 'weapon_hunter_claw', intervals: [7, 8, 8, 7, 8, 8] };
  const slow = { kind: 'pounce', weapon: 'weapon_hunter_claw', intervals: [18, 21, 19, 20, 22, 18] };

  // One fast phase is an anecdote: a hand can get lucky on six intervals. The
  // same thing on several separate pounces in one match is a pattern.
  it('needs the signature to repeat across distinct airborne phases', () => {
    expect(matchDetections(Array(POUNCE_REPEATS - 1).fill(fast), DEFAULT_THRESHOLDS)).toEqual([]);
    const hit = matchDetections([slow, ...Array(POUNCE_REPEATS).fill(fast), slow], DEFAULT_THRESHOLDS);
    expect(hit).toEqual([{ signature: 'pounce_spam', qualifying: [1, 2, 3, 4] }]);
  });
});

describe('pistolRate', () => {
  const pistol = (intervals: number[]) => ({ kind: 'fire', weapon: 'weapon_pistol', intervals });
  const RATE = DEFAULT_THRESHOLDS.pistolMinRate;
  // 13/s aliases to 7s and 8s at 100 tick; this is the measured macro's shape.
  const macro = (n: number) => Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 7 : 8));
  const hand = (n: number) => Array.from({ length: n }, (_, i) => [12, 9, 17, 11, 14, 8, 13][i % 7]);

  it('marks three seconds at the macro rate', () => {
    expect(pistolRate(pistol(macro(45)), RATE)).toBe(true);
  });

  it('does not mark the same rate held for under three seconds', () => {
    // 30 intervals at ~7.7 ticks is 2.3 s. A hand can sprint; it cannot sustain.
    expect(pistolRate(pistol(macro(30)), RATE)).toBe(false);
  });

  it('does not mark a hand at its measured peak, however long the burst', () => {
    expect(pistolRate(pistol(hand(200)), RATE)).toBe(false);
  });

  // The mean over the WHOLE burst would let a macro hide by clicking slowly
  // for a few seconds after letting go of it, inside the same burst.
  it('finds a sustained window inside a longer, slower burst', () => {
    expect(pistolRate(pistol([...hand(20), ...macro(45), ...hand(40)]), RATE)).toBe(true);
  });

  // Jitter is symmetric, so it cannot move a three second mean: this is the
  // jittered run from the measurements, tiled to length.
  it('marks a jittered macro, which variance cannot separate from a hand', () => {
    const jittered = [6, 9, 7, 11, 5, 8, 10, 6, 9, 7, 12, 4, 8, 10, 6, 9, 7, 11, 5, 8];
    expect(pistolRate(pistol([...jittered, ...jittered, ...jittered]), RATE)).toBe(true);
  });

  it('only reads fire bursts on a pistol', () => {
    expect(pistolRate({ kind: 'fire', weapon: 'weapon_hunting_rifle', intervals: macro(60) }, RATE)).toBe(false);
    expect(pistolRate({ kind: 'pounce', weapon: 'weapon_pistol', intervals: macro(60) }, RATE)).toBe(false);
  });

  it('needs two such bursts in a match before it is a detection', () => {
    const one = matchDetections([pistol(macro(60))], DEFAULT_THRESHOLDS);
    const two = matchDetections([pistol(macro(60)), pistol(hand(50)), pistol(macro(50))], DEFAULT_THRESHOLDS);
    expect(PISTOL_REPEATS).toBe(2);
    expect(one).toEqual([]);
    expect(two).toEqual([{ signature: 'pistol_rate', qualifying: [0, 2] }]);
  });
});

describe('holdStats', () => {
  // How long each press was held down, in usercmds. It is what separates the
  // three things that all look the same by press rate.
  const WHEEL = [1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1];          // a wheel notch is down for one usercmd
  const FIXED = [3, 4, 3, 3, 4, 3, 4, 3, 3, 4, 3, 30];         // a 35 ms scripted hold, aliased; last one cut short
  const HAND = [6, 9, 5, 11, 7, 8, 12, 6, 10, 7, 5, 9];        // 5 to 12, never the same twice

  it('reports the median, the spread and the share of one-tick holds', () => {
    const w = holdStats(WHEEL)!;
    expect(w.n).toBe(12);
    expect(w.medianTicks).toBe(1);
    expect(w.oneTickFrac).toBeCloseTo(11 / 12, 5);
    const h = holdStats(HAND)!;
    expect(h.medianTicks).toBe(7.5);
    expect(h.minTicks).toBe(5);
    expect(h.maxTicks).toBe(12);
    expect(h.sdTicks).toBeGreaterThan(2);
    expect(h.oneTickFrac).toBe(0);
  });

  it('has nothing to say about no holds', () => {
    expect(holdStats([])).toBeNull();
    expect(holdStats(null)).toBeNull();
  });

  it('calls one-tick holds wheel-like', () => {
    expect(holdAnnotation(WHEEL)).toBe('wheel-like');
  });

  // The median, not the mean or the range: the last hold of a burst is often
  // the player simply keeping the button down afterwards.
  it('calls a constant hold fixed-hold, whatever the last press did', () => {
    expect(holdAnnotation(FIXED)).toBe('fixed-hold');
  });

  it('calls a hand variable-hold', () => {
    expect(holdAnnotation(HAND)).toBe('variable-hold');
  });

  // A median of 1 puts every 1 and 2 within a tick of it, so a wheel whose
  // notches sometimes merge would read as a constant scripted hold.
  it('never calls a one-tick median fixed-hold', () => {
    expect(holdAnnotation([1, 2, 1, 1, 2, 1, 2, 1, 1, 2])).toBe('variable-hold');
  });

  it('says so when there is too little to judge, or nothing at all', () => {
    expect(holdAnnotation([1, 1, 1])).toBe('no-hold-data');
    expect(holdAnnotation(null)).toBe('no-hold-data');
  });
});

describe('decodeIntervals as the hold decoder', () => {
  it('allows one more hold than the interval cap, since holds are per press', () => {
    expect(decodeIntervals('0'.repeat(MAX_INTERVALS + 1), MAX_INTERVALS + 1)).toHaveLength(MAX_INTERVALS + 1);
    expect(decodeIntervals('0'.repeat(MAX_INTERVALS + 2), MAX_INTERVALS + 1)).toBeNull();
  });
});

describe('steady taps', () => {
  it('finds a fixed-rate tapper steady and a spun wheel not', () => {
    expect(isSteadyBurst(BELLINGHAM_TAPS)).toBe(true);
    expect(isSteadyBurst(ICY_WHEEL)).toBe(false);
    expect(isSteadyBurst([6, 6, 6, 6, 6])).toBe(false); // too short to say
  });

  it('needs a detection\'s steady bursts to outnumber its wheel bursts', () => {
    const one = (iv: number[]) => burstLabel(iv, iv.map(() => 1).concat(1));
    expect(detectionLabel([one(BELLINGHAM_TAPS), one(BELLINGHAM_TAPS)])).toBe('steady-taps');
    expect(detectionLabel([one(BELLINGHAM_TAPS), one(ICY_WHEEL)])).toBe('wheel-like');
    expect(detectionLabel([one(BELLINGHAM_TAPS), one(BELLINGHAM_TAPS), one(ICY_WHEEL)])).toBe('steady-taps');
  });
});

describe('steady taps with skipped beats', () => {
  // A device that misses a beat leaves one gap of twice its period. That is
  // still the same clock.
  it('counts a gap of twice the median as on the beat', () => {
    expect(isSteadyBurst([6, 6, 6, 12, 6, 6, 6, 6, 13, 6])).toBe(true);
    expect(isSteadyBurst([6, 6, 6, 11, 6, 5, 6, 6, 14, 6])).toBe(true);
    expect(isSteadyBurst([6, 6, 6, 9, 6, 6, 6, 6, 9, 6])).toBe(false); // 9 is neither
  });

  // Below a median of 5 the two windows touch (4: 3 to 5 and 6 to 10), and
  // their union is a spun wheel's whole range.
  it('only when the doubled window is clear of the single one', () => {
    expect(isSteadyBurst([3, 3, 6, 3, 7, 3, 8, 3, 6, 3])).toBe(false);
    expect(isSteadyBurst([4, 4, 8, 4, 9, 4, 10, 4, 7, 4])).toBe(false);
  });

  it('finds real device bursts with skips steady, and a fast wheel not', () => {
    for (const b of CARAMELLOW_SKIPS) expect(isSteadyBurst(b.intervals)).toBe(true);
    for (const b of [...ICY_FAST_PISTOL, ...ICY_FAST_POUNCES]) expect(isSteadyBurst(b.intervals)).toBe(false);
  });
});

describe('burstLabel', () => {
  // Owner's ground truth: Icy Inferno spins a wheel quickly up and down.
  it('calls a fast wheel wheel-like even when its notches merge into longer holds', () => {
    for (const b of [...ICY_FAST_PISTOL, ...ICY_FAST_POUNCES]) {
      expect(holdStats(b.holds)!.oneTickFrac).toBeLessThan(0.8); // the old rule missed every one
      expect(burstLabel(b.intervals, b.holds)).toBe('wheel-like');
    }
  });

  // The ruling: a wheel-like burst whose rate is flat is a device, because a
  // script that taps without holding looks exactly like a wheel.
  it('checks for a steady device first', () => {
    for (const b of CARAMELLOW_SKIPS) expect(burstLabel(b.intervals, b.holds)).toBe('steady-taps');
    expect(burstLabel(MIRA_180.intervals, MIRA_180.holds)).toBe('steady-taps');
    // 33/s, gaps of 3: fast enough for the wheel rule, flat enough to be a device.
    const flat3 = [3, 3, 3, 3, 4, 3, 3, 2, 3, 3, 3, 3];
    expect(burstLabel(flat3, flat3.map(() => 1).concat(1))).toBe('steady-taps');
  });

  it('calls one-tick holds on an irregular rhythm wheel-like', () => {
    const holds = Array.from({ length: ICY_WHEEL.length + 1 }, () => 1);
    expect(burstLabel(ICY_WHEEL, holds)).toBe('wheel-like');
  });

  it('keeps fixed-hold and variable-hold for everything a wheel is not', () => {
    const slow = [12, 9, 14, 11, 10, 13, 12, 9, 11, 12, 10];
    expect(burstLabel(slow, [3, 4, 3, 3, 4, 3, 4, 3, 3, 4, 3, 30])).toBe('fixed-hold');
    expect(burstLabel(slow, [6, 9, 5, 11, 7, 8, 12, 6, 10, 7, 5, 9])).toBe('variable-hold');
    expect(burstLabel(slow, null)).toBe('no-hold-data');
    expect(burstLabel(slow, [1, 1, 1])).toBe('no-hold-data');
  });
});

describe('detectionLabel', () => {
  it('is what most of the bursts are, never pooled holds', () => {
    expect(detectionLabel(['wheel-like', 'wheel-like', 'variable-hold'])).toBe('wheel-like');
    expect(detectionLabel(['steady-taps', 'steady-taps', 'wheel-like'])).toBe('steady-taps');
    expect(detectionLabel(['fixed-hold', 'fixed-hold', 'variable-hold'])).toBe('fixed-hold');
  });

  // A wheel's short run of notches is sometimes steady by chance, so one
  // steady burst beside one wheel burst must not make the detection a device.
  it('breaks a tie toward wheel-like, and steady-taps must outnumber it', () => {
    expect(detectionLabel(['wheel-like', 'steady-taps'])).toBe('wheel-like');
    expect(detectionLabel(['wheel-like', 'wheel-like', 'steady-taps', 'variable-hold'])).toBe('wheel-like');
    expect(detectionLabel(['wheel-like', 'steady-taps', 'steady-taps'])).toBe('steady-taps');
    expect(detectionLabel(['steady-taps', 'fixed-hold'])).toBe('steady-taps');
  });

  it('ignores bursts with no holds unless there is nothing else', () => {
    expect(detectionLabel(['no-hold-data', 'wheel-like', 'wheel-like'])).toBe('wheel-like');
    expect(detectionLabel(['no-hold-data', 'no-hold-data'])).toBe('no-hold-data');
    expect(detectionLabel([])).toBe('no-hold-data');
  });
});
