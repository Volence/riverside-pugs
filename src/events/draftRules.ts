import { findSlurs } from '../slurs.js';
import { hasUnsafeChars } from '../profileFields.js';

/**
 * The draft rules that need no database (drafts plan D1). Task 2 holds the
 * signup note; later tasks add the team count, the default cut, captain
 * offer order and publish validation. src/events/drafts.ts calls these
 * inside its transactions.
 */

/** Ruling 10: a note is optional free text of 1 to 80 characters. */
export const NOTE_MAX = 80;

/** Invisible-by-design code points, refused as team names refuse them
 *  (src/teams/teams.ts normalizeName). */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

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
