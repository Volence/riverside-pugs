import type { DB } from '../db.js';
import { insertBan } from '../admin/players.js';
import { publishBanChange } from '../banEvents.js';
import { getSetting } from '../settings.js';
import { addTicketEvent, canSeeTicket, getTicketRow, hasStaffFlag, seedAccess, type TicketRow } from './store.js';

export const TICKET_OUTCOMES = ['action_taken', 'warned', 'no_action', 'invalid'] as const;
export type TicketOutcome = (typeof TICKET_OUTCOMES)[number];
export type ActionResult = { ok: true } | { ok: false; status: number; error: string };

const fail = (status: number, error: string): ActionResult => ({ ok: false, status, error });
const OK: ActionResult = { ok: true };

/** Missing and invisible are the same answer on purpose. */
function visible(db: DB, id: number, by: string): TicketRow | null {
  const t = getTicketRow(db, id);
  return t && canSeeTicket(db, t, by) ? t : null;
}

/** tickets_one_open turns a second open ticket of one flavour into a
 *  constraint error; this turns that into a 409 with words. */
function guardUnique(fn: () => void, error: string): ActionResult {
  try {
    fn();
    return OK;
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return fail(409, error);
    throw err;
  }
}

export function claimTicket(db: DB, id: number, by: string, claim: boolean): ActionResult {
  const t = visible(db, id, by);
  if (!t) return fail(404, 'no such ticket');
  if (t.status !== 'open') return fail(409, 'the ticket is closed');
  db.transaction(() => {
    db.prepare('UPDATE tickets SET claimed_by = ? WHERE id = ?').run(claim ? by : null, id);
    addTicketEvent(db, id, by, claim ? 'claimed' : 'unclaimed');
  })();
  return OK;
}

export function setRestricted(db: DB, id: number, by: string, restricted: boolean, adminSteamIds: string[]): ActionResult {
  const t = visible(db, id, by);
  if (!t) return fail(404, 'no such ticket');
  if ((t.restricted === 1) === restricted) return OK;
  if (!restricted) {
    if (hasStaffFlag(db, t.target_id)) return fail(400, 'a ticket about staff stays restricted');
    if (db.prepare("SELECT 1 FROM ticket_reports WHERE ticket_id = ? AND category = 'unsafe'").get(id)) {
      return fail(400, 'a ticket holding a safety report stays restricted');
    }
  }
  return guardUnique(() => db.transaction(() => {
    db.prepare('UPDATE tickets SET restricted = ? WHERE id = ?').run(restricted ? 1 : 0, id);
    if (restricted) seedAccess(db, id, t.target_id, adminSteamIds, [by]);
    addTicketEvent(db, id, by, restricted ? 'restricted' : 'unrestricted');
  })(), `there is already an open ${restricted ? 'restricted' : 'normal'} ticket about this player`);
}

export function addAccess(db: DB, id: number, by: string, steamid: string): ActionResult {
  const t = visible(db, id, by);
  if (!t) return fail(404, 'no such ticket');
  if (t.restricted !== 1) return fail(400, 'the ticket is not restricted');
  if (steamid === t.target_id) return fail(400, 'the accused can never be given access');
  if (!hasStaffFlag(db, steamid)) return fail(400, 'only staff can be given access');
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO ticket_access (ticket_id, steamid, added_by, created_at) VALUES (?, ?, ?, ?)')
      .run(id, steamid, by, new Date().toISOString());
    addTicketEvent(db, id, by, 'access_added', { steamid });
  })();
  return OK;
}

export function closeTicket(db: DB, id: number, by: string, outcome: unknown, note: unknown): ActionResult {
  const t = visible(db, id, by);
  if (!t) return fail(404, 'no such ticket');
  if (typeof outcome !== 'string' || !(TICKET_OUTCOMES as readonly string[]).includes(outcome)) return fail(400, 'pick an outcome');
  if (t.status !== 'open') return fail(409, 'the ticket is already closed');
  const text = typeof note === 'string' ? note.trim().slice(0, 1000) : '';
  db.transaction(() => {
    db.prepare("UPDATE tickets SET status = 'closed', outcome = ?, outcome_note = ?, closed_at = ?, closed_by = ? WHERE id = ?")
      .run(outcome, text, new Date().toISOString(), by, id);
    addTicketEvent(db, id, by, 'closed', { outcome, note: text });
  })();
  return OK;
}

export function reopenTicket(db: DB, id: number, by: string): ActionResult {
  const t = visible(db, id, by);
  if (!t) return fail(404, 'no such ticket');
  if (t.status === 'open') return fail(409, 'the ticket is already open');
  return guardUnique(() => db.transaction(() => {
    db.prepare("UPDATE tickets SET status = 'open', outcome = NULL, outcome_note = '', closed_at = NULL, closed_by = NULL WHERE id = ?").run(id);
    addTicketEvent(db, id, by, 'reopened');
  })(), 'there is a newer open ticket about this player; work that one');
}

/**
 * Ban the accused from the ticket. A moderator is capped at
 * ticket_mod_ban_max_minutes and cannot ban permanently; an admin is not
 * capped. The ban row carries the ticket id.
 *
 * publishBanChange runs after the commit and never inside it, for the reason
 * written above insertBan: a subscriber dials rcon and places a permanent
 * engine ban, which nothing un-does if the row it stands for is rolled back.
 */
export function banFromTicket(db: DB, id: number, by: string, reason: unknown, minutes: unknown, now = new Date()): ActionResult {
  const t = visible(db, id, by);
  if (!t) return fail(404, 'no such ticket');
  if (t.status !== 'open') return fail(409, 'reopen the ticket before banning from it');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) return fail(400, 'a reason is required (up to 500 characters)');
  let mins: number | null = null;
  if (minutes !== undefined && minutes !== null && minutes !== '') {
    mins = Number(minutes);
    if (!Number.isInteger(mins) || mins <= 0 || mins > 60 * 24 * 365) return fail(400, 'minutes must be a whole number between 1 and 525600');
  }
  const actor = db.prepare('SELECT is_admin FROM players WHERE steamid = ?').get(by) as { is_admin: number } | undefined;
  if (actor?.is_admin !== 1) {
    // A banned admin fails requireAdmin and no moderator can lift the ban, so
    // one moderator on the access list could otherwise lock the admins out.
    const target = db.prepare('SELECT is_admin FROM players WHERE steamid = ?').get(t.target_id) as { is_admin: number } | undefined;
    if (target?.is_admin === 1) return fail(403, 'only an admin can ban an admin');
    const cap = Number(getSetting(db, 'ticket_mod_ban_max_minutes') ?? '10080');
    if (mins === null || mins > cap) return fail(403, `moderators can ban for up to ${cap} minutes; ask an admin for longer`);
  }
  const text = reason.trim();
  db.transaction(() => {
    insertBan(db, t.target_id, by, text, mins, now);
    db.prepare('UPDATE bans SET ticket_id = ? WHERE id = (SELECT MAX(id) FROM bans WHERE player_id = ?)').run(id, t.target_id);
    addTicketEvent(db, id, by, 'banned', { reason: text, minutes: mins }, now);
  })();
  publishBanChange({ kind: 'ban', steamid: t.target_id, reason: text });
  return OK;
}
