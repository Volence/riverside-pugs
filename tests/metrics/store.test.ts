import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { roundContext, writeRoundMetrics } from '../../src/metrics/store.js';

const A = '76561198000000001', B = '76561198000000002';
function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  for (const p of [A, B]) db.prepare('INSERT INTO players (steamid, name) VALUES (?, ?)').run(p, p);
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, origin) VALUES (1, 1, 'completed', 'x', 'queue')").run();
  db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (1, ?, 'a'), (1, ?, 'b')").run(A, B);
  db.prepare("INSERT INTO match_maps (match_id, ordinal, map) VALUES (1, 0, 'l4d_vs_hospital01_apartment')").run();
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'b')").run();
  db.prepare('INSERT INTO rating_history (player_id, match_id, season_id, mu_before, sigma_before, mu_after, sigma_after) VALUES (?, 1, 1, 30, 5, 31, 5), (?, 1, 1, 20, 5, 19, 5)').run(A, B);
  return db;
}

describe('metrics store', () => {
  it('builds the round context with survivor and infected side ratings', () => {
    const ctx = roundContext(setup(), { matchId: 1, ordinal: 0, half: 1 });
    expect(ctx).toMatchObject({ map: 'l4d_vs_hospital01_apartment', origin: 'queue', survMu: 20, infMu: 30 });
  });

  it('replaces a round atomically', () => {
    const db = setup();
    const key = { matchId: 1, ordinal: 0, half: 1 as const };
    writeRoundMetrics(db, key, [{ metric: 'a.x', phase: 'all', num: 1, den: 1 }, { metric: 'a.y', phase: 'tank', num: 2, den: 3 }],
      { hasReplay: true, hasStats: false, replaySeen: true, engine: 'e1', now: '2026-09-23 10:00:00' });
    writeRoundMetrics(db, key, [{ metric: 'a.x', phase: 'all', num: 5, den: 1 }],
      { hasReplay: false, hasStats: true, replaySeen: false, engine: 'e2', now: '2026-09-23 11:00:00' });
    expect(db.prepare('SELECT metric, phase, num FROM round_metrics').all()).toEqual([{ metric: 'a.x', phase: 'all', num: 5 }]);
    expect(db.prepare('SELECT has_replay, has_stats, replay_seen, engine, map, surv_mu FROM round_metric_context').get())
      .toEqual({ has_replay: 0, has_stats: 1, replay_seen: 0, engine: 'e2', map: 'l4d_vs_hospital01_apartment', surv_mu: 20 });
  });
});
