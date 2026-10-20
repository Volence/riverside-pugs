import { describe, it, expect, beforeEach } from 'vitest';
import { ICY_WHEEL, BELLINGHAM_TAPS, ICY_FAST_PISTOL, ICY_FAST_POUNCES, CARAMELLOW_SKIPS, MIRA_180, type StoredSample } from './fixtures/wheelSamples.js';
import { BELLA_631 as BELLA_HOPS, WHEEL_600 } from './fixtures/bhopSamples.js';
import { BELLA_631 as BELLA_STALLS, DANIEL_BAD_LINE } from './fixtures/stallSamples.js';
import { atRate, gapAtRate, hopAtRate, tapped } from './fixtures/tickrateConvert.js';
import { burst, human, macro, rng, uniform } from './inputSim.js';
import {
  BURST_MAX_TICKS, DEFAULT_THRESHOLDS, ENCODE_MAX_TICKS, MAX_INTERVALS, autobhop, burstLabel, burstMaxTicks,
  decodeIntervals, detectionLabel, encodeIntervals, isSteadyBurst, matchDetections, pistolRate, pounceSpam,
  ticksAtLeast, ticksAtMost, ticksFor, type BurstLabel, type SignatureBurst,
} from '../src/inputStats.js';
import { fakelag, recordInputStall } from '../src/inputStalls.js';
import { detectionsForPlayer, recordInputBurst, rerunSignatures } from '../src/inputBursts.js';
import { openDb, type DB } from '../src/db.js';
import { parseLogDatagram } from '../src/logParse.js';

/**
 * 128 tick. Every threshold was calibrated at 100 tick; these pin that a 128
 * tick server's recording of the same hands, wheels and devices gets the same
 * answer, and that the 100 tick answers are untouched (the rest of the suite
 * runs every old test at 100).
 */

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);
const A = '76561198030413993';

describe('tick rate helpers', () => {
  it('are the identity at 100 tick, so nothing calibrated moves', () => {
    for (let t = 0; t <= 400; t++) {
      expect(ticksAtMost(t)).toBe(t);
      expect(ticksAtLeast(t, 100)).toBe(t);
      expect(ticksFor(t, 100)).toBe(t);
    }
    expect(burstMaxTicks(100)).toBe(BURST_MAX_TICKS);
  });

  it('move each kind of threshold the way it is meant to at 128', () => {
    expect(ticksAtMost(3, 128)).toBe(4);      // fast wheel gap, 30 ms
    expect(ticksAtMost(2, 128)).toBe(3);      // skipped beat slack, 20 ms
    expect(ticksAtMost(1, 128)).toBe(1);      // one tick is still one tick
    expect(ticksAtLeast(8, 128)).toBe(10);    // fakelag floor, 80 ms
    expect(ticksAtMost(20, 128)).toBe(26);    // fakelag ceiling, 200 ms
    expect(ticksAtMost(100, 128)).toBe(128);  // the plugin's stall ceiling, 1 s
    expect(ticksFor(300, 128)).toBe(384);     // pistol sustain, 3 s
    expect(ticksFor(120, 128)).toBe(154);     // bhop chain, 1.2 s
    expect(burstMaxTicks(128)).toBe(38);      // burst-closing silence, 300 ms
  });

  // The plugin cannot import these, so it does the same sums in integers.
  // If either side changes, this says so.
  it('agree with the plugin\'s integer arithmetic at every rate it may claim', () => {
    for (let rate = 30; rate <= 128; rate++) {
      expect(Math.floor((rate * 3 + 5) / 10)).toBe(burstMaxTicks(rate));
      expect(Math.floor((75 * rate + 1000) / 1000)).toBe(ticksAtLeast(8, rate));
      expect(Math.floor((1005 * rate) / 1000)).toBe(ticksAtMost(100, rate));
    }
  });

  // At 128 a burst closes at 38, so the alphabet runs to 'U'. Still nothing
  // that could break a log line.
  it('keeps the wider alphabet free of quotes, spaces and backslashes', () => {
    const all = Array.from({ length: ENCODE_MAX_TICKS }, (_, i) => i + 1);
    const every = encodeIntervals(all);
    expect(every).toMatch(/^[0-9:;<=>?@A-U]+$/);
    expect(decodeIntervals(every, MAX_INTERVALS, burstMaxTicks(128))).toEqual(all);
    // ...and a 100 tick line still refuses anything past 30.
    expect(decodeIntervals(every)).toBeNull();
  });
});

/** Every real sample with the label it gets at 100 tick, as stored. */
const REAL: [string, StoredSample][] = [
  ...ICY_FAST_PISTOL.map((s, i): [string, StoredSample] => [`Icy fast pistol ${i}`, s]),
  ...ICY_FAST_POUNCES.map((s, i): [string, StoredSample] => [`Icy fast pounce ${i}`, s]),
  ['Icy slow wheel', tapped(ICY_WHEEL)],
  ...CARAMELLOW_SKIPS.map((s, i): [string, StoredSample] => [`caramellow ${i}`, s]),
  ['mira 180', MIRA_180],
  ['Bellingham', tapped(BELLINGHAM_TAPS)],
  // The hold fixtures from inputStats.test.ts: a 35 ms scripted hold and a hand.
  ['35 ms scripted hold', { intervals: [12, 9, 14, 11, 10, 13, 12, 9, 11, 12, 10], holds: [3, 4, 3, 3, 4, 3, 4, 3, 3, 4, 3, 30] }],
  ['hand', { intervals: [12, 9, 14, 11, 10, 13, 12, 9, 11, 12, 10], holds: [6, 9, 5, 11, 7, 8, 12, 6, 10, 7, 5, 9] }],
];

describe('the real samples, as a 128 tick server would have recorded them', () => {
  it('get the label they get at 100 tick, burst by burst, on every seed', () => {
    for (const [name, s] of REAL) {
      const at100 = burstLabel(s.intervals, s.holds);
      for (const seed of SEEDS) {
        const c = atRate(s, 128, seed);
        expect(burstLabel(c.intervals, c.holds, 128), `${name}, seed ${seed}`).toBe(at100);
      }
    }
  });

  it('and so the same detection label: caramellow a device, Icy a legal wheel', () => {
    for (const seed of SEEDS) {
      const at = (xs: readonly StoredSample[]): BurstLabel[] =>
        xs.map((s) => atRate(s, 128, seed)).map((c) => burstLabel(c.intervals, c.holds, 128));
      expect(detectionLabel(at(CARAMELLOW_SKIPS))).toBe('steady-taps');
      expect(detectionLabel(at([...ICY_FAST_PISTOL, ...ICY_FAST_POUNCES]))).toBe('wheel-like');
    }
  });

  // Why the thresholds have to move: read with 100 tick's numbers, Icy's
  // 30 ms wheel gaps read 4 ticks, stop counting as fast, and a legal wheel
  // becomes variable-hold evidence.
  it('are misread by 100 tick thresholds, which is the point of all this', () => {
    const s = ICY_FAST_PISTOL[1];
    let misread = 0;
    for (const seed of SEEDS) {
      const c = atRate(s, 128, seed);
      if (burstLabel(c.intervals, c.holds) !== 'wheel-like') misread++;
    }
    expect(misread).toBeGreaterThan(SEEDS.length * 0.9);
  });
});

/** Ticks a press at `ms` is seen on, at `rate`. */
const at = (ms: number, rate: number): number => Math.ceil(ms / (1000 / rate));
/** Intervals of presses at the given times, at `rate`. */
const gapsOf = (times: readonly number[], rate: number): number[] =>
  times.slice(1).map((t, i) => at(t, rate) - at(times[i], rate));

describe('scripts and hands, recorded at 128 tick', () => {
  // A rapid-fire bind: one-usercmd taps on a 17/s clock. One tick at 128 is
  // 7.8 ms and the clock aliases to 7,8, but the holds are still one tick.
  it('still catches a one-tick tap script as a device, not a wheel', () => {
    const r = rng(21);
    for (let k = 0; k < 50; k++) {
      const phase = r() * 50;
      const times = Array.from({ length: 41 }, (_, i) => phase + i * (1000 / 17));
      const iv = gapsOf(times, 128);
      expect(burstLabel(iv, iv.map(() => 1).concat(1), 128)).toBe('steady-taps');
    }
    // 33/s, the fast-gap rule's own speed: 30 ms is 3 or 4 ticks at 128.
    const flat = gapsOf(Array.from({ length: 13 }, (_, i) => 3 + i * 30), 128);
    expect(burstLabel(flat, flat.map(() => 1).concat(1), 128)).toBe('steady-taps');
  });

  // A set 35 ms hold reads 4,5 at 128 (3,4 at 100): within a tick of the
  // median either way.
  it('still calls a scripted fixed hold fixed-hold', () => {
    const slow = gapsOf([0, 120, 210, 350, 460, 560, 690, 810, 900, 1010, 1130, 1230], 128);
    const holds = [4, 5, 4, 4, 5, 4, 5, 4, 4, 5, 4, 38];
    expect(burstLabel(slow, holds, 128)).toBe('fixed-hold');
  });

  // A hand's 50 to 120 ms holds spread over 6 to 15 ticks at 128, wider than
  // at 100, so the one-tick fixed-hold window catches less of it, never more.
  it('does not flag a varied hand at 128', () => {
    const r = rng(22);
    for (let k = 0; k < 200; k++) {
      const iv = burst(human(8), 3000, r, 128);
      if (iv.length < 4) continue;
      const holds = Array.from({ length: iv.length + 1 }, () => at(50 + r() * 70, 128));
      expect(burstLabel(iv, holds, 128)).toBe('variable-hold');
      expect(pounceSpam({ kind: 'pounce', weapon: 'weapon_hunter_claw', intervals: iv, tickrate: 128 }, 12)).toBe(false);
      expect(pistolRate({ kind: 'fire', weapon: 'weapon_pistol', intervals: iv, tickrate: 128 }, 12)).toBe(false);
    }
    expect(burstLabel([12, 9, 14, 11, 10, 13], [6, 7, 8, 9, 10, 6, 8], 128)).toBe('variable-hold');
  });

  it('still calls a spun wheel a wheel', () => {
    // Runs of notches 15 to 35 ms apart, with resets.
    const r = rng(23);
    let t = 0;
    const times = [0];
    while (times.length < 60) {
      for (let j = 0; j < 4; j++) times.push(t += 15 + r() * 20);
      times.push(t += 80 + r() * 120);
    }
    const iv = gapsOf(times, 128);
    expect(burstLabel(iv, iv.map(() => 1).concat(1), 128)).toBe('wheel-like');
  });
});

/** A device on a fixed clock: press i at i*T plus a few ms of jitter, with a
 *  tenth of its beats skipped. */
function device(r: () => number, periodMs: number, jitterMs: number, n: number, rate: number): number[] {
  const times: number[] = [];
  const phase = r() * 1000;
  for (let k = 0; times.length < n + 1; k++) {
    if (times.length === 0 || r() > 0.1) {
      let u = 0;
      while (u === 0) u = r();
      times.push(phase + k * periodMs + jitterMs * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()));
    }
  }
  return gapsOf(times, rate).map((g) => Math.max(1, g));
}

describe('the steady check at 128 tick', () => {
  // One tick at 128 is 7.8 ms, so a window of one tick around the median is
  // narrower IN TIME than it was at 100, and a jittery device falls out of it
  // and reads as a legal wheel. The beat window is read as a time instead.
  it('finds a jittered device about as steady as at 100 tick', () => {
    const share = (rate: number): number => {
      const r = rng(24);
      let steady = 0;
      const N = 4000;
      for (let i = 0; i < N; i++) {
        if (isSteadyBurst(device(r, uniform(r, 45, 75), 3, 6 + Math.floor(r() * 30), rate), rate)) steady++;
      }
      return steady / N;
    };
    const s100 = share(100), s128 = share(128);
    expect(s100).toBeGreaterThan(0.95);
    expect(s128).toBeGreaterThan(s100 - 0.02);
  });
});

describe('the signatures at 128 tick', () => {
  // The measured macro pounce: 7.7 ticks at 100 is 77 ms, about 9.9 at 128.
  it('mark the measured 13/s macro, which 100 tick arithmetic would call 10/s', () => {
    const iv = [10, 10, 9, 10, 10, 10];
    expect(pounceSpam({ kind: 'pounce', weapon: 'weapon_hunter_claw', intervals: iv, tickrate: 128 }, 12)).toBe(true);
    expect(pounceSpam({ kind: 'pounce', weapon: 'weapon_hunter_claw', intervals: iv }, 12)).toBe(false);
  });

  it('time the pistol sustain in seconds: 3 s is 384 ticks', () => {
    const fire = (secs: number): SignatureBurst => ({
      kind: 'fire', weapon: 'weapon_pistol', tickrate: 128,
      intervals: gapsOf(Array.from({ length: Math.round(secs * 13) + 1 }, (_, i) => i * (1000 / 13)), 128),
    });
    expect(pistolRate(fire(3.2), 12)).toBe(true);
    expect(pistolRate(fire(2.7), 12)).toBe(false);
  });

  // The calibration Monte Carlo of inputSignatureSim.test.ts, again at 128.
  it('keep the calibrated false positive and detection rates', () => {
    const claw = (intervals: number[]): SignatureBurst => ({ kind: 'pounce', weapon: 'weapon_hunter_claw', intervals, tickrate: 128 });
    const pistol = (intervals: number[]): SignatureBurst => ({ kind: 'fire', weapon: 'weapon_pistol', intervals, tickrate: 128 });
    const rate = (make: (r: () => number) => SignatureBurst[], sig: string, matches: number, seed: number): number => {
      const r = rng(seed);
      let flagged = 0;
      for (let m = 0; m < matches; m++) if (matchDetections(make(r), DEFAULT_THRESHOLDS).some((d) => d.signature === sig)) flagged++;
      return flagged / matches;
    };
    const pounces = (p: ReturnType<typeof human>, n: number) => (r: () => number) =>
      Array.from({ length: n }, () => claw(burst(p, uniform(r, 500, 2000), r, 128)));
    const pistols = (p: ReturnType<typeof human>, n: number, lo: number) => (r: () => number) =>
      Array.from({ length: n }, () => pistol(burst(p, uniform(r, lo, 8000), r, 128).slice(0, MAX_INTERVALS)));
    expect(rate(pounces(human(8), 60), 'pounce_spam', 1000, 2)).toBeLessThan(0.005);
    expect(rate(pounces(macro(13, 25), 10), 'pounce_spam', 500, 5)).toBeGreaterThan(0.99);
    expect(rate(pistols(human(8), 150, 1000), 'pistol_rate', 300, 11)).toBeLessThan(0.005);
    expect(rate(pistols(macro(13, 25), 10, 2000), 'pistol_rate', 500, 14)).toBeGreaterThan(0.99);
  });
});

const hopsAt = (seq: readonly (readonly [number, number])[], rate: number, seed: number): SignatureBurst[] => {
  const r = rng(seed);
  return seq.map((h) => hopAtRate(h, rate, r)).map(([g, t]) => ({ kind: 'bhop', weapon: '', intervals: [1], groundTicks: g, serverTick: t, tickrate: rate }));
};

describe('autobhop at 128 tick', () => {
  it('catches the confirmed script and leaves the best honest wheel alone', () => {
    for (const seed of SEEDS) {
      const bella = autobhop(hopsAt(BELLA_HOPS, 128, seed));
      expect(bella).toMatchObject({ chained: 36, perfect: 26, longestRun: 10 });
      expect(autobhop(hopsAt(WHEEL_600, 128, seed))).toBeNull();
    }
  });

  it('chains hops within 1.2 s, which is 154 ticks', () => {
    const run = (dt: number): SignatureBurst[] => Array.from({ length: 30 }, (_, i) => (
      { kind: 'bhop', weapon: '', intervals: [1], groundTicks: 0, serverTick: 1000 + i * dt, tickrate: 128 }));
    expect(autobhop(run(150))).not.toBeNull();
    expect(autobhop(run(155))).toBeNull();
  });
});

const stallRows = (seq: readonly (readonly number[])[], rate: number, seed: number) => {
  const r = rng(seed);
  return seq.map(([gap, missed, , team, cls, lunging], i) => ({
    id: i + 1, gap: gapAtRate(gap, rate, r), missed, team, cls, lunging, at: '', tickrate: rate,
  }));
};

describe('fakelag at 128 tick', () => {
  it('catches the confirmed fakelag and leaves the worst honest line alone', () => {
    for (const seed of SEEDS) {
      expect(fakelag(stallRows(BELLA_STALLS, 128, seed))?.lunging).toBe(29);
      expect(fakelag(stallRows(DANIEL_BAD_LINE, 128, seed))).toBeNull();
    }
  });

  // Bella's holds were a fixed 110 ms: 11 ticks at 100, 14 at 128. A cheat
  // that chokes a COUNT of commands instead would show 11 at 128: caught too.
  it('reads the 80 to 200 ms window at the stall\'s own rate', () => {
    const mid = (gap: number, tickrate?: number) => ({ id: 1, gap, missed: 0, team: 3, cls: 3, lunging: 1, at: '', tickrate });
    const caught = (gap: number, tickrate?: number) => fakelag(Array.from({ length: 10 }, () => mid(gap, tickrate))) !== null;
    expect([caught(14, 128), caught(11, 128), caught(10, 128), caught(26, 128)]).toEqual([true, true, true, true]);
    expect([caught(9, 128), caught(27, 128)]).toEqual([false, false]);
    // 100 tick, as calibrated, with and without the rate said.
    expect([caught(8), caught(20), caught(8, 100), caught(20, 100)]).toEqual([true, true, true, true]);
    expect([caught(7), caught(21), caught(26), caught(21, 100)]).toEqual([false, false, false, false]);
  });
});

const parse = (body: string) => parseLogDatagram(Buffer.from(`L 10/20/2026 - 12:00:00: ${body}`, 'utf8'));

describe('the wire at 128 tick', () => {
  const BURST = 'L4DM id=76561198030288393 k=fire w=weapon_pistol n=4 g=0 a=0 st=91422 ct=91419 sp=31';
  it('reads rate= and the wider alphabet that comes with it', () => {
    expect(parse(`${BURST} rate=128 v=2 d=UUA9 h=00000`)).toMatchObject({
      kind: 'input_burst', tickrate: 128, intervals: [38, 38, 18, 10], holds: [1, 1, 1, 1, 1],
    });
    // 39 is past the cap at 128.
    expect(parse(`${BURST} rate=128 v=2 d=VUA9 h=00000`)).toBeNull();
    expect(parse(`${BURST} rate=128 v=2 d=UUA9 h=0000V`)).toBeNull();
  });

  // A line without rate= is 100 tick, which is every line the old plugin sent.
  it('reads a line without a rate as 100 tick, exactly as before', () => {
    const old = parse(`${BURST} v=2 d=7787 h=23242`);
    expect(old).not.toHaveProperty('tickrate');
    expect(parse(`${BURST} rate=100 v=2 d=7787 h=23242`)).toEqual({ ...old, tickrate: 100 });
    expect(parse(`${BURST} v=2 d=UUA9 h=00000`)).toBeNull();
  });

  it('refuses a rate no server runs', () => {
    for (const bad of ['rate=129', 'rate=29', 'rate=0', 'rate=-128', 'rate=12x', 'rate=']) {
      expect(parse(`${BURST} ${bad} v=2 d=7787 h=23242`)).toBeNull();
    }
  });

  it('lets a stall run to one second at its own rate', () => {
    const stall = (gap: number, rate?: number) =>
      parse(`L4DM id=${A} k=stall st=52304 gap=${gap} miss=0 cmds=12 team=3 cls=3 lunge=1${rate ? ` rate=${rate}` : ''} v=2`);
    expect(stall(128, 128)).toMatchObject({ kind: 'input_stall', gap: 128, tickrate: 128 });
    expect(stall(129, 128)).toBeNull();
    expect(stall(100)).toMatchObject({ gap: 100 });
    expect(stall(100)).not.toHaveProperty('tickrate');
    expect(stall(101)).toBeNull();
  });
});

describe('storage at 128 tick', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); });

  // 13/s for 3.5 s at 128 is about 9.8 ticks a press; read as 100 tick it
  // would be 10/s and nothing.
  const pistol = (tickrate: number | null) => ({
    matchId: 9, serverId: 3, steamid: A, kind: 'fire' as const, weapon: 'weapon_pistol', airPresses: 0, groundTicks: 0,
    serverTick: 5000, clientTick: 4990, wire: 2 as const, serverSpan: 450, tickrate,
    intervals: gapsOf(Array.from({ length: 46 }, (_, i) => i * (1000 / 13)), 128),
    holds: Array.from({ length: 46 }, (_, i) => (i === 45 ? 38 : 1)),
  });

  it('stores the rate, flags at it, and shows it on the evidence', () => {
    recordInputBurst(db, pistol(128));
    const second = recordInputBurst(db, pistol(128));
    expect(second.detections).toEqual(['pistol_rate']);
    const [d] = detectionsForPlayer(db, A);
    expect(d.bursts[0]).toMatchObject({ tickrate: 128, annotation: 'steady-taps' });
    expect(d.bursts[0].ratePerSec).toBeGreaterThan(12.9);
    expect(d.note).toBe('steady-taps');
    // A rerun reads the stored rate the same way.
    rerunSignatures(db);
    expect(detectionsForPlayer(db, A).map((x) => [x.signature, x.note])).toEqual([['pistol_rate', 'steady-taps']]);
  });

  it('reads a row with no rate as 100 tick', () => {
    recordInputBurst(db, pistol(null));
    expect(recordInputBurst(db, pistol(null)).detections).toEqual([]);
    expect(detectionsForPlayer(db, A)).toEqual([]);
  });

  it('flags a stall at the rate it was stored with', () => {
    const r = rng(31);
    const created = BELLA_STALLS.map(([gap, missed, cmds, team, cls, lunging], i) => recordInputStall(db, {
      matchId: 631, serverId: 3, steamid: A, serverTick: 1000 + i * 128, gap: gapAtRate(gap, 128, r), missed, cmds, team, cls, lunging, tickrate: 128,
    })).filter((x) => x.created);
    expect(created).toHaveLength(1);
    expect(detectionsForPlayer(db, A)[0]).toMatchObject({ signature: 'fakelag', hits: 29 });
  });
});
