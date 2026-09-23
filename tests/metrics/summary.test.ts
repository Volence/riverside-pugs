import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { summarizeByPatch } from '../../src/metrics/summary.js';

function seed() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x')").run();
  db.prepare("INSERT INTO balance_patches (id, name, source, first_seen_at) VALUES (7, 'Baseline', 'historical', '2000-01-01 00:00:00')").run();
  return db;
}

describe('summarizeByPatch', () => {
  it('pools num over den per patch', () => {
    const db = seed();
    const ctx = db.prepare("INSERT INTO round_metric_context (match_id, ordinal, half, patch_id, has_replay, has_stats, engine, computed_at) VALUES (1, ?, ?, 7, 0, 0, 'e', 'n')");
    const row = db.prepare("INSERT INTO round_metrics VALUES (1, ?, ?, 'round.saferoom', 'all', ?, 1)");
    ctx.run(0, 1); row.run(0, 1, 1);
    ctx.run(0, 2); row.run(0, 2, 0);
    ctx.run(1, 1); row.run(1, 1, 1);
    expect(summarizeByPatch(db, ['round.saferoom'])).toEqual([
      { patchId: 7, patchName: 'Baseline', metric: 'round.saferoom', rounds: 3, value: 2 / 3 },
    ]);
  });

  it('skips voided and unfinished matches and filters by phase', () => {
    const db = seed();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign, voided_at) VALUES (2, 1, 'completed', 'x', '2000-01-02 00:00:00')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (3, 1, 'live', 'x')").run();
    for (const m of [1, 2, 3]) {
      db.prepare("INSERT INTO round_metric_context (match_id, ordinal, half, patch_id, has_replay, has_stats, engine, computed_at) VALUES (?, 0, 1, 7, 1, 0, 'e', 'n')").run(m);
      db.prepare("INSERT INTO round_metrics VALUES (?, 0, 1, 'tank.spawns', 'all', ?, 1)").run(m, m);
      db.prepare("INSERT INTO round_metrics VALUES (?, 0, 1, 'tank.spawns', 'tank', 5, 1)").run(m);
    }
    expect(summarizeByPatch(db, ['tank.spawns'])).toEqual([
      { patchId: 7, patchName: 'Baseline', metric: 'tank.spawns', rounds: 1, value: 1 },
    ]);
    expect(summarizeByPatch(db, ['tank.spawns'], 'tank')[0].value).toBe(5);
    expect(summarizeByPatch(db, [])).toEqual([]);
  });
});
