import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import { makeOptionalViewer, makeRequireActive, makeRequireAdmin, makeRequireMod } from './guards.js';
import { competitiveAccess } from '../teams/access.js';
import { logAdmin } from '../admin/audit.js';
import * as E from '../events/events.js';
import * as D from '../events/drafts.js';
import * as S from '../events/standins.js';
import * as V from '../events/validate.js';
import type { Standins } from '../events/standinFlow.js';
import { adminStandinViews, myStandinView } from '../events/standinViews.js';

const NOT_FOUND = { error: 'not found' };

/**
 * Bench stand-ins (drafts plan D3a). The player routes sit behind
 * competitive_enabled exactly as src/routes/events.ts does, and an
 * unpublished event answers 404. The desk routes follow the Events desk:
 * mods read, admins write, logAdmin after the commit. Everything goes through
 * the one Standins flow, so the DMs and the chain move the same way from
 * every surface.
 */
export async function standinRoutes(app: FastifyInstance, opts: { db: DB; standins: Standins }): Promise<void> {
  const { db, standins } = opts;
  const optionalViewer = makeOptionalViewer(db);
  const requireActive = makeRequireActive(db);
  const requireAdmin = makeRequireAdmin(db);
  const requireStaff = makeRequireMod(db);
  const refuse = (reply: FastifyReply, r: { error: V.EventError; detail?: V.EntryProblem[] }) =>
    reply.code(V.EVENT_ERRORS[r.error].status).send({
      error: V.EVENT_ERRORS[r.error].text,
      ...(r.detail ? { problems: r.detail.map((p) => ({ steamid: p.steamid, name: getPlayer(db, p.steamid)?.name ?? p.steamid, problems: p.problems })) } : {}),
    });
  const active = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!competitiveAccess(db, optionalViewer(req))) { reply.code(404).send(NOT_FOUND); return null; }
    return requireActive(req, reply);
  };
  const draftBySlug = (reply: FastifyReply, slug: string): E.EventRow | null => {
    const ev = E.getEventBySlug(db, slug);
    if (!ev || ev.status === 'draft') { reply.code(404).send(NOT_FOUND); return null; }
    if (ev.entry_kind !== 'draft') { refuse(reply, { error: 'not_draft' }); return null; }
    return ev;
  };
  const draftById = (reply: FastifyReply, raw: string): E.EventRow | null => {
    const id = Number(raw);
    const ev = Number.isInteger(id) ? E.getEvent(db, id) : undefined;
    if (!ev) { refuse(reply, { error: 'not_found' }); return null; }
    if (ev.entry_kind !== 'draft') { refuse(reply, { error: 'not_draft' }); return null; }
    return ev;
  };
  const requestIn = (ev: E.EventRow, raw: string): S.StandinRow | undefined => {
    const id = Number(raw);
    const r = Number.isInteger(id) ? S.requestOf(db, id) : undefined;
    return r && r.event_id === ev.id ? r : undefined;
  };
  const askBody = (body: unknown): { entryId: number; out: string; scope: unknown } | null => {
    const b = (body ?? {}) as { entryId?: unknown; out?: unknown; scope?: unknown };
    return typeof b.entryId === 'number' && Number.isInteger(b.entryId) && typeof b.out === 'string' ? { entryId: b.entryId, out: b.out, scope: b.scope } : null;
  };
  type Slug = { slug: string };
  type SlugId = { slug: string; id: string };
  type DeskId = { id: string; rid: string };

  app.get('/api/events/:slug/standins', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    return myStandinView(db, ev, me);
  });

  app.post('/api/events/:slug/standins', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const ev = draftBySlug(reply, (req.params as Slug).slug);
    if (!ev) return;
    const b = askBody(req.body);
    if (!b) return refuse(reply, { error: 'bad_request' });
    const r = standins.request({ eventId: ev.id, ...b, by: me, staff: false });
    if (!r.ok) return refuse(reply, r);
    return r.value;
  });

  app.post('/api/events/:slug/standins/:id/cancel', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const p = req.params as SlugId;
    const ev = draftBySlug(reply, p.slug);
    if (!ev) return;
    const r0 = requestIn(ev, p.id);
    if (!r0) return refuse(reply, { error: 'standin_closed' });
    const r = standins.cancel({ requestId: r0.id, by: me, staff: false });
    if (!r.ok) return refuse(reply, r);
    return { ok: true };
  });

  app.post('/api/events/:slug/standin-offers/:id', async (req, reply) => {
    const me = active(req, reply);
    if (!me) return;
    const p = req.params as SlugId;
    const ev = draftBySlug(reply, p.slug);
    if (!ev) return;
    const accept = ((req.body ?? {}) as { accept?: unknown }).accept;
    if (typeof accept !== 'boolean') return refuse(reply, { error: 'bad_request' });
    const offer = Number.isInteger(Number(p.id)) ? S.offerOf(db, Number(p.id)) : undefined;
    const owner = offer ? S.requestOf(db, offer.request_id) : undefined;
    if (!offer || !owner || owner.event_id !== ev.id) return refuse(reply, { error: 'standin_offer_gone' });
    const r = accept ? await standins.accept({ offerId: offer.id, steamid: me }) : standins.decline({ offerId: offer.id, steamid: me });
    if (!r.ok) return refuse(reply, r);
    return { ok: true };
  });

  app.get('/api/admin/events/:id/standins', async (req, reply) => {
    if (!requireStaff(req, reply)) return;
    const ev = draftById(reply, (req.params as { id: string }).id);
    if (!ev) return;
    return adminStandinViews(db, ev);
  });

  app.post('/api/admin/events/:id/standins', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ev = draftById(reply, (req.params as { id: string }).id);
    if (!ev) return;
    const b = askBody(req.body);
    if (!b) return refuse(reply, { error: 'bad_request' });
    const r = standins.request({ eventId: ev.id, ...b, by: me, staff: true });
    if (!r.ok) return refuse(reply, r);
    logAdmin(db, me, 'event_standin_request', ev.id, { entryId: b.entryId, out: b.out, scope: b.scope, requestId: r.value.requestId });
    return r.value;
  });

  app.post('/api/admin/events/:id/standins/:rid/cancel', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const p = req.params as DeskId;
    const ev = draftById(reply, p.id);
    if (!ev) return;
    const r0 = requestIn(ev, p.rid);
    if (!r0) return refuse(reply, { error: 'standin_closed' });
    const r = standins.cancel({ requestId: r0.id, by: me, staff: true });
    if (!r.ok) return refuse(reply, r);
    logAdmin(db, me, 'event_standin_cancel', ev.id, { requestId: r0.id });
    return { ok: true };
  });

  app.post('/api/admin/events/:id/standins/:rid/margin-off', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const p = req.params as DeskId;
    const ev = draftById(reply, p.id);
    if (!ev) return;
    const r0 = requestIn(ev, p.rid);
    if (!r0) return refuse(reply, { error: 'standin_closed' });
    const r = standins.marginOff({ requestId: r0.id, by: me });
    if (!r.ok) return refuse(reply, r);
    logAdmin(db, me, 'event_standin_margin_off', ev.id, { requestId: r0.id, reopened: r.value.reopened });
    return r.value;
  });

  app.post('/api/admin/events/:id/standin-margin', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ev = draftById(reply, (req.params as { id: string }).id);
    if (!ev) return;
    const r = D.setStandinMargin(db, { eventId: ev.id, margin: ((req.body ?? {}) as { margin?: unknown }).margin, actor: me, now: new Date() });
    if (!r.ok) return refuse(reply, r);
    logAdmin(db, me, 'event_standin_margin', ev.id, { margin: r.value.margin });
    return r.value;
  });
}
