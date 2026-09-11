import { readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { DB } from './db.js';

const TOKEN_RE = /^[0-9a-f]{32}$/;

export interface DemoFile {
  ordinal: number;
  map: string;
  filename: string;
  bytes: number;
}

/**
 * Find the demos belonging to one match.
 *
 * Discovery is by filename rather than by anything the plugin tells us. The
 * plugin names each demo `pug_<token>_<ordinal>_<map>.dem` precisely so the
 * link between a demo and its match is a property of the file itself, which
 * survives a backend restart, a lost datagram, or a match that ended badly.
 * The cost is that this only works while the backend shares a filesystem with
 * the game server, which is why `demoDir` defaults to empty (feature off).
 *
 * Never throws: a missing or unreadable directory yields no demos, because a
 * match result must never fail to record over a cosmetic download link.
 */
export function discoverMatchDemos(dir: string, token: string): DemoFile[] {
  if (!dir || !TOKEN_RE.test(token)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const re = new RegExp(`^pug_${token}_(\\d+)_(.+)\\.dem$`);
  const out: DemoFile[] = [];
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    let bytes: number;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      bytes = st.size;
    } catch {
      continue;
    }
    // A zero-byte file is a recording that was started and never got data,
    // e.g. the match was aborted immediately. Offering it as a download would
    // just waste someone's time.
    if (bytes === 0) continue;
    out.push({ ordinal: Number(m[1]), map: m[2], filename: name, bytes });
  }
  return out.sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Record a match's demos. Upserts, so re-running after a demo finishes
 * flushing updates the size rather than failing. Returns the row count.
 *
 * `excludeInProgress` drops the highest-ordinal demo, which during a live
 * match is always the one srcds is still writing: `tv_record` for map N+1 is
 * what closes map N's file. Offering that one as a download hands the user a
 * truncated, unplayable demo. At match completion the flag is off, because by
 * then the final demo has been closed by `tv_stoprecord`.
 */
export function recordMatchDemos(
  db: DB, matchId: number, token: string, dir: string,
  opts: { excludeInProgress?: boolean } = {},
): number {
  let found = discoverMatchDemos(dir, token);
  if (opts.excludeInProgress && found.length > 0) {
    const newest = Math.max(...found.map((d) => d.ordinal));
    found = found.filter((d) => d.ordinal !== newest);
  }
  if (found.length === 0) return 0;
  const ins = db.prepare(
    `INSERT INTO match_demos (match_id, ordinal, map, filename, bytes) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (match_id, ordinal) DO UPDATE SET
       map = excluded.map, filename = excluded.filename, bytes = excluded.bytes`,
  );
  db.transaction(() => {
    for (const d of found) ins.run(matchId, d.ordinal, d.map, d.filename, d.bytes);
  })();
  return found.length;
}

/**
 * Resolve a recorded demo to an on-disk path, or null.
 *
 * The stored filename is treated as untrusted even though rows are only ever
 * written from a directory listing filtered by a strict pattern. A path that
 * comes out of a database and goes into a file read is exactly the shape of
 * bug that turns a bad row into an arbitrary file disclosure, so the name is
 * reduced to its basename and the resolved path is re-checked against the
 * demo directory before it is handed back.
 */
export function resolveDemoPath(
  db: DB, matchId: number, ordinal: number, dir: string,
): { path: string; filename: string; bytes: number } | null {
  if (!dir) return null;
  const row = db
    .prepare('SELECT filename, bytes FROM match_demos WHERE match_id = ? AND ordinal = ?')
    .get(matchId, ordinal) as { filename: string; bytes: number } | undefined;
  if (!row) return null;

  // Any separator or traversal segment means the row is not what we wrote.
  if (row.filename !== basename(row.filename)) return null;
  if (!/^pug_[0-9a-f]{32}_\d+_.+\.dem$/.test(row.filename)) return null;

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
