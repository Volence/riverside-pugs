import { findSlurs } from '../slurs.js';
import { DEFAULT_IGNORABLE, hasUnsafeChars } from '../profileFields.js';

/**
 * The draft rules that need no database (drafts plan D1): the signup note,
 * the team count, the default cut and publish validation (later tasks add
 * captain offer order). src/events/drafts.ts calls these
 * inside its transactions.
 */

/** Ruling 10: a note is optional free text of 1 to 80 characters. */
export const NOTE_MAX = 80;

/** A signup note, trimmed: null when absent or blank, 'bad' when longer than
 *  NOTE_MAX, not plain one-line text, or caught by the slur filter team names
 *  go through. */
export function cleanNote(s: unknown): string | null | 'bad' {
  if (s === undefined || s === null) return null;
  if (typeof s !== 'string') return 'bad';
  const note = s.normalize('NFC').trim();
  if (note === '') return null;
  if (note.length > NOTE_MAX || hasUnsafeChars(note) || DEFAULT_IGNORABLE.test(note)) return 'bad';
  if (findSlurs(note).length > 0) return 'bad';
  return note;
}

export type CutRole = 'captain' | 'pool' | 'bench';

/** Ruling 5: one team per four active signups, rounded down. */
export function maxTeams(activeCount: number): number {
  return Math.floor(Math.max(0, activeCount) / 4);
}

/** Roles for every active signup (Ruling 5): captains as given, then pool =
 *  the first teams*3 non-captains in signup order, the rest bench. A captain
 *  not among the signups is ignored. */
export function defaultRoles(signups: { steamid: string }[], captains: ReadonlySet<string>, teams: number): Map<string, CutRole> {
  const out = new Map<string, CutRole>();
  let pool = Math.max(0, teams) * 3;
  for (const s of signups) {
    if (captains.has(s.steamid)) out.set(s.steamid, 'captain');
    else if (pool > 0) { out.set(s.steamid, 'pool'); pool--; }
    else out.set(s.steamid, 'bench');
  }
  return out;
}

export type CutProblem = 'too_few_teams' | 'too_many_teams' | 'too_few_captains' | 'too_many_captains' | 'pool_size' | 'unassigned' | 'ineligible';

/** Why a working cut cannot be published, in this order of checks; [] =
 *  publishable. Publish refuses unless the pool is exactly teams x 3
 *  (Review Focus 3). */
export function cutProblems(o: { teams: number | null; active: number; captains: number; pool: number; unassigned: number; ineligible: number }): CutProblem[] {
  const out: CutProblem[] = [];
  const teams = o.teams ?? 0;
  if (o.teams === null || teams < 2) out.push('too_few_teams');
  if (teams > maxTeams(o.active)) out.push('too_many_teams');
  if (o.captains < teams) out.push('too_few_captains');
  if (o.captains > teams) out.push('too_many_captains');
  if (o.pool !== teams * 3) out.push('pool_size');
  if (o.unassigned > 0) out.push('unassigned');
  if (o.ineligible > 0) out.push('ineligible');
  return out;
}
