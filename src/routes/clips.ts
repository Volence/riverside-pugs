import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  claimClip, clipThumbKeyFor, clipVideoKeyFor, failClip, finishClip, getClip, jobFor, listClips, setClipFile,
} from '../clips.js';
import type { DB } from '../db.js';
import { head, put, publicUrlFor, type R2Config } from '../r2.js';

export const CLIP_VIDEO_LIMIT = 40 * 1024 * 1024;
export const CLIP_THUMB_LIMIT = 2 * 1024 * 1024;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Highlight clips (src/clips.ts).
 *
 * Worker side, for clipd on the render box, all under /api/clips/worker/ and
 * all needing the X-Clip-Token header to equal CLIP_WORKER_TOKEN (unset = the
 * worker side answers 404 to everything):
 *   POST claim            -> 200 job (ClipJob) | 204 nothing to do
 *   PUT  <id>/video       body video/mp4 (<= 40 MB) -> stored on R2 clips/<match>/<id>.mp4
 *   PUT  <id>/thumb       body image/jpeg (<= 2 MB) -> clips/<match>/<id>.jpg
 *   POST <id>/done        the clip is finished (needs the video)
 *   POST <id>/fail        {error}: back in the queue, or failed after 3 tries
 *
 * Public: GET /api/clips?player=<steamid>&before=<id>&limit=<n>&min=<count>&kind=skeet|quad.
 */
export async function clipRoutes(app: FastifyInstance, opts: { db: DB; r2: R2Config | null; token?: string }): Promise<void> {
  const { db, r2 } = opts;
  const token = opts.token ?? process.env.CLIP_WORKER_TOKEN?.trim() ?? '';

  for (const [type, limit] of [['video/mp4', CLIP_VIDEO_LIMIT], ['image/jpeg', CLIP_THUMB_LIMIT]] as const) {
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: limit }, (_req, body, done) => done(null, body));
  }

  const authed = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const got = req.headers['x-clip-token'];
    // hashes of equal length, so timingSafeEqual never throws and length leaks nothing
    const h = (s: string) => createHash('sha256').update(s).digest();
    if (!token || typeof got !== 'string' || !timingSafeEqual(h(got), h(token))) {
      void reply.code(404).send({ error: 'not found' });
      return false;
    }
    return true;
  };
  const rendering = (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    const row = Number.isInteger(id) ? getClip(db, id) : null;
    if (!row || row.status !== 'rendering') { void reply.code(409).send({ error: 'that clip is not being rendered' }); return null; }
    return row;
  };

  app.post('/api/clips/worker/claim', async (req, reply) => {
    if (!authed(req, reply)) return;
    if (!r2) return reply.code(503).send({ error: 'R2 is not configured' });
    const row = claimClip(db);
    if (!row) return reply.code(204).send();
    return jobFor(db, row);
  });

  const upload = (which: 'video' | 'thumb') => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authed(req, reply)) return;
    if (!r2) return reply.code(503).send({ error: 'R2 is not configured' });
    const row = rendering(req, reply);
    if (!row) return;
    const body = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'empty body' });
    const key = which === 'video' ? clipVideoKeyFor(row.match_id, row.id) : clipThumbKeyFor(row.match_id, row.id);
    const dir = await mkdtemp(join(tmpdir(), 'pug-clip-'));
    try {
      const file = join(dir, which === 'video' ? 'clip.mp4' : 'clip.jpg');
      await writeFile(file, body);
      await put(r2, key, file, { contentType: which === 'video' ? 'video/mp4' : 'image/jpeg', cacheControl: IMMUTABLE });
      const got = await head(r2, key);
      if (!got || got.bytes !== body.length) return reply.code(502).send({ error: 'upload did not land on R2' });
      setClipFile(db, row.id, which, key, body.length);
      return { key, bytes: body.length };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  app.put('/api/clips/worker/:id/video', { bodyLimit: CLIP_VIDEO_LIMIT }, upload('video'));
  app.put('/api/clips/worker/:id/thumb', { bodyLimit: CLIP_THUMB_LIMIT }, upload('thumb'));

  app.post('/api/clips/worker/:id/done', async (req, reply) => {
    if (!authed(req, reply)) return;
    const row = rendering(req, reply);
    if (!row) return;
    if (!finishClip(db, row.id)) return reply.code(409).send({ error: 'the video is not uploaded yet' });
    return { ok: true };
  });

  app.post('/api/clips/worker/:id/fail', async (req, reply) => {
    if (!authed(req, reply)) return;
    const row = rendering(req, reply);
    if (!row) return;
    const error = String((req.body as { error?: unknown } | undefined)?.error ?? 'unknown').slice(0, 500);
    failClip(db, row.id, error);
    return { ok: true };
  });

  app.get('/api/clips', async (req, reply) => {
    if (!r2) return { clips: [] };
    const q = req.query as { player?: string; before?: string; limit?: string; min?: string; kind?: string };
    if (q.player !== undefined && !/^\d{17}$/.test(q.player)) return reply.code(400).send({ error: 'bad player' });
    const clips = listClips(db, (k) => publicUrlFor(r2, k), {
      player: q.player, before: q.before ? Number(q.before) || undefined : undefined,
      limit: q.limit ? Number(q.limit) || undefined : undefined, minCount: q.min ? Number(q.min) || undefined : undefined,
      kind: q.kind === 'quad' || q.kind === 'skeet' ? q.kind : undefined,
    });
    return { clips };
  });
}
