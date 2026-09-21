import type { DB } from '../db.js';
import { banIsWithheld, WITHHELD_REASON } from './banRedaction.js';
import { canOpenFile, type FileViewer } from './fileAccess.js';
import { fmtBanLength } from './timeline/bans.js';
import { toIso } from './timeline/types.js';

export interface PeopleBanRow {
  id: number;
  steamid: string;
  name: string;
  reason: string;
  /** How long it was for, in the words the ban form offers. */
  length: string;
  createdAt: string;
  expiresAt: string | null;
  createdByName: string | null;
  liftedAt: string | null;
  liftedByName: string | null;
  active: boolean;
  /** The ticket it came from, null when there is none or when naming it
   *  would tell the reader a restricted ticket exists. */
  ticketId: number | null;
  withheld: boolean;
  /** Whether this viewer may open the banned player's file. A moderator sees
   *  a ban on a colleague and is simply not offered the link. */
  canOpen: boolean;
}

interface Row {
  id: number; player_id: string; name: string | null; reason: string; created_at: string;
  expires_at: string | null; created_by_name: string | null; lifted_at: string | null;
  lifted_by_name: string | null; ticket_id: number | null;
}

/**
 * The ban list, inside the panel.
 *
 * Lifted and expired bans stay listed, as on the public page it replaces: a
 * record that quietly deletes its mistakes is not a record, and "lifted by,
 * and when" is the part that shows the process works.
 */
export function peopleBans(
  db: DB, viewer: FileViewer,
  opts: { filter?: 'active' | 'expired' | 'all'; q?: string; now?: Date } = {},
): PeopleBanRow[] {
  const now = opts.now ?? new Date();
  const q = (opts.q ?? '').trim();
  const like = `%${q.toLowerCase()}%`;
  const rows = db.prepare(
    `SELECT b.id, b.player_id, p.name, b.reason, b.created_at, b.expires_at,
            pc.name AS created_by_name, b.lifted_at, pl.name AS lifted_by_name, b.ticket_id
     FROM bans b
     LEFT JOIN players p  ON p.steamid  = b.player_id
     LEFT JOIN players pc ON pc.steamid = b.created_by
     LEFT JOIN players pl ON pl.steamid = b.lifted_by
     WHERE (? = '' OR b.player_id = ? OR LOWER(COALESCE(p.name, '')) LIKE ?)
     ORDER BY b.id DESC LIMIT 500`,
  ).all(q, q, like) as Row[];

  const filter = opts.filter ?? 'all';
  return rows.map((r) => {
    const active = r.lifted_at === null
      && (r.expires_at === null || Date.parse(toIso(r.expires_at)) > now.getTime());
    const withheld = banIsWithheld(db, r.ticket_id, viewer.steamid);
    return {
      id: r.id,
      steamid: r.player_id,
      name: r.name ?? r.player_id,
      reason: withheld ? WITHHELD_REASON : r.reason,
      length: fmtBanLength(r.created_at, r.expires_at),
      createdAt: toIso(r.created_at),
      expiresAt: r.expires_at === null ? null : toIso(r.expires_at),
      createdByName: withheld ? null : r.created_by_name,
      liftedAt: r.lifted_at === null ? null : toIso(r.lifted_at),
      liftedByName: withheld ? null : r.lifted_by_name,
      active,
      // Naming the ticket would say a restricted case exists, which is the
      // one thing its access list is for.
      ticketId: withheld ? null : r.ticket_id,
      withheld,
      canOpen: canOpenFile(db, viewer, r.player_id),
    };
  }).filter((b) => (filter === 'all' ? true : filter === 'active' ? b.active : !b.active));
}
