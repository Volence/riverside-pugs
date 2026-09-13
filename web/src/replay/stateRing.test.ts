import { describe, it, expect } from 'vitest';
import { STATE } from '../../../src/replayFormat';
import { DEAD_COLOR, STATE_RINGS, stateRing, stateRingColor, statusGlyph } from './stateRing';
import { GHOST_COLOR, SLOT_COLORS } from './draw';
import { distance, type Vision } from './colorDistance';

const BITS = [STATE.PINNED, STATE.INCAP, STATE.LEDGED, STATE.BURNING, STATE.BILED];
const VISIONS: Vision[] = ['normal', 'protanopia', 'deuteranopia'];
const worst = (a: string, b: string) => Math.min(...VISIONS.map((v) => distance(a, b, v)));

describe('stateRing', () => {
  it('is null for a healthy player and for a dead one', () => {
    expect(stateRing(STATE.PRESENT | STATE.ALIVE)).toBeNull();
    expect(stateRing(STATE.PRESENT)).toBeNull();
  });

  it('picks the first state in priority order for every subset of the five bits', () => {
    for (let mask = 1; mask < 32; mask++) {
      let state = STATE.PRESENT | STATE.ALIVE;
      BITS.forEach((b, i) => { if (mask & (1 << i)) state |= b; });
      const ring = stateRing(state)!;
      const expected = STATE_RINGS.find((r) => (state & r.bit) !== 0)!;
      expect(ring).toBe(expected);
      // The glyph and the ring can never disagree: same table, same walk.
      expect(statusGlyph(state)).toBe(expected.glyph);
      expect(stateRingColor(state)).toBe(expected.color);
    }
  });

  it('keeps the letters the map has always used', () => {
    expect(statusGlyph(STATE.PINNED)).toBe('P');
    expect(statusGlyph(STATE.INCAP)).toBe('X');
    expect(statusGlyph(STATE.LEDGED)).toBe('L');
    expect(statusGlyph(STATE.BURNING)).toBe('F');
    expect(statusGlyph(STATE.BILED)).toBe('B');
    expect(statusGlyph(0)).toBe('');
  });
});

describe('state ring palette under dichromacy', () => {
  const colors = Array.from(new Set(STATE_RINGS.map((r) => r.color)));

  it('keeps the state colours at least 15 apart from one another', () => {
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        expect(worst(colors[i], colors[j])).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it('keeps every state colour clear of the ghost and dead greys', () => {
    for (const c of colors) {
      expect(worst(c, GHOST_COLOR)).toBeGreaterThanOrEqual(15);
      expect(worst(c, DEAD_COLOR)).toBeGreaterThanOrEqual(15);
    }
  });

  // Two exceptions, by name, and only these two.
  //
  // Down and hanging gold against infected slot 6 gold: a gold ring only
  // ever appears on a survivor, whose rim is cool, and an infected's gold
  // rim never carries a gold ring. Cross-team adjacency is the one place
  // they meet and the face inside disambiguates.
  //
  // Biled purple against the four survivor rims under protanopia and
  // deuteranopia: a dichromat cannot separate blue from purple at all, it
  // is the missing cone. No purple passes; the glyph letter B is the
  // channel for that viewer. Under normal vision the purple must still
  // clear every rim.
  it('keeps every state colour at least 15 from every slot rim, with the two named exceptions', () => {
    const biled = STATE_RINGS.find((r) => r.key === 'biled')!;
    for (const r of STATE_RINGS) {
      for (let slot = 0; slot < 8; slot++) {
        const rim = SLOT_COLORS[slot];
        if ((r.key === 'incap' || r.key === 'ledged') && slot === 6) continue;
        if (r === biled && slot < 4) {
          expect(distance(r.color, rim, 'normal')).toBeGreaterThanOrEqual(15);
          continue;
        }
        expect(worst(r.color, rim)).toBeGreaterThanOrEqual(15);
      }
    }
  });
});
