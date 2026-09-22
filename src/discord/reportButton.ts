import type { DB } from '../db.js';
import { REPORT_CATEGORIES } from '../tickets/filing.js';
import { REPORT_LABELS } from './commands.js';
import type { ModalDef } from './transport.js';

/** A player the reporter could mean. */
export interface Candidate { steamid: string; name: string }

/**
 * Everyone the reporter has shared a match with, most recent match first,
 * one row each. Feeds the form's dropdown, which Discord caps at 25 options:
 * the default of 24 leaves room for the sentinel option.
 *
 * Filters to 'live', 'completed', and 'aborted' matches. This includes aborted
 * matches because that is when someone is most likely to be reported for going
 * AFK or abandoning mid-match. We exclude only 'configuring' matches, which had
 * lobbies that filled but never started a server.
 */
export function recentCoPlayers(db: DB, steamid: string, limit = 24): Candidate[] {
  return db.prepare(
    `SELECT p.steamid AS steamid, p.name AS name, MAX(mine.match_id) AS last_match
       FROM match_players mine
       JOIN match_players theirs
         ON theirs.match_id = mine.match_id AND theirs.player_id != mine.player_id
       JOIN players p ON p.steamid = theirs.player_id
       JOIN matches m ON m.id = mine.match_id
      WHERE mine.player_id = ? AND m.state IN ('live', 'completed', 'aborted')
      GROUP BY p.steamid
      ORDER BY last_match DESC
      LIMIT ?`,
  ).all(steamid, limit) as Candidate[];
}

/**
 * Players whose name the reporter may have typed. Exact matches win outright:
 * someone called "Bob" must not be buried by everyone called "Bobby". Only
 * when nothing matches exactly do we widen to a substring.
 *
 * The typed text goes into LIKE, so '%' and '_' are escaped. Without this a
 * reporter typing '%' matches the whole player list, which reads as the
 * feature being broken rather than as a wildcard.
 */
export function resolveByName(db: DB, typed: string, limit = 6): Candidate[] {
  const name = typed.trim();
  if (!name) return [];
  const exact = db.prepare(
    'SELECT steamid, name FROM players WHERE lower(name) = lower(?) ORDER BY name LIMIT ?',
  ).all(name, limit) as Candidate[];
  if (exact.length > 0) return exact;
  const escaped = name.replace(/[\\%_]/g, (c) => `\\${c}`);
  return db.prepare(
    `SELECT steamid, name FROM players
      WHERE lower(name) LIKE '%' || lower(?) || '%' ESCAPE '\\'
      ORDER BY name LIMIT ?`,
  ).all(escaped, limit) as Candidate[];
}

/** Custom id prefix. 'r:' is the admin feed and 't:' is tickets. */
export const REPORT_PREFIX = 'rp:';
/** The dropdown entry meaning "I will type the name instead". A modal select
 *  has no optional flag, so this sentinel is what lets the dropdown be
 *  skipped without the form refusing to submit. */
export const OTHER = '__other';
/** Discord's ceiling on a select option label. */
const LABEL_MAX = 100;

const clip = (s: string) => (s.length <= LABEL_MAX ? s : `${s.slice(0, LABEL_MAX - 1)}…`);

/** The form, built for this reporter: the dropdown is their own recent
 *  opponents, so the common case is one pick rather than any typing. */
export function reportModal(db: DB, reporter: string): ModalDef {
  return {
    customId: `${REPORT_PREFIX}new`,
    title: 'Report a player',
    fields: [
      {
        kind: 'select',
        id: 'who',
        label: 'Who are you reporting?',
        options: [
          { label: 'Someone else (I will type the name below)', value: OTHER },
          ...recentCoPlayers(db, reporter).map((c) => ({ label: clip(c.name), value: c.steamid })),
        ],
      },
      { kind: 'text', id: 'name', label: 'Or type their name', style: 'short', required: false, maxLength: 100 },
      {
        kind: 'select',
        id: 'reason',
        label: 'What happened?',
        options: REPORT_CATEGORIES.map((c) => ({ label: REPORT_LABELS[c], value: c })),
      },
      { kind: 'text', id: 'details', label: 'Details, in your own words', style: 'paragraph', required: false, maxLength: 1000 },
    ],
  };
}

/** Only the standing message's button answers with a form. The candidate
 *  buttons reply with a message, and the transport has to know the difference
 *  before it runs the handler. */
export function opensReportModal(customId: string): boolean {
  return customId === `${REPORT_PREFIX}open`;
}
