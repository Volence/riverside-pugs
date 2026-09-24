import { WITHHELD_REASON, banIsWithheld } from '../banRedaction.js';
import { ROW_LIMIT, marks, toIso, type TimelineAdapter, type TimelineItem } from './types.js';

interface Row {
  id: number; reason: string; created_by: string; created_by_name: string | null;
  created_at: string; expires_at: string | null; lifted_at: string | null;
  lifted_by_name: string | null; ticket_id: number | null;
}

/** How long a ban ran, in the words the panel's own ban form offers. Derived
 *  from the two timestamps because the minutes an admin picked are not
 *  stored: only the expiry they produced is. */
export function fmtBanLength(createdAt: string, expiresAt: string | null): string {
  if (!expiresAt) return 'permanent';
  const m = Math.round((Date.parse(toIso(expiresAt)) - Date.parse(toIso(createdAt))) / 60_000);
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m >= 60 && m % 60 === 0) return `${m / 60} h`;
  return `${m} min`;
}

/** Bans, with the reason of one issued from a ticket this viewer cannot see
 *  withheld rather than dropped. */
export const bansAdapter: TimelineAdapter = {
  source: 'ban',
  items({ db, ids, viewer }): TimelineItem[] {
    const rows = db.prepare(
      `SELECT b.id, b.reason, b.created_by, pc.name AS created_by_name, b.created_at,
              b.expires_at, b.lifted_at, pl.name AS lifted_by_name, b.ticket_id
       FROM bans b
       LEFT JOIN players pc ON pc.steamid = b.created_by
       LEFT JOIN players pl ON pl.steamid = b.lifted_by
       WHERE b.player_id IN (${marks(ids)}) ORDER BY b.id DESC LIMIT ?`,
    ).all(...ids, ROW_LIMIT) as Row[];
    return rows.map((r) => {
      const withheld = banIsWithheld(db, r.ticket_id, viewer);
      const by = withheld ? 'a moderator' : (r.created_by_name ?? r.created_by);
      return {
        at: toIso(r.created_at),
        source: 'ban' as const,
        kind: r.lifted_at ? 'lifted' : 'ban',
        summary: `Banned by ${by}, ${fmtBanLength(r.created_at, r.expires_at)}: `
          + `${withheld ? WITHHELD_REASON : r.reason}.`
          + (r.lifted_at ? ` Lifted ${withheld ? '' : `by ${r.lifted_by_name ?? 'the system'} `}since.` : ''),
        matchId: null,
        replay: null,
        ref: { type: 'ban', id: r.id },
      };
    });
  },
};
