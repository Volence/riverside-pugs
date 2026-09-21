import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { getSession } from '../session.js';
import { getPlayer } from '../players.js';
import { inGoodStanding } from '../standing.js';

/**
 * Identify the viewer without requiring one. Returns the steamid of an active
 * logged-in player, or null for anyone else (not logged in, or logged in but
 * not yet active). Never sends a reply.
 *
 * For public read routes. The null is not a "deny": it flows into
 * `visibleStats(raw, subject, viewer)`, where it simply fails the
 * `viewer === subject` test and so strips every `self`-visibility stat. An
 * anonymous reader is therefore treated exactly like any other non-subject
 * viewer, with no separate code path that could forget to redact.
 */
export function makeOptionalViewer(db: DB) {
  return function optionalViewer(req: FastifyRequest): string | null {
    const steamid = getSession(req);
    if (!steamid) return null;
    return inGoodStanding(db, steamid) ? steamid : null;
  };
}

/** Returns a per-route guard: steamid of an active player, or sends the
 *  401/403 reply and returns null. "Active" is inGoodStanding, the one
 *  predicate the Discord surfaces share: status active, no ban in force, and
 *  not a SteamID that has been merged into another account. */
export function makeRequireActive(db: DB) {
  return function requireActive(req: FastifyRequest, reply: FastifyReply): string | null {
    const steamid = getSession(req);
    if (!steamid) {
      reply.code(401).send({ error: 'not logged in' });
      return null;
    }
    if (!inGoodStanding(db, steamid)) {
      reply.code(403).send({ error: 'not an active player' });
      return null;
    }
    return steamid;
  };
}

/** Per-route guard for the admin panel: an active admin's steamid, or the
 *  401/403 reply sent and null. */
export function makeRequireAdmin(db: DB) {
  return function requireAdmin(req: FastifyRequest, reply: FastifyReply): string | null {
    const steamid = getSession(req);
    if (!steamid) {
      reply.code(401).send({ error: 'not logged in' });
      return null;
    }
    const player = getPlayer(db, steamid);
    if (!player || player.is_admin !== 1 || !inGoodStanding(db, steamid)) {
      reply.code(403).send({ error: 'admins only' });
      return null;
    }
    return steamid;
  };
}
