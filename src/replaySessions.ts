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

/**
 * Which of two copies of the same round to read: the replay directory's
 * (`own`) or the live directory's (`live`).
 *
 * A round's identity is its header's `startedUnix`, not its byte count. An
 * aborted round and a restart reuse the same filename, and a pull job can
 * bring the aborted round's file into the replay directory after the live
 * copy has already been truncated and restarted for the new round (Task 1).
 * While the new round is still short, comparing bytes alone would keep
 * serving the old one, and once the new round grows past the old round's
 * length a `since` cursor would splice the new round's frames onto the old
 * file's tail. So: when the two disagree on `startedUnix`, the newer round
 * wins outright, regardless of length. Only when `startedUnix` matches (the
 * ordinary case of one round's file growing in two places) does length
 * decide, and there the replay directory wins a tie, as elsewhere.
 */
function furtherInfo(own: ReplayFileInfo, live: ReplayFileInfo): ReplayFileInfo {
  if (live.startedUnix !== own.startedUnix) {
    return live.startedUnix > own.startedUnix ? live : own;
  }
  return live.bytes > own.bytes ? live : own;
}

/** Every replay in one directory, keyed by filename. */
function infosIn(dir: string, nowMs: number): Map<string, ReplayFileInfo> {
  const out = new Map<string, ReplayFileInfo>();
  if (!dir) return out;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const info = readInfo(dir, name, nowMs);
    if (info) out.set(name, info);
  }
  return out;
}

/** Every replay on disk, grouped by the session token in its filename.
 *
 *  With a live directory, a round present in both is represented by whichever
 *  copy `furtherInfo` picks: the newer round by `startedUnix` regardless of
 *  length, or on a matching `startedUnix` the copy with more bytes, the
 *  replay directory's on a tie. See `furtherInfo` and `resolveFurther`.
 *
 *  Never throws. A missing or unreadable directory yields no sessions,
 *  because a browse page returning empty is a far better failure than a
 *  browse page returning 500. */
export function listSessions(dir: string, nowMs: number, db?: DB, liveDir = ''): ReplaySession[] {
  const infos = infosIn(dir, nowMs);
  for (const [name, live] of infosIn(liveDir, nowMs)) {
    const own = infos.get(name);
    infos.set(name, own ? furtherInfo(own, live) : live);
  }

  const byToken = new Map<string, ReplayFileInfo[]>();
  for (const info of infos.values()) {
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
 *
 * A live directory, when given, is merged in as listSessions describes.
 */
export function currentFileFor(
  dir: string, token: string, nowMs: number, db?: DB, delayMs: number = DEFAULT_DELAY_MS,
  liveDir = '',
): ReplayFileInfo | null {
  if ((!dir && !liveDir) || !TOKEN_RE.test(token)) return null;
  const session = listSessions(dir, nowMs, db, liveDir).find((s) => s.token === token);
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

/**
 * Resolve a round by name in both the replay directory and the live
 * directory, and take the copy `furtherInfo` picks: the newer round by
 * `startedUnix` regardless of length, or on a matching `startedUnix` the
 * longer copy, the replay directory winning a tie.
 *
 * The `startedUnix` rule is what keeps an aborted-and-restarted round (same
 * filename, a pull job can land the old round's file in the replay directory
 * after the live copy was truncated and restarted for the new one) from
 * being served as the old round while it is short and then having the new
 * round's frames spliced onto its tail once it grows past. The byte rule is
 * what lets the pulled final file take over from the pushed copy the moment
 * it is as long, and what keeps Dallas, where the plugin's own growing file
 * and the pushed copy sit side by side, from ever making the viewer go
 * backwards. Both lookups go through resolveByName, so both get its path
 * hardening.
 */
export function resolveFurther(
  replayDir: string, liveDir: string, filename: string, nowMs: number,
): { path: string; info: ReplayFileInfo } | null {
  const own = resolveByName(replayDir, filename, nowMs);
  const live = liveDir ? resolveByName(liveDir, filename, nowMs) : null;
  if (!own) return live;
  if (!live) return own;
  return furtherInfo(own.info, live.info) === live.info ? live : own;
}
