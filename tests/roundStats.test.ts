import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { roundAttribution } from '../src/roundStats.js';

const P_A = 'STEAM_0:0:1';
const P_B = 'STEAM_0:0:2';

/** One map, two halves. Team a is survivor in half 1, team b in half 2. */
function matchWithOneMap() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'no_mercy')").run();
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score) VALUES (1, 0, 1, 'a', 300)").run();
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score) VALUES (1, 0, 2, 'b', 250)").run();
  // Cumulative end-of-map snapshot, exactly as the live pipeline writes it.
  // The player on team a has both a survivor stat and an infected stat from
  // the same map, because they played both sides on it.
  const ins = db.prepare(
    'INSERT INTO match_live_map_stats (match_id, ordinal, player_id, stats_json) VALUES (1, 0, ?, ?)',
  );
  ins.run(P_A, JSON.stringify({ skeets: 3, damage_as_si: 500 }));
  ins.run(P_B, JSON.stringify({ skeets: 1, damage_as_si: 800 }));
  return db;
}

const TEAMS = new Map<string, 'a' | 'b'>([[P_A, 'a'], [P_B, 'b']]);

describe('per-round side attribution', () => {
  it('puts a survivor stat only in the round its owner held survivor', () => {
    const rounds = roundAttribution(matchWithOneMap(), 1, TEAMS);
    const h1 = rounds.find((r) => r.half === 1)!;
    const h2 = rounds.find((r) => r.half === 2)!;
    // Team a were survivors in half 1, so their skeets belong there.
    expect(h1.byPlayer[P_A]).toEqual({ skeets: 3 });
    // And their SI damage belongs to half 2, when they were infected.
    expect(h2.byPlayer[P_A]).toEqual({ damage_as_si: 500 });
  });

  it('attributes the opposing team the other way round', () => {
    const rounds = roundAttribution(matchWithOneMap(), 1, TEAMS);
    const h1 = rounds.find((r) => r.half === 1)!;
    const h2 = rounds.find((r) => r.half === 2)!;
    expect(h1.byPlayer[P_B]).toEqual({ damage_as_si: 800 });
    expect(h2.byPlayer[P_B]).toEqual({ skeets: 1 });
  });

  it('drops an unknown stat key rather than guessing its side', () => {
    const db = matchWithOneMap();
    db.prepare('UPDATE match_live_map_stats SET stats_json = ? WHERE player_id = ?')
      .run(JSON.stringify({ skeets: 3, not_a_stat: 9 }), P_A);
    const h1 = roundAttribution(db, 1, TEAMS).find((r) => r.half === 1)!;
    expect(h1.byPlayer[P_A]).toEqual({ skeets: 3 });
  });

  it('reports an unreliable round so callers can refuse to show it', () => {
    const db = matchWithOneMap();
    db.prepare('UPDATE match_rounds SET reliable = 0 WHERE half = 1').run();
    const h1 = roundAttribution(db, 1, TEAMS).find((r) => r.half === 1)!;
    expect(h1.reliable).toBe(false);
  });

  it('returns nothing for a match with no rounds recorded', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'no_mercy')").run();
    expect(roundAttribution(db, 1, TEAMS)).toEqual([]);
  });
});
