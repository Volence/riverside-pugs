import { readFileSync, createReadStream, openSync, readSync, closeSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DB } from '../db.js';
import { listSessions, currentFileFor, resolveByName, type ReplayFileInfo } from '../replaySessions.js';
import { resolveReplayPath } from '../replays.js';
import { releasableBytes } from '../replayTail.js';
import {
  decodeFrames, decodeHeader, HEADER_BYTES, VERSION, TOKEN_BYTES, TOKEN_OFFSET,
} from '../replayFormat.js';

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
function readRange(path: string, from: number, to: number): Buffer {
  const buf = Buffer.alloc(to - from);
  const fd = openSync(path, 'r');
  try {
    const got = readSync(fd, buf, 0, buf.length, from);
    // A short read means the file shrank under us. Return what there is
    // rather than a buffer of trailing zeroes claiming to be data.
    return got === buf.length ? buf : buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
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

  // The header carries the session token, and for a ranked match that token
  // seeds the game server's sv_password in orchestrator.ts. This route is
  // public and `cutoffFor` deliberately releases the header from the first
  // second of a round, so those 32 bytes would otherwise be the easiest way
  // into a private match. Blank them here, on the wire, rather than trusting
  // every future caller to address files by something other than a name.
  // No consumer reads `header.token` off a response: the one reader of that
  // field, `discoverMatchReplays`, opens the file on disk itself.
  if (start < TOKEN_END) {
    const headEnd = Math.min(cutoff, TOKEN_END);
    const head = readRange(path, start, headEnd);
    const zeroFrom = Math.max(start, TOKEN_OFFSET) - start;
    const zeroTo = Math.min(headEnd, TOKEN_END) - start;
    if (zeroTo > zeroFrom) head.fill(0, zeroFrom, Math.min(zeroTo, head.length));
    if (headEnd >= cutoff) return reply.send(head);

    // Header first, then the rest of the slice as a stream, so a closed file
    // is still not buffered whole. `end` is inclusive for createReadStream.
    const out = new PassThrough();
    out.write(head);
    const rest = createReadStream(path, { start: headEnd, end: cutoff - 1 });
    // `pipe` does not forward errors, and an unhandled one on the source
    // would leave the response hanging open forever instead of failing.
    rest.on('error', (e) => out.destroy(e));
    rest.pipe(out);
    return reply.send(out);
  }

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
   * Filtering ranked sessions out also keeps their tokens off a public page.
   * A match token seeds the game server's sv_password in orchestrator.ts, and
   * every token in this listing is rendered in the browser.
   *
   * The filter is on `matches.token`, NOT on the presence of a match_replays
   * row. Those rows are written at round_end, so filtering on them left the
   * whole of a ranked match's first round unclaimed and published its token
   * on this page, which is exactly the window in which the password matters.
   * The orchestrator writes the token the moment it takes a server, so
   * matching on it has no window at all. A standalone `!mix` session has no
   * matches row and stays listed.
   */
  app.get('/api/replays/sessions', async () => {
    const rows = db
      .prepare('SELECT token FROM matches WHERE token IS NOT NULL')
      .all() as { token: string }[];
    const ranked = new Set(rows.map((r) => r.token));
    const sessions = listSessions(replayDir, Date.now())
      .filter((s) => !ranked.has(s.token));
    return { sessions };
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
    const info = currentFileFor(replayDir, row.token, Date.now());
    if (!info) return reply.code(404).send({ error: 'no replay for that match' });
    return { ordinal: info.ordinal, half: info.half, closed: info.closed };
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
      ? resolveByName(replayDir, row.filename, now)
      : liveRoundFor(Number(id), ordinal, half, now);
    if (!found) return reply.code(404).send({ error: 'no such replay' });
    return sendSlice(reply, found.path, found.info, Number(since ?? 0), now);
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
  ): ReturnType<typeof resolveByName> {
    const ord = Number(ordinal);
    const hf = Number(half);
    if (!Number.isInteger(matchId)) return null;
    if (!Number.isInteger(ord) || ord < 0) return null;
    if (hf !== 1 && hf !== 2) return null;
    const row = db
      .prepare('SELECT token FROM matches WHERE id = ?')
      .get(matchId) as { token: string | null } | undefined;
    if (!row?.token) return null;
    return resolveByName(replayDir, `pug_${row.token}_${ord}_${hf}.rpl`, nowMs);
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
