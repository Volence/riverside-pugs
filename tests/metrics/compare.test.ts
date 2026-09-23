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

/** Two metrics, both a huge and essentially noise-free real change: side A's
 *  tank.spawns is always 0 (so its rel is undefined, null) and side A's
 *  round.saferoom is 0.2 (so its rel is a finite 4). Used to check that a
 *  null-rel real row still sorts ahead of a finite-rel real row. */
function setupNullRel(n = 40) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO balance_patches (id, name, source, first_seen_at) VALUES (1, 'Old', 'detected', '2026-09-01 00:00:00'), (2, 'New', 'detected', '2026-09-10 00:00:00')").run();
  const match = db.prepare("INSERT INTO matches (id, season_id, state, campaign, origin, ended_at) VALUES (?, 1, 'completed', 'x', 'queue', ?)");
  const ctx = db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, map, origin, patch_id, surv_mu, inf_mu, has_replay, has_stats, engine, computed_at)
    VALUES (?, 0, ?, 'mapA', 'queue', ?, 25, 25, 0, 0, ?, 'n')`);
  const row = db.prepare('INSERT INTO round_metrics VALUES (?, 0, ?, ?, ?, ?, ?)');
  let id = 1;
  const add = (patch: number, day: number, saferoomNum: number, saferoomDen: number, tankNum: number, tankDen: number) => {
    for (let i = 0; i < n; i++, id++) {
      match.run(id, `2026-09-${String(day).padStart(2, '0')} 10:${String(i).padStart(2, '0')}:00`);
      for (const half of [1, 2]) {
        ctx.run(id, half, patch, ENGINE);
        row.run(id, half, 'round.saferoom', 'all', saferoomNum, saferoomDen);
        row.run(id, half, 'tank.spawns', 'all', tankNum, tankDen);
      }
    }
  };
  add(1, 5, 1, 5, 0, 1);  // side A: saferoom 0.2, tank.spawns 0
  add(2, 15, 1, 1, 1, 1); // side B: saferoom 1.0, tank.spawns 1
  return db;
}

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

  it('shows the skill banner when ratings are only available for one side', () => {
    const db = setup();
    db.prepare('UPDATE round_metric_context SET surv_mu = NULL, inf_mu = NULL WHERE patch_id = 2').run();
    expect(compareSides(db, A, B, { phases: 'all', reps: 50 }).banners.skill)
      .toBe('Ratings are unavailable for one side, so the skill check could not run.');
  });

  it('sorts a real row with a null rel (A was 0) ahead of a real row with a finite rel', () => {
    const r = compareSides(setupNullRel(), A, B, { phases: 'all', reps: 400 });
    const real = r.rows.filter((x) => x.verdict === 'real');
    expect(real.map((x) => x.metric)).toEqual(['tank.spawns', 'round.saferoom']);
    expect(real[0].rel).toBeNull();
    expect(real[1].rel).not.toBeNull();
  });

  it('keeps whole-round rows identical whether or not sub-phases are requested', () => {
    const db = setup();
    const whole = compareSides(db, A, B, { phases: 'all', reps: 300 });
    const split = compareSides(db, A, B, { phases: 'split', reps: 300 });
    const splitWhole = split.rows.filter((row) => row.phase === 'all');
    expect(splitWhole.map((row) => [row.metric, row.lo, row.hi, row.p, row.verdict]))
      .toEqual(whole.rows.map((row) => [row.metric, row.lo, row.hi, row.p, row.verdict]));
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

  it('breaks value ties deterministically (highest match id first, then ordinal, then half)', () => {
    // Every side B round has the same saferoom value (1), so the pick is
    // decided entirely by the tiebreak: match id descending, then ordinal,
    // then half ascending.
    const d = metricDetail(setup(), 'round.saferoom', 'all', A, B);
    expect(d.examples.map((e) => `${e.matchId}/${e.half}`)).toEqual([
      '41/2', '41/1', '42/2', '80/1', '80/2',
    ]);
  });
});
