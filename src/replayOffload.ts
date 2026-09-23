import {
  readFileSync, statSync, writeFileSync, rmSync, mkdtempSync, openSync, readSync, closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from './db.js';
import { replayKey, type R2Config } from './r2.js';
import { realOps, type R2Ops } from './demoOffload.js';
import { resolveReplayPath } from './replays.js';
import { decodeHeader, HEADER_BYTES } from './replayFormat.js';
import { infectedMaskForHeader, prepareForUpload } from './replaySides.js';

/** A replay must sit unchanged this long before it is uploaded. Chicago and
 *  Riverside rounds reach Dallas through pull timers 2 to 5 minutes after the
 *  round ends, so a younger file may still be half-copied. */
export const REPLAY_QUIET_MS = 10 * 60 * 1000;

export interface EligibleReplay {
  matchId: number;
  ordinal: number;
  half: number;
  path: string;
  filename: string;
  bytes: number;
}

export interface EligibleReplaysResult {
  eligible: EligibleReplay[];
  /** Rows the query returned but a per-file check ruled out: the file did not
   *  resolve, it has not sat quiet long enough, or its header is not closed. */
  skipped: number;
}

/**
 * Rows ready to upload right now: queued (no r2_key, not pruned), belonging
 * to a finished match, whose file resolves on disk, has sat past
 * REPLAY_QUIET_MS, and whose header reports a closed file (frameCount != 0).
 *
 * Pulled out of `sweepReplays` so `scripts/offload-replays.ts` can print
 * exactly what the sweep would upload, without a second copy of the query and
 * the per-file checks drifting from the real thing.
 *
 * `limit` bounds the ELIGIBLE rows returned, not the rows queried: a row
 * whose file can never qualify (missing, never closed, or fails the filename
 * pattern) is skipped and the scan keeps going, oldest match first, rather
 * than counting that row against the window and stalling behind it forever.
 * A few thousand `stat` calls an hour is trivial next to a sweep that quietly
 * stops uploading.
 */
export function eligibleReplays(
  db: DB, replayDir: string, opts: { limit?: number; nowMs?: number } = {},
): EligibleReplaysResult {
  if (!replayDir) return { eligible: [], skipped: 0 };
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.limit ?? 50;
  const rows = db.prepare(
    `SELECT r.match_id AS matchId, r.ordinal, r.half
       FROM match_replays r JOIN matches m ON m.id = r.match_id
      WHERE r.r2_key IS NULL AND r.pruned_at IS NULL
        AND m.state IN ('completed', 'aborted')
      ORDER BY r.match_id ASC, r.ordinal ASC, r.half ASC`,
  ).all() as { matchId: number; ordinal: number; half: number }[];

  const eligible: EligibleReplay[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (eligible.length >= limit) break;
    const found = resolveReplayPath(db, row.matchId, row.ordinal, row.half, replayDir);
    if (!found) { skipped++; continue; }
    try {
      if (nowMs - statSync(found.path).mtimeMs < REPLAY_QUIET_MS) { skipped++; continue; }
      const h = decodeHeader(readFileSync(found.path).subarray(0, HEADER_BYTES));
      if (!h || h.frameCount === 0) { skipped++; continue; }
    } catch { skipped++; continue; }
    eligible.push({
      matchId: row.matchId, ordinal: row.ordinal, half: row.half,
      path: found.path, filename: found.filename, bytes: found.bytes,
    });
  }
  if (eligible.length === 0 && skipped > 0) {
    console.log(`[replayOffload] ${skipped} row(s) considered but none eligible; the backlog may be stuck`);
  }
  return { eligible, skipped };
}

export interface BackupCheckResult {
  ok: boolean;
  /** Set when `ok` is false: why the file was skipped. */
  reason?: string;
}

/**
 * Checked before `scripts/offload-replays.ts --backups` uploads a workstation
 * backup copy: the header must decode, the file must be closed (frameCount
 * not 0), and its size must equal the row's recorded `bytes`. Those rows were
 * pruned on the box already, so once a backup's key is recorded it becomes
 * the ONLY served copy: a garbage or partial file passing only the filename
 * check would be served back to a viewer with no way to notice.
 *
 * Reads just the header (like `resolveReplayPath`'s discovery does), not the
 * whole file, so checking a batch of backups before upload stays cheap.
 */
export function validateBackupFile(path: string, expectedBytes: number): BackupCheckResult {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { ok: false, reason: 'file not found' };
  }
  if (size !== expectedBytes) {
    return { ok: false, reason: `size ${size} does not match the row's ${expectedBytes} bytes` };
  }
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEADER_BYTES);
    const got = readSync(fd, buf, 0, HEADER_BYTES, 0);
    if (got < HEADER_BYTES) return { ok: false, reason: 'file is shorter than the header' };
    const h = decodeHeader(buf);
    if (!h) return { ok: false, reason: 'header does not decode' };
    if (h.frameCount === 0) return { ok: false, reason: 'never closed (frameCount is 0)' };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* nothing useful to do */ }
  }
}

/**
 * Upload one replay: a copy with the token zeroed and the side mask stamped,
 * then HEAD to confirm the size, then record the key. Any failure leaves the
 * row as it was. The local file is never touched; the pruner removes it once
 * the row carries a key.
 */
export async function offloadReplay(
  db: DB, cfg: R2Config, row: { matchId: number; ordinal: number; half: number },
  path: string, opts: { ops?: R2Ops } = {},
): Promise<'uploaded' | 'failed'> {
  const ops = opts.ops ?? realOps;
  const key = replayKey(row.matchId, row.ordinal, row.half);
  const tmp = mkdtempSync(join(tmpdir(), 'rplup-'));
  try {
    const file = readFileSync(path);
    const mask = infectedMaskForHeader(db, file.subarray(0, HEADER_BYTES), row.matchId, row.ordinal, row.half);
    const body = prepareForUpload(file, mask);
    const tmpPath = join(tmp, 'r.rpl');
    writeFileSync(tmpPath, body);
    await ops.put(cfg, key, tmpPath, { contentType: 'application/octet-stream' });
    const remote = await ops.head(cfg, key);
    if (!remote || remote.bytes !== body.length) {
      console.error(`[replayOffload] match ${row.matchId} ${row.ordinal}/${row.half}: uploaded ${body.length} but remote reports ${remote?.bytes ?? 'absent'}`);
      return 'failed';
    }
    db.prepare("UPDATE match_replays SET r2_key = ?, r2_at = datetime('now') WHERE match_id = ? AND ordinal = ? AND half = ?")
      .run(key, row.matchId, row.ordinal, row.half);
    return 'uploaded';
  } catch (err) {
    console.error(`[replayOffload] upload failed for match ${row.matchId} ${row.ordinal}/${row.half}:`, (err as Error).message);
    return 'failed';
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The hourly sweep: every eligible replay, oldest match first, bounded by
 *  `limit`. Never throws and never deletes. */
export async function sweepReplays(
  db: DB, cfg: R2Config, replayDir: string,
  opts: { limit?: number; nowMs?: number; ops?: R2Ops } = {},
): Promise<{ uploaded: number; skipped: number; failed: number }> {
  const out = { uploaded: 0, skipped: 0, failed: 0 };
  if (!replayDir) return out;
  const { eligible, skipped } = eligibleReplays(db, replayDir, { limit: opts.limit ?? 50, nowMs: opts.nowMs });
  out.skipped = skipped;

  for (const row of eligible) {
    const r = await offloadReplay(db, cfg, row, row.path, { ops: opts.ops });
    if (r === 'uploaded') out.uploaded++; else out.failed++;
  }
  if (out.uploaded > 0 || out.failed > 0) {
    console.log(`[replayOffload] ${out.uploaded} uploaded, ${out.skipped} skipped, ${out.failed} failed`);
  }
  return out;
}
