import { readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { decodeHeader, HEADER_BYTES } from './replayFormat.js';
import { DEFAULT_DELAY_MS } from './replayTail.js';
import { campaignForMap } from './campaigns.js';
import { resolveCampaignForMap } from './campaignRegistry.js';
import type { DB } from './db.js';
import type { ReplayFileInfo, ReplaySession } from './replaySessionTypes.js';

// Re-exported so every existing importer of these two types from this module
// keeps working unchanged; the definitions themselves live in
// replaySessionTypes.ts, which has no imports and is what the browser project
// includes instead of this file.
export type { ReplayFileInfo, ReplaySession };

const TOKEN_RE = /^[0-9a-f]{32}$/;
const NAME_RE = /^pug_([0-9a-f]{32})_(\d+)_([12])\.rpl$/;

/**
 * How long a file with no patched frame count may sit untouched before it is
 * treated as finished.
 *
 * `frameCount` is patched into the header when the writer closes, so 0 means
 * "never closed", which is true both of a round in progress and of a
 * recording the game server died in the middle of. Without this, a crashed
 * file would be treated as live forever and held behind the delay forever.
 * The recorder writes at 10Hz, so a minute of silence is four orders of
 * magnitude past normal.
 */
export const CLOSED_AFTER_IDLE_MS = 60_000;

/** Read just the header. A replay runs to 15 MB and a listing shows dozens,
 *  so parsing one to learn its map name is not an option. */
function readInfo(dir: string, filename: string, nowMs: number): ReplayFileInfo | null {
  const m = NAME_RE.exec(filename);
  if (!m) return null;
  const path = join(dir, filename);

  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const buf = new Uint8Array(HEADER_BYTES);
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const read = readSync(fd, buf, 0, HEADER_BYTES, 0);
    if (read < HEADER_BYTES) return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }

  const h = decodeHeader(buf);
  if (!h) return null;

  return {
    filename,
    token: m[1],
    ordinal: Number(m[2]),
    half: Number(m[3]),
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    map: h.map,
    startedUnix: h.startedUnix,
    frameCount: h.frameCount,
    playerHz: h.playerHz,
    version: h.version,
    closed: h.frameCount !== 0 || nowMs - st.mtimeMs > CLOSED_AFTER_IDLE_MS,
  };
}

/** Every replay on disk, grouped by the session token in its filename.
 *
 *  Never throws. A missing or unreadable directory yields no sessions,
 *  because a browse page returning empty is a far better failure than a
 *  browse page returning 500. */
export function listSessions(dir: string, nowMs: number, db?: DB): ReplaySession[] {
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const byToken = new Map<string, ReplayFileInfo[]>();
  for (const name of names) {
    const info = readInfo(dir, name, nowMs);
    if (!info) continue;
    const list = byToken.get(info.token);
    if (list) list.push(info);
    else byToken.set(info.token, [info]);
  }

  const out: ReplaySession[] = [];
  for (const [token, files] of byToken) {
    files.sort((a, b) => a.ordinal - b.ordinal || a.half - b.half);
    out.push({
      token,
      startedUnix: Math.min(...files.map((f) => f.startedUnix)),
      // Sorted above, so files[0] is the first map played.
      // Without a db this falls back to stock-only resolution, which is what
      // every caller that does not have one actually wants.
      campaign: db ? resolveCampaignForMap(db, files[0].map) : campaignForMap(files[0].map),
      files,
    });
  }
  // Newest session first, which is what someone opening the page wants.
  out.sort((a, b) => b.startedUnix - a.startedUnix);
  return out;
}

/**
 * The file a live viewer should be reading for this token.
 *
 * Not simply the newest round. A live viewer is held `delayMs` behind, so the
 * round it should be reading is the round that was live `delayMs` ago. The
 * newest file is the right answer only once it is older than the delay.
 *
 * Answering "newest" unconditionally is what made a round change cut the
 * viewer off mid-round: the client re-resolves the session every poll and
 * resets when the round changes, so the moment the next round's file appeared
 * it discarded the last `delayMs` of the round being watched, which the
 * server had been holding back and had not sent yet, and then sat empty until
 * the new round aged past the delay. Holding the pointer here gives the old
 * round exactly the time it needs to play out, and by then its file is closed
 * and served whole.
 *
 * Ordinal then half, not mtime. A map change writes a new file while the old
 * one may still be flushing, and ordering by modification time would flip
 * back to the previous round for as long as that takes.
 *
 * A session whose every file is newer than the delay still answers with its
 * first file rather than nothing: the client needs the header's map name and
 * slot roster before it can render at all, and the header carries no
 * positions, so there is nothing to hold back.
 */
export function currentFileFor(
  dir: string, token: string, nowMs: number, db?: DB, delayMs: number = DEFAULT_DELAY_MS,
): ReplayFileInfo | null {
  if (!dir || !TOKEN_RE.test(token)) return null;
  const session = listSessions(dir, nowMs, db).find((s) => s.token === token);
  if (!session || session.files.length === 0) return null;
  const cutoffUnixMs = nowMs - Math.max(0, delayMs);
  for (let i = session.files.length - 1; i >= 0; i--) {
    if (session.files[i].startedUnix * 1000 <= cutoffUnixMs) return session.files[i];
  }
  return session.files[0];
}

/**
 * Resolve an untrusted filename to a path inside the replay directory.
 *
 * This mirrors `resolveReplayPath`'s hardening in `src/replays.ts` and for a
 * stronger reason: that function's name comes from a database row this
 * process wrote, and this one's comes from a URL. A name that goes into a
 * file read is exactly the shape of bug that turns a crafted request into
 * arbitrary file disclosure, so the pattern, the basename check and the
 * resolved-prefix check are all load-bearing rather than belt and braces.
 */
export function resolveByName(
  dir: string, filename: string, nowMs: number,
): { path: string; info: ReplayFileInfo } | null {
  if (!dir) return null;
  if (filename !== basename(filename)) return null;
  if (!NAME_RE.test(filename)) return null;

  const root = resolve(dir);
  const path = resolve(root, filename);
  if (path !== join(root, filename)) return null;
  if (!path.startsWith(root + '/')) return null;

  const info = readInfo(dir, filename, nowMs);
  if (!info) return null;
  return { path, info };
}
