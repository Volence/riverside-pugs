import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { loadRoundInput } from '../../src/metrics/loadRound.js';

const A = '76561198000000001', B = '76561198000000002';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  for (const p of [A, B]) db.prepare("INSERT INTO players (steamid, name) VALUES (?, ?)").run(p, p);
  db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x')").run();
  db.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (1, ?, 'a'), (1, ?, 'b')").run(A, B);
  db.prepare(`INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, reliable, started_at, ended_at, survivors_alive, skill_detect)
              VALUES (1, 0, 2, 'b', 412, 1, '2026-09-20 10:00:00', '2026-09-20 10:09:00', 0, 1)`).run();
  const ev = db.prepare(`INSERT INTO match_live_events (match_id, map_ordinal, seq, kind, actor, target, value, half, t_ms)
                         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ev.run(0, 2, 'tank_spawn', A, null, 0, 2, 5000);
  ev.run(0, 1, 'si_spawn', A, null, 3, 2, 1000);
  ev.run(0, 3, 'skeet', B, A, 0, 1, 900);      // other half: excluded
  ev.run(1, 4, 'skeet', B, A, 0, 2, 900);      // other map: excluded
  db.prepare("INSERT INTO match_round_stats VALUES (1, 0, 2, ?, 'crowns', 1), (1, 0, 2, ?, 'dmg_as_tank', 300)").run(B, A);
  db.prepare("INSERT INTO match_round_marks VALUES (1, 0, 2, 'panic', 7000)").run();
  return db;
}

describe('loadRoundInput', () => {
  it('loads one round and only its own events, ordered by time', () => {
    const r = loadRoundInput(setup(), { matchId: 1, ordinal: 0, half: 2 })!;
    expect(r.survTeam).toBe('b');
    expect(r.reliable).toBe(true);
    expect(r.ended).toBe(true);
    expect(r.score).toBe(412);
    expect(r.survivorsAlive).toBe(0);
    expect(r.events.map((e) => e.kind)).toEqual(['si_spawn', 'tank_spawn']);
    expect(r.events[0]).toEqual({ kind: 'si_spawn', actor: A, target: null, value: 3, tMs: 1000 });
    expect(r.stats.get(B)?.get('crowns')).toBe(1);
    expect(r.stats.get(A)?.get('dmg_as_tank')).toBe(300);
    expect(r.hasStats).toBe(true);
    expect(r.skillDetect).toBe(true);
    expect(r.marks).toEqual([{ kind: 'panic', tMs: 7000 }]);
    expect(r.teamOf.get(A)).toBe('a');
  });

  it('reports no stats for a round that predates ROUND_STAT', () => {
    const db = setup();
    db.prepare('UPDATE match_rounds SET skill_detect = NULL').run();
    db.prepare('DELETE FROM match_round_stats').run();
    const r = loadRoundInput(db, { matchId: 1, ordinal: 0, half: 2 })!;
    expect(r.hasStats).toBe(false);
    expect(r.skillDetect).toBe(false);
    expect(r.stats.size).toBe(0);
  });

  it('returns null for a missing round', () => {
    expect(loadRoundInput(setup(), { matchId: 1, ordinal: 5, half: 1 })).toBeNull();
  });
});
