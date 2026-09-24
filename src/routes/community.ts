import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { makeOptionalViewer, makeRequireActive } from './guards.js';
import { getSetting, settingNumber } from '../settings.js';
import { getPlayer } from '../players.js';
import type { CommunityStore } from '../community/store.js';
import { checkCrosshairArt, checkDescription, checkTitle, COMMUNITY_XHAIR_CAPS } from '../community/validate.js';
import {
  countLive, ENTRY_KINDS, entryRow, getEntry, insertEntry, like, likeCount, listEntries,
  mineEntries, sharesSince, tombstone, unlike, type EntryKind,
} from '../community/entries.js';

/**
 * The community page's API. See "Routes" in
 * docs/superpowers/specs/2026-09-24-hud-community-design.md.
 *
 * Crosshair shares are a small JSON body and touch no disk. The HUD upload and
 * the file routes, which do, need the store; it comes in as a getter so that
 * building the server never creates the community folder until something
 * actually writes to or reads from it.
 */
export interface CommunityRouteOpts {
  db: DB;
  store: () => CommunityStore;
  /** Injected in tests; the wall clock otherwise. */
  now?: () => Date;
}

const DAY_MS = 86_400_000;
const PERMISSION_ERROR = 'Tick the box to confirm you may share this.';

export async function communityRoutes(app: FastifyInstance, opts: CommunityRouteOpts): Promise<void> {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const optionalViewer = makeOptionalViewer(db);
  const requireActive = makeRequireActive(db);

  const isStaff = (steamid: string | null): boolean => {
    if (!steamid) return false;
    const p = getPlayer(db, steamid);
    return !!p && (p.is_admin === 1 || p.is_mod === 1);
  };

  // Read on every request, so an admin's settings change applies at once.
  // The fallbacks are the schema defaults, and settingNumber turns a blank
  // or out-of-range hand edit into them rather than into 0.
  const caps = () => ({
    huds: settingNumber(db, 'community_huds_per_player', 2, { min: 0, max: 5, integer: true }),
    crosshairs: settingNumber(db, 'community_crosshairs_per_player', 2, { min: 0, max: 5, integer: true }),
    perDay: settingNumber(db, 'community_shares_per_day', 6, { min: 1, max: 50, integer: true }),
  });
  // Off only on an explicit '0', as penalties_enabled: the kill switch is a
  // deliberate act, and a missing row is the seeded default (on).
  const uploadsOn = () => getSetting(db, 'community_uploads') !== '0';

  /**
   * The share caps for one more entry of `kind`, or the refusal. Called inside
   * the insert's transaction, so two shares racing each other cannot both
   * pass the count.
   */
  const capProblem = (author: string, kind: EntryKind): { status: 403 | 409 | 429; error: string } | null => {
    const c = caps();
    const cap = kind === 'hud' ? c.huds : c.crosshairs;
    const noun = kind === 'hud' ? 'HUD' : 'crosshair';
    if (cap === 0) return { status: 403, error: `Sharing ${noun}s is switched off right now.` };
    if (countLive(db, author, kind) >= cap) {
      return { status: 409, error: `You are sharing ${cap} ${noun}${cap === 1 ? '' : 's'} already. Delete one to share another.` };
    }
    if (sharesSince(db, author, new Date(now().getTime() - DAY_MS)) >= c.perDay) {
      return { status: 429, error: `You can share ${c.perDay} times a day; try again tomorrow.` };
    }
    return null;
  };

  const idOf = (raw: string): number | null => (/^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null);
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'no such entry' });

  app.get<{ Querystring: { kind?: string; sort?: string; page?: string; author?: string } }>(
    '/api/community', async (req, reply) => {
      const kind = req.query.kind as EntryKind;
      if (!ENTRY_KINDS.includes(kind)) return reply.code(400).send({ error: 'kind must be hud or crosshair' });
      return listEntries(db, {
        kind,
        sort: req.query.sort === 'top' ? 'top' : 'new',
        page: Number(req.query.page ?? 0),
        author: req.query.author || null,
        viewer: optionalViewer(req),
      });
    },
  );

  app.get('/api/community/mine', async (req, reply) => {
    const me = requireActive(req, reply);
    if (!me) return reply;
    const c = caps();
    return {
      entries: mineEntries(db, me),
      caps: { ...c, sharedToday: sharesSince(db, me, new Date(now().getTime() - DAY_MS)) },
    };
  });

  app.get<{ Params: { id: string } }>('/api/community/:id', async (req, reply) => {
    const id = idOf(req.params.id);
    if (id === null) return notFound(reply);
    const viewer = optionalViewer(req);
    const entry = getEntry(db, id, { viewer, staff: isStaff(viewer) });
    return entry ?? notFound(reply);
  });

  app.post<{ Body: { title?: unknown; description?: unknown; art?: unknown; permission?: unknown } }>(
    '/api/community/crosshairs', { bodyLimit: 256 * 1024 }, async (req, reply) => {
      const me = requireActive(req, reply);
      if (!me) return reply;
      if (!uploadsOn()) return reply.code(403).send({ error: 'Sharing is switched off right now.' });
      const b = (req.body ?? {}) as Record<string, unknown>;
      const title = checkTitle(b.title);
      if (!title.ok) return reply.code(title.status).send({ error: title.error });
      const description = checkDescription(b.description);
      if (!description.ok) return reply.code(description.status).send({ error: description.error });
      const art = checkCrosshairArt(b.art, COMMUNITY_XHAIR_CAPS);
      if (!art.ok) return reply.code(art.status).send({ error: art.error });
      if (b.permission !== true) return reply.code(400).send({ error: PERMISSION_ERROR });

      // Stored re-serialized from the checked value, never the raw body, so
      // nothing the checks did not look at is kept.
      const payload = JSON.stringify(art.value);
      const result = db.transaction(() => {
        const problem = capProblem(me, 'crosshair');
        if (problem) return problem;
        return {
          id: insertEntry(db, {
            kind: 'crosshair', authorId: me, title: title.value, description: description.value,
            payload, bytes: Buffer.byteLength(payload), createdAt: now(),
          }),
        };
      })();
      if ('error' in result) return reply.code(result.status).send({ error: result.error });
      return { id: result.id };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/community/:id', async (req, reply) => {
    const me = requireActive(req, reply);
    if (!me) return reply;
    const id = idOf(req.params.id);
    const row = id === null ? null : entryRow(db, id);
    if (!row || row.deleted_at !== null) return notFound(reply);
    // Staff take an entry down through /remove, which asks for a reason and
    // writes the audit log. This one is the author's own delete.
    if (row.author_id !== me) return reply.code(403).send({ error: 'only the author can delete this' });
    if (!tombstone(db, row.id, { by: me, reason: null, now: now() })) return notFound(reply);
    return { ok: true };
  });

  const likeRoute = async (on: boolean, req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const me = requireActive(req, reply);
    if (!me) return reply;
    const id = idOf(req.params.id);
    const row = id === null ? null : entryRow(db, id);
    if (!row || row.deleted_at !== null) return notFound(reply);
    if (row.author_id === me) return reply.code(400).send({ error: 'You cannot like your own entry.' });
    if (on) like(db, row.id, me, now());
    else unlike(db, row.id, me);
    return { likes: likeCount(db, row.id), likedByMe: on };
  };
  app.put<{ Params: { id: string } }>('/api/community/:id/like', (req, reply) => likeRoute(true, req, reply));
  app.delete<{ Params: { id: string } }>('/api/community/:id/like', (req, reply) => likeRoute(false, req, reply));
}
