import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  // A clip is a pointer into a replay: start and end times and nothing else.
  // Prune the file and the clip still lists on the admin page and opens onto
  // nothing, and a review can no longer be checked against what it judged.
  describe('integrity evidence', () => {
    const matchOf = (filename: string) =>
      (db.prepare('SELECT match_id AS id FROM match_replays WHERE filename = ?').get(filename) as { id: number }).id;
    const addClip = (matchId: number, ordinal: number) => db.prepare(
      `INSERT INTO integrity_clips (match_id, ordinal, half, slot, steamid, start_ms, end_ms, kind, score, detail, analyzer_version)
       VALUES (?, ?, 1, 0, '765', 1000, 3000, 'ghost_track', 0.8, '{}', 1)`,
    ).run(matchId, ordinal);

    it('never selects a replay one of whose rounds has a clip, however old', () => {
      const flagged = seedReplay(400, 1);
      const plain = seedReplay(400, 2);
      addClip(matchOf(flagged), 1);
      expect(planPrune(db, dir, new Date(), 90, 500e9, 10e9).map((c) => c.filename)).toEqual([plain]);
    });

    it('never selects a replay an admin has reviewed, even when it was dismissed', () => {
      const reviewed = seedReplay(400, 1);
      db.prepare(
        `INSERT INTO integrity_reviews (match_id, ordinal, half, slot, state, note) VALUES (?, 1, 1, 0, 'dismissed', 'heard it')`,
      ).run(matchOf(reviewed));
      expect(planPrune(db, dir, new Date(), 90, 500e9, 10e9)).toEqual([]);
    });

    it('protects the round, not the match: the other rounds of that match still go', () => {
      const flagged = seedReplay(400, 1);
      const id = matchOf(flagged);
      const other = `pug_${TOKEN}_2_1.rpl`;
      writeFileSync(join(dir, other), Buffer.alloc(16));
      db.prepare('INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz) VALUES (?, 2, 1, ?, 1024, 10, 10)')
        .run(id, other);
      addClip(id, 1);
      expect(planPrune(db, dir, new Date(), 90, 500e9, 10e9).map((c) => c.filename)).toEqual([other]);
    });

    it('holds against the free space floor as well', () => {
      const flagged = seedReplay(30, 1, 5e9);
      seedReplay(20, 2, 5e9);
      seedReplay(10, 3, 5e9);
      addClip(matchOf(flagged), 1);
      const plan = planPrune(db, dir, new Date(), 90, 1e9, 10e9);
      expect(plan.map((c) => c.ordinal)).toEqual([2, 3]);
    });
  });

  // The balance metrics job reads a round's replay once, after the match. With
  // R2 on and the disk under the floor, production pruned replays within
  // hours, before the job (which waits while any match is live) got to them:
  // those rounds were then computed without their replay, for good.
  describe('rounds still waiting on balance metrics', () => {
    const matchOf = (filename: string) =>
      (db.prepare('SELECT match_id AS id FROM match_replays WHERE filename = ?').get(filename) as { id: number }).id;
    const addRound = (matchId: number, ordinal: number, ended = true) => db.prepare(
      `INSERT INTO match_rounds (match_id, ordinal, half, surv_team, started_at, ended_at)
       VALUES (?, ?, 1, 'a', '2026-09-01 00:00:00', ?)`,
    ).run(matchId, ordinal, ended ? '2026-09-01 00:05:00' : null);
    const addContext = (matchId: number, ordinal: number, hasReplay: number, replaySeen: number) => db.prepare(
      `INSERT INTO round_metric_context (match_id, ordinal, half, has_replay, has_stats, replay_seen, engine, computed_at)
       VALUES (?, ?, 1, ?, 0, ?, 'e', 'n')`,
    ).run(matchId, ordinal, hasReplay, replaySeen);

    it('holds a finished round with no metrics yet, by window and by floor', () => {
      const waiting = seedReplay(400, 1, 5e9);
      const plain = seedReplay(400, 2, 5e9);
      addRound(matchOf(waiting), 1);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(planPrune(db, dir, new Date(), 90, 500e9, 10e9).map((c) => c.filename)).toEqual([plain]);
      expect(planPrune(db, dir, new Date(), 9999, 0, 1e9).map((c) => c.filename)).toEqual([plain]);
      warn.mockRestore();
    });

    it('holds a round whose metrics were computed before its replay arrived', () => {
      const waiting = seedReplay(400, 1);
      addRound(matchOf(waiting), 1);
      addContext(matchOf(waiting), 1, 0, 0);
      expect(planPrune(db, dir, new Date(), 90, 500e9, 10e9)).toEqual([]);
    });

    it('releases the round once the job has read its replay, or tried to', () => {
      const done = seedReplay(400, 1);
      const unreadable = seedReplay(400, 2);
      addRound(matchOf(done), 1);
      addContext(matchOf(done), 1, 1, 1);
      addRound(matchOf(unreadable), 2);
      addContext(matchOf(unreadable), 2, 0, 1);
      expect(planPrune(db, dir, new Date(), 90, 500e9, 10e9).map((c) => c.filename).sort()).toEqual([done, unreadable].sort());
    });

    it('does not hold rounds the job never computes: voided matches, unfinished rounds', () => {
      const voided = seedReplay(400, 1);
      db.prepare("UPDATE matches SET voided_at = datetime('now') WHERE id = ?").run(matchOf(voided));
      addRound(matchOf(voided), 1);
      const unfinished = seedReplay(400, 2);
      addRound(matchOf(unfinished), 2, false);
      expect(planPrune(db, dir, new Date(), 90, 500e9, 10e9).map((c) => c.filename).sort()).toEqual([voided, unfinished].sort());
    });
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

describe('with R2 configured (requireOffloaded)', () => {
  const markOffloaded = (filename: string) => db.prepare(
    `UPDATE match_replays SET r2_key = 'replays/k', r2_at = datetime('now') WHERE filename = ?`,
  ).run(filename);

  it('never selects a replay that has no r2_key, by window or by floor', () => {
    // two old rows past the retention window, one with r2_key, one without; free bytes below the floor
    const OFFLOADED_NAME = seedReplay(120, 1, 5e9);
    const notOffloaded = seedReplay(120, 2, 5e9);
    markOffloaded(OFFLOADED_NAME);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plan = planPrune(db, dir, new Date(), 90, 0, 10e9, { requireOffloaded: true });
    warn.mockRestore();
    expect(plan.map((c) => c.filename)).toEqual([OFFLOADED_NAME]);
    expect(plan.map((c) => c.filename)).not.toContain(notOffloaded);
  });

  it('still selects offloaded replays for the floor, oldest first', () => {
    // All three rows are inside the retention window (not old enough to be
    // selected by age), all offloaded, and free space is below the floor, so
    // only the floor sweep can select them, oldest first, exactly as the
    // non-R2 floor sweep test above does.
    const first = seedReplay(30, 1, 5e9);
    const second = seedReplay(20, 2, 5e9);
    const third = seedReplay(10, 3, 5e9);
    [first, second, third].forEach(markOffloaded);
    const plan = planPrune(db, dir, new Date(), 90, 1e9, 10e9, { requireOffloaded: true });
    expect(plan.map((c) => c.filename)).toEqual([first, second]);
  });

  it('behaves exactly as before without the option', () => {
    // Same fixture as the first test: one offloaded row, one not, both past
    // the retention window. With no opts, r2_key is irrelevant and both go.
    const offloaded = seedReplay(120, 1, 5e9);
    const notOffloaded = seedReplay(120, 2, 5e9);
    markOffloaded(offloaded);
    const plan = planPrune(db, dir, new Date(), 90, 500e9, 10e9);
    expect(plan.map((c) => c.filename).sort()).toEqual([notOffloaded, offloaded].sort());
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

  it('does NOT mark a row pruned when the file could not be removed', () => {
    // The failure this guards: the replay dir is written by the game server's
    // user and read by the web app's. If the directory mode forgets group
    // write, rmSync throws EACCES. Treating that as "already gone" would mark
    // the row pruned, retire it from every future pass, and leave the bytes on
    // disk forever, which is a disk filling up while the database insists it
    // was cleaned.
    const name = seedReplay(120, 1);
    const plan = planPrune(db, dir, new Date(), 90, 500e9, 10e9);
    chmodSync(dir, 0o555);
    let result;
    try {
      result = prunePlan(db, dir, plan);
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.missing).toBe(0);
    expect(existsSync(join(dir, name))).toBe(true);
    const row = db.prepare('SELECT pruned_at FROM match_replays').get() as { pruned_at: string | null };
    expect(row.pruned_at).toBeNull();
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
    expect(pruneReplays(db, '')).toEqual({ deleted: 0, bytes: 0, missing: 0, refused: 0, failed: 0 });
  });

  it('does not throw when the directory does not exist', () => {
    const missingDir = join(dir, 'does-not-exist');
    expect(() => pruneReplays(db, missingDir)).not.toThrow();
    expect(pruneReplays(db, missingDir)).toEqual({ deleted: 0, bytes: 0, missing: 0, refused: 0, failed: 0 });
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
