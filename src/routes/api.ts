import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { makeRequireActive } from './guards.js';

export interface ApiRouteOpts {
  db: DB;
  matchmaker: Matchmaker;
}

export async function apiRoutes(app: FastifyInstance, opts: ApiRouteOpts): Promise<void> {
  const { db, matchmaker } = opts;
  const requireActive = makeRequireActive(db);

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
