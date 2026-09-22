import { ticketsAbout } from '../../tickets/views.js';
import { toIso, type TimelineAdapter, type TimelineItem } from './types.js';

/** Tickets about this player, one row each: opened, closed, outcome. The
 *  discussion stays on the ticket page.
 *
 *  Everything goes through ticketsAbout, so the tickets rules are obeyed by
 *  construction: nobody sees a ticket about themselves, and a restricted one
 *  is simply absent for anyone off its access list. */
export const ticketsAdapter: TimelineAdapter = {
  source: 'ticket',
  items({ db, ids, viewer }): TimelineItem[] {
    const out: TimelineItem[] = [];
    for (const id of ids) {
      for (const t of ticketsAbout(db, id, viewer)) {
        out.push({
          at: toIso(t.createdAt),
          source: 'ticket',
          kind: t.status,
          summary: `Ticket #${t.id}: ${t.categories.join(', ') || 'opened by staff'}, `
            + `${t.reports} report${t.reports === 1 ? '' : 's'}, `
            + `${t.status === 'open' ? 'open' : `closed ${(t.outcome ?? 'with no outcome').replace(/_/g, ' ')}`}.`,
          matchId: null,
          replay: null,
          ref: { type: 'ticket', id: t.id },
        });
      }
    }
    return out;
  },
};
