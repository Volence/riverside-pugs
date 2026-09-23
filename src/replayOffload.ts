import { readFileSync, statSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
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
  const nowMs = opts.nowMs ?? Date.now();
  const rows = db.prepare(
    `SELECT r.match_id AS matchId, r.ordinal, r.half
       FROM match_replays r JOIN matches m ON m.id = r.match_id
      WHERE r.r2_key IS NULL AND r.pruned_at IS NULL
        AND m.state IN ('completed', 'aborted')
      ORDER BY r.match_id ASC, r.ordinal ASC, r.half ASC
      LIMIT ?`,
  ).all(opts.limit ?? 50) as { matchId: number; ordinal: number; half: number }[];

  for (const row of rows) {
    const found = resolveReplayPath(db, row.matchId, row.ordinal, row.half, replayDir);
    if (!found) { out.skipped++; continue; }
    try {
      if (nowMs - statSync(found.path).mtimeMs < REPLAY_QUIET_MS) { out.skipped++; continue; }
      const h = decodeHeader(readFileSync(found.path).subarray(0, HEADER_BYTES));
      if (!h || h.frameCount === 0) { out.skipped++; continue; }
    } catch { out.skipped++; continue; }
    const r = await offloadReplay(db, cfg, row, found.path, { ops: opts.ops });
    if (r === 'uploaded') out.uploaded++; else out.failed++;
  }
  if (out.uploaded > 0 || out.failed > 0) {
    console.log(`[replayOffload] ${out.uploaded} uploaded, ${out.skipped} skipped, ${out.failed} failed`);
  }
  return out;
}
