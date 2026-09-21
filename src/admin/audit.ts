import type { DB } from '../db.js';
import { publishAdminEvent } from '../adminFeed.js';
import { canSeeTicket, getTicketRow } from '../tickets/store.js';

/** Record an admin action. Called by every admin mutation, in the same
 *  request, so the log cannot miss one that succeeded.
 *
 *  `quiet` writes the audit row and publishes nothing. For restricted
 *  tickets: the admin feed channel is readable by every admin, including, in
 *  the case that matters, the one the ticket is about. */
export function logAdmin(
  db: DB, adminId: string, action: string, target: string | number, detail: object = {}, opts: { quiet?: boolean } = {},
): void {
  db.prepare('INSERT INTO admin_actions (admin_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(adminId, action, String(target), JSON.stringify(detail), new Date().toISOString());
  if (opts.quiet) return;
  publishAdminEvent({ kind: 'admin_action', adminId, action, target: String(target), detail: detail as Record<string, unknown> });
}

export interface AuditEntry {
  id: number;
  adminId: string;
  adminName: string | null;
  action: string;
  target: string;
  targetName: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** The log as this admin may read it. A ticket action carries the ticket id
 *  as its target and the outcome, the access list and the ban reason in its
 *  detail, so a row about a ticket the reader cannot open is dropped here:
 *  the row is still written, and an accused admin reading the log must not be
 *  able to tell that a case about them exists. */
export function recentActions(db: DB, viewer: string, limit = 200): AuditEntry[] {
  const rows = db.prepare(
    `SELECT a.id, a.admin_id, pa.name AS admin_name, a.action, a.target, pt.name AS target_name, a.detail, a.created_at
     FROM admin_actions a
     LEFT JOIN players pa ON pa.steamid = a.admin_id
     LEFT JOIN players pt ON pt.steamid = a.target
     ORDER BY a.id DESC LIMIT ?`,
  ).all(limit) as { id: number; admin_id: string; admin_name: string | null; action: string; target: string; target_name: string | null; detail: string; created_at: string }[];
  return rows.filter((r) => {
    if (!r.action.startsWith('ticket_')) return true;
    const t = getTicketRow(db, Number(r.target));
    return !!t && canSeeTicket(db, t, viewer);
  }).map((r) => ({
    id: r.id, adminId: r.admin_id, adminName: r.admin_name, action: r.action, target: r.target,
    targetName: r.target_name, detail: JSON.parse(r.detail), createdAt: r.created_at,
  }));
}
