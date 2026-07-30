import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { getSession } from '../session.js';
import { getPlayer } from '../players.js';

export interface ApiRouteOpts {
  db: DB;
  matchmaker: Matchmaker;
}

export async function apiRoutes(app: FastifyInstance, opts: ApiRouteOpts): Promise<void> {
  const { db, matchmaker } = opts;

  /** Returns the steamid of an active player or sends the error reply and returns null. */
  function requireActive(req: FastifyRequest, reply: FastifyReply): string | null {
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
  }

  app.post('/api/queue/join', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    const result = matchmaker.join(steamid);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return { ok: true };
  });

  app.post('/api/queue/leave', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    matchmaker.leave(steamid);
    return { ok: true };
  });

  app.post('/api/lobby/ready', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    if (!matchmaker.ready(steamid)) return reply.code(409).send({ error: 'no ready check active' });
    return { ok: true };
  });

  app.post('/api/lobby/vote', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    const { campaign } = (req.body ?? {}) as { campaign?: string };
    if (!campaign || !matchmaker.vote(steamid, campaign)) {
      return reply.code(409).send({ error: 'invalid vote' });
    }
    return { ok: true };
  });

  app.get('/api/state', async (req, reply) => {
    const steamid = requireActive(req, reply);
    if (!steamid) return;
    return matchmaker.stateFor(steamid);
  });
}
