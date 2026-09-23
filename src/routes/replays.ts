import { readFileSync, createReadStream, openSync, readSync, closeSync } from 'node:fs';
import { PassThrough, pipeline, type Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { currentFileFor, resolveByName, resolveFurther, type ReplayFileInfo } from '../replaySessions.js';
import { phaseFor } from '../liveView.js';
import { resolveReplayPath } from '../replays.js';
import { releasableBytes } from '../replayTail.js';
import {
  decodeFrames, decodeHeader, HEADER_BYTES, VERSION, TOKEN_BYTES, TOKEN_OFFSET, INFECTED_MASK_OFFSET, SIDES_FLAG_OFFSET } from '../replayFormat.js';
import { applyPush, parsePush, PUSH_BODY_LIMIT } from '../replayPush.js';

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
  // A file written by a newer version may have changed the record size or
  // the meaning of a field, so `decodeFrames` below would produce plausible
  // nonsense rather than an error. The cutoff is computed from the `tMs` it
  // reads, which means a version this reader does not understand could
  // release bytes it should not. Release nothing instead. This is the same
  // ceiling `parseReplay` applies, for a stronger reason.
  if (header.version > VERSION) return 0;

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

/** One past the last token byte in the header. */
const TOKEN_END = TOKEN_OFFSET + TOKEN_BYTES;

/** Read `[from, to)` of a file into a Buffer. Used only for the first 44
 *  bytes of a response, so the synchronous read is bounded and tiny. */
export function readRange(path: string, from: number, to: number): Buffer {
  const buf = Buffer.alloc(to - from);
  const fd = openSync(path, 'r');
  try {
    const got = readSync(fd, buf, 0, buf.length, from);
    // By the time this runs, sendSlice has already set Content-Length for the
    // whole slice. A short read means the file shrank under us, and returning
    // fewer bytes than that promise now would leave the client hanging
    // forever waiting on bytes that will never arrive: worse than failing the
    // request outright, which at least ends it. Throw instead, and let the
    // error handler turn it into a 500.
    if (got !== buf.length) {
      throw new Error(`short read on ${path}: wanted ${buf.length} bytes at ${from}, got ${got}`);
    }
    return buf;
  } finally {
    closeSync(fd);
  }
}

/**
 * Concatenate an in-memory head buffer with the streamed remainder of a file,
 * as one Readable.
 *
 * Used when the head has to be buffered, to redact bytes in it, but the rest
 * of a possibly multi-megabyte file must not be. `pipeline` ties the two
 * streams' lifetimes together in both directions: an error on `rest` reaches
 * the returned stream, and destroying the returned stream (which is what
 * Fastify does when a client aborts the response) destroys `rest` too. A
 * plain `pipe` does not do that second half, which is what let an aborted
 * download leak an open file descriptor before this existed.
 */
export function concatHeadAndStream(head: Buffer, rest: Readable): Readable {
  const out = new PassThrough();
  out.write(head);
  pipeline(rest, out, (err) => {
    // pipeline already destroyed both streams; this is only for the log.
    // ERR_STREAM_PREMATURE_CLOSE is the expected shape of a client abort, not
    // a real failure, and is noisy enough on an ordinary closed tab that it
    // is not worth logging.
    if (err && (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error('[replays] streaming remainder failed:', err);
    }
  });
  return out;
}

function sendSlice(
  reply: FastifyReply, path: string, info: ReplayFileInfo, since: number, nowMs: number,
  infectedMask: number | null = null,
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

  // The header carries the session token, and for a ranked match that token
  // seeds the game server's sv_password in orchestrator.ts. This route is
  // public and `cutoffFor` deliberately releases the header from the first
  // second of a round, so those 32 bytes would otherwise be the easiest way
  // into a private match. Blank them here, on the wire, rather than trusting
  // every future caller to address files by something other than a name.
  // No consumer reads `header.token` off a response: the one reader of that
  // field, `discoverMatchReplays`, opens the file on disk itself.
  // The side mask (format version 3) lives past the token, so when there is
  // one to stamp the rewritten head runs to the end of the header.
  const rewriteEnd = infectedMask === null ? TOKEN_END : HEADER_BYTES;
  if (start < rewriteEnd) {
    const headEnd = Math.min(cutoff, rewriteEnd);
    const head = readRange(path, start, headEnd);
    const zeroFrom = Math.max(start, TOKEN_OFFSET) - start;
    const zeroTo = Math.min(headEnd, TOKEN_END) - start;
    if (zeroTo > zeroFrom) head.fill(0, zeroFrom, Math.min(zeroTo, head.length));
    // Older files (and a version 3 writer that could not resolve a side) say
    // nothing about which slots are infected. For a replay of a known match
    // the answer is in the database, so it is written into the header on the
    // wire: roster team plus the round's survivor side. A file that already
    // carries a mask keeps it; the writer saw the real teams.
    if (infectedMask !== null && start === 0 && head.length >= HEADER_BYTES
      && head[SIDES_FLAG_OFFSET] !== 1) {
      head[INFECTED_MASK_OFFSET] = infectedMask & 0xff;
      head[SIDES_FLAG_OFFSET] = 1;
    }
    if (headEnd >= cutoff) return reply.send(head);

    // Header first, then the rest of the slice as a stream, so a closed file
    // is still not buffered whole. `end` is inclusive for createReadStream.
    const rest = createReadStream(path, { start: headEnd, end: cutoff - 1 });
    return reply.send(concatHeadAndStream(head, rest));
  }

  // `end` is inclusive for createReadStream, so subtract one. Streaming
  // rather than buffering matters for the closed case, where this is a
  // multi-megabyte download.
  return reply.send(createReadStream(path, { start, end: cutoff - 1 }));
}

/**
 * Which roster slots are infected in one round of a match, as the header's
 * version 3 side mask, or null when the answer is not knowable.
 *
 * Files recorded before version 3 say nothing about sides, and the viewer
 * used to assume slots 0 to 3 were survivors, which is wrong for every second
 * half and for any roster taken in join order. The database knows better:
 * each rostered player's pug team, and which team survived this round
 * (`match_rounds.surv_team`, absent until ROUND_START arrives with a side).
 * The file's own slot table maps slots to players. Null leaves the header
 * alone, so the viewer falls back to slot order exactly as before.
 */
export function infectedMaskFor(
  db: DB, path: string, matchId: number, ordinal: number, half: number,
): number | null {
  const round = db.prepare(
    'SELECT surv_team FROM match_rounds WHERE match_id = ? AND ordinal = ? AND half = ?',
  ).get(matchId, ordinal, half) as { surv_team: 'a' | 'b' } | undefined;
  if (!round) return null;
  const team = new Map(
    (db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ?')
      .all(matchId) as { player_id: string; team: 'a' | 'b' }[])
      .map((r) => [r.player_id, r.team] as const),
  );
  let head: Buffer;
  try {
    head = readRange(path, 0, HEADER_BYTES);
  } catch {
    return null;
  }
  const h = decodeHeader(head);
  if (!h) return null;
  let mask = 0;
  for (let slot = 0; slot < h.slots.length; slot++) {
    const t = team.get(h.slots[slot]);
    if (t !== undefined && t !== round.surv_team) mask |= 1 << slot;
  }
  return mask;
}

export async function replayRoutes(
  app: FastifyInstance, opts: { db: DB; replayDir: string; liveDir?: string },
): Promise<void> {
  const { db, replayDir, liveDir = '' } = opts;

  /**
   * Live replay bytes from a game server, about once a second per match.
   *
   * The match's token is the credential: it is secret, it only travels over
   * HTTPS (or stays inside the Dallas box), and only a match in the 'live'
   * state accepts data. An unknown, finished or aborted token gets the same
   * 404 so the answer says nothing about which tokens exist. The reply is a
   * length or an error and never names a file. See src/replayPush.ts for the
   * offset rule that keeps the live copy an exact prefix of the real file.
   */
  app.post('/api/replays/push', { bodyLimit: PUSH_BODY_LIMIT }, async (req, reply) => {
    if (!liveDir) return reply.code(404).send({ error: 'live push is not configured' });
    const parsed = parsePush(req.body);
    if (!parsed.ok) return reply.code(parsed.status).send({ error: parsed.error });
    const live = db
      .prepare("SELECT id FROM matches WHERE token = ? AND state = 'live'")
      .get(parsed.batch.token) as { id: number } | undefined;
    if (!live) return reply.code(404).send({ error: 'no live match for that token' });
    let result;
    try {
      result = applyPush(liveDir, parsed.batch);
    } catch (err) {
      // A filesystem failure here (EACCES, ENOSPC, EISDIR, ...) carries the
      // live file's path in its message, and that path is
      // `pug_<token>_<ordinal>_<half>.rpl`: the match token, on its way to a
      // log line, is exactly what the token-never-leaves-the-server-side rule
      // exists to stop. Log only the error code and the match id, never the
      // error itself or its message, and answer with a fixed body that names
      // neither the token nor a path.
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
      console.error('[replays] push failed for match', live.id, 'code:', code);
      return reply.code(503).send({ error: 'live push is unavailable right now' });
    }
    if (result.status === 400 || result.status === 507) return reply.code(result.status).send({ error: result.error });
    return reply.code(result.status).send({ length: result.length });
  });

  /**
   * Which round of a match is being recorded right now, addressed by match id.
   *
   * Answers with the (ordinal, half) pair and nothing else. The filename is
   * NOT in the payload, because the filename IS the token: every ranked
   * replay is named `pug_<token>_<ordinal>_<half>.rpl`, and that token seeds
   * the game server's `sv_password` in orchestrator.ts. Returning a name here
   * and letting the client put it in a URL would publish a way into a private
   * match just as surely as a `token` field would.
   *
   * A client turns this answer into bytes through
   * `/api/replays/match/:id/:ordinal/:half`, which resolves the filename
   * server-side. A match id is already public: it is in the URL of every
   * match page.
   */
  app.get('/api/replays/live/match/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db
      .prepare('SELECT token FROM matches WHERE id = ?')
      .get(Number(id)) as { token: string | null } | undefined;
    if (!row?.token) return reply.code(404).send({ error: 'no replay for that match' });
    const info = currentFileFor(replayDir, row.token, Date.now(), db, undefined, liveDir);
    if (!info) return reply.code(404).send({ error: 'no replay for that match' });
    // The game's phase rides along: this is polled once a second already, and
    // it is what lets the viewer say "paused" or "readying up" while no frames
    // are arriving, instead of showing a frozen frame with no explanation.
    return { ordinal: info.ordinal, half: info.half, closed: info.closed, phase: phaseFor(db, Number(id)) };
  });

  /** The same answer for a standalone session, addressed by its own token.
   *
   *  Kept alongside the by-id route because a `!mix` session has no match row
   *  to be addressed through. Those tokens are generated by the plugin per
   *  campaign and are nobody's password. */
  app.get('/api/replays/live/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const info = currentFileFor(replayDir, token, Date.now(), db);
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

  /**
   * The bytes of one round of a match, addressed by match id.
   *
   * This is the only route a ranked replay is fetched through, live or
   * finished, because it is the only one that takes an id instead of a name.
   * Since the name of a ranked file contains the match token, keeping the
   * client on this route is what keeps the token off the wire entirely.
   */
  app.get('/api/replays/match/:id/:ordinal/:half', async (req, reply) => {
    const { id, ordinal, half } = req.params as { id: string; ordinal: string; half: string };
    const { since } = req.query as { since?: string };
    const now = Date.now();
    const row = resolveReplayPath(db, Number(id), Number(ordinal), Number(half), replayDir);
    // Go back through the by-name resolver rather than trusting the row's
    // path directly, because that is what knows whether the file is still
    // being written. A match's current map is live too.
    const found = row
      ? resolveFurther(replayDir, liveDir, row.filename, now)
      : liveRoundFor(Number(id), ordinal, half, now);
    if (!found) return reply.code(404).send({ error: 'no such replay' });
    return sendSlice(reply, found.path, found.info, Number(since ?? 0), now,
      infectedMaskFor(db, found.path, Number(id), Number(ordinal), Number(half)));
  });

  /**
   * The round in progress, which has no `match_replays` row yet.
   *
   * Those rows are written at round_end, so for the whole of a round there is
   * nothing for `resolveReplayPath` to find. The live viewer needs exactly
   * that round, so the name is rebuilt from the match's own token instead.
   * The token comes from this process's database and the ordinal and half are
   * checked to be plain non-negative integers before they go anywhere near a
   * filename; `resolveByName` then applies the same pattern, basename and
   * resolved-prefix checks every other path gets.
   */
  function liveRoundFor(
    matchId: number, ordinal: string, half: string, nowMs: number,
  ): ReturnType<typeof resolveFurther> {
    const ord = Number(ordinal);
    const hf = Number(half);
    if (!Number.isInteger(matchId)) return null;
    if (!Number.isInteger(ord) || ord < 0) return null;
    if (hf !== 1 && hf !== 2) return null;
    const row = db
      .prepare('SELECT token FROM matches WHERE id = ?')
      .get(matchId) as { token: string | null } | undefined;
    if (!row?.token) return null;
    return resolveFurther(replayDir, liveDir, `pug_${row.token}_${ord}_${hf}.rpl`, nowMs);
  }

  /**
   * Events and chat for one round of a COMPLETED match.
   *
   * The completed gate is the whole point of the route reading the match row
   * first. `match_chat` is fed from `player_say`, which does not distinguish
   * team chat from all chat, so serving this for a match in progress would
   * hand a survivor the infected team's chat verbatim and in real time, while
   * the frames on the same page are deliberately held ten seconds back. This
   * matches what /api/matches/:id already does, so the viewer cannot mount on
   * a live match anyway; the gate is here because the endpoint is public and
   * trivially discoverable regardless of what the UI does.
   *
   * There is no live timeline. If one is ever wanted it needs the same
   * cutoff the frames get, not this route with the gate removed.
   *
   * `t_ms` defaults to -1 for rows written before that column existed, and a
   * row that cannot be placed in time cannot be placed on a timeline, so it
   * is filtered out here rather than rendered at zero. Ordering is by `seq`
   * rather than by `t_ms` because events and chat share one monotonic counter
   * and that is what puts a message and the death it was about in the order
   * they actually happened.
   */
  app.get('/api/replays/timeline/:matchId/:ordinal/:half', async (req, reply) => {
    const { matchId, ordinal, half } = req.params as
      { matchId: string; ordinal: string; half: string };
    const id = Number(matchId);
    const ord = Number(ordinal);
    const hf = Number(half);

    const match = db
      .prepare("SELECT id FROM matches WHERE id = ? AND state = 'completed'")
      .get(id) as { id: number } | undefined;
    if (!match) return reply.code(404).send({ error: 'no such match' });

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

    // Two shapes, discriminated on `kind`, mirroring TimelineEntry in
    // web/src/replay/timeline.ts. An event carries the plugin's own kind
    // slug and its operands and the client composes the sentence, so every
    // id in it can be resolved through the roster; the old pre-joined `text`
    // put a raw target SteamID on screen.
    const entries = [
      ...events.map((e) => ({
        seq: e.seq, tMs: e.tMs, kind: 'event' as const,
        event: e.kind, actor: e.actor, target: e.target, value: e.value,
      })),
      ...chat.map((c) => ({
        seq: c.seq, tMs: c.tMs, kind: 'chat' as const,
        actor: c.steamid, team: c.team, text: c.message,
      })),
    ].sort((a, b) => a.seq - b.seq);

    return { entries };
  });
}
