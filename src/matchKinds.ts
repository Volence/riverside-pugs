/**
 * What kind of match a row is, and the one definition of "a completed PUG".
 *
 * Scrims and tournament matches live in the same `matches` table as PUGs so
 * they reuse setup, capture, replays and the viewer, but they must never count
 * toward anything PUG-facing: SR, the leaderboard, profiles, standings,
 * chemistry, endorsements, weekly awards, skeet posts, balance analytics. Every
 * such query builds its filter from completedPug(); tests/matchKindGuard.test.ts
 * fails on a raw completed-match filter anywhere else.
 *
 * voided_at is deliberately NOT part of it: some PUG aggregates count voided
 * matches and some do not, and each call site keeps its own rule.
 */
export type MatchKind = 'pug' | 'scrim' | 'tournament';
export type MatchVisibility = 'public' | 'participants' | 'staff';

export function completedPug(alias?: string): string {
  const p = alias ? `${alias}.` : '';
  return `${p}state = 'completed' AND ${p}kind = 'pug'`;
}
