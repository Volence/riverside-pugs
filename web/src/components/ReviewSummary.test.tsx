import { describe, it, expect } from 'vitest';
import { opponentsReviewLine, reviewSummaryText } from './ReviewSummary';

const s = (positivePct: number | null, topTag: 'on_time' | 'good_comms' | 'good_sport' | 'left_early' | 'toxic' | null, count = 3) =>
  ({ count, positivePct, topTag });

describe('review summary text (plan 2 Ruling 5)', () => {
  it('reads "Not enough reviews yet" under the summary minimum', () => {
    expect(reviewSummaryText(s(null, null, 0))).toBe('Not enough reviews yet');
    expect(reviewSummaryText(s(null, null, 2))).toBe('Not enough reviews yet');
  });

  it('gives the percentage and top tag label at the minimum', () => {
    expect(reviewSummaryText(s(67, 'on_time'))).toBe('67% positive, top tag: On time');
    expect(reviewSummaryText(s(100, 'toxic'))).toBe('100% positive, top tag: Toxic');
  });

  it('the team page line prefixes "Opponents\' reviews:" only when there is enough', () => {
    expect(opponentsReviewLine(s(92, 'on_time'))).toBe("Opponents' reviews: 92% positive, top tag: On time");
    expect(opponentsReviewLine(s(null, null, 1))).toBe('Not enough reviews yet');
  });
});
