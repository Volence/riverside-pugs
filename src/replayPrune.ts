import { rmSync, statfsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { DB } from './db.js';
import { getSetting } from './settings.js';

const NAME_RE = /^pug_[0-9a-f]{32}_\d+_[12]\.rpl$/;

export interface PruneCandidate {
  matchId: number;
  ordinal: number;
  half: number;
  filename: string;
  bytes: number;
}

export interface PruneResult {
  deleted: number;
  bytes: number;
  /** Rows whose file was already gone. Marked pruned anyway; not an error. */
  missing: number;
  /** Rows whose filename failed the path check and were left entirely alone. */
  refused: number;
  /** Rows whose file is STILL on disk because the unlink failed, typically a
   *  permission problem. Deliberately left unmarked so the next pass retries. */
  failed: number;
}

/**
 * Decide what to delete. Pure apart from reading the database, so the dry run
 * the admin panel will need in 6c is this function called and shown.
 *
 * Two independent reasons a replay is selected:
 *   1. It is older than the retention window.
 *   2. Free space is below the floor, in which case the oldest are taken
 *      regardless of the window until the floor would be cleared. A full disk
 *      stops the game server, which outranks keeping a recent replay.
 *
 * A replay is only ever eligible when its match is completed. A live or
 * configuring match's files are being written right now.
 *
 * A replay is NEVER eligible while a round of it has an integrity clip or an
 * integrity review, under either reason. A clip is nothing but a start and an
 * end time inside that file, so pruning the file leaves a flagged moment on
 * the admin page that opens onto nothing, and a review that can no longer be
 * checked against what it judged, dismissals included. The protection is per
 * round, and a round is about a megabyte, so holding these against the free
 * space floor too costs nothing a disk would notice. A re-analysis that no
 * longer flags the round deletes its clips and releases it.
 *
 * With R2 configured (`opts.requireOffloaded`), a replay is only ever
 * eligible once `match_replays.r2_key` is set, under either reason. On
 * 2026-09-23 the free space floor rule deleted 559 replays that existed
 * nowhere else, because the local file was the only copy; once R2 holds the
 * copy, the floor is free to fall back on it, but never on a file that is
 * still the sole copy.
 */
export function planPrune(
  db: DB, dir: string, now: Date, retentionDays: number,
  freeBytes: number, floorBytes: number,
  opts: { requireOffloaded?: boolean } = {},
): PruneCandidate[] {
  if (!dir) return [];
  // 'live' and 'configuring' stay excluded: those files are being written
  // right now. 'completed' and 'aborted' are both terminal states whose
  // replay files are done and safe to reason about for pruning.
  const rows = db.prepare(
    `SELECT r.match_id AS matchId, r.ordinal, r.half, r.filename, r.bytes,
            COALESCE(m.ended_at, m.created_at) AS ageBasis
       FROM match_replays r
       JOIN matches m ON m.id = r.match_id
      WHERE r.pruned_at IS NULL
        AND m.state IN ('completed', 'aborted')
        AND (? = 0 OR r.r2_key IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM integrity_clips c
                         WHERE c.match_id = r.match_id AND c.ordinal = r.ordinal AND c.half = r.half)
        AND NOT EXISTS (SELECT 1 FROM integrity_reviews v
                         WHERE v.match_id = r.match_id AND v.ordinal = r.ordinal AND v.half = r.half)
      ORDER BY ageBasis ASC, r.ordinal ASC, r.half ASC`,
  ).all(opts.requireOffloaded ? 1 : 0) as (PruneCandidate & { ageBasis: string })[];

  const cutoff = new Date(now.getTime() - retentionDays * 86400_000);
  const windowSelected: PruneCandidate[] = [];
  const taken = new Set<string>();

  for (const r of rows) {
    // SQLite's datetime('now') is 'YYYY-MM-DD HH:MM:SS', which is not ISO
    // and is not reliably parsed. Make it ISO and stamp it UTC, which is what
    // SQLite wrote. ageBasis is always present: matches.created_at is
    // NOT NULL DEFAULT (datetime('now')), so an aborted match with no
    // ended_at still has an age basis to compare against the cutoff.
    if (new Date(r.ageBasis.replace(' ', 'T') + 'Z') < cutoff) {
      windowSelected.push({ matchId: r.matchId, ordinal: r.ordinal, half: r.half, filename: r.filename, bytes: r.bytes });
      taken.add(r.filename);
    }
  }

  // Floor sweep: figure out what it would take to clear the floor using every
  // remaining candidate, oldest first. If even all of them together cannot
  // clear it, select none of them: deleting the entire replay history and
  // still being out of disk is pure loss, and the retention-window selections
  // above still stand regardless.
  const remaining = rows.filter((r) => !taken.has(r.filename));
  let projectedFree = freeBytes + windowSelected.reduce((n, c) => n + c.bytes, 0);
  const sweepSelected: PruneCandidate[] = [];
  for (const r of remaining) {
    if (projectedFree >= floorBytes) break;
    sweepSelected.push({ matchId: r.matchId, ordinal: r.ordinal, half: r.half, filename: r.filename, bytes: r.bytes });
    projectedFree += r.bytes;
  }
  if (projectedFree < floorBytes) {
    const totalCandidateBytes = remaining.reduce((n, c) => n + c.bytes, 0);
    console.warn(
      `[replay] free space floor unreachable from replays alone: `
      + `${freeBytes} bytes free, ${floorBytes} byte floor, `
      + `${totalCandidateBytes} bytes of candidates available`,
    );
    return windowSelected;
  }
  return windowSelected.concat(sweepSelected);
}

/** Apply a plan. The row is marked rather than deleted, so a pruned replay can
 *  be reported as expired instead of 404ing. */
export function prunePlan(db: DB, dir: string, plan: PruneCandidate[]): PruneResult {
  const result: PruneResult = { deleted: 0, bytes: 0, missing: 0, refused: 0, failed: 0 };
  const root = resolve(dir);
  const mark = db.prepare(
    `UPDATE match_replays SET pruned_at = datetime('now')
      WHERE match_id = ? AND ordinal = ? AND half = ?`,
  );

  for (const c of plan) {
    // Same hardening as resolveReplayPath. Deletion is irreversible, so a
    // filename that is not exactly what we write is left untouched rather
    // than normalised into something plausible.
    if (c.filename !== basename(c.filename) || !NAME_RE.test(c.filename)) {
      result.refused++;
      continue;
    }
    const path = resolve(root, c.filename);
    if (path !== join(root, c.filename) || !path.startsWith(root + '/')) {
      result.refused++;
      continue;
    }
    let removed = false;
    try {
      rmSync(path);
      removed = true;
    } catch (err) {
      // ENOENT is the benign case: the file is already gone, so the row still
      // needs marking or it is reconsidered every single day forever.
      //
      // Anything else, above all EACCES, means the file is STILL THERE and we
      // could not remove it. Marking that row pruned would retire it from every
      // future pass while the bytes stay on disk, which is exactly how a disk
      // fills up while the database insists it was cleaned. This is not
      // hypothetical: the replay directory is written by the game server's user
      // and read by the web app's, so a directory mode that forgets group write
      // produces precisely this. Leave the row alone and complain.
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        result.missing++;
      } else {
        result.failed++;
        console.error(`[replay] cannot remove ${c.filename}, leaving the row unmarked:`, err);
        continue;
      }
    }
    if (removed) {
      result.deleted++;
      result.bytes += c.bytes;
    }
    mark.run(c.matchId, c.ordinal, c.half);
  }
  return result;
}

/** The daily job. Never throws: a prune failure must not take down the
 *  process that is recording ranked results. */
export function pruneReplays(db: DB, dir: string, opts: { requireOffloaded?: boolean } = {}): PruneResult {
  const empty: PruneResult = { deleted: 0, bytes: 0, missing: 0, refused: 0, failed: 0 };
  if (!dir) return empty;
  try {
    const days = Number(getSetting(db, 'replay_retention_days') ?? '90');
    const floorGb = Number(getSetting(db, 'replay_free_floor_gb') ?? '10');
    const st = statfsSync(dir);
    const freeBytes = Number(st.bavail) * Number(st.bsize);
    const plan = planPrune(db, dir, new Date(), days, freeBytes, floorGb * 1e9, opts);
    if (plan.length === 0) return empty;
    const result = prunePlan(db, dir, plan);
    const line = `[replay] pruned ${result.deleted} files, ${(result.bytes / 1e6).toFixed(1)} MB`
      + `, ${result.missing} already gone, ${result.refused} refused, ${result.failed} failed`;
    // A non-zero failed count means bytes are still on disk that we believe we
    // should have removed, so it is an error-level event, not a status line.
    if (result.failed > 0) console.error(line);
    else console.log(line);
    return result;
  } catch (err) {
    console.error('[replay] prune failed', err);
    return empty;
  }
}
