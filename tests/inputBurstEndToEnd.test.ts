import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseLogDatagram } from '../src/logParse.js';
import { DEFAULT_THRESHOLDS, burstStats, pounceSpam } from '../src/inputStats.js';

/**
 * Lines captured off the real wire from l4d_inputstats.smx on the local test
 * server, 2026-09-21. Checked in verbatim so that the plugin's format and the
 * parser can never drift apart silently: if someone changes the encoding on one
 * side, this fails.
 */
const REAL = [
  'L 09/21/2026 - 03:38:03: L4DM id=76561197960287930 k=pounce w=test_weapon n=21 g=4 a=22 st=101 ct=0 d=678678678678678678678',
  'L 09/21/2026 - 03:38:03: L4DM id=76561197960287930 k=fire w=test_weapon n=12 g=4 a=13 st=101 ct=0 d=678678678678',
  'L 09/21/2026 - 03:38:03: L4DM id=76561197960287930 k=bhop w=test_weapon n=4 g=4 a=5 st=101 ct=0 d=6786',
  // A single-interval bhop line. This one exists because the bhop path once
  // emitted a literal '!', a leftover from the base 33 alphabet, which meant
  // EVERY real bhop line would have been refused by the parser. Nothing caught
  // it but reading the wire.
  'L 09/21/2026 - 03:42:30: L4DM id=76561197960287930 k=bhop w=test_weapon n=1 g=4 a=2 st=101 ct=0 d=6',
  // Live client, 2026-09-21. A REAL hunter pounce: three airborne presses at
  // 6.5/s. This is the human baseline the signature must never mark, and it is
  // where `weapon_hunter_claw` was confirmed.
  'L 09/21/2026 - 10:40:36: L4DM id=STEAM_1:1:35074132 k=pounce w=weapon_hunter_claw n=2 g=203 a=3 st=41646 ct=0 d=A<',
  // Live client, same session. A SURVIVOR shooting mid-jump also produces a
  // pounce burst, which is why the signature filters on the weapon.
  'L 09/21/2026 - 10:36:14: L4DM id=STEAM_1:1:35074132 k=pounce w=weapon_pistol n=6 g=54 a=7 st=15406 ct=0 d=767767',
];

describe('lines the plugin actually emitted', () => {
  it('does not flag a real hunter pounce or an airborne survivor', () => {
    const hunter = parseLogDatagram(Buffer.from(REAL[4], 'utf8')) as never;
    const survivor = parseLogDatagram(Buffer.from(REAL[5], 'utf8')) as never;
    expect(pounceSpam(hunter, DEFAULT_THRESHOLDS.pounceMinRate)).toBe(false);
    expect(pounceSpam(survivor, DEFAULT_THRESHOLDS.pounceMinRate)).toBe(false);
  });

  it('the parser accepts every one of them', () => {
    for (const line of REAL) {
      const ev = parseLogDatagram(Buffer.from(line, 'utf8'));
      // Under sv_lan 1 the plugin falls back to the STEAM_ form, which the
      // parser normalises, so assert a 17-digit SteamID64 rather than a literal.
      expect(ev, line).toMatchObject({ kind: 'input_burst' });
      expect((ev as { steamid: string }).steamid, line).toMatch(/^7656119[0-9]{10}$/);
    }
  });

  it('decodes the intervals the plugin encoded', () => {
    const ev = parseLogDatagram(Buffer.from(REAL[2], 'utf8')) as { intervals: number[] };
    // The test command emits 7,8,9 repeating; base 48 renders those as 6,7,8.
    expect(ev.intervals).toEqual([7, 8, 9, 7]);
  });

  it('carries the airborne press count the shipped signature reads', () => {
    const ev = parseLogDatagram(Buffer.from(REAL[0], 'utf8')) as { airPresses: number; burstKind: string };
    expect(ev.burstKind).toBe('pounce');
    expect(ev.airPresses).toBe(22);
  });

  it('produces usable statistics from a real line', () => {
    const ev = parseLogDatagram(Buffer.from(REAL[0], 'utf8')) as { intervals: number[] };
    const s = burstStats(ev.intervals);
    expect(s.n).toBe(21);
    expect(s.meanTicks).toBeCloseTo(8, 1);
    expect(s.ratePerSec).toBeCloseTo(12.5, 1);
  });
});

/**
 * Plugin 0.2.0 lines. NOT captured off a wire: nothing may start the shared
 * test server while other sessions are using it, so these are written out from
 * EmitLine's format string in plugin/l4d_inputstats.sp, field for field. They
 * pin the parser to that format. Replace them with captured lines the first
 * time 0.2.0 runs anywhere, exactly as REAL above was.
 */
const FORMAT_0_2 = [
  'L 09/21/2026 - 14:00:00: L4DM id=76561197960287930 k=fire w=weapon_pistol n=6 g=0 a=0 st=52000 ct=51996 sp=46 v=2 d=787787',
  'L 09/21/2026 - 14:00:01: L4DM id=STEAM_1:1:35074132 k=pounce w=weapon_hunter_claw n=6 g=61 a=7 st=52100 ct=52096 sp=46 v=2 d=787787',
  'L 09/21/2026 - 14:00:02: L4DM id=76561197960287930 k=bhop w= n=1 g=2 a=0 st=52200 ct=52197 sp=0 v=2 d=0',
];

describe('lines in the 0.2.0 format', () => {
  it('the parser accepts every one of them as wire 2', () => {
    for (const line of FORMAT_0_2) {
      expect(parseLogDatagram(Buffer.from(line, 'utf8')), line).toMatchObject({ kind: 'input_burst', wire: 2 });
    }
  });

  it('reads both clocks and the server span off a fire burst', () => {
    const ev = parseLogDatagram(Buffer.from(FORMAT_0_2[0], 'utf8'));
    expect(ev).toMatchObject({ serverTick: 52000, clientTick: 51996, serverSpan: 46, intervals: [8, 9, 8, 8, 9, 8] });
  });
});
