import type { ReviewSummary, ReviewTag } from '../api';

/** Mirrors src/scrims/reviews.ts: REVIEW_TAGS is what the form offers;
 *  REVIEW_TAG_LABELS also names the retired good_comms for stored reviews. */
export const REVIEW_TAGS: ReviewTag[] = ['on_time', 'easy_to_schedule', 'flexible', 'good_sport', 'left_early', 'toxic'];
export const REVIEW_TAG_LABELS: Record<ReviewTag, string> = {
  on_time: 'On time', easy_to_schedule: 'Easy to schedule', flexible: 'Flexible', good_sport: 'Good sport',
  left_early: 'Left early', toxic: 'Toxic', good_comms: 'Good comms',
};
/** A tag's tooltip, where the label alone could be misread. */
export const REVIEW_TAG_HINTS: Partial<Record<ReviewTag, string>> = { flexible: 'OK with map, side or sub changes' };
/** Mirrors src/scrims/reviews.ts's REVIEW_NOTE_MAX. */
export const REVIEW_NOTE_MAX = 300;

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
