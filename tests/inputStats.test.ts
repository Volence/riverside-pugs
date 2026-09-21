import { describe, it, expect } from 'vitest';
import {
  BURST_MAX_TICKS, MAX_INTERVALS, burstStats, decodeIntervals, encodeIntervals, pounceSpam,
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
  const claw = (airPresses: number) => ({ kind: 'pounce', weapon: 'weapon_hunter_claw', airPresses });

  it('ignores a real hunter pounce', () => {
    // Measured on a live client 2026-09-21: a normal pounce reads a=3.
    expect(pounceSpam(claw(1), 12)).toBe(false);
    expect(pounceSpam(claw(3), 12)).toBe(false);
  });

  it('flags a button held through the air', () => {
    expect(pounceSpam(claw(20), 12)).toBe(true);
  });

  it('only applies to the pounce anchor', () => {
    expect(pounceSpam({ kind: 'fire', weapon: 'weapon_hunter_claw', airPresses: 40 }, 12)).toBe(false);
  });

  // The pounce anchor fires for anyone airborne. A survivor shooting while
  // falling logged a=3 on a live client, and a fire macro while jumping reached
  // a=8 against a threshold of 12: close enough that without this filter a
  // survivor with a macro, or a long fall, would eventually be flagged as a
  // hunter cheat.
  it('never flags a survivor who was merely airborne', () => {
    expect(pounceSpam({ kind: 'pounce', weapon: 'weapon_pistol', airPresses: 40 }, 12)).toBe(false);
    expect(pounceSpam({ kind: 'pounce', weapon: '', airPresses: 40 }, 12)).toBe(false);
  });
});
