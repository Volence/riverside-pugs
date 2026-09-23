import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { compareSides, metricDetail } from '../../src/metrics/compare/compare.js';
import { ENGINE } from '../../src/metrics/registry.js';

/** Patch 1: 40 matches, saferoom 20%. Patch 2: 40 matches, saferoom 80%.
 *  tank.spawns identical on both. One map. */
function setup(nA = 40, nB = 40) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO balance_patches (id, name, source, first_seen_at) VALUES (1, 'Old', 'detected', '2026-09-01 00:00:00'), (2, 'New', 'detected', '2026-09-10 00:00:00')").run();
  const match = db.prepare("INSERT INTO matches (id, season_id, state, campaign, origin, ended_at) VALUES (?, 1, 'completed', 'x', 'queue', ?)");
  const ctx = db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, map, origin, patch_id, surv_mu, inf_mu, has_replay, has_stats, engine, computed_at)
    VALUES (?, 0, ?, 'mapA', 'queue', ?, 25, 25, 0, 0, ?, 'n')`);
  const row = db.prepare('INSERT INTO round_metrics VALUES (?, 0, ?, ?, ?, ?, ?)');
  let id = 1;
  const add = (patch: number, n: number, safeEvery: number, day: number) => {
    for (let i = 0; i < n; i++, id++) {
      match.run(id, `2026-09-${String(day).padStart(2, '0')} 10:${String(i).padStart(2, '0')}:00`);
      for (const half of [1, 2]) {
        ctx.run(id, half, patch, ENGINE);
        row.run(id, half, 'round.saferoom', 'all', (i * 2 + half) % safeEvery === 0 ? 1 : 0, 1);
        row.run(id, half, 'tank.spawns', 'all', 1, 1);
      }
    }
  };
  add(1, nA, 5, 5);   // 1 in 5 rounds safe
  add(2, nB, 1, 15);  // x % 1 === 0 always holds: every side B round is safe
  return db;
}
const A = { patchIds: [1], origin: 'all' as const, maps: null };
const B = { patchIds: [2], origin: 'all' as const, maps: null };

describe('compareSides', () => {
  it('flags a large change as real and an unchanged metric as noise', () => {
    const r = compareSides(setup(), A, B, { phases: 'all', reps: 400 });
    const safe = r.rows.find((x) => x.metric === 'round.saferoom')!;
    expect(safe.a).toBeCloseTo(0.2, 2);
    expect(safe.b).toBeCloseTo(1, 2);
    expect(safe.verdict).toBe('real');
    const tank = r.rows.find((x) => x.metric === 'tank.spawns')!;
    expect(tank.verdict).toBe('noise');
    expect(r.rows[0].metric).toBe('round.saferoom');
    expect(r.counts.real).toBe(1);
    expect(r.a.matches).toBe(40);
  });

  it('calls a small sample too early and estimates matches needed', () => {
    const r = compareSides(setup(5, 5), A, B, { phases: 'all', reps: 400 });
    const tank = r.rows.find((x) => x.metric === 'tank.spawns')!;
    expect(tank.verdict).toBe('too_early');
    const safe = r.rows.find((x) => x.metric === 'round.saferoom')!;
    expect(safe.verdict).not.toBe('noise');
  });

  it('is reproducible with the default seed', () => {
    const db = setup();
    const x = compareSides(db, A, B, { phases: 'all', reps: 200 });
    const y = compareSides(db, A, B, { phases: 'all', reps: 200 });
    expect(x.rows.map((r) => [r.lo, r.hi])).toEqual(y.rows.map((r) => [r.lo, r.hi]));
  });

  it('shows the skill banner when ratings differ by more than 1 mu', () => {
    const db = setup();
    db.prepare('UPDATE round_metric_context SET surv_mu = 30, inf_mu = 30 WHERE patch_id = 2').run();
    expect(compareSides(db, A, B, { phases: 'all', reps: 50 }).banners.skill).toMatch(/rating/i);
  });
});

describe('metricDetail', () => {
  it('returns a time-ordered trend, per-map bars and side B examples', () => {
    const d = metricDetail(setup(), 'round.saferoom', 'all', A, B);
    expect(d.trend).toHaveLength(80);
    expect(d.trend[0].side).toBe('a');
    expect(d.trend[79].side).toBe('b');
    expect(d.perMap).toEqual([expect.objectContaining({ map: 'mapA', roundsA: 80, roundsB: 80 })]);
    expect(d.boundaries.map((b) => b.patchId)).toEqual([1, 2]);
    expect(d.examples.length).toBeGreaterThan(0);
    expect(d.examples.every((e) => e.matchId > 40)).toBe(true);
  });
});
