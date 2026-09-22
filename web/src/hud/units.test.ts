import { describe, it, expect } from 'vitest';
import { screenW, parsePos, parseSize, formatPos, scaleToken } from './units';

describe('screenW', () => {
  it('is 480 units tall at every aspect', () => {
    expect(screenW('4:3')).toBe(640);
    expect(screenW('16:10')).toBe(768);
    expect(screenW('16:9')).toBe(853);
  });
});

describe('parsePos', () => {
  it('reads plain, right and centre anchors', () => {
    expect(parsePos('10', 853)).toBe(10);
    expect(parsePos('r125', 853)).toBe(728);
    expect(parsePos('c-13', 480)).toBe(227);
    expect(parsePos('c10', 480)).toBe(250);
  });
});

describe('parseSize', () => {
  it('reads f as fill minus', () => {
    expect(parseSize('f0', 853)).toBe(853);
    expect(parseSize('150', 853)).toBe(150);
  });
});

describe('formatPos', () => {
  it('anchors by which third the centre sits in', () => {
    expect(formatPos(8, 120, 853)).toBe('8');
    expect(formatPos(400, 53, 853)).toBe('c-26');     // middle third; Math.round(-26.5) is -26
    expect(formatPos(728, 150, 853)).toBe('r125');
  });

  it('round-trips through parsePos', () => {
    for (const [pos, size] of [[8, 120], [400, 53], [728, 150], [0, 853]] as const) {
      // Half of 853 is not a whole unit, so a centre anchor can land half a unit off.
      expect(Math.abs(parsePos(formatPos(pos, size, 853), 853) - pos)).toBeLessThanOrEqual(0.5);
    }
  });

  it('keeps an element the same distance from its anchored edge at another aspect', () => {
    const token = formatPos(728, 150, 853);            // placed at 16:9, 125 from the right
    expect(640 - parsePos(token, 640)).toBe(125);
  });
});

describe('scaleToken', () => {
  it('multiplies the number and keeps the anchor', () => {
    expect(scaleToken('40', 1.5)).toBe('60');
    expect(scaleToken('r10', 2)).toBe('r20');
    expect(scaleToken('c-13', 2)).toBe('c-26');
    expect(scaleToken('f0', 2)).toBe('f0');
  });
  it('leaves anything it does not understand alone', () => {
    expect(scaleToken('', 2)).toBe('');
    expect(scaleToken('abc', 2)).toBe('abc');
  });
});
