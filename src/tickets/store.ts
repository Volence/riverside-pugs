import type { DB } from '../db.js';

export interface TicketRow {
  id: number;
  target_id: string;
  status: 'open' | 'closed';
  outcome: string | null;
  outcome_note: string;
  restricted: number;
  claimed_by: string | null;
  opened_by: string | null;
  created_at: string;
  closed_at: string | null;
  closed_by: string | null;
}

/** Admin or moderator flag set, whatever the account's status. Used to decide
 *  that a report is ABOUT staff, where a banned moderator is still staff for
 *  the purpose of keeping their colleagues out of the case. */
export function hasStaffFlag(db: DB, steamid: string): boolean {
  const p = db.prepare('SELECT is_admin, is_mod FROM players WHERE steamid = ?').get(steamid) as
    | { is_admin: number; is_mod: number } | undefined;
  return !!p && (p.is_admin === 1 || p.is_mod === 1);
}

export function getTicketRow(db: DB, id: number): TicketRow | undefined {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined;
}

/** The one visibility rule. The accused never sees a ticket about themselves;
 *  a restricted ticket is seen only by its access list. Callers turn false
 *  into 404, never 403: a restricted ticket must not be detectable. */
export function canSeeTicket(db: DB, t: TicketRow, viewer: string): boolean {
  if (t.target_id === viewer) return false;
  if (t.restricted !== 1) return true;
  return !!db.prepare('SELECT 1 FROM ticket_access WHERE ticket_id = ? AND steamid = ?').get(t.id, viewer);
}

export function addTicketEvent(
  db: DB, ticketId: number, actorId: string | null, kind: string, detail: object = {}, now = new Date(),
): void {
  db.prepare('INSERT INTO ticket_events (ticket_id, actor_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, actorId, kind, JSON.stringify(detail), now.toISOString());
}

/** Who may see a newly restricted ticket. The configured owners first; if
 *  that leaves nobody (none configured, or the owner is the accused), every
 *  admin. Never the accused, by any route. */
export function seedAccess(
  db: DB, ticketId: number, targetId: string, adminSteamIds: string[], extra: string[] = [], now = new Date(),
): void {
  const exists = (id: string) => !!db.prepare('SELECT 1 FROM players WHERE steamid = ?').get(id);
  let ids = adminSteamIds.filter((id) => id !== targetId && exists(id));
  if (ids.length === 0) {
    ids = (db.prepare('SELECT steamid FROM players WHERE is_admin = 1 AND steamid != ?').all(targetId) as { steamid: string }[])
      .map((r) => r.steamid);
  }
  const ins = db.prepare('INSERT OR IGNORE INTO ticket_access (ticket_id, steamid, added_by, created_at) VALUES (?, ?, ?, ?)');
  for (const id of new Set([...ids, ...extra.filter((e) => e !== targetId)])) ins.run(ticketId, id, 'system', now.toISOString());
}

/**
 * Close the gap between "this player is now staff" and "the case about them
 * is readable by every moderator". Called when a player is promoted and when
 * one is merged into a staff account.
 *
 * tickets_one_open allows one open ticket of each flavour, so where the
 * player already has an open restricted ticket the normal one is folded into
 * it rather than restricted, the way a merge folds two open tickets together.
 * Runs inside the caller's transaction.
 */
export function restrictOpenTicketAbout(
  db: DB, targetId: string, adminSteamIds: string[], now = new Date(),
): void {
  const open = (restricted: number) => db.prepare("SELECT id FROM tickets WHERE target_id = ? AND restricted = ? AND status = 'open'")
    .get(targetId, restricted) as { id: number } | undefined;
  const normal = open(0);
  if (!normal) return;
  const sibling = open(1);
  if (!sibling) {
    db.prepare('UPDATE tickets SET restricted = 1 WHERE id = ?').run(normal.id);
    seedAccess(db, normal.id, targetId, adminSteamIds, [], now);
    addTicketEvent(db, normal.id, null, 'restricted', {}, now);
    return;
  }
  db.prepare('UPDATE ticket_reports SET ticket_id = ? WHERE ticket_id = ?').run(sibling.id, normal.id);
  db.prepare('UPDATE ticket_events SET ticket_id = ? WHERE ticket_id = ?').run(sibling.id, normal.id);
  db.prepare('UPDATE bans SET ticket_id = ? WHERE ticket_id = ?').run(sibling.id, normal.id);
  // A ticket that was restricted once and is no longer keeps its old list;
  // the sibling has its own, so those rows go rather than travel.
  db.prepare('DELETE FROM ticket_access WHERE ticket_id = ?').run(normal.id);
  db.prepare('DELETE FROM tickets WHERE id = ?').run(normal.id);
}
