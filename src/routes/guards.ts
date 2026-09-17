import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { getSession } from '../session.js';
import { getPlayer } from '../players.js';

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
    const player = getPlayer(db, steamid);
    return player && player.status === 'active' ? steamid : null;
  };
}

/** Returns a per-route guard: steamid of an active player, or sends the
 *  401/403 reply and returns null. */
export function makeRequireActive(db: DB) {
  return function requireActive(req: FastifyRequest, reply: FastifyReply): string | null {
    const steamid = getSession(req);
    if (!steamid) {
      reply.code(401).send({ error: 'not logged in' });
      return null;
    }
    const player = getPlayer(db, steamid);
    if (!player || player.status !== 'active') {
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
    if (!player || player.status !== 'active' || player.is_admin !== 1) {
      reply.code(403).send({ error: 'admins only' });
      return null;
    }
    return steamid;
  };
}
