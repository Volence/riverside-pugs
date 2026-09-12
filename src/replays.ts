import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { DB } from './db.js';
import { HEADER_BYTES, decodeHeader, parseReplay } from './replayFormat.js';

const TOKEN_RE = /^[0-9a-f]{32}$/;
const NAME_RE = /^pug_[0-9a-f]{32}_\d+_[12]\.rpl$/;

export interface ReplayFile {
  ordinal: number;
  half: number;
  filename: string;
  bytes: number;
  frames: number;
  sampleHz: number;
  /** False when the writer never patched a frame count into the header, which
   *  means the file is either still being written or was abandoned by a crash.
   *  Its frames are still good; only the count had to be recovered. */
  closed: boolean;
}

/** Read just the header of a replay, without pulling the whole file into
 *  memory. A full match is 10 to 15 MB per round and indexing happens on the
 *  request path, so reading 160 bytes matters. */
function readHeader(path: string): ReturnType<typeof decodeHeader> {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEADER_BYTES);
    const got = readSync(fd, buf, 0, HEADER_BYTES, 0);
    if (got < HEADER_BYTES) return null;
    return decodeHeader(buf);
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* nothing useful to do */ }
  }
}

/**
 * Find the replays belonging to one match.
 *
 * Discovery is by filename, exactly as `discoverMatchDemos` works and for the
 * same reason: the plugin names each file `pug_<token>_<ordinal>_<half>.rpl`
 * so the link between a file and its match is a property of the file itself,
 * surviving a backend restart or a match that ended badly. Unlike demos there
 * is no datagram announcing the file at all, so this listing is the only way a
 * replay is ever noticed.
 *
 * Never throws: a missing or unreadable directory yields no replays, because a
 * match result must never fail to record over a replay link.
 */
export function discoverMatchReplays(dir: string, token: string): ReplayFile[] {
  if (!dir || !TOKEN_RE.test(token)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const re = new RegExp(`^pug_${token}_(\\d+)_([12])\\.rpl$`);
  const out: ReplayFile[] = [];
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    let bytes: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      bytes = st.size;
    } catch {
      continue;
    }
    const header = readHeader(path);
    if (!header) continue;
    // The name claims one match and the bytes claim another. Trusting the name
    // would file some other match's round under this one, so drop it.
    if (header.token !== token) continue;

    let frames = header.frameCount;
    const closed = frames > 0;
    if (!closed) {
      // Never closed, so the count was never patched in. Recovering it means
      // parsing, which is why the header carries the count at all: this branch
      // is the rare one, taken by a crashed or in-progress file.
      try {
        const parsed = parseReplay(readFileSync(path));
        frames = parsed ? parsed.frames.length : 0;
      } catch {
        frames = 0;
      }
    }
    out.push({
      ordinal: Number(m[1]), half: Number(m[2]),
      filename: name, bytes, frames, sampleHz: header.playerHz, closed,
    });
  }
  return out.sort((a, b) => a.ordinal - b.ordinal || a.half - b.half);
}

/**
 * Record a match's replays. Upserts, so re-running after a round closes
 * updates the frame count rather than failing. Returns the row count.
 *
 * `excludeOpen` drops files the writer has not closed, which during a live
 * match is the round in progress. At match completion the flag is off, because
 * by then every round has ended and a file still showing no frame count is a
 * crash worth recording rather than an unfinished write.
 */
export function recordMatchReplays(
  db: DB, matchId: number, token: string, dir: string,
  opts: { excludeOpen?: boolean } = {},
): number {
  let found = discoverMatchReplays(dir, token);
  if (opts.excludeOpen) found = found.filter((r) => r.closed);
  if (found.length === 0) return 0;
  const ins = db.prepare(
    `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (match_id, ordinal, half) DO UPDATE SET
       filename = excluded.filename, bytes = excluded.bytes,
       frames = excluded.frames, sample_hz = excluded.sample_hz`,
  );
  db.transaction(() => {
    for (const r of found) ins.run(matchId, r.ordinal, r.half, r.filename, r.bytes, r.frames, r.sampleHz);
  })();
  return found.length;
}

/**
 * Resolve a recorded replay to an on-disk path, or null.
 *
 * The stored filename is treated as untrusted even though rows are only ever
 * written from a directory listing filtered by a strict pattern, for the same
 * reason `resolveDemoPath` does it: a path that comes out of a database and
 * goes into a file read is exactly the shape of bug that turns a bad row into
 * arbitrary file disclosure.
 */
export function resolveReplayPath(
  db: DB, matchId: number, ordinal: number, half: number, dir: string,
): { path: string; filename: string; bytes: number } | null {
  if (!dir) return null;
  const row = db
    .prepare('SELECT filename FROM match_replays WHERE match_id = ? AND ordinal = ? AND half = ?')
    .get(matchId, ordinal, half) as { filename: string } | undefined;
  if (!row) return null;

  if (row.filename !== basename(row.filename)) return null;
  if (!NAME_RE.test(row.filename)) return null;

  const root = resolve(dir);
  const path = resolve(root, row.filename);
  if (path !== join(root, row.filename)) return null;
  if (!path.startsWith(root + '/')) return null;

  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return { path, filename: row.filename, bytes: st.size };
  } catch {
    // Row survives a prune; the file does not. Absent, not an error.
    return null;
  }
}
