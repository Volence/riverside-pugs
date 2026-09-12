import { readFileSync, createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { listSessions, currentFileFor, resolveByName, type ReplayFileInfo } from '../replaySessions.js';
import { resolveReplayPath } from '../replays.js';
import { releasableBytes } from '../replayTail.js';
import { decodeFrames, decodeHeader, HEADER_BYTES } from '../replayFormat.js';

/** How long a computed cutoff is reused.
 *
 *  Finding the cutoff for an open file means decoding frames, and the first
 *  request from any viewer decodes the whole file. Several people opening the
 *  live page within the same second would otherwise each pay for that scan.
 *  One second is shorter than the poll interval, so nobody ever sees a stale
 *  cutoff, and it is enough to collapse a thundering herd into one scan. */
const CUTOFF_TTL_MS = 1000;

interface CutoffEntry { at: number; size: number; mtimeMs: number; cutoff: number }
const cutoffCache = new Map<string, CutoffEntry>();

/**
 * How many bytes of this file may be sent right now.
 *
 * A closed file is history: every byte of it is older than any delay could
 * care about, so it is served whole and never parsed. That matters for more
 * than tidiness, because a finished round runs to 15 MB and parsing it to
 * answer a download would be absurd.
 *
 * An open file is live. Its newest frames carry ghost infected positions on a
 * page anyone can open, so the cutoff is not optional.
 */
function cutoffFor(path: string, info: ReplayFileInfo, nowMs: number): number {
  if (info.closed) return info.bytes;

  const hit = cutoffCache.get(path);
  if (hit && nowMs - hit.at < CUTOFF_TTL_MS && hit.size === info.bytes && hit.mtimeMs === info.mtimeMs) {
    return hit.cutoff;
  }

  const buf = readFileSync(path);
  const header = decodeHeader(buf);
  // An unreadable header means we cannot know when the round started, and
  // without that the delay cannot be computed. Release nothing.
  if (!header) return 0;

  const { frames } = decodeFrames(buf, HEADER_BYTES, buf.length);
  const released = releasableBytes(frames, header.startedUnix * 1000, nowMs);
  // Zero releasable frames still means the header may go out: the client
  // needs the map name and the slot roster before it can render anything,
  // and the header carries no positions.
  const cutoff = released === 0 ? HEADER_BYTES : released;

  cutoffCache.set(path, { at: nowMs, size: info.bytes, mtimeMs: info.mtimeMs, cutoff });
  return cutoff;
}

function sendSlice(
  reply: FastifyReply, path: string, info: ReplayFileInfo, since: number, nowMs: number,
): FastifyReply {
  const cutoff = cutoffFor(path, info, nowMs);
  // Every legitimate `since` is a byte offset this server itself handed out
  // in X-Replay-Next, and those are always whole. A fractional value can only
  // come from a malformed request, and Math.floor keeps that harmless rather
  // than handing a non-integer straight to createReadStream, which throws.
  const start = Number.isFinite(since) && since > 0 ? Math.min(Math.floor(since), cutoff) : 0;

  reply.header('Content-Type', 'application/octet-stream');
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Replay-Next', String(cutoff));
  reply.header('X-Replay-Closed', info.closed ? '1' : '0');
  reply.header('Content-Length', String(Math.max(0, cutoff - start)));

  if (cutoff <= start) return reply.send(Buffer.alloc(0));
  // `end` is inclusive for createReadStream, so subtract one. Streaming
  // rather than buffering matters for the closed case, where this is a
  // multi-megabyte download.
  return reply.send(createReadStream(path, { start, end: cutoff - 1 }));
}

export async function replayRoutes(
  app: FastifyInstance, opts: { db: DB; replayDir: string },
): Promise<void> {
  const { db, replayDir } = opts;

  app.get('/api/replays/sessions', async () => ({
    sessions: listSessions(replayDir, Date.now()),
  }));

  app.get('/api/replays/live/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const info = currentFileFor(replayDir, token, Date.now());
    if (!info) return reply.code(404).send({ error: 'no replay for that token' });
    return { filename: info.filename, closed: info.closed };
  });

  app.get('/api/replays/file/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const { since } = req.query as { since?: string };
    const now = Date.now();
    const found = resolveByName(replayDir, name, now);
    if (!found) return reply.code(404).send({ error: 'no such replay' });
    return sendSlice(reply, found.path, found.info, Number(since ?? 0), now);
  });

  app.get('/api/replays/match/:id/:ordinal/:half', async (req, reply) => {
    const { id, ordinal, half } = req.params as { id: string; ordinal: string; half: string };
    const { since } = req.query as { since?: string };
    const now = Date.now();
    const row = resolveReplayPath(db, Number(id), Number(ordinal), Number(half), replayDir);
    if (!row) return reply.code(404).send({ error: 'no such replay' });
    // Go back through the by-name resolver rather than trusting the row's
    // path directly, because that is what knows whether the file is still
    // being written. A match's current map is live too.
    const found = resolveByName(replayDir, row.filename, now);
    if (!found) return reply.code(404).send({ error: 'no such replay' });
    return sendSlice(reply, found.path, found.info, Number(since ?? 0), now);
  });
}
