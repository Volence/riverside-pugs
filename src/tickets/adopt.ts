import type { DB } from '../db.js';
import { foldTicket, hasStaffFlag, holdFeedAbout, reseedOrphanedTickets } from './store.js';

/**
 * Someone who was only in the Discord has linked Steam: everything recorded
 * under their Discord id becomes the player's, the way mergePlayers moves an
 * alt onto a main. Runs inside the caller's transaction.
 *
 * discord_sanctions rows stay keyed by Discord id on purpose: Discord acts on
 * that id, and lifting a timeout later has to name it. The player's case view
 * finds them through discord_link_history (sanctionsForPlayer).
 *
 * `stillEmpty` is how many open restricted tickets have nobody on their list
 * afterwards, for the caller to report once its transaction has committed.
 */
export function adoptDiscordPerson(
  db: DB, discordId: string, steamid: string, adminSteamIds: string[], now = new Date(),
): { moved: number; stillEmpty: number } {
  // tickets_one_open allows one open case per person per flavour. Where both
  // identities have one, the Discord one folds into the player's.
  for (const restricted of [0, 1]) {
    const gone = db.prepare("SELECT id FROM tickets WHERE target_discord_id = ? AND restricted = ? AND status = 'open'")
      .get(discordId, restricted) as { id: number } | undefined;
    const keep = db.prepare("SELECT id FROM tickets WHERE target_id = ? AND restricted = ? AND status = 'open'")
      .get(steamid, restricted) as { id: number } | undefined;
    if (gone && keep) foldTicket(db, gone.id, keep.id, 'merge', now);
  }
  const moved = db.prepare('UPDATE tickets SET target_id = ?, target_discord_id = NULL WHERE target_discord_id = ?').run(steamid, discordId).changes;
  db.prepare("UPDATE ticket_reports SET reporter_id = ?, reporter_discord_id = NULL, reporter_name = '' WHERE reporter_discord_id = ?").run(steamid, discordId);
  db.prepare('UPDATE pending_reports SET reporter_id = ?, reporter_discord_id = NULL WHERE reporter_discord_id = ?').run(steamid, discordId);
  db.prepare('UPDATE ticket_threads SET reporter_id = ?, reporter_discord_id = NULL WHERE reporter_discord_id = ?').run(steamid, discordId);
  // What they wrote in a ticket thread before they linked: the mirror stored
  // it with no player, because there was none. Only the unset ones: a message
  // written while this Discord account belonged to somebody else keeps them.
  db.prepare('UPDATE ticket_messages SET author_player_id = ? WHERE author_discord_id = ? AND author_player_id IS NULL').run(steamid, discordId);
  if (hasStaffFlag(db, steamid)) holdFeedAbout(db, steamid);
  // The accused never sits on a list of a case about themselves.
  db.prepare('DELETE FROM ticket_access WHERE steamid = ? AND ticket_id IN (SELECT id FROM tickets WHERE target_id = ?)').run(steamid, steamid);
  const { stillEmpty } = reseedOrphanedTickets(db, adminSteamIds, [], now);
  return { moved, stillEmpty };
}
