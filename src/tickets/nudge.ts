import type { DB } from '../db.js';
import type { Hub } from '../ws.js';
import { getPlayer } from '../players.js';
import { inGoodStanding } from '../standing.js';
import { canSeeTicket, getTicketRow } from './store.js';

/**
 * "This ticket changed: refetch it", to the browsers of people who may see
 * that ticket and to no others.
 *
 * hub.broadcast('refresh') reaches every open browser, the accused's
 * included, and every browser answers it with a refetch. A ticket's chat must
 * never ride that. This sends 'tickets' only to sockets whose user is, right
 * now, a moderator or admin in good standing who passes canSeeTicket: the rule
 * every read path uses, so the accused and anyone off a restricted ticket's
 * list hear nothing, not even that something happened.
 *
 * The event is a name and nothing else. A ticket that no longer exists (it
 * was folded into another) is told to nobody.
 */
export function ticketNudger(db: DB, hub: Hub): (ticketId: number) => void {
  return (ticketId) => {
    const t = getTicketRow(db, ticketId);
    if (!t) return;
    hub.sendTo('tickets', (steamid) => {
      const p = getPlayer(db, steamid);
      // inGoodStanding, as every other staff check asks it: players.status is
      // a cached consequence of the bans table, and a moderator banned a
      // moment ago must stop hearing on the socket they already hold.
      return !!p && (p.is_admin === 1 || p.is_mod === 1) && inGoodStanding(db, steamid) && canSeeTicket(db, t, steamid);
    });
  };
}
