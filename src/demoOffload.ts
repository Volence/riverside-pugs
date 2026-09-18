import { unlink } from 'node:fs/promises';
import type { DB } from './db.js';
import { resolveDemoPath } from './demos.js';
import { demoKey, head, put, type R2Config } from './r2.js';

/**
 * The bucket operations this module needs, as an interface.
 *
 * Injected rather than imported directly so the ordering rules below can be
 * tested: that a failed upload leaves the file alone, that a size mismatch is
 * caught before the row is written, that the local copy is never deleted first.
 * Those are the properties worth having tests for and none of them are
 * observable through a real network call.
 */
export interface R2Ops {
  put(cfg: R2Config, key: string, filePath: string,
      opts: { contentType?: string; contentDisposition?: string }): Promise<{ bytes: number }>;
  head(cfg: R2Config, key: string): Promise<{ bytes: number } | null>;
  remove(path: string): Promise<void>;
}

export const realOps: R2Ops = { put, head, remove: unlink };

/**
 * Move finished demos off the game server's disk and into R2.
 *
 * Demos are the bulk of the disk pressure on the box: 4.3 GB of them, growing
 * about 1 GB a day, on a 47 GB disk with under 10 GB free. They are also the
 * easiest thing to move, because once a match ends its demos are closed and
 * nothing on the server ever reads them again. The web app only hands them to
 * a browser, which a redirect does just as well from somewhere else.
 *
 * The ordering rule that matters: UPLOAD, VERIFY, RECORD, THEN DELETE. Every
 * step is skippable and every failure leaves the demo exactly where it was.
 * There is no point in this sequence where the local file is gone and the
 * remote copy is unconfirmed, because the failure mode that would produce is
 * losing a match's only recording, which is not recoverable by re-running
 * anything.
 */

export interface OffloadResult {
  uploaded: number;
  bytes: number;
  skipped: number;
  failed: number;
}

const EMPTY: OffloadResult = { uploaded: 0, bytes: 0, skipped: 0, failed: 0 };

/** The download name a browser should see, matching what the local route
 *  serves today. `playdemo` takes a filename with no extension and the console
 *  has no tab completion, so the 60-character stored name is unusable by hand;
 *  pug8-1 is match 8, map 1. Stored on the object so a redirect keeps it. */
export function friendlyName(matchId: number, ordinal: number): string {
  return `pug${matchId}-${ordinal + 1}.dem`;
}

/**
 * Offload every demo of one match that is not already in R2.
 *
 * `deleteLocal` exists so the first production run can be done in two halves:
 * copy everything up and check the bucket by hand, then come back and reclaim
 * the space. Uploading is idempotent, so the second pass re-verifies rather
 * than re-uploading.
 */
export async function offloadMatchDemos(
  db: DB,
  cfg: R2Config,
  matchId: number,
  demoDir: string,
  opts: { deleteLocal?: boolean; ops?: R2Ops } = {},
): Promise<OffloadResult> {
  const ops = opts.ops ?? realOps;
  if (!demoDir) return EMPTY;
  const rows = db
    .prepare('SELECT ordinal, filename, r2_key AS r2Key FROM match_demos WHERE match_id = ? ORDER BY ordinal')
    .all(matchId) as { ordinal: number; filename: string; r2Key: string | null }[];
  if (rows.length === 0) return EMPTY;

  const out: OffloadResult = { ...EMPTY };

  for (const row of rows) {
    // resolveDemoPath is reused rather than joining the path here, because it
    // carries the filename validation that keeps a bad row from reaching the
    // filesystem. It also returns null for a row whose file is already gone,
    // which is exactly the "nothing to do" case.
    const found = resolveDemoPath(db, matchId, row.ordinal, demoDir);

    if (row.r2Key) {
      // Already recorded as uploaded. If the local copy is still around, this
      // is the second half of a two-pass run: verify and reclaim.
      if (found && opts.deleteLocal) {
        try {
          const remote = await ops.head(cfg, row.r2Key);
          if (remote && remote.bytes === found.bytes) {
            await ops.remove(found.path);
            out.bytes += found.bytes;
          } else {
            console.error(`[demoOffload] match ${matchId} map ${row.ordinal}: remote copy missing or wrong size, keeping local`);
            out.failed++;
            continue;
          }
        } catch (err) {
          console.error(`[demoOffload] verify failed for match ${matchId} map ${row.ordinal}:`, err);
          out.failed++;
          continue;
        }
      }
      out.skipped++;
      continue;
    }

    if (!found) { out.skipped++; continue; }

    const key = demoKey(matchId, row.filename);
    try {
      await ops.put(cfg, key, found.path, {
        contentType: 'application/octet-stream',
        contentDisposition: `attachment; filename="${friendlyName(matchId, row.ordinal)}"`,
      });

      // Verify before recording, not after. A PUT that returns 200 having
      // stored a truncated body would otherwise be indistinguishable from a
      // good one until someone tried to watch it.
      const remote = await ops.head(cfg, key);
      if (!remote || remote.bytes !== found.bytes) {
        console.error(`[demoOffload] match ${matchId} map ${row.ordinal}: uploaded ${found.bytes} but remote reports ${remote?.bytes ?? 'absent'}`);
        out.failed++;
        continue;
      }

      db.prepare("UPDATE match_demos SET r2_key = ?, r2_at = datetime('now') WHERE match_id = ? AND ordinal = ?")
        .run(key, matchId, row.ordinal);

      if (opts.deleteLocal) {
        await ops.remove(found.path);
        out.bytes += found.bytes;
      }
      out.uploaded++;
    } catch (err) {
      // Never fatal. The demo stays on disk and the next sweep tries again.
      console.error(`[demoOffload] upload failed for match ${matchId} map ${row.ordinal}:`, err);
      out.failed++;
    }
  }

  return out;
}

/**
 * Sweep every completed match that still has demos on disk.
 *
 * Ordered oldest first, because the oldest demos are the ones closest to being
 * pruned: moving those first is what turns a prune that destroys a recording
 * into one that never needs to happen.
 *
 * `limit` bounds a single sweep so the first run against a backlog of 180 files
 * does not hold the process for an hour. It is a sweep, not a queue; whatever
 * is left is picked up next time.
 */
export async function sweepDemos(
  db: DB,
  cfg: R2Config,
  demoDir: string,
  opts: { limit?: number; deleteLocal?: boolean; ops?: R2Ops } = {},
): Promise<OffloadResult> {
  if (!demoDir) return EMPTY;
  const limit = opts.limit ?? 25;
  const matches = db.prepare(
    `SELECT DISTINCT d.match_id AS id
       FROM match_demos d
       JOIN matches m ON m.id = d.match_id
      WHERE d.r2_key IS NULL
        AND m.state IN ('completed', 'aborted')
      ORDER BY d.match_id ASC
      LIMIT ?`,
  ).all(limit) as { id: number }[];

  const total: OffloadResult = { ...EMPTY };
  for (const m of matches) {
    const r = await offloadMatchDemos(db, cfg, m.id, demoDir, opts);
    total.uploaded += r.uploaded;
    total.bytes += r.bytes;
    total.skipped += r.skipped;
    total.failed += r.failed;
  }

  if (total.uploaded > 0 || total.failed > 0) {
    console.log(
      `[demoOffload] ${total.uploaded} uploaded, ${(total.bytes / 1e6).toFixed(1)} MB reclaimed`
      + `, ${total.skipped} skipped, ${total.failed} failed`,
    );
  }
  return total;
}
