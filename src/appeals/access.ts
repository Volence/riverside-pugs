import type { DB } from '../db.js';
import { canOpenFile, type FileViewer } from '../admin/fileAccess.js';
import { banIsWithheld } from '../admin/banRedaction.js';
import { resolveAlias } from '../aliases.js';
import { canSeeTicket, getTicketRow, hasStaffFlag } from '../tickets/store.js';
import { OPEN_STATES, type AppealRow } from './types.js';

export type Fail = { ok: false; status: number; error: string };

/** The ban or sanction row behind an appeal: who issued it and its ticket. */
function source(db: DB, row: AppealRow): { createdBy: string; ticketId: number | null } {
  const r = row.ban_id !== null
    ? db.prepare('SELECT created_by, ticket_id FROM bans WHERE id = ?').get(row.ban_id)
    : db.prepare('SELECT created_by, ticket_id FROM discord_sanctions WHERE id = ?').get(row.sanction_id);
  const s = r as { created_by: string; ticket_id: number | null } | undefined;
  return { createdBy: s?.created_by ?? 'system', ticketId: s?.ticket_id ?? null };
}

export const issuerOf = (db: DB, row: AppealRow): string => source(db, row).createdBy;

/** 'system' (abandon bans, alt holds) and moderators are moderator rank. */
export function issuerIsAdmin(db: DB, createdBy: string): boolean {
  const p = db.prepare('SELECT is_admin FROM players WHERE steamid = ?').get(createdBy) as { is_admin: number } | undefined;
  return p?.is_admin === 1;
}

/**
 * The file rules, applied to an appeal. A moderator never sees an appeal by
 * staff (canOpenFile keeps them out of staff files), and nobody sees one
 * against a ban or sanction from a restricted ticket they cannot see.
 * Callers answer 404, never 403, as for files and tickets.
 */
export function canSeeAppeal(db: DB, viewer: FileViewer, row: AppealRow): boolean {
  if (!viewer.isAdmin && !viewer.isMod) return false;
  if (row.steamid !== null && !canOpenFile(db, viewer, row.steamid)) return false;
  const { ticketId } = source(db, row);
  if (row.ban_id !== null) return !banIsWithheld(db, ticketId, viewer.steamid);
  if (ticketId === null) return true;
  const t = getTicketRow(db, ticketId);
  return !!t && canSeeTicket(db, t, viewer.steamid);
}

/** A moderator's own discord_id (null if unlinked or unknown). */
function discordOf(db: DB, steamid: string): string | null {
  return (db.prepare('SELECT discord_id FROM players WHERE steamid = ?').get(steamid) as { discord_id: string | null } | undefined)
    ?.discord_id ?? null;
}

/** Owner ruling (2026-10-04): the viewer is the appellant through a linked
 *  identity, not just the same steamid. Caught here, before anything else,
 *  so a self-decision is refused the same 404 as "no such appeal" rather
 *  than a 403 that would confirm the appeal exists. Covers: a second Steam
 *  account aliased to the appellant's (or vice versa), and the viewer's own
 *  linked Discord matching either the sanction's discord_id or the
 *  appellant's current linked Discord. */
function isAppellant(db: DB, viewer: FileViewer, row: AppealRow): boolean {
  if (row.steamid !== null && resolveAlias(db, row.steamid) === resolveAlias(db, viewer.steamid)) return true;
  const viewerDiscord = discordOf(db, viewer.steamid);
  if (viewerDiscord === null) return false;
  if (row.discord_id !== null && viewerDiscord === row.discord_id) return true;
  if (row.steamid !== null && discordOf(db, row.steamid) === viewerDiscord) return true;
  return false;
}

/** Owner ruling 2 (2026-10-04): anyone at the issuer's rank or above,
 *  the issuer included. */
export function decideCheck(db: DB, viewer: FileViewer, row: AppealRow): { ok: true } | Fail {
  if (!canSeeAppeal(db, viewer, row)) return { ok: false, status: 404, error: 'no such appeal' };
  if (isAppellant(db, viewer, row)) return { ok: false, status: 404, error: 'no such appeal' };
  if (!OPEN_STATES.includes(row.state)) return { ok: false, status: 409, error: 'this appeal has already been decided' };
  if (!viewer.isAdmin && issuerIsAdmin(db, issuerOf(db, row))) {
    return { ok: false, status: 403, error: 'only an admin can decide an appeal against an admin\'s ban' };
  }
  return { ok: true };
}

/** Worked on the site alone: no forum post, no feed line, audited quiet.
 *  An appeal by staff, or against a ban or sanction from a restricted
 *  ticket (restricted tickets have no staff thread either). Fails closed
 *  when the ticket row is gone. */
export function appealIsQuiet(db: DB, row: AppealRow): boolean {
  if (row.steamid !== null && hasStaffFlag(db, row.steamid)) return true;
  const { ticketId } = source(db, row);
  if (ticketId === null) return false;
  const t = getTicketRow(db, ticketId);
  return !t || t.restricted === 1;
}
