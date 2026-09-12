import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { planPrune, prunePlan, pruneReplays } from '../src/replayPrune.js';

const TOKEN = 'e'.repeat(32);
let dir: string;
let db: DB;

/** Insert a completed match that ended `daysAgo` days ago, with one replay
 *  file on disk and a row pointing at it. Returns the filename.
 *
 *  `bytes` is what the ROW claims, not the size of the file written. planPrune
 *  reasons from the indexed size, and the floor tests need multi-gigabyte
 *  values, which must never become multi-gigabyte allocations in a test. */
function seedReplay(daysAgo: number, ordinal: number, bytes = 1024): string {
  const token = TOKEN;
  db.prepare(
    `INSERT INTO matches (season_id, state, campaign, token, ended_at)
     VALUES (1, 'completed', 'no_mercy', ?, datetime('now', ?))`,
  ).run(token, `-${daysAgo} days`);
  const id = (db.prepare('SELECT MAX(id) AS id FROM matches').get() as { id: number }).id;
  const filename = `pug_${token}_${ordinal}_1.rpl`;
  writeFileSync(join(dir, filename), Buffer.alloc(16));
  db.prepare(
    `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz)
     VALUES (?, ?, 1, ?, ?, 10, 10)`,
  ).run(id, ordinal, filename, bytes);
  return filename;
}

/** Insert a match in `state` and back-date either `ended_at` (when set) or
 *  `created_at` (when `endedAt` is null) by `daysAgo` days, with one replay
 *  file on disk and a row pointing at it. Returns the filename. */
function seedReplayWithState(
  state: string, daysAgo: number, ordinal: number, endedAt: 'set' | 'null', bytes = 1024,
): string {
  const token = TOKEN;
  if (endedAt === 'set') {
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign, token, ended_at)
       VALUES (1, ?, 'no_mercy', ?, datetime('now', ?))`,
    ).run(state, token, `-${daysAgo} days`);
  } else {
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign, token, created_at, ended_at)
       VALUES (1, ?, 'no_mercy', ?, datetime('now', ?), NULL)`,
    ).run(state, token, `-${daysAgo} days`);
  }
  const id = (db.prepare('SELECT MAX(id) AS id FROM matches').get() as { id: number }).id;
  const filename = `pug_${token}_${ordinal}_1.rpl`;
  writeFileSync(join(dir, filename), Buffer.alloc(16));
  db.prepare(
    `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz)
     VALUES (?, ?, 1, ?, ?, 10, 10)`,
  ).run(id, ordinal, filename, bytes);
  return filename;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rplprune-'));
  db = openDb(':memory:');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('planPrune', () => {
  it('selects replays past the retention window', () => {
    seedReplay(120, 1);
    seedReplay(10, 2);
    const plan = planPrune(db, dir, new Date(), 90, 500e9, 10e9);
    expect(plan.map((c) => c.ordinal)).toEqual([1]);
  });

  it('leaves everything alone when nothing is old and space is fine', () => {
    seedReplay(10, 1);
    expect(planPrune(db, dir, new Date(), 90, 500e9, 10e9)).toEqual([]);
  });

  it('never selects a replay of a match that is not completed', () => {
    // A live or configuring match's files are being written right now.
    // Deleting one mid-round is the one failure this whole module must not
    // have, so it is checked on the plan rather than only at delete time.
    db.prepare(
      `INSERT INTO matches (season_id, state, campaign, token, ended_at)
       VALUES (1, 'live', 'no_mercy', ?, datetime('now', '-200 days'))`,
    ).run(TOKEN);
    const id = (db.prepare('SELECT MAX(id) AS id FROM matches').get() as { id: number }).id;
    const filename = `pug_${TOKEN}_1_1.rpl`;
    writeFileSync(join(dir, filename), Buffer.alloc(10));
    db.prepare(
      `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz)
       VALUES (?, 1, 1, ?, 10, 10, 10)`,
    ).run(id, filename);
    expect(planPrune(db, dir, new Date(), 90, 500e9, 10e9)).toEqual([]);
  });

  it('never selects a row that was already pruned', () => {
    seedReplay(120, 1);
    db.prepare(`UPDATE match_replays SET pruned_at = datetime('now')`).run();
    expect(planPrune(db, dir, new Date(), 90, 500e9, 10e9)).toEqual([]);
  });

  it('takes the oldest first when free space is below the floor, even inside the window', () => {
    // The floor overrides the retention window, because a full disk stops the
    // game server, which matters more than keeping a three week old replay.
    // Bytes are large enough here that the floor IS reachable from replays
    // alone, unlike the "unreachable" case covered separately below.
    seedReplay(30, 1, 5e9);
    seedReplay(20, 2, 5e9);
    seedReplay(10, 3, 5e9);
    const plan = planPrune(db, dir, new Date(), 90, 1e9, 10e9);
    expect(plan[0].ordinal).toBe(1);
  });

  it('stops taking files once the floor would be cleared', () => {
    // 9 GB free, 10 GB floor, so 1 GB has to go. Each file here is 2 GB, so
    // exactly one file is enough and the second must be left alone.
    seedReplay(30, 1, 2e9);
    seedReplay(20, 2, 2e9);
    const plan = planPrune(db, dir, new Date(), 90, 9e9, 10e9);
    expect(plan).toHaveLength(1);
    expect(plan[0].ordinal).toBe(1);
  });

  it('selects a replay of an aborted match past the retention window', () => {
    // A live match can go straight to 'aborted' without ever passing through
    // 'completed' (src/orchestrator.ts reapOrphanedMatches / no idle server).
    // Those replays must still be prunable, or they and their multi-MB files
    // are invisible to retention forever.
    seedReplayWithState('aborted', 120, 1, 'set');
    const plan = planPrune(db, dir, new Date(), 90, 500e9, 10e9);
    expect(plan.map((c) => c.ordinal)).toEqual([1]);
  });

  it('selects a replay of an aborted match with a NULL ended_at, via created_at', () => {
    // orchestrator.ts sets state = 'aborted' without setting ended_at, so the
    // age basis must fall back to created_at (NOT NULL, always present) or
    // the row is unprunable even after the state widening above.
    seedReplayWithState('aborted', 120, 1, 'null');
    const plan = planPrune(db, dir, new Date(), 90, 500e9, 10e9);
    expect(plan.map((c) => c.ordinal)).toEqual([1]);
  });

  it('never selects a replay of a live match, aborted or not', () => {
    seedReplayWithState('live', 200, 1, 'null');
    expect(planPrune(db, dir, new Date(), 90, 500e9, 10e9)).toEqual([]);
  });

  it('selects nothing for the floor sweep when the floor is unreachable from replays alone', () => {
    // Free space is far below the floor, and even every candidate byte on
    // disk cannot close the gap. Deleting all of it anyway would be pure
    // loss, so the sweep must select none of its own candidates. Retention
    // selections still stand.
    seedReplay(120, 1, 1e6); // in the retention window: should still be selected
    seedReplay(10, 2, 1e6); // inside the window, not old enough for retention
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plan = planPrune(db, dir, new Date(), 90, 1e9, 500e9);
    warn.mockRestore();
    expect(plan.map((c) => c.ordinal)).toEqual([1]);
  });
});

describe('prunePlan', () => {
  it('deletes the files and marks the rows, keeping the rows themselves', () => {
    const name = seedReplay(120, 1);
    const plan = planPrune(db, dir, new Date(), 90, 500e9, 10e9);
    const result = prunePlan(db, dir, plan);

    expect(result.deleted).toBe(1);
    expect(result.bytes).toBe(1024);
    expect(existsSync(join(dir, name))).toBe(false);

    const row = db.prepare('SELECT pruned_at FROM match_replays').get() as { pruned_at: string | null };
    // The row outlives the file so the UI can say "expired" rather than 404.
    expect(row.pruned_at).not.toBeNull();
  });

  it('marks a row whose file is already gone rather than failing', () => {
    seedReplay(120, 1);
    const plan = planPrune(db, dir, new Date(), 90, 500e9, 10e9);
    rmSync(join(dir, plan[0].filename));
    const result = prunePlan(db, dir, plan);
    expect(result.deleted).toBe(0);
    expect(result.missing).toBe(1);
    const row = db.prepare('SELECT pruned_at FROM match_replays').get() as { pruned_at: string | null };
    expect(row.pruned_at).not.toBeNull();
  });

  it('refuses a filename that escapes the replay directory', () => {
    seedReplay(120, 1);
    const plan = planPrune(db, dir, new Date(), 90, 500e9, 10e9);
    const result = prunePlan(db, dir, [{ ...plan[0], filename: '../../etc/passwd' }]);
    expect(result.deleted).toBe(0);
    expect(result.refused).toBe(1);
  });
});

describe('pruneReplays', () => {
  it('returns a zeroed result and does not throw when dir is empty', () => {
    expect(() => pruneReplays(db, '')).not.toThrow();
    expect(pruneReplays(db, '')).toEqual({ deleted: 0, bytes: 0, missing: 0, refused: 0 });
  });

  it('does not throw when the directory does not exist', () => {
    const missingDir = join(dir, 'does-not-exist');
    expect(() => pruneReplays(db, missingDir)).not.toThrow();
    expect(pruneReplays(db, missingDir)).toEqual({ deleted: 0, bytes: 0, missing: 0, refused: 0 });
  });

  it('reads the retention window from settings and actually prunes', () => {
    setSetting(db, 'replay_retention_days', '5');
    setSetting(db, 'replay_free_floor_gb', '0');
    const name = seedReplay(30, 1);
    seedReplay(1, 2);
    const result = pruneReplays(db, dir);
    expect(result.deleted).toBe(1);
    expect(result.bytes).toBe(1024);
    expect(existsSync(join(dir, name))).toBe(false);
    const rows = db.prepare('SELECT ordinal, pruned_at FROM match_replays ORDER BY ordinal').all() as
      { ordinal: number; pruned_at: string | null }[];
    expect(rows[0].pruned_at).not.toBeNull();
    expect(rows[1].pruned_at).toBeNull();
  });
});
