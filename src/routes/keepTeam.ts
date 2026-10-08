import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { Notifier } from '../notify/notify.js';
import { makeOptionalViewer, makeRequireActive } from './guards.js';
import { competitiveAccess } from '../teams/access.js';
import * as E from '../events/events.js';
import * as N from '../events/entries.js';
import * as K from '../events/keepTeam.js';
import * as V from '../events/validate.js';
import { answerKeepFlow, startKeepFlow } from '../events/keepFlow.js';

const NOT_FOUND = { error: 'not found' };

/** Keep this team on a finished draft event's page (drafts plan D3b), behind
 *  competitive_enabled as every event route is. Only the team's four see
 *  their keep; the DMs go out through keepFlow after each commit. */
export async function keepRoutes(app: FastifyInstance, opts: { db: DB; notifier?: Notifier; publicUrl?: string; now?: () => number }): Promise<void> {
  const { db } = opts;
  const optionalViewer = makeOptionalViewer(db);
  const requireActive = makeRequireActive(db);
  const now = () => new Date((opts.now ?? Date.now)());
  const refuse = (reply: FastifyReply, error: V.EventError) => reply.code(V.EVENT_ERRORS[error].status).send({ error: V.EVENT_ERRORS[error].text });
  const active = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!competitiveAccess(db, optionalViewer(req))) { reply.code(404).send(NOT_FOUND); return null; }
    return requireActive(req, reply);
  };
  const draftBySlug = (reply: FastifyReply, slug: string): E.EventRow | null => {
    const ev = E.getEventBySlug(db, slug);
    if (!ev || ev.status === 'draft') { reply.code(404).send(NOT_FOUND); return null; }
    if (ev.entry_kind !== 'draft') { refuse(reply, 'not_draft'); return null; }
    return ev;
  };
  const deps = { db, notifier: opts.notifier, publicUrl: opts.publicUrl };
  type Slug = { slug: string };

  app.get('/api/events/:slug/keep', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    return { keep: K.myKeepView(db, ev.id, me, now()) };
  });

  app.post('/api/events/:slug/keep/start', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    const entry = N.entriesOf(db, ev.id).find((e) => N.isActive(e) && e.captain_steamid === me);
    if (!entry) return refuse(reply, K.keepsOf(db, ev.id).some((k) => K.playersOf(k).includes(me)) ? 'not_captain' : 'keep_not_open');
    const b = (req.body ?? {}) as { name?: unknown; tag?: unknown };
    const r = startKeepFlow(deps, { entryId: entry.id, steamid: me, name: b.name, tag: b.tag, now: now() });
    if (!r.ok) return refuse(reply, r.error);
    return r.value;
  });

  app.post('/api/events/:slug/keep/answer', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    const accept = ((req.body ?? {}) as { accept?: unknown }).accept;
    if (typeof accept !== 'boolean') return refuse(reply, 'bad_request');
    const k = K.keepsOf(db, ev.id).find((x) => K.playersOf(x).includes(me));
    if (!k) return refuse(reply, 'keep_not_player');
    const r = answerKeepFlow(deps, { keepId: k.id, steamid: me, accept, now: now() });
    if (!r.ok) return refuse(reply, r.error);
    return r.value;
  });
}
