import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { loadSide, rowKey } from '../../src/metrics/compare/load.js';
import { ENGINE } from '../../src/metrics/registry.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO balance_patches (id, name, source, first_seen_at) VALUES (1, 'P1', 'historical', '2026-09-01 00:00:00'), (2, 'P2', 'detected', '2026-09-10 00:00:00')").run();
  const match = db.prepare("INSERT INTO matches (id, season_id, state, campaign, origin, ended_at, voided_at) VALUES (?, 1, ?, 'x', ?, '2026-09-20 00:00:00', ?)");
  match.run(1, 'completed', 'queue', null);
  match.run(2, 'completed', 'in_game', null);
  match.run(3, 'completed', 'queue', '2026-09-21 00:00:00');   // voided
  match.run(4, 'live', 'queue', null);                          // not completed
  const ctx = db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, map, origin, patch_id, surv_mu, inf_mu, has_replay, has_stats, engine, computed_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 0, ?, 'n')`);
  const row = db.prepare('INSERT INTO round_metrics VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const mid of [1, 2, 3, 4]) {
    ctx.run(mid, 0, 1, 'mapA', mid === 2 ? 'in_game' : 'queue', 26, 24, mid === 1 ? ENGINE + 'x' : ENGINE);
    ctx.run(mid, 1, 1, 'mapB', mid === 2 ? 'in_game' : 'queue', 26, 24, ENGINE);
    row.run(mid, 0, 1, 'round.saferoom', 'all', 1, 1);
    row.run(mid, 1, 1, 'round.saferoom', 'all', 0, 1);
    row.run(mid, 0, 1, 'round.saferoom', 'tank', 1, 1);
  }
  return db;
}

describe('loadSide', () => {
  it('sums per match and map for completed, unvoided matches in the patches', () => {
    const d = loadSide(setup(), { patchIds: [1], origin: 'all', maps: null }, ['all']);
    const s = d.samples.get(rowKey('round.saferoom', 'all'))!;
    expect(s).toHaveLength(2);
    expect(s[0].get('mapA')).toEqual({ num: 1, den: 1 });
    expect(s[0].get('mapB')).toEqual({ num: 0, den: 1 });
    expect(d.samples.has(rowKey('round.saferoom', 'tank'))).toBe(false);
    expect(d.summary).toMatchObject({ matches: 2, rounds: 4, meanMu: 25, meanGap: 2, olderEngineRounds: 1, historical: true });
  });

  it('does not count failed rounds as using an older metric definition', () => {
    const db = setup();
    db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, map, origin, patch_id, has_replay, has_stats, engine, computed_at)
      VALUES (1, 2, 1, 'mapA', 'queue', 1, 0, 0, ?, 'n'), (1, 3, 1, 'mapA', 'queue', 1, 0, 0, ?, 'n')`)
      .run(ENGINE + '!failed', 'older-engine!failed');
    expect(loadSide(db, { patchIds: [1], origin: 'all', maps: null }, ['all']).summary.olderEngineRounds).toBe(1);
  });

  it('filters by origin and map', () => {
    const q = loadSide(setup(), { patchIds: [1], origin: 'in_game', maps: ['mapA'] }, ['all', 'tank']);
    expect(q.summary.matches).toBe(1);
    expect(q.samples.get(rowKey('round.saferoom', 'all'))![0].has('mapB')).toBe(false);
    expect(q.samples.get(rowKey('round.saferoom', 'tank'))).toHaveLength(1);
  });

  it('drops event and normal rows of rounds from before the plugin sent event markers', () => {
    // A round with no per-round stats (has_stats = 0) predates pug-match
    // 0.3.9, which brought panic and finale markers in the same release: its
    // event time is unknown, so its "event" share reads 0 and its event
    // stretches are counted as "normal". Neither is comparable to a round
    // that has markers. Tank and witch phases come from the replay and stay.
    const db = setup();
    const row = db.prepare('INSERT INTO round_metrics VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const mid of [1, 2]) {
      row.run(mid, 0, 1, 'round.phase_share', 'event', 0, 5);
      row.run(mid, 0, 1, 'round.phase_share', 'normal', 3, 5);
      row.run(mid, 0, 1, 'round.phase_share', 'witch', 1, 5);
    }
    db.prepare('UPDATE round_metric_context SET has_stats = 1 WHERE match_id = 2 AND ordinal = 0').run();
    const d = loadSide(db, { patchIds: [1], origin: 'all', maps: null }, ['event', 'normal', 'witch']);
    expect(d.samples.get(rowKey('round.phase_share', 'event'))).toHaveLength(1);
    expect(d.samples.get(rowKey('round.phase_share', 'normal'))).toHaveLength(1);
    expect(d.samples.get(rowKey('round.phase_share', 'witch'))).toHaveLength(2);
  });

  it('is empty for patches with no rounds', () => {
    const d = loadSide(setup(), { patchIds: [2], origin: 'all', maps: null }, ['all']);
    expect(d.summary).toMatchObject({ matches: 0, rounds: 0, meanMu: null, historical: false });
    expect(d.samples.size).toBe(0);
  });
});
