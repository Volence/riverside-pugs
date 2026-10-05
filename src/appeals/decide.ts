import type { DB } from '../db.js';
import { liftOneBan } from '../admin/players.js';
import { liftAltHold } from '../altHolds.js';
import { mootAppeal, recordDecision, targetInForce } from './store.js';
import type { Fail } from './access.js';
import type { AppealRow } from './types.js';

const fail = (status: number, error: string): Fail => ({ ok: false, status, error });

/**
 * Carry out a staff decision on an appeal against a WEBSITE ban or hold
 * (a Discord sanction is decided in the route, which has to call Discord).
 * decideCheck has already said this viewer may decide it.
 *
 * The decision is recorded first, by the guarded UPDATE, so of two staff
 * pressing at once exactly one goes on to lift anything. Lifting happens
 * after and on its own: liftOneBan and liftAltHold each commit and then tell
 * the game servers, which must never happen inside an outer transaction.
 */
export function decideBanAppeal(
  db: DB, row: AppealRow, by: string, outcome: 'accept' | 'shorten' | 'deny', endsAt: unknown, now = new Date(),
): { ok: true } | Fail {
  const ban = db.prepare('SELECT id, kind, expires_at FROM bans WHERE id = ?').get(row.ban_id) as
    | { id: number; kind: string; expires_at: string | null } | undefined;
  if (!ban) return fail(404, 'no such appeal');
  if (!targetInForce(db, row, now)) {
    mootAppeal(db, row.id, now);
    return fail(409, 'The ban is no longer in force, so the appeal has been closed.');
  }
  if (outcome === 'shorten') {
    if (ban.kind === 'alt_hold') return fail(400, 'A hold is lifted or kept; it cannot be shortened.');
    const t = typeof endsAt === 'string' ? Date.parse(endsAt) : NaN;
    if (!Number.isFinite(t)) return fail(400, 'Pick when the ban should end.');
    if (t <= now.getTime() + 60_000) return fail(400, 'Pick a time in the future.');
    if (ban.expires_at !== null && t >= Date.parse(ban.expires_at)) return fail(400, 'Pick a time before the ban ends now.');
    const iso = new Date(t).toISOString();
    if (!recordDecision(db, row.id, by, 'shortened', iso, now)) return fail(409, 'this appeal has already been decided');
    db.prepare('UPDATE bans SET expires_at = ? WHERE id = ? AND lifted_at IS NULL').run(iso, ban.id);
    return { ok: true };
  }
  if (outcome === 'deny') {
    return recordDecision(db, row.id, by, 'denied', null, now) ? { ok: true } : fail(409, 'this appeal has already been decided');
  }
  if (!recordDecision(db, row.id, by, 'accepted', null, now)) return fail(409, 'this appeal has already been decided');
  const hold = db.prepare('SELECT id FROM alt_holds WHERE ban_id = ? AND resolved_at IS NULL').get(ban.id) as { id: number } | undefined;
  if (hold) liftAltHold(db, hold.id, by, now);
  else liftOneBan(db, ban.id, by, now);
  return { ok: true };
}
