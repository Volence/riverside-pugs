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
  // The file's mtime is what anchors the delay to a clock a game pause
  // cannot stop. Without it the cutoff is computed against `startedUnix`
  // alone, which drifts against the game time the frames carry.
  const released = releasableBytes(
    frames, header.startedUnix * 1000, nowMs, undefined, info.mtimeMs,
  );
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

  /**
   * The standalone `!mix` sessions, and only those.
   *
   * A ranked match's replays are reachable through its match page, so they do
   * not need to be listed here. The orphan files, recorded under a token the
   * plugin generated for a mix, have no other route to them, and that is what
   * this page is for.
   *
   * Filtering by "has no match_replays row" also keeps ranked tokens off a
   * public page. A match token seeds the game server's sv_password in
   * orchestrator.ts, and every token in this listing is rendered in the
   * browser.
   */
  app.get('/api/replays/sessions', async () => {
    const rows = db
      .prepare('SELECT DISTINCT filename FROM match_replays')
      .all() as { filename: string }[];
    const claimed = new Set(rows.map((r) => r.filename));
    const sessions = listSessions(replayDir, Date.now())
      // A session is standalone when NONE of its files belongs to a match.
      // Testing every file rather than the first means a match that recorded
      // only its later maps still counts as claimed.
      .filter((s) => !s.files.some((f) => claimed.has(f.filename)));
    return { sessions };
  });

  /**
   * The current round of a match, addressed by match id.
   *
   * The token stays on this side of the wire. It seeds the game server's
   * `sv_password` in orchestrator.ts, so a live page carrying it would hand
   * anyone reading it a way into a private ranked match. A match id is
   * already public: it is in the URL of every match page.
   */
  app.get('/api/replays/live/match/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db
      .prepare('SELECT token FROM matches WHERE id = ?')
      .get(Number(id)) as { token: string | null } | undefined;
    if (!row?.token) return reply.code(404).send({ error: 'no replay for that match' });
    const info = currentFileFor(replayDir, row.token, Date.now());
    if (!info) return reply.code(404).send({ error: 'no replay for that match' });
    return { filename: info.filename, closed: info.closed };
  });

  /** The same answer for a standalone session, addressed by its own token.
   *
   *  Kept alongside the by-id route because a `!mix` session has no match row
   *  to be addressed through. Those tokens are generated by the plugin per
   *  campaign and are nobody's password. */
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

  /**
   * Events and chat for one round, on the same clock as the replay frames.
   *
   * `t_ms` defaults to -1 for rows written before that column existed, and a
   * row that cannot be placed in time cannot be placed on a timeline, so it
   * is filtered out here rather than rendered at zero. Ordering is by `seq`
   * rather than by `t_ms` because events and chat share one monotonic counter
   * and that is what puts a message and the death it was about in the order
   * they actually happened.
   */
  app.get('/api/replays/timeline/:matchId/:ordinal/:half', async (req) => {
    const { matchId, ordinal, half } = req.params as
      { matchId: string; ordinal: string; half: string };
    const id = Number(matchId);
    const ord = Number(ordinal);
    const hf = Number(half);

    const events = db.prepare(
      `SELECT seq, t_ms AS tMs, kind, actor, target, value FROM match_live_events
       WHERE match_id = ? AND map_ordinal = ? AND half = ? AND t_ms >= 0`,
    ).all(id, ord, hf) as
      { seq: number; tMs: number; kind: string; actor: string; target: string | null; value: number }[];

    const chat = db.prepare(
      `SELECT seq, t_ms AS tMs, steamid, team, message FROM match_chat
       WHERE match_id = ? AND map_ordinal = ? AND half = ? AND t_ms >= 0`,
    ).all(id, ord, hf) as
      { seq: number; tMs: number; steamid: string; team: string | null; message: string }[];

    const entries = [
      ...events.map((e) => ({
        seq: e.seq, tMs: e.tMs, kind: 'event' as const,
        text: e.target ? `${e.kind} ${e.target} ${e.value}` : `${e.kind} ${e.value}`,
        actor: e.actor, team: null as string | null,
      })),
      ...chat.map((c) => ({
        seq: c.seq, tMs: c.tMs, kind: 'chat' as const,
        text: c.message, actor: c.steamid, team: c.team,
      })),
    ].sort((a, b) => a.seq - b.seq);

    return { entries };
  });
}
