import { createGzip, constants as Z } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import {
  DEMO_PUSH_BODY_LIMIT, parseDemoPush, type DemoFeed, type LiveClient, type Recording,
} from '../demoLive.js';
import { errCode } from '../replayPush.js';
import { canViewMatch, viewerFor } from '../matchVisibility.js';
import { makeOptionalViewer } from './guards.js';

const NOT_FOUND = { error: 'no live demo for that match' };

/**
 * The live SourceTV demo of a match, 10 s behind (src/demoLive.ts), in the
 * wire format of the theatre spike's relay (research/theatre-spike/live/
 * README.md, "Wire format"), so the viewer takes these addresses as its
 * `live=` URL unchanged:
 *
 *   POST /api/demos/push                      the box sidecar's bytes
 *   GET  /api/demos/live/match/:id/ws         WebSocket: hello, binary, pos, end, restart
 *   GET  /api/demos/live/match/:id/live.dem   the same bytes as one streamed body
 *
 * Only a match in 'live' state the viewer may see, with a recording, is
 * served; anything else is the same 404, so the answer says nothing about
 * which matches have a demo going.
 */
export async function demoLiveRoutes(app: FastifyInstance, opts: { db: DB; feed: DemoFeed }): Promise<void> {
  const { db, feed } = opts;
  const viewerOf = makeOptionalViewer(db);

  app.addContentTypeParser(
    'application/octet-stream', { parseAs: 'buffer', bodyLimit: DEMO_PUSH_BODY_LIMIT },
    (_req, body, done) => done(null, body),
  );

  /**
   * New bytes of a growing demo, from the sidecar on a game box, about once
   * a second per match. The body is the raw bytes (application/octet-stream);
   * the fields are headers, the token too, because URLs get logged:
   *
   *   X-Demo-Token    the match token from the file name pug_<token>_<ordinal>_<map>.dem
   *   X-Demo-Ordinal  the ordinal from the file name
   *   X-Demo-Map      the map from the file name
   *   X-Demo-Offset   where in the file these bytes start
   *   X-Demo-Started  the box's id for this recording (unix seconds it started, or
   *                   first seen): larger at offset 0 means a new recording at that name
   *
   * The token is the credential, as for /api/replays/push: only a live match
   * accepts, an unknown or finished token gets the same 404, and neither a
   * reply nor a log line names the token or a file. Replies: 200 {length},
   * 409 {length[, error]} (resume from length), 400, 413, 507, 503.
   */
  app.post('/api/demos/push', { bodyLimit: DEMO_PUSH_BODY_LIMIT }, async (req, reply) => {
    if (!feed.liveDir) return reply.code(404).send({ error: 'live demo push is not configured' });
    const parsed = parseDemoPush(req.headers, req.body);
    if (!parsed.ok) return reply.code(parsed.status).send({ error: parsed.error });
    const live = db
      .prepare("SELECT id FROM matches WHERE token = ? AND state = 'live'")
      .get(parsed.meta.token) as { id: number } | undefined;
    if (!live) return reply.code(404).send({ error: 'no live match for that token' });
    let result;
    try {
      result = feed.applyPush(parsed.meta, (req.body as Buffer | undefined) ?? Buffer.alloc(0));
    } catch (err) {
      // The error's message names the copy's path, and the path holds the
      // token: log the code and the match id only.
      console.error('[demos] push failed for match', live.id, 'code:', errCode(err));
      return reply.code(503).send({ error: 'live demo push is unavailable right now' });
    }
    if (result.status === 200) return reply.code(200).send({ length: result.length });
    if (result.status === 409) {
      return reply.code(409).send(result.error ? { length: result.length, error: result.error } : { length: result.length });
    }
    return reply.code(result.status).send({ error: result.error });
  });

  /** The recording to serve for this request, or null (404). */
  function recordingFor(req: FastifyRequest): Recording | null {
    if (!feed.enabled) return null;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || !canViewMatch(db, viewerFor(db, viewerOf(req)), id)) return null;
    const row = db.prepare("SELECT token FROM matches WHERE id = ? AND state = 'live'").get(id) as
      { token: string | null } | undefined;
    if (!row?.token) return null;
    return feed.current(row.token);
  }

  app.get('/api/demos/live/match/:id/live.dem', async (req, reply: FastifyReply) => {
    const rec = recordingFor(req);
    if (!rec) return reply.code(404).send(NOT_FOUND);
    const q = req.query as { offset?: string; id?: string };
    const off = feed.startOffset(rec, q.offset ?? 0, q.id);
    const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Demo-Id': rec.id,
      'X-Demo-Size': String(rec.released),
      'X-Demo-Offset': String(off),
      ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
    });
    res.socket?.setNoDelay(true);
    const z = gz ? createGzip({ level: 6, flush: Z.Z_SYNC_FLUSH }) : null;
    if (z) z.pipe(res);
    const out = z ?? res;
    let closed = false;
    const c: LiveClient = {
      sent: off, busy: false,
      send: (b) => new Promise<void>((resolve, reject) => {
        if (closed) { reject(new Error('closed')); return; }
        if (out.write(Buffer.from(b))) { resolve(); return; }
        const done = () => { out.off('drain', done); res.off('close', done); closed ? reject(new Error('closed')) : resolve(); };
        out.once('drain', done);
        res.once('close', done);
      }),
      end: () => { if (!closed) { closed = true; out.end(); } },
    };
    res.on('close', () => { closed = true; feed.unsubscribe(rec, c); });
    feed.subscribe(rec, c);
  });

  app.get('/api/demos/live/match/:id/ws', {
    websocket: true,
    // Refuse before the upgrade, so a match with nothing to serve is a plain
    // 404 like the HTTP route rather than an open socket that never speaks.
    preValidation: async (req, reply) => {
      if (!recordingFor(req)) return reply.code(404).send(NOT_FOUND);
    },
  }, (socket, req) => {
    const rec = recordingFor(req);
    if (!rec) { socket.close(1011); return; }
    const q = req.query as { offset?: string; id?: string };
    const off = feed.startOffset(rec, q.offset ?? 0, q.id);
    let closed = false;
    const c: LiveClient = {
      sent: off, busy: false,
      send: (b) => new Promise<void>((resolve, reject) => {
        if (closed) { reject(new Error('closed')); return; }
        socket.send(b, { binary: true }, (err) => (err ? reject(err) : resolve()));
      }),
      text: (s) => { if (!closed) socket.send(s); },
      end: () => { if (!closed) { closed = true; socket.close(1000); } },
    };
    socket.on('close', () => { closed = true; feed.unsubscribe(rec, c); });
    socket.on('error', () => { closed = true; feed.unsubscribe(rec, c); });
    // Anything the browser sends is ignored (ws answers pings itself).
    socket.send(feed.hello(rec, off));
    feed.subscribe(rec, c);
  });
}
