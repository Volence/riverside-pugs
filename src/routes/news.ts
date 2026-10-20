import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { logAdmin } from '../admin/audit.js';
import { getSetting } from '../settings.js';
import {
  NEWS_CHANNEL_SETTING, NEWS_KINDS, NEWS_PAGE_SIZE, createNews, deleteNews, getNewsRow, listAll, listPublished, publishNews,
  toAdmin, toPublic, unpublishNews, updateNews, validateNews, type NewsKind, type NewsRow,
} from '../news.js';
import type { NewsPoster } from '../discord/newsPoster.js';
import { makeRequireAdmin } from './guards.js';
import { seasonOneLive } from '../seasonThemes.js';

/** How long a staff request waits on Discord before answering anyway. The
 *  poster carries on in the background and the editor reloads the state. */
const DISCORD_WAIT_MS = 5_000;

export interface NewsRouteOpts {
  db: DB;
  /** The running news poster, or null while the bot is not connected (or
   *  not configured). Read per request: the bot logs in after routes exist. */
  poster: () => NewsPoster | null;
}

/**
 * News: GET /api/news and /api/news/:id for everyone (published posts only),
 * and the editor's routes under /api/admin/news for admins. Each mutation
 * ends with logAdmin, as in admin.ts. A Discord problem never fails a
 * request: the post is saved first, the poster is asked for a pass and given
 * a few seconds, and whatever it managed is what the editor is told.
 */
export async function newsRoutes(app: FastifyInstance, opts: NewsRouteOpts): Promise<void> {
  const { db, poster } = opts;
  const requireAdmin = makeRequireAdmin(db);

  const idOf = (req: FastifyRequest): number | null => {
    const raw = (req.params as { id: string }).id;
    return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
  };

  app.get('/api/news', async (req) => {
    const q = req.query as { page?: string; limit?: string; kind?: string };
    const page = Math.max(1, Math.min(10_000, Math.floor(Number(q.page) || 1)));
    const size = Math.max(1, Math.min(NEWS_PAGE_SIZE, Math.floor(Number(q.limit) || NEWS_PAGE_SIZE)));
    const kind = (NEWS_KINDS as readonly string[]).includes(q.kind ?? '') ? q.kind as NewsKind : null;
    // News launches with Season 1 (seasonOneLive): until then the public
    // side is empty, while staff can already write drafts.
    if (!seasonOneLive(db)) return { posts: [], page, pages: 1, total: 0 };
    const { posts, total } = listPublished(db, page, size, kind);
    return { posts: posts.map((p) => toPublic(db, p)), page, pages: Math.max(1, Math.ceil(total / size)), total };
  });

  app.get('/api/news/:id', async (req, reply) => {
    const id = idOf(req);
    const row = id === null ? undefined : getNewsRow(db, id);
    // A draft is a 404 like a post that does not exist: nothing says it is there.
    if (!row || row.published_at === null || !seasonOneLive(db)) return reply.code(404).send({ error: 'no such post' });
    return { post: toPublic(db, row) };
  });

  const editorState = () => ({
    posts: listAll(db).map((p) => toAdmin(db, p)),
    channelSet: (getSetting(db, NEWS_CHANNEL_SETTING) ?? '').trim() !== '',
    live: seasonOneLive(db),
    botConnected: poster() !== null,
  });

  /** Ask the poster for a pass on one post and wait a little for it. */
  const pushToDiscord = async (id: number): Promise<void> => {
    const p = poster();
    if (!p) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      p.sync(id),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, DISCORD_WAIT_MS); }),
    ]);
    clearTimeout(timer);
  };

  const answer = (row: NewsRow | undefined) => ({
    ...editorState(),
    post: row ? toAdmin(db, getNewsRow(db, row.id) ?? row) : null,
  });

  /** Admin, then the post exists. */
  const target = (req: FastifyRequest, reply: FastifyReply): { adminId: string; row: NewsRow } | null => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return null;
    const id = idOf(req);
    const row = id === null ? undefined : getNewsRow(db, id);
    if (!row) {
      reply.code(404).send({ error: 'no such post' });
      return null;
    }
    return { adminId, row };
  };

  app.get('/api/admin/news', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return editorState();
  });

  app.post('/api/admin/news', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const v = validateNews(req.body);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    const row = createNews(db, adminId, v.value);
    logAdmin(db, adminId, 'news_create', row.id, { kind: row.kind, title: row.title });
    return reply.code(201).send(answer(row));
  });

  app.post('/api/admin/news/:id', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    const v = validateNews(req.body);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    const row = updateNews(db, t.row.id, v.value);
    logAdmin(db, t.adminId, 'news_update', row.id, { kind: row.kind, title: row.title, published: row.published_at !== null });
    if (row.discord_state === 'pending') await pushToDiscord(row.id);
    return answer(row);
  });

  app.post('/api/admin/news/:id/publish', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    if (t.row.published_at !== null) return reply.code(409).send({ error: 'already published' });
    if (!t.row.body.trim()) return reply.code(400).send({ error: 'write something before publishing' });
    if (!seasonOneLive(db)) return reply.code(409).send({ error: 'News goes live with Season 1. Save it as a draft until then.' });
    const row = publishNews(db, t.row.id);
    logAdmin(db, t.adminId, 'news_publish', row.id, { kind: row.kind, title: row.title });
    await pushToDiscord(row.id);
    return answer(row);
  });

  app.post('/api/admin/news/:id/unpublish', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    if (t.row.published_at === null) return reply.code(409).send({ error: 'not published' });
    const row = unpublishNews(db, t.row.id);
    logAdmin(db, t.adminId, 'news_unpublish', row.id, { kind: row.kind, title: row.title });
    await pushToDiscord(row.id);
    return answer(row);
  });

  app.post('/api/admin/news/:id/delete', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    deleteNews(db, t.row.id);
    logAdmin(db, t.adminId, 'news_delete', t.row.id, { kind: t.row.kind, title: t.row.title });
    await pushToDiscord(t.row.id);
    return answer(undefined);
  });
}
