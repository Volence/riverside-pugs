import type { DB } from '../db.js';
import { personKey, targetOf } from './person.js';

export interface TicketRow {
  id: number;
  target_id: string | null;
  target_discord_id: string | null;
  target_name: string;
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
export function hasStaffFlag(db: DB, steamid: string | null): boolean {
  if (steamid === null) return false;
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

/** Who would be let into a restricted ticket about this player. The
 *  configured owners first; if that leaves nobody (none configured, or the
 *  owner is the accused), every admin. Never the accused, and never anyone in
 *  `exclude`: a merge passes the account that is about to stop existing, whose
 *  row would otherwise be rewritten onto the accused and thrown away. */
export function accessSeed(db: DB, targetId: string, adminSteamIds: string[], exclude: string[] = []): string[] {
  const out = new Set([targetId, ...exclude]);
  const exists = (id: string) => !!db.prepare('SELECT 1 FROM players WHERE steamid = ?').get(id);
  const owners = adminSteamIds.filter((id) => !out.has(id) && exists(id));
  if (owners.length > 0) return owners;
  return (db.prepare('SELECT steamid FROM players WHERE is_admin = 1').all() as { steamid: string }[])
    .map((r) => r.steamid).filter((id) => !out.has(id));
}

/** Put the seed, and anyone in `extra` who is not the accused, on the list. */
export function seedAccess(
  db: DB, ticketId: number, targetId: string, adminSteamIds: string[], extra: string[] = [], now = new Date(), exclude: string[] = [],
): void {
  const out = new Set([targetId, ...exclude]);
  const ins = db.prepare('INSERT OR IGNORE INTO ticket_access (ticket_id, steamid, added_by, created_at) VALUES (?, ?, ?, ?)');
  for (const id of new Set([...accessSeed(db, targetId, adminSteamIds, exclude), ...extra.filter((e) => !out.has(e))])) {
    ins.run(ticketId, id, 'system', now.toISOString());
  }
}

/**
 * Move everything hanging off `gone` onto `keep`, then delete `gone`. Both
 * are open tickets about one player in one flavour, which tickets_one_open
 * does not allow to coexist. Runs inside the caller's transaction.
 *
 * `access`: 'merge' carries the list across (two restricted tickets become
 * one), 'drop' discards it (a normal ticket folded into its restricted
 * sibling, which has a list of its own).
 *
 * The audit rows move too. recentActions drops a ticket row whose ticket it
 * cannot find, so without this the Audit tab would lose every action ever
 * taken on the emptied ticket.
 */
export function foldTicket(db: DB, gone: number, keep: number, access: 'merge' | 'drop', now = new Date()): void {
  db.prepare('UPDATE ticket_reports SET ticket_id = ? WHERE ticket_id = ?').run(keep, gone);
  // A restricted survivor's reports must never reach the admin feed, whatever
  // ticket they used to live on: feed_held follows the survivor's current
  // state, covering the ones that just moved in.
  if ((db.prepare('SELECT restricted FROM tickets WHERE id = ?').get(keep) as { restricted: number } | undefined)?.restricted === 1) {
    db.prepare('UPDATE ticket_reports SET feed_held = 1 WHERE ticket_id = ?').run(keep);
  }
  db.prepare('UPDATE ticket_events SET ticket_id = ? WHERE ticket_id = ?').run(keep, gone);
  db.prepare('UPDATE bans SET ticket_id = ? WHERE ticket_id = ?').run(keep, gone);
  // discord_sanctions.ticket_id is a foreign key to tickets, same as bans: a
  // sanction recorded against the emptied ticket must follow it, or deleting
  // `gone` below would throw a foreign key violation.
  db.prepare('UPDATE discord_sanctions SET ticket_id = ? WHERE ticket_id = ?').run(keep, gone);
  // Close DMs owed to reporters reference the ticket too: a notice queued on
  // the emptied ticket still goes out, from the survivor.
  db.prepare('UPDATE ticket_notices SET ticket_id = ? WHERE ticket_id = ?').run(keep, gone);
  // An in-game call links the ticket it filed onto. No foreign key holds this
  // one, so without the move the card and the calls page would link a ticket
  // that no longer exists.
  db.prepare('UPDATE mod_calls SET ticket_id = ? WHERE ticket_id = ?').run(keep, gone);
  if (access === 'merge') db.prepare('UPDATE OR IGNORE ticket_access SET ticket_id = ? WHERE ticket_id = ?').run(keep, gone);
  db.prepare('DELETE FROM ticket_access WHERE ticket_id = ?').run(gone);
  db.prepare("UPDATE admin_actions SET target = ? WHERE target = ? AND action LIKE 'ticket\\_%' ESCAPE '\\'")
    .run(String(keep), String(gone));
  // The mirrored discussion is part of the case. Attachments hang off their
  // message, so they follow without being touched.
  db.prepare('UPDATE ticket_messages SET ticket_id = ? WHERE ticket_id = ?').run(keep, gone);
  // Discord threads follow the ticket. Where the survivor already has a staff
  // thread, the other is marked 'folded': TicketSync posts one line in the
  // survivor naming it, then locks and archives it. Where it has none, the
  // moved thread simply becomes the survivor's. A forum thread that lands on
  // a restricted ticket this way is deleted by the reconciler, whatever its
  // state: see forbiddenForumThreads.
  const keepHasThread = db.prepare("SELECT 1 FROM ticket_threads WHERE ticket_id = ? AND kind = 'staff' AND state = 'open'").get(keep) ? 1 : 0;
  db.prepare(
    `UPDATE ticket_threads SET ticket_id = ?,
       state = CASE WHEN kind = 'staff' AND state = 'open' AND ? = 1 THEN 'folded' ELSE state END
     WHERE ticket_id = ?`,
  ).run(keep, keepHasThread, gone);
  db.prepare('DELETE FROM tickets WHERE id = ?').run(gone);
  addTicketEvent(db, keep, null, 'folded', { from: gone }, now);
}

/**
 * Keep everything about this player that the admin feed has not said yet out
 * of it for good. Called the moment somebody becomes staff (promotion, a
 * merge into a staff account, a Discord link that adopts a staff player's
 * old cases): every admin reads the feed, and they may be reading it now.
 *
 * Only reports not yet announced: one already said cannot be unsaid, and
 * marking it would change nothing. Runs inside the caller's transaction.
 *
 * This is what is left of restrictOpenTicketAbout. A ticket about staff is
 * no longer restricted for it (owner, 2026-09-22): the whole team works it,
 * and the accused is kept out by canSeeTicket on the site and by
 * forumAudience in Discord.
 */
export function holdFeedAbout(db: DB, steamid: string): number {
  return db.prepare(
    `UPDATE ticket_reports SET feed_held = 1
     WHERE feed_held = 0 AND announced_at IS NULL
       AND ticket_id IN (SELECT id FROM tickets WHERE target_id = ?)`,
  ).run(steamid).changes;
}

/**
 * Whether an audit row about this ticket must stay off the admin feed:
 * restricted, or about somebody with a staff flag. The feed line names only
 * the ticket number, but an accused admin who sees activity on a ticket the
 * site answers 404 for has learned that a case about them exists.
 */
export function ticketIsQuiet(db: DB, t: { restricted: number; target_id: string | null }): boolean {
  return t.restricted === 1 || hasStaffFlag(db, t.target_id);
}

/**
 * Open restricted tickets with nobody on their list, given to whoever can
 * take them now. A list empties when the only person on it is merged into
 * the accused, and starts empty when a safety report is filed while there is
 * no admin to give it to. Called at the end of a merge and whenever an admin
 * is created, so such a ticket surfaces the moment there is somebody to show
 * it to.
 */
export function reseedOrphanedTickets(
  db: DB, adminSteamIds: string[], exclude: string[] = [], now = new Date(),
): { seeded: number; stillEmpty: number } {
  const orphans = db.prepare(
    `SELECT t.id, t.target_id, t.target_discord_id, t.target_name FROM tickets t WHERE t.restricted = 1 AND t.status = 'open'
       AND NOT EXISTS (SELECT 1 FROM ticket_access a WHERE a.ticket_id = t.id)`,
  ).all() as { id: number; target_id: string | null; target_discord_id: string | null; target_name: string }[];
  let seeded = 0;
  for (const t of orphans) {
    seedAccess(db, t.id, personKey(targetOf(t)), adminSteamIds, [], now, exclude);
    if (db.prepare('SELECT 1 FROM ticket_access WHERE ticket_id = ?').get(t.id)) seeded++;
  }
  return { seeded, stillEmpty: orphans.length - seeded };
}
