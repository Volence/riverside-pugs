import { describe, expect, it } from 'vitest';
import type { PublicRow } from '../../api';
import { CHANGES_UNAVAILABLE_TEXT, plural, publicDelta, publicValue, skillBannerText, verdictSentence } from './wording';

const row = (o: Partial<PublicRow>): PublicRow => ({
  metric: 'tank.killed_rate', group: 'tank', label: 'Tanks killed by survivors', a: 0.62, b: 0.71, diff: 0.09, rel: 0.145,
  lo: 0.03, hi: 0.15, verdict: 'real', moreMatches: null, nA: 40, nB: 40, noSharedMaps: false, ...o,
});

describe('public wording', () => {
  it('formats shares and per-spawn rates as percent, others with the admin units', () => {
    expect(publicValue('tank.killed_rate', 0.62)).toBe('62%');
    expect(publicValue('hunter.skeet_rate', 0.123)).toBe('12%');
    expect(publicValue('tank.lifetime_killed_s', 41.4)).toBe('41 s');
    expect(publicValue('round.score', 412.345)).toBe('412.35');
    expect(publicValue('round.score', null)).toBe('n/a');
    expect(publicDelta('tank.killed_rate', 0.09)).toBe('+9 pts');
    expect(publicDelta('tank.lifetime_killed_s', -3.2)).toBe('-3 s');
    expect(publicDelta('round.score', 0.001)).toBe('0');
  });
  it('real change carries values, change and range and never says caused', () => {
    const s = verdictSentence(row({}), true);
    expect(s).toBe('Measured change: Tanks killed by survivors went from 62% to 71% (+9 pts, likely between +3 pts and +15 pts).');
    expect(s).not.toMatch(/caus/i);
  });
  it('noise, too early and no data', () => {
    expect(verdictSentence(row({ verdict: 'noise' }), true)).toBe('No clear change: within normal variation.');
    expect(verdictSentence(row({ verdict: 'too_early', moreMatches: 12 }), true)).toBe('Too early to tell: about 12 more matches needed.');
    expect(verdictSentence(row({ verdict: 'too_early', moreMatches: 1 }), true)).toBe('Too early to tell: about 1 more match needed.');
    expect(verdictSentence(row({ verdict: 'too_early', moreMatches: 800 }), true)).toBe('Too early to tell: about 500+ more matches needed.');
    expect(verdictSentence(row({ verdict: 'too_early', moreMatches: null }), true)).toBe('Too early to tell: more matches needed.');
    // A finished previous patch cannot gain more matches, so this reads as a
    // flat statement rather than a countdown, checked before moreMatches.
    expect(verdictSentence(row({ verdict: 'too_early', moreMatches: 12, nA: 9 }), true))
      .toBe('Too early to tell: the previous patch has too few measured matches to compare against.');
    // A patch no longer being played cannot gain matches either, checked first of all.
    expect(verdictSentence(row({ verdict: 'too_early', moreMatches: 12, nA: 9 }), false))
      .toBe('Too early to tell: too few matches were measured on these patches to tell.');
    expect(verdictSentence(row({ verdict: 'too_early', moreMatches: 12 }), false))
      .toBe('Too early to tell: too few matches were measured on these patches to tell.');
    expect(verdictSentence(row({ verdict: 'no_data', b: null, nB: 0 }), true)).toBe('Not measured for this patch.');
    expect(verdictSentence(row({ verdict: 'no_data', a: null, nA: 0 }), true)).toBe('Not measured for the previous patch.');
    expect(verdictSentence(row({ verdict: 'no_data', a: null, b: null, noSharedMaps: true }), true)).toBe('No maps in common with the previous patch, so no comparison.');
  });
  it('plural and the unrecorded text', () => {
    expect(plural(1, 'match', 'matches')).toBe('1 match');
    expect(plural(0, 'match', 'matches')).toBe('0 matches');
    expect(plural(8, 'round', 'rounds')).toBe('8 rounds');
    expect(CHANGES_UNAVAILABLE_TEXT.unrecorded).toBe('No list of settings was recorded for this patch. See the notes above.');
  });
  it('skill banner', () => {
    expect(skillBannerText(null)).toBeNull();
    expect(skillBannerText('differs')).toMatch(/players, not the patch/);
    expect(skillBannerText('unavailable')).toMatch(/could not/);
  });
});
