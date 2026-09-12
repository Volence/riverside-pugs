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
  const rows = db.prepare(
    `SELECT r.match_id AS matchId, r.ordinal, r.half, r.filename, r.bytes,
            m.ended_at AS endedAt
       FROM match_replays r
       JOIN matches m ON m.id = r.match_id
      WHERE r.pruned_at IS NULL
        AND m.state = 'completed'
      ORDER BY m.ended_at ASC, r.ordinal ASC, r.half ASC`,
  ).all() as (PruneCandidate & { endedAt: string | null })[];

  const cutoff = new Date(now.getTime() - retentionDays * 86400_000);
  const out: PruneCandidate[] = [];
  const taken = new Set<string>();

  for (const r of rows) {
    if (!r.endedAt) continue;
    // SQLite's datetime('now') is 'YYYY-MM-DD HH:MM:SS', which is not ISO
    // and is not reliably parsed. Make it ISO and stamp it UTC, which is what
    // SQLite wrote.
    if (new Date(r.endedAt.replace(' ', 'T') + 'Z') < cutoff) {
      out.push({ matchId: r.matchId, ordinal: r.ordinal, half: r.half, filename: r.filename, bytes: r.bytes });
      taken.add(r.filename);
    }
  }

  // Rows are already ordered oldest first, so the floor sweep just walks them.
  let projectedFree = freeBytes + out.reduce((n, c) => n + c.bytes, 0);
  for (const r of rows) {
    if (projectedFree >= floorBytes) break;
    if (taken.has(r.filename)) continue;
    out.push({ matchId: r.matchId, ordinal: r.ordinal, half: r.half, filename: r.filename, bytes: r.bytes });
    taken.add(r.filename);
    projectedFree += r.bytes;
  }
  return out;
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
