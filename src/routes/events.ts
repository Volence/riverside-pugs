import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { CommunityStore } from '../community/store.js';
import { bannerType } from '../community/validate.js';
import { getPlayer } from '../players.js';
import { makeOptionalViewer } from './guards.js';
import { competitiveAccess, competitivePublic } from '../teams/access.js';
import { getEventBySlug } from '../events/events.js';
import { eventListItems, eventView } from '../events/views.js';

const NOT_FOUND = { error: 'not found' };
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The public side of events (tournaments plan T1a): the list and one event
 * page, read only. Behind competitive_enabled exactly as the team pages are:
 * a signed-in viewer goes through competitiveAccess, a signed-out one is let
 * in only once the switch is at everyone. A draft is for staff, admins and
 * mods (Ruling 14): to anyone else it answers the very same 404 as a slug
 * that does not exist, so whether a draft exists cannot be read off the answer.
 */
export async function eventRoutes(app: FastifyInstance, opts: { db: DB; store: () => CommunityStore }): Promise<void> {
  const { db } = opts;
  const optionalViewer = makeOptionalViewer(db);
  const allowedViewer = (req: FastifyRequest, reply: FastifyReply): { viewer: string | null } | null => {
    const viewer = optionalViewer(req);
    const allowed = viewer ? competitiveAccess(db, viewer) : competitivePublic(db);
    if (!allowed) { reply.code(404).send(NOT_FOUND); return null; }
    return { viewer };
  };
  const isStaff = (viewer: string | null): boolean => {
    const p = viewer ? getPlayer(db, viewer) : undefined;
    return !!p && (p.is_admin === 1 || p.is_mod === 1);
  };

  app.get('/api/events', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    return { events: eventListItems(db, { staff: isStaff(v.viewer) }) };
  });

  /** A banner, only while an event this viewer may see holds it (Ruling 4):
   *  a draft's banner is staff only, like the draft. Served as the type its
   *  bytes are, with the same lockdown headers as a team logo. */
  app.get('/api/events/banners/:key', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    const key = (req.params as { key: string }).key;
    if (!HEX64.test(key)) return reply.code(404).send(NOT_FOUND);
    const holders = db.prepare('SELECT status FROM events WHERE banner_key = ?').all(key) as { status: string }[];
    if (!holders.some((h) => h.status !== 'draft' || isStaff(v.viewer))) return reply.code(404).send(NOT_FOUND);
    const bytes = opts.store().readBanner(key);
    const type = bytes ? bannerType(bytes) : null;
    if (!bytes || !type) return reply.code(404).send(NOT_FOUND);
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'public, max-age=3600')
      .type(type === 'png' ? 'image/png' : 'image/webp').send(bytes);
  });

  app.get('/api/events/:slug', async (req, reply) => {
    const v = allowedViewer(req, reply);
    if (!v) return;
    const ev = getEventBySlug(db, (req.params as { slug: string }).slug);
    if (!ev || (ev.status === 'draft' && !isStaff(v.viewer))) return reply.code(404).send(NOT_FOUND);
    return eventView(db, ev);
  });
}
