import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { compareSides, metricDetail, moreMatchesFor, type MoreMatchesRow } from '../../src/metrics/compare/compare.js';
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
        // Noisy, with a small bump on side B: no clear change (noise at 40
        // vs 40, too early with a finite estimate at 20 vs 20), and the
        // bootstrap has something to draw, so a perturbed random stream shows.
        row.run(id, half, 'tank.spawns', 'all', (i + half) % 3 === 0 || (patch === 2 && i % 7 === 0) ? 2 : 1, 1);
        // Sub-phase rows, so a phases=split run has a second BH family with
        // real data in it (tank: a clear shift; witch: noisy, no shift).
        row.run(id, half, 'round.saferoom', 'tank', (i * 2 + half) % safeEvery === 0 ? 1 : 0, 1);
        row.run(id, half, 'tank.spawns', 'tank', 1, 1);
        row.run(id, half, 'round.saferoom', 'witch', (i + half) % 3 === 0 ? 1 : 0, 1);
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
    // Not significant: a finite estimate against its BH cutoff, well above 1.
    expect(tank.moreMatches).toBeGreaterThan(1);
    const safe = r.rows.find((x) => x.metric === 'round.saferoom')!;
    expect(safe.verdict).toBe('too_early');
    // Passes BH but side A (a finished patch) is under the 10-match minimum
    // and cannot grow: no estimate.
    expect(safe.moreMatches).toBeNull();
  });

  it('asks only for the B matches missing from the minimum once a row passes BH', () => {
    const r = compareSides(setup(12, 5), A, B, { phases: 'all', reps: 400 });
    const safe = r.rows.find((x) => x.metric === 'round.saferoom')!;
    expect(safe.verdict).toBe('too_early');
    expect(safe.moreMatches).toBe(5);
  });

  it('shows the skill banner when team rating mismatch differs, even though halves swap sides', () => {
    const db = setup();
    // Side A: 27 vs 23 on half 1, 23 vs 27 on half 2 (teams swap sides), so
    // the signed survivor-minus-infected gap averages 0 but the mismatch is 4.
    db.prepare(`UPDATE round_metric_context SET surv_mu = CASE half WHEN 1 THEN 27 ELSE 23 END,
      inf_mu = CASE half WHEN 1 THEN 23 ELSE 27 END WHERE patch_id = 1`).run();
    const r = compareSides(db, A, B, { phases: 'all', reps: 50 });
    expect(r.a.meanGap).toBe(4);
    expect(r.b.meanGap).toBe(0);
    expect(r.banners.skill).toMatch(/mean team rating mismatch 4\.0 vs 0\.0/);
  });

  it('flags a row with data on both sides but no shared map', () => {
    const db = setup();
    db.prepare("UPDATE round_metric_context SET map = 'mapB' WHERE patch_id = 2").run();
    const r = compareSides(db, A, B, { phases: 'all', reps: 50 });
    const safe = r.rows.find((x) => x.metric === 'round.saferoom')!;
    expect(safe).toMatchObject({ noSharedMaps: true, verdict: 'no_data', excludedMaps: ['mapA', 'mapB'] });
    expect(compareSides(setup(), A, B, { phases: 'all', reps: 50 }).rows.every((x) => !x.noSharedMaps)).toBe(true);
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

  it.each([[40, 40], [20, 20]])('keeps whole-round rows identical whether or not sub-phases are requested (%i vs %i matches)', (nA, nB) => {
    // 20 vs 20 leaves tank.spawns too early, so its moreMatches depends on
    // its rank within its BH family and would move if the families merged.
    const db = setup(nA, nB);
    if (nA === 20) {
      const tank = compareSides(db, A, B, { phases: 'all', reps: 300 }).rows.find((row) => row.metric === 'tank.spawns')!;
      expect(tank.verdict).toBe('too_early');
      expect(tank.moreMatches).not.toBeNull();
    }
    const whole = compareSides(db, A, B, { phases: 'all', reps: 300 });
    const split = compareSides(db, A, B, { phases: 'split', reps: 300 });
    // The fixture must give the split run real sub-phase rows, or this test
    // could not notice a sub-phase family leaking into the whole-round one.
    const sub = split.rows.filter((row) => row.phase !== 'all');
    expect(sub.map((row) => `${row.metric}|${row.phase}`).sort())
      .toEqual(['round.saferoom|tank', 'round.saferoom|witch', 'tank.spawns|tank']);
    expect(sub.every((row) => row.p !== null)).toBe(true);
    const splitWhole = split.rows.filter((row) => row.phase === 'all');
    expect(splitWhole.map((row) => [row.metric, row.lo, row.hi, row.p, row.verdict, row.moreMatches]))
      .toEqual(whole.rows.map((row) => [row.metric, row.lo, row.hi, row.p, row.verdict, row.moreMatches]));
  });
});

describe('moreMatchesFor', () => {
  const quiet = (p: number): MoreMatchesRow => ({
    p, significant: false, verdict: 'too_early', diff: 0.01, seA: 0.05, seB: 0.05, nA: 20, nB: 20,
  });

  it('targets the row\'s own BH cutoff, not a plain 95% interval', () => {
    // 40 rows; the strongest has p 0.004 and its 95% interval already
    // excludes zero, but at rank 1 of 40 BH needs p <= 0.0025. The old
    // estimate said "1 more match"; the right target is z for alpha 0.0025.
    const family = [
      { p: 0.004, significant: false, verdict: 'too_early' as const, diff: 0.1, seA: 0.02, seB: 0.04, nA: 27, nB: 18 },
      ...Array.from({ length: 39 }, () => quiet(0.5)),
    ];
    const more = moreMatchesFor(family, 1000);
    expect(more[0]).not.toBe(1);
    expect(more[0]).toBe(24);
  });

  it('gives no estimate when the cutoff is below what the bootstrap can resolve', () => {
    // Rank 1 of 60 needs alpha 0.00167, under 2 / 1001.
    const family = [
      { p: 0.004, significant: false, verdict: 'too_early' as const, diff: 0.1, seA: 0.02, seB: 0.04, nA: 27, nB: 18 },
      ...Array.from({ length: 59 }, () => quiet(0.5)),
    ];
    expect(moreMatchesFor(family, 1000)[0]).toBeNull();
  });

  it('for a row that passed BH, asks for the B matches the minimum still needs', () => {
    const passed = (nA: number, nB: number): MoreMatchesRow => ({
      p: 0.001, significant: true, verdict: 'too_early', diff: 0.3, seA: 0.01, seB: 0.01, nA, nB,
    });
    expect(moreMatchesFor([passed(12, 4)], 1000)).toEqual([6]);
    expect(moreMatchesFor([passed(9, 40)], 1000)).toEqual([null]);
  });

  it('is null for rows that are not too early', () => {
    expect(moreMatchesFor([{ ...quiet(0.5), verdict: 'noise' }], 1000)).toEqual([null]);
  });
});

describe('metricDetail', () => {
  it('pools each selected patch on its own', () => {
    const d = metricDetail(setup(), 'round.saferoom', 'all', { ...A, patchIds: [1, 2] }, B);
    expect(d.perPatch).toEqual([
      { patchId: 1, label: 'Old', value: 0.2, matches: 40 },
      { patchId: 2, label: 'New', value: 1, matches: 40 },
    ]);
  });

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

  it('leaves out event and normal rows of rounds from before the event markers', () => {
    const db = setup();
    const row = db.prepare("INSERT INTO round_metrics VALUES (?, 0, ?, 'round.phase_share', 'event', ?, 5)");
    for (let id = 1; id <= 80; id++) for (const half of [1, 2]) row.run(id, half, id > 40 ? 1 : 0);
    // Only side B's rounds carry per-round stats (pug-match 0.3.9+).
    db.prepare('UPDATE round_metric_context SET has_stats = 1 WHERE match_id > 40').run();
    const d = metricDetail(db, 'round.phase_share', 'event', A, B);
    expect(d.trend.every((t) => t.side === 'b')).toBe(true);
    expect(d.trend).toHaveLength(40);
    expect(d.perPatch).toEqual([
      { patchId: 1, label: 'Old', value: null, matches: 0 },
      { patchId: 2, label: 'New', value: 0.2, matches: 40 },
    ]);
    expect(d.perMap).toEqual([]);
    expect(d.examples.every((e) => e.matchId > 40)).toBe(true);
  });
});
