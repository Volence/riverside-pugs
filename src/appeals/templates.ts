import type { DB } from '../db.js';
import { appealSettings, nextAppealAt } from './rules.js';
import { refOf, type AppealMessageRow, type AppealRow, type AppealState } from './types.js';

export const STATE_LABEL: Record<AppealState, string> = {
  open: 'Waiting for staff',
  asked: 'Waiting on the player',
  answered: 'Player replied, waiting for staff',
  accepted: 'Accepted',
  shortened: 'Shortened',
  denied: 'Denied',
  auto_denied: 'Denied automatically',
  lapsed: 'No answer in time',
  moot: 'Closed, the ban ended',
};

const fmt = (iso: string) => new Date(iso).toUTCString().replace(/:\d\d GMT$/, ' UTC');
const answerBy = (db: DB, row: AppealRow) => new Date(Date.parse(row.asked_at!) + appealSettings(db).answerHours * 3600_000).toISOString();

function again(db: DB, row: AppealRow, now: Date): string {
  const at = nextAppealAt(db, refOf(row), now);
  return at ? ` You can appeal again after ${fmt(at)}.` : '';
}

/** What the appellant reads on the site. Fixed sentences only: staff never
 *  add their own words to an outcome. */
export function playerLine(db: DB, row: AppealRow, now = new Date()): string | null {
  switch (row.state) {
    case 'open': case 'answered': return 'Your appeal was received. Staff will review it.';
    case 'asked': return `Staff have written to you about your appeal. Reply by ${fmt(answerBy(db, row))}.`;
    case 'accepted': return 'Your appeal was accepted. The ban has been lifted.';
    case 'shortened': return `Your appeal was reviewed. The ban now ends ${fmt(row.new_expires_at!)}.`;
    case 'denied': case 'auto_denied': case 'lapsed': return `Your appeal was reviewed and the ban stands.${again(db, row, now)}`;
    case 'moot': return null;
  }
}

/** The DM for a state, or null when that state sends none ('open' and
 *  'answered' are the appellant's own doing; 'asked' is told by the staff
 *  message itself, see messageDmText; 'moot' needs no word). */
export function dmText(db: DB, row: AppealRow, publicUrl: string, now = new Date()): string | null {
  const link = `${publicUrl}/appeal`;
  switch (row.state) {
    case 'open': case 'answered': case 'asked': case 'moot': return null;
    default: return `${playerLine(db, row, now)} (${link})`;
  }
}

/** The DM for one staff message. Never names who wrote it: the player
 *  only ever hears from "Staff". */
export function messageDmText(db: DB, msg: AppealMessageRow, publicUrl: string): string {
  const by = Math.floor((Date.parse(msg.created_at) + appealSettings(db).answerHours * 3600_000) / 1000);
  return `Staff wrote about your appeal:\n> ${msg.body.replace(/\n/g, '\n> ')}\nReply at ${publicUrl}/appeal by <t:${by}:f>.`;
}

/** Sent to a Discord member when the bot times them out or bans them. */
export function sanctionDmText(kind: 'timeout' | 'ban', until: string | null, reason: string, appealUrl: string | null): string {
  const what = kind === 'ban'
    ? 'You have been banned from the Riverside Discord'
    : `You have been timed out in the Riverside Discord until <t:${Math.floor(Date.parse(until!) / 1000)}:f>`;
  return `${what}. Reason: ${reason}.${appealUrl ? `\nIf you think this was a mistake, you can appeal at ${appealUrl}` : ''}`;
}
