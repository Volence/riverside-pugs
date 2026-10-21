import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { makeRequireActive } from './guards.js';

/** Duo queue (docs/superpowers/specs/2026-10-21-duo-queue-design.md). Thin:
 *  every rule lives in the matchmaker, which also broadcasts the change. */
export interface DuoRouteOpts { db: DB; matchmaker: Matchmaker }

export async function duoRoutes(app: FastifyInstance, opts: DuoRouteOpts): Promise<void> {
  const { db, matchmaker } = opts;
  const requireActive = makeRequireActive(db);
  const inviteId = (req: FastifyRequest): number | null => {
    const n = Number((req.params as { id: string }).id);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  app.post('/api/duo/invite', async (req, reply) => {
    const me = requireActive(req, reply);
    if (!me) return;
    const to = (req.body as { steamid?: unknown } | undefined)?.steamid;
    if (typeof to !== 'string' || !/^\d{17}$/.test(to)) return reply.code(400).send({ error: 'steamid required' });
    const r = matchmaker.inviteDuo(me, to, 'site');
    if (!r.ok) return reply.code(409).send({ error: r.error });
    return { ok: true, inviteId: r.inviteId };
  });

  for (const action of ['accept', 'decline', 'cancel'] as const) {
    app.post(`/api/duo/invites/:id/${action}`, async (req, reply) => {
      const me = requireActive(req, reply);
      if (!me) return;
      const id = inviteId(req);
      if (id === null) return reply.code(400).send({ error: 'bad invite id' });
      const r = action === 'accept' ? matchmaker.acceptDuo(id, me)
        : action === 'decline' ? matchmaker.declineDuo(id, me)
          : matchmaker.cancelDuo(id, me);
      if (!r.ok) return reply.code(409).send({ error: r.error });
      return { ok: true };
    });
  }

  app.post('/api/duo/end', async (req, reply) => {
    const me = requireActive(req, reply);
    if (!me) return;
    const r = matchmaker.endDuo(me);
    if (!r.ok) return reply.code(409).send({ error: r.error });
    return { ok: true };
  });
}
