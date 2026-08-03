import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { getSession } from '../session.js';
import { getPlayer } from '../players.js';

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
