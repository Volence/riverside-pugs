import type { DB } from './db.js';
import { getSetting } from './settings.js';
import { seasonOneLive } from './seasonThemes.js';
import { inGoodStanding } from './standing.js';
import { getPlayer } from './players.js';

/**
 * Duo queue (docs/superpowers/specs/2026-10-21-duo-queue-design.md): two
 * players who always queue and play on the same team. Pure DB here; the
 * matchmaker owns what a duo means for the queue.
 */

/** How long an invite stays open. */
export const DUO_INVITE_MS = 10 * 60 * 1000;

/** Whether duos do anything: Season 1 has started (owner 2026-10-21: it
 *  ships with Season 1 exactly) and staff have not switched it off. */
export function duoQueueLive(db: DB): boolean {
  return seasonOneLive(db) && getSetting(db, 'duo_queue_enabled') !== '0';
}

export function partnerOf(db: DB, steamid: string): string | null {
  const row = db.prepare(
    'SELECT player_a, player_b FROM duos WHERE ended_at IS NULL AND (player_a = ? OR player_b = ?) LIMIT 1',
  ).get(steamid, steamid) as { player_a: string; player_b: string } | undefined;
  if (!row) return null;
  return row.player_a === steamid ? row.player_b : row.player_a;
}

export interface DuoInvite {
  id: number;
  fromId: string;
  toId: string;
  source: 'site' | 'discord';
  createdAt: string;
  resolvedAt: string | null;
  outcome: string | null;
}

export type DuoResult = { ok: true } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false as const, error });

interface InviteRow { id: number; from_id: string; to_id: string; source: 'site' | 'discord'; created_at: string; resolved_at: string | null; outcome: string | null }

const toInvite = (r: InviteRow): DuoInvite => ({
  id: r.id, fromId: r.from_id, toId: r.to_id, source: r.source,
  createdAt: r.created_at, resolvedAt: r.resolved_at, outcome: r.outcome,
});

export function getDuoInvite(db: DB, id: number): DuoInvite | null {
  const r = db.prepare('SELECT * FROM duo_invites WHERE id = ?').get(id) as InviteRow | undefined;
  return r ? toInvite(r) : null;
}

function isOpen(inv: DuoInvite, now: Date): boolean {
  return inv.resolvedAt === null && now.getTime() - Date.parse(inv.createdAt) < DUO_INVITE_MS;
}

/** How long an inviter waits to ask the same player again after a decline
 *  (owner 2026-11-03). One way: the one who declined may still ask back, in
 *  case the decline was a slip. */
export const DUO_DECLINE_COOLDOWN_MS = 60 * 60 * 1000;
/** Invites one player may send in a rolling hour, whatever became of them.
 *  Each one DMs its invitee, so this is the cap on that. */
export const DUO_INVITES_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

/** Whole minutes until `untilMs`, never less than 1. */
const minutesUntil = (untilMs: number, now: Date) => Math.max(1, Math.ceil((untilMs - now.getTime()) / 60_000));

/** Why `fromId` may not invite `toId` again yet, or null: `toId` declined
 *  the last invite between them within the cooldown, or the hourly cap. */
function inviteLimit(db: DB, fromId: string, toId: string, now: Date): string | null {
  // Only the latest invite between the two counts: once the decliner has
  // asked back, the decline is behind them.
  const last = db.prepare(
    `SELECT from_id, outcome, resolved_at FROM duo_invites
     WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY id DESC LIMIT 1`,
  ).get(fromId, toId, toId, fromId) as { from_id: string; outcome: string | null; resolved_at: string | null } | undefined;
  const declined = last?.from_id === fromId && last.outcome === 'declined' && last.resolved_at
    && now.getTime() - Date.parse(last.resolved_at) < DUO_DECLINE_COOLDOWN_MS ? last.resolved_at : null;
  if (declined) {
    const n = minutesUntil(Date.parse(declined) + DUO_DECLINE_COOLDOWN_MS, now);
    return `that player declined your last invite; try again in ${n} minute${n === 1 ? '' : 's'}`;
  }
  // The oldest invite that still counts toward the cap: once it is an hour
  // old there is room for one more.
  const oldest = db.prepare(
    'SELECT created_at FROM duo_invites WHERE from_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1 OFFSET ?',
  ).get(fromId, new Date(now.getTime() - HOUR_MS).toISOString(), DUO_INVITES_PER_HOUR - 1) as { created_at: string } | undefined;
  if (oldest) {
    const n = minutesUntil(Date.parse(oldest.created_at) + HOUR_MS, now);
    return `you have sent ${DUO_INVITES_PER_HOUR} duo invites in the last hour; try again in ${n} minute${n === 1 ? '' : 's'}`;
  }
  return null;
}

/** A staff block from the duo queue (owner 2026-11-03), the same lengths as
 *  a ban. expiresAt null is permanent. */
export interface DuoBlock {
  id: number;
  playerId: string;
  reason: string;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export function activeDuoBlock(db: DB, steamid: string, now = new Date()): DuoBlock | null {
  const r = db.prepare(
    `SELECT b.*, p.name AS created_by_name FROM duo_blocks b LEFT JOIN players p ON p.steamid = b.created_by
     WHERE b.player_id = ? AND b.lifted_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > ?)
     ORDER BY b.id DESC LIMIT 1`,
  ).get(steamid, now.toISOString()) as {
    id: number; player_id: string; reason: string; created_by: string; created_by_name: string | null;
    created_at: string; expires_at: string | null;
  } | undefined;
  return r ? {
    id: r.id, playerId: r.player_id, reason: r.reason, createdBy: r.created_by, createdByName: r.created_by_name,
    createdAt: r.created_at, expiresAt: r.expires_at,
  } : null;
}

/** What a blocked player is told about their own block. */
function ownBlockText(b: DuoBlock): string {
  return b.expiresAt
    ? `you are blocked from duo queue until ${b.expiresAt.slice(0, 16).replace('T', ' ')} UTC`
    : 'you are blocked from duo queue permanently';
}

/** Why a duo block stops `steamid` from duoing with `other`, or null. The
 *  player's own block is named to them; the other's is not, so a block is
 *  never disclosed to anyone but the one blocked. */
export function duoBlockError(db: DB, steamid: string, other: string, now = new Date()): string | null {
  const own = activeDuoBlock(db, steamid, now);
  if (own) return ownBlockText(own);
  return activeDuoBlock(db, other, now) ? 'that player cannot duo right now' : null;
}

/** Block a player from duo queue and void every open invite from or to them.
 *  Ending a duo they are in is the matchmaker's (Matchmaker.duoBlocked), so
 *  the queue hears of it. */
export function blockFromDuo(
  db: DB, steamid: string, by: string, reason: string, minutes: number | null, now = new Date(),
): number {
  const at = now.toISOString();
  const expires = minutes ? new Date(now.getTime() + minutes * 60 * 1000).toISOString() : null;
  return db.transaction(() => {
    db.prepare("UPDATE duo_invites SET resolved_at = ?, outcome = 'void' WHERE resolved_at IS NULL AND (from_id = ? OR to_id = ?)")
      .run(at, steamid, steamid);
    return Number(db.prepare('INSERT INTO duo_blocks (player_id, reason, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(steamid, reason, by, at, expires).lastInsertRowid);
  })();
}

/** Lift every open duo block on a player. False when there was none. */
export function liftDuoBlock(db: DB, steamid: string, by: string, now = new Date()): boolean {
  const at = now.toISOString();
  return db.prepare(
    'UPDATE duo_blocks SET lifted_at = ?, lifted_by = ? WHERE player_id = ? AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
  ).run(at, by, steamid, at).changes > 0;
}

export function createDuoInvite(
  db: DB, fromId: string, toId: string, source: 'site' | 'discord', now = new Date(),
): { ok: true; inviteId: number } | { ok: false; error: string } {
  if (fromId === toId) return fail('you cannot duo with yourself');
  if (!getPlayer(db, toId) || !inGoodStanding(db, toId, now)) return fail('that player cannot queue');
  const blocked = duoBlockError(db, fromId, toId, now);
  if (blocked) return fail(blocked);
  if (partnerOf(db, fromId)) return fail('you are already in a duo; end it first');
  if (partnerOf(db, toId)) return fail('that player is already in a duo');
  const limit = inviteLimit(db, fromId, toId, now);
  if (limit) return fail(limit);
  const at = now.toISOString();
  return db.transaction(() => {
    db.prepare("UPDATE duo_invites SET resolved_at = ?, outcome = 'replaced' WHERE from_id = ? AND resolved_at IS NULL")
      .run(at, fromId);
    const id = Number(db.prepare('INSERT INTO duo_invites (from_id, to_id, source, created_at) VALUES (?, ?, ?, ?)')
      .run(fromId, toId, source, at).lastInsertRowid);
    return { ok: true as const, inviteId: id };
  })();
}

export function acceptDuoInvite(db: DB, inviteId: number, steamid: string, now = new Date()): DuoResult {
  const inv = getDuoInvite(db, inviteId);
  if (!inv || inv.toId !== steamid || !isOpen(inv, now)) return fail('that invite is no longer open');
  const blocked = duoBlockError(db, steamid, inv.fromId, now);
  if (blocked) return fail(blocked);
  if (partnerOf(db, inv.fromId) || partnerOf(db, inv.toId)) return fail('one of you is already in a duo');
  const at = now.toISOString();
  db.transaction(() => {
    db.prepare('INSERT INTO duos (player_a, player_b, created_at) VALUES (?, ?, ?)').run(inv.fromId, inv.toId, at);
    db.prepare("UPDATE duo_invites SET resolved_at = ?, outcome = 'accepted' WHERE id = ?").run(at, inviteId);
    // Every other open invite from or to either of them is moot now.
    db.prepare(
      `UPDATE duo_invites SET resolved_at = ?, outcome = 'void'
       WHERE resolved_at IS NULL AND (from_id IN (?, ?) OR to_id IN (?, ?))`,
    ).run(at, inv.fromId, inv.toId, inv.fromId, inv.toId);
  })();
  return { ok: true };
}

function resolveAs(
  db: DB, inviteId: number, steamid: string, who: 'fromId' | 'toId', outcome: 'declined' | 'cancelled', now: Date,
): DuoResult {
  const inv = getDuoInvite(db, inviteId);
  if (!inv || inv[who] !== steamid || !isOpen(inv, now)) return fail('that invite is no longer open');
  db.prepare('UPDATE duo_invites SET resolved_at = ?, outcome = ? WHERE id = ?').run(now.toISOString(), outcome, inviteId);
  return { ok: true };
}

export function declineDuoInvite(db: DB, inviteId: number, steamid: string, now = new Date()): DuoResult {
  return resolveAs(db, inviteId, steamid, 'toId', 'declined', now);
}

export function cancelDuoInvite(db: DB, inviteId: number, steamid: string, now = new Date()): DuoResult {
  return resolveAs(db, inviteId, steamid, 'fromId', 'cancelled', now);
}

/** `by` is the steamid that ended it, or 'system' (a ban). */
export function endDuo(db: DB, steamid: string, by: string, now = new Date()): DuoResult {
  const r = db.prepare(
    'UPDATE duos SET ended_at = ?, ended_by = ? WHERE ended_at IS NULL AND (player_a = ? OR player_b = ?)',
  ).run(now.toISOString(), by, steamid, steamid);
  return r.changes > 0 ? { ok: true } : fail('you are not in a duo');
}

export function openDuoInvites(db: DB, steamid: string, now = new Date()): { incoming: DuoInvite[]; outgoing: DuoInvite | null } {
  const rows = (db.prepare(
    'SELECT * FROM duo_invites WHERE resolved_at IS NULL AND (to_id = ? OR from_id = ?) ORDER BY id',
  ).all(steamid, steamid) as InviteRow[]).map(toInvite).filter((i) => isOpen(i, now));
  return {
    incoming: rows.filter((i) => i.toId === steamid),
    outgoing: rows.find((i) => i.fromId === steamid) ?? null,
  };
}

/** Note `n` duos passed over at one pop, for the trial review. */
export function recordDuoPopSkips(db: DB, n: number, now = new Date()): void {
  const ins = db.prepare("INSERT INTO duo_pop_skips (at, kind) VALUES (?, 'skipped')");
  for (let i = 0; i < n; i++) ins.run(now.toISOString());
}

/** Note a held pop forced through after duo_hold_max_minutes: the solos it
 *  bumped to the front, and how long it had been held. */
export function recordDuoHoldBump(db: DB, bumped: string[], heldMs: number, now = new Date()): void {
  db.prepare("INSERT INTO duo_pop_skips (at, kind, bumped, held_ms) VALUES (?, 'forced', ?, ?)")
    .run(now.toISOString(), bumped.join(','), Math.round(heldMs));
}

/** The duos present in `ids`, each once, in the order their first member appears. */
export function pairsAmong(ids: string[], partner: (id: string) => string | null): [string, string][] {
  const present = new Set(ids);
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const p = partner(id);
    if (p && present.has(p) && !seen.has(p)) {
      out.push([id, p]);
      seen.add(id);
      seen.add(p);
    }
  }
  return out;
}
