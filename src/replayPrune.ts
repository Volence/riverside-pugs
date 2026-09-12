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
 */
export function planPrune(
  db: DB, dir: string, now: Date, retentionDays: number,
  freeBytes: number, floorBytes: number,
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
      ORDER BY ageBasis ASC, r.ordinal ASC, r.half ASC`,
  ).all() as (PruneCandidate & { ageBasis: string })[];

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
  const result: PruneResult = { deleted: 0, bytes: 0, missing: 0, refused: 0 };
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
    } catch {
      // Already gone. The row still needs marking, or it is reconsidered
      // every single day forever.
      result.missing++;
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
export function pruneReplays(db: DB, dir: string): PruneResult {
  const empty: PruneResult = { deleted: 0, bytes: 0, missing: 0, refused: 0 };
  if (!dir) return empty;
  try {
    const days = Number(getSetting(db, 'replay_retention_days') ?? '90');
    const floorGb = Number(getSetting(db, 'replay_free_floor_gb') ?? '10');
    const st = statfsSync(dir);
    const freeBytes = Number(st.bavail) * Number(st.bsize);
    const plan = planPrune(db, dir, new Date(), days, freeBytes, floorGb * 1e9);
    if (plan.length === 0) return empty;
    const result = prunePlan(db, dir, plan);
    console.log(
      `[replay] pruned ${result.deleted} files, ${(result.bytes / 1e6).toFixed(1)} MB`
      + `, ${result.missing} already gone, ${result.refused} refused`,
    );
    return result;
  } catch (err) {
    console.error('[replay] prune failed', err);
    return empty;
  }
}
