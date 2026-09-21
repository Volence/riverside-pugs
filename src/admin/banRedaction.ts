import type { DB } from '../db.js';
import type { BanRow } from './players.js';
import { canSeeTicket, getTicketRow } from '../tickets/store.js';

export const WITHHELD_REASON = 'Withheld (restricted ticket)';

/**
 * A ban issued from a restricted ticket carries that ticket's free text and
 * its issuer. Once an ordinary ticket exists about the same player, any
 * moderator opening it sees this player's record too, so a ban tied to a
 * ticket they cannot see is redacted rather than dropped: they still learn
 * the player is or was banned and for how long, never why or by whom.
 *
 * One copy, used by the timeline, the file, the ban list and the ticket
 * page. Two copies of a rule like this is how the two drift apart.
 *
 * bans.ticket_id carries no foreign key, so a row that no longer resolves
 * (never created, or the ticket since gone by some path that did not clear
 * it) is treated as one the viewer may not open: the alternative is showing
 * the real reason and issuer to everyone the moment the link breaks, and a
 * confidentiality rule that fails open on a dangling pointer is not a rule.
 */
export function banIsWithheld(db: DB, ticketId: number | null, viewer: string): boolean {
  if (ticketId === null) return false;
  const t = getTicketRow(db, ticketId);
  return !t || !canSeeTicket(db, t, viewer);
}

export function redactBan(ban: BanRow): BanRow {
  return {
    ...ban,
    reason: WITHHELD_REASON,
    // BanRow.createdBy is typed string, not string | null, so '' stands in
    // for withheld rather than widening a type the whole panel shares.
    createdBy: '',
    createdByName: null,
    liftedBy: null,
    liftedByName: null,
  };
}

/** The rule for one player's bans, with the ban-to-ticket lookup done once. */
export function banRedactor(db: DB, steamid: string, viewer: string): (ban: BanRow) => BanRow {
  const ticketIdByBan = new Map(
    (db.prepare('SELECT id, ticket_id FROM bans WHERE player_id = ?').all(steamid) as
      { id: number; ticket_id: number | null }[]).map((r) => [r.id, r.ticket_id]),
  );
  return (ban) => (banIsWithheld(db, ticketIdByBan.get(ban.id) ?? null, viewer) ? redactBan(ban) : ban);
}
