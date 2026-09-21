import type { DB } from '../db.js';
import { playerDetail, type BanRow } from '../admin/players.js';
import { getPlayer } from '../players.js';
import { canSeeTicket, getTicketRow } from './store.js';
import { ticketsAbout } from './views.js';

const WITHHELD_REASON = 'Withheld (restricted ticket)';

/** A ban issued from a restricted ticket carries that ticket's free-text
 *  reason and its issuer. Once a later, ordinary ticket exists about the
 *  same player, any moderator opening that ticket gets this case file too,
 *  so a ban tied to a ticket this viewer cannot see is redacted here rather
 *  than dropped: the moderator still learns the player is or was banned and
 *  for how long, never why or by whom. */
function redactBan(db: DB, ban: BanRow, ticketId: number | null, viewer: string): BanRow {
  if (ticketId === null) return ban;
  const t = getTicketRow(db, ticketId);
  if (t && canSeeTicket(db, t, viewer)) return ban;
  return {
    ...ban,
    reason: WITHHELD_REASON,
    // BanRow.createdBy is typed string, not string | null, so '' stands in
    // for "withheld" rather than widening a type shared with the admin panel.
    createdBy: '',
    createdByName: null,
    liftedBy: null,
    liftedByName: null,
  };
}

/**
 * What a moderator sees about the accused beside a ticket. Picked from
 * playerDetail rather than passed through whole: a moderator is not an admin,
 * and does not get notes, the match list, or the hashed network rows. They do
 * get sharesAddressWith, because "is this a second account" is a ticket
 * question; it carries names and countries, never a hash.
 */
export function caseFile(db: DB, steamid: string, viewer: string) {
  const p = getPlayer(db, steamid);
  const d = playerDetail(db, steamid);
  if (!p || !d) return null;
  // playerDetail's ban rows don't carry ticket_id, so it's looked up here
  // rather than plumbed through toBan, which the admin Players tab also uses.
  const ticketIdByBan = new Map(
    (db.prepare('SELECT id, ticket_id FROM bans WHERE player_id = ?').all(steamid) as { id: number; ticket_id: number | null }[])
      .map((r) => [r.id, r.ticket_id]),
  );
  const redact = (ban: BanRow) => redactBan(db, ban, ticketIdByBan.get(ban.id) ?? null, viewer);
  return {
    steamid: p.steamid,
    name: p.name,
    avatar: p.avatar,
    status: p.status,
    // playerDetail spreads a search row that is absent in theory, so its
    // type is a union; narrow rather than assert.
    sr: 'sr' in d ? d.sr : null,
    games: 'games' in d ? d.games : 0,
    createdAt: p.created_at,
    activeBan: d.activeBan ? redact(d.activeBan) : null,
    bans: d.bans.map(redact),
    penalties: d.penalties,
    timeout: d.timeout,
    inputFlags: d.inputFlags,
    aliases: d.aliases,
    sharesAddressWith: d.sharesAddressWith,
    tickets: ticketsAbout(db, steamid, viewer),
  };
}
