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

export function createDuoInvite(
  db: DB, fromId: string, toId: string, source: 'site' | 'discord', now = new Date(),
): { ok: true; inviteId: number } | { ok: false; error: string } {
  if (fromId === toId) return fail('you cannot duo with yourself');
  if (!getPlayer(db, toId) || !inGoodStanding(db, toId, now)) return fail('that player cannot queue');
  if (partnerOf(db, fromId)) return fail('you are already in a duo; end it first');
  if (partnerOf(db, toId)) return fail('that player is already in a duo');
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
