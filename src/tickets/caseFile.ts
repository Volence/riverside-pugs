import type { DB } from '../db.js';
import { playerDetail } from '../admin/players.js';
import { getPlayer } from '../players.js';
import { banRedactor } from '../admin/banRedaction.js';
import { ticketsAbout } from './views.js';

/**
 * What a moderator sees about the accused beside a ticket. Picked from
 * playerDetail rather than passed through whole: a moderator is not an admin,
 * and does not get notes, the match list, or the hashed network rows. They do
 * get sharesAddressWith, because "is this a second account" is a ticket
 * question; it carries names and countries, never a hash.
 */
export function caseFile(db: DB, steamid: string, viewer: string) {
  const p = getPlayer(db, steamid);
  // playerDetail now redacts bans itself, so it needs the real viewer too:
  // its default '' viewer would over-redact a ban this viewer is actually
  // allowed to see, which the redact() below could not undo.
  const d = playerDetail(db, steamid, viewer);
  if (!p || !d) return null;
  const redact = banRedactor(db, steamid, viewer);
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
