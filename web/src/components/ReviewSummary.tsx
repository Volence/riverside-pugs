import type { ReviewSummary, ReviewTag } from '../api';

/** Mirrors src/scrims/reviews.ts's REVIEW_TAGS and REVIEW_TAG_LABELS. */
export const REVIEW_TAGS: ReviewTag[] = ['on_time', 'good_comms', 'good_sport', 'left_early', 'toxic'];
export const REVIEW_TAG_LABELS: Record<ReviewTag, string> = {
  on_time: 'On time', good_comms: 'Good comms', good_sport: 'Good sport', left_early: 'Left early', toxic: 'Toxic',
};

/** The core of a review aggregate's text, with no label (plan 2 Ruling 5):
 *  "N% positive, top tag: Label", or "Not enough reviews yet" under 3. */
export function reviewSummaryText(s: ReviewSummary): string {
  if (s.positivePct === null || s.topTag === null) return 'Not enough reviews yet';
  return `${s.positivePct}% positive, top tag: ${REVIEW_TAG_LABELS[s.topTag]}`;
}

/** The team page's line, verbatim (plan 2 Task 5 brief): "Opponents'
 *  reviews: 92% positive, top tag: On time", or "Not enough reviews yet"
 *  with no prefix. */
export function opponentsReviewLine(s: ReviewSummary): string {
  const text = reviewSummaryText(s);
  return text === 'Not enough reviews yet' ? text : `Opponents' reviews: ${text}`;
}
