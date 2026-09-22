import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { addTicketEvent, canSeeTicket, getTicketRow } from './store.js';
import { publishTicketSignal } from './signals.js';

/**
 * Discord-side sanctions on people who have no player account: a timeout or
 * a ban the bot carried out. Written in phase 3c; read here so a sanctioned
 * Discord-only member cannot file reports, which is their equivalent of
 * inGoodStanding.
 */
export function activeDiscordSanction(
  db: DB, discordId: string, now = new Date(),
): { kind: 'timeout' | 'ban'; until: string | null } | null {
  const row = db.prepare(
    `SELECT kind, until FROM discord_sanctions
     WHERE discord_id = ? AND lifted_at IS NULL AND (until IS NULL OR until > ?)
     ORDER BY id DESC LIMIT 1`,
  ).get(discordId, now.toISOString()) as { kind: 'timeout' | 'ban'; until: string | null } | undefined;
  return row ?? null;
}

export const DISCORD_TIMEOUT_MAX_MINUTES = 40320;
export type SanctionKind = 'timeout' | 'ban';
export interface SanctionPlan { ticketId: number; discordId: string; kind: SanctionKind; minutes: number | null; reason: string; restricted: boolean }
export type Checked<T> = { ok: true; plan: T } | { ok: false; status: number; error: string };

const no = (status: number, error: string) => ({ ok: false as const, status, error });
const isAdmin = (db: DB, steamid: string) =>
  (db.prepare('SELECT is_admin FROM players WHERE steamid = ?').get(steamid) as { is_admin: number } | undefined)?.is_admin === 1;

/**
 * Whether `by` may do this to the Discord-only person a ticket is about, and
 * exactly what. The one place the caps live: the route calls Discord only
 * with a plan this returned.
 *
 * Discord's own member.timeout REPLACES a running timeout rather than
 * stacking on it, so after the checks above pass on their own terms, this
 * also looks at what is already active on that discord_id: an active ban
 * blocks any new sanction outright (Discord has nothing further to do and a
 * ban already lasts until lifted), and an active timeout blocks a moderator
 * (who could otherwise silently overwrite an admin's longer one) while
 * letting an admin proceed, since an admin lifting-and-replacing is exactly
 * what recordDiscordSanction then records.
 */
export function checkDiscordSanction(
  db: DB, ticketId: number, by: string, body: { kind?: unknown; minutes?: unknown; reason?: unknown }, now = new Date(),
): Checked<SanctionPlan> {
  const t = getTicketRow(db, ticketId);
  if (!t || !canSeeTicket(db, t, by)) return no(404, 'no such ticket');
  if (t.status !== 'open') return no(409, 'reopen the ticket first');
  if (t.target_discord_id === null) return no(400, 'this ticket is about a player; use the server ban');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > 500) return no(400, 'a reason is required (up to 500 characters)');
  if (body.kind !== 'timeout' && body.kind !== 'ban') return no(400, 'pick a timeout or a ban');
  const admin = isAdmin(db, by);
  let plan: SanctionPlan;
  if (body.kind === 'ban') {
    if (!admin) return no(403, 'only an admin can ban from the Discord');
    plan = { ticketId, discordId: t.target_discord_id, kind: 'ban', minutes: null, reason, restricted: t.restricted === 1 };
  } else {
    const minutes = Number(body.minutes);
    if (!Number.isInteger(minutes) || minutes <= 0) return no(400, 'a timeout needs a length in minutes');
    if (minutes > DISCORD_TIMEOUT_MAX_MINUTES) return no(400, `Discord allows at most ${DISCORD_TIMEOUT_MAX_MINUTES} minutes`);
    if (!admin) {
      const cap = Math.min(Number(getSetting(db, 'ticket_mod_ban_max_minutes') ?? '10080'), DISCORD_TIMEOUT_MAX_MINUTES);
      if (minutes > cap) return no(403, `moderators can time out for up to ${cap} minutes; ask an admin for longer`);
    }
    plan = { ticketId, discordId: t.target_discord_id, kind: 'timeout', minutes, reason, restricted: t.restricted === 1 };
  }
  const active = activeDiscordSanction(db, t.target_discord_id, now);
  if (active) {
    if (active.kind === 'ban') return no(409, 'they are already banned from the Discord');
    if (!admin) {
      const until = active.until ? new Date(active.until).toUTCString() : 'no end date';
      return no(409, `already timed out until ${until}; an admin can lift or change it`);
    }
  }
  return { ok: true, plan };
}

/** Insert the row, log it on the ticket, and tell Discord-sync after the
 *  commit. Returns the new row's id.
 *
 *  Also, in the same transaction, marks every other still-active row for
 *  this discord_id lifted (by this actor, now), with a
 *  'discord_sanction_lifted' event on each one's own ticket if it has one:
 *  Discord's timeout replaces a running one rather than stacking on it, so
 *  the record has to follow what Discord now actually holds, not leave a
 *  superseded row reading "active". */
export function recordDiscordSanction(db: DB, plan: SanctionPlan, by: string, now = new Date()): number {
  const until = plan.kind === 'timeout' && plan.minutes !== null
    ? new Date(now.getTime() + plan.minutes * 60_000).toISOString()
    : null;
  const nowIso = now.toISOString();
  const id = db.transaction(() => {
    const insertedId = Number(db.prepare(
      `INSERT INTO discord_sanctions (discord_id, kind, until, reason, ticket_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(plan.discordId, plan.kind, until, plan.reason, plan.ticketId, by, nowIso).lastInsertRowid);
    addTicketEvent(db, plan.ticketId, by, 'discord_sanction', { kind: plan.kind, minutes: plan.minutes, reason: plan.reason }, now);
    const superseded = db.prepare(
      `SELECT id, kind, ticket_id FROM discord_sanctions
       WHERE discord_id = ? AND id != ? AND lifted_at IS NULL AND (until IS NULL OR until > ?)`,
    ).all(plan.discordId, insertedId, nowIso) as { id: number; kind: SanctionKind; ticket_id: number | null }[];
    if (superseded.length > 0) {
      const lift = db.prepare('UPDATE discord_sanctions SET lifted_by = ?, lifted_at = ? WHERE id = ?');
      for (const row of superseded) {
        lift.run(by, nowIso, row.id);
        if (row.ticket_id !== null) {
          addTicketEvent(db, row.ticket_id, by, 'discord_sanction_lifted', { kind: row.kind, superseded: true }, now);
        }
      }
    }
    return insertedId;
  })();
  publishTicketSignal({ kind: 'ticket', ticketId: plan.ticketId });
  return id;
}

export interface LiftPlan { sanctionId: number; discordId: string; kind: SanctionKind; ticketId: number | null; restricted: boolean }

/** Whether `by` may lift this sanction. Visibility first: the row must
 *  exist and, if it is tied to a ticket, that ticket must be visible to
 *  `by`, else the same 404 a missing sanction would give, so a restricted
 *  ticket's sanctions are not detectable by someone off its access list,
 *  whatever their role. Only once that holds do admin-ness and whether the
 *  sanction is still active get checked. */
export function checkLift(db: DB, sanctionId: number, by: string, now = new Date()): Checked<LiftPlan> {
  const row = db.prepare('SELECT id, discord_id, kind, until, ticket_id, lifted_at FROM discord_sanctions WHERE id = ?').get(sanctionId) as
    | { id: number; discord_id: string; kind: SanctionKind; until: string | null; ticket_id: number | null; lifted_at: string | null }
    | undefined;
  if (!row) return no(404, 'no such sanction');
  let restricted = false;
  if (row.ticket_id !== null) {
    const t = getTicketRow(db, row.ticket_id);
    if (!t || !canSeeTicket(db, t, by)) return no(404, 'no such sanction');
    restricted = t.restricted === 1;
  }
  if (!isAdmin(db, by)) return no(403, 'only an admin can lift a Discord sanction');
  const active = row.lifted_at === null && (row.kind !== 'timeout' || row.until === null || row.until > now.toISOString());
  if (!active) return no(409, 'that sanction is no longer in force');
  return { ok: true, plan: { sanctionId: row.id, discordId: row.discord_id, kind: row.kind, ticketId: row.ticket_id, restricted } };
}

/** Mark the row lifted, and log it on the ticket if it has one. Guarded with
 *  `AND lifted_at IS NULL` so two admins racing to lift the same sanction
 *  cannot both record it: the loser's UPDATE changes nothing, and this
 *  returns false, so the caller (the route) can answer 409 rather than write
 *  a second event and re-notify the ticket. */
export function recordLift(db: DB, plan: LiftPlan, by: string, now = new Date()): boolean {
  const changed = db.transaction(() => {
    const c = db.prepare('UPDATE discord_sanctions SET lifted_by = ?, lifted_at = ? WHERE id = ? AND lifted_at IS NULL')
      .run(by, now.toISOString(), plan.sanctionId).changes > 0;
    if (c && plan.ticketId !== null) {
      addTicketEvent(db, plan.ticketId, by, 'discord_sanction_lifted', { kind: plan.kind }, now);
    }
    return c;
  })();
  if (changed && plan.ticketId !== null) publishTicketSignal({ kind: 'ticket', ticketId: plan.ticketId });
  return changed;
}

export interface SanctionRow {
  id: number; kind: SanctionKind; until: string | null; reason: string; ticketId: number | null;
  createdBy: string; createdByName: string | null; createdAt: string; liftedBy: string | null; liftedAt: string | null; active: boolean;
}

/** Every sanction ever placed on this Discord id, newest first. */
export function sanctionsFor(db: DB, discordId: string, now = new Date()): SanctionRow[] {
  const rows = db.prepare(
    `SELECT s.id, s.kind, s.until, s.reason, s.ticket_id, s.created_by, p.name AS created_by_name, s.created_at, s.lifted_by, s.lifted_at
     FROM discord_sanctions s LEFT JOIN players p ON p.steamid = s.created_by
     WHERE s.discord_id = ? ORDER BY s.id DESC`,
  ).all(discordId) as {
    id: number; kind: SanctionKind; until: string | null; reason: string; ticket_id: number | null;
    created_by: string; created_by_name: string | null; created_at: string; lifted_by: string | null; lifted_at: string | null;
  }[];
  const nowIso = now.toISOString();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    until: r.until,
    reason: r.reason,
    ticketId: r.ticket_id,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    liftedBy: r.lifted_by,
    liftedAt: r.lifted_at,
    active: r.lifted_at === null && (r.until === null || r.until > nowIso),
  }));
}

/**
 * Every sanction on any Discord id this player has ever linked, newest first.
 * The rows stay keyed by Discord id (Discord acts on that id), so once a
 * Discord-only person links Steam, this is how their player case view still
 * finds what was done to them before. discord_link_history keeps every link,
 * and a merge moves those rows onto the survivor. Not redacted: callers pass
 * each row through redactDiscordSanction for their viewer.
 */
export function sanctionsForPlayer(db: DB, steamid: string, now = new Date()): SanctionRow[] {
  const ids = (db.prepare(
    `SELECT discord_id FROM discord_link_history WHERE steamid = ?
     UNION SELECT discord_id FROM players WHERE steamid = ? AND discord_id IS NOT NULL`,
  ).all(steamid, steamid) as { discord_id: string }[]).map((r) => r.discord_id);
  return ids.flatMap((id) => sanctionsFor(db, id, now))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
}
