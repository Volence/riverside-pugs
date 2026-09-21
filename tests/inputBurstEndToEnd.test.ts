import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseLogDatagram } from '../src/logParse.js';
import { burstStats } from '../src/inputStats.js';

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
];

describe('lines the plugin actually emitted', () => {
  it('the parser accepts every one of them', () => {
    for (const line of REAL) {
      const ev = parseLogDatagram(Buffer.from(line, 'utf8'));
      expect(ev, line).toMatchObject({ kind: 'input_burst', steamid: '76561197960287930' });
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
