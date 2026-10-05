import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { ModerationOps } from '../discord/transport.js';
import { getSession } from '../session.js';
import { appellantFromDiscord, appellantFromSteam } from '../appeals/rules.js';
import { answerQuestion, fileAppeal } from '../appeals/store.js';
import { playerView } from '../appeals/views.js';
import { clearAppealSession, readAppealSession } from '../appeals/appealSession.js';
import type { AppealRef, AppealSource, Appellant } from '../appeals/types.js';

export interface AppealRouteOpts {
  db: DB;
  moderation: () => ModerationOps | null;
}

export async function appealRoutes(app: FastifyInstance, opts: AppealRouteOpts): Promise<void> {
  const { db } = opts;

  /** A Steam session first (banned players keep theirs), else the appeal
   *  cookie from /appeal's Discord sign-in. Never anything in the body. */
  const appellantOf = (req: FastifyRequest): { who: Appellant; source: AppealSource } | null => {
    const steamid = getSession(req, db);
    if (steamid) return { who: appellantFromSteam(db, steamid), source: 'site' };
    const d = readAppealSession(req);
    return d ? { who: appellantFromDiscord(db, d.discordId, d.name), source: 'appeal_page' } : null;
  };

  const refFrom = (body: unknown): AppealRef | null => {
    const b = (body ?? {}) as { kind?: unknown; id?: unknown };
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0) return null;
    return b.kind === 'ban' || b.kind === 'sanction' ? { kind: b.kind, id } : null;
  };

  app.get('/api/appeals/mine', async (req, reply) => {
    const a = appellantOf(req);
    if (!a) return reply.code(401).send({ error: 'not signed in' });
    return { ...playerView(db, a.who), signedInAs: a.source === 'site' ? 'steam' : 'discord' };
  });

  app.post('/api/appeals', async (req, reply) => {
    const a = appellantOf(req);
    if (!a) return reply.code(401).send({ error: 'not signed in' });
    const ref = refFrom(req.body);
    if (!ref) return reply.code(400).send({ error: 'Pick what you are appealing.' });
    const b = (req.body ?? {}) as { whatHappened?: unknown; whyLift?: unknown };
    const r = fileAppeal(db, a.who, { ref, whatHappened: b.whatHappened, whyLift: b.whyLift, source: a.source });
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r;
  });

  app.post('/api/appeals/:id/answer', async (req, reply) => {
    const a = appellantOf(req);
    if (!a) return reply.code(401).send({ error: 'not signed in' });
    const r = answerQuestion(db, a.who, Number((req.params as { id: string }).id), ((req.body ?? {}) as { answer?: unknown }).answer);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r;
  });

  app.post('/api/appeals/sign-out', async (_req, reply) => {
    clearAppealSession(reply);
    return { ok: true };
  });
}
