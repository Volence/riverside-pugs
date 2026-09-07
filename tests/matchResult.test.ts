import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { completeMatch } from '../src/matchResult.js';
import { upsertPlayer } from '../src/players.js';
import type { Dump } from '../src/dumpParse.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);

function seedLiveMatch(db: DB): number {
  for (const id of IDS) upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
  const matchId = Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'no_mercy')").run().lastInsertRowid,
  );
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  return matchId;
}

function dumpFor(matchId: number): Dump {
  return {
    matchId,
    maps: [
      { map: 'l4d_hospital01_apartment', a: 100, b: 150 },
      { map: 'l4d_hospital02_subway', a: 120, b: 160 },
    ],
    players: IDS.map((steamid, i) => ({
      steamid, team: i < 4 ? 'a' : 'b', sidmg: 1000 + i, sikill: i, ck: 200 + i, ff: 10 + i, rev: i % 3,
    })),
    skillDetect: false,
    skills: [],
    winner: 'b',
    totalA: 220,
    totalB: 310,
  };
}

describe('completeMatch', () => {
  let db: DB;
  let matchId: number;
  beforeEach(() => { db = openDb(':memory:'); matchId = seedLiveMatch(db); });

  it('persists match result, per-map scores, per-player stats, and ratings in one go', () => {
    expect(completeMatch(db, matchId, dumpFor(matchId))).toBe(true);
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as any;
    expect(m.state).toBe('completed');
    expect(m.team_a_score).toBe(220);
    expect(m.team_b_score).toBe(310);
    expect(m.winner).toBe('b');
    expect(m.ended_at).toBeTruthy();
    const maps = db.prepare('SELECT * FROM match_maps WHERE match_id = ? ORDER BY ordinal').all(matchId) as any[];
    expect(maps).toHaveLength(2);
    expect(maps[0]).toMatchObject({ ordinal: 0, map: 'l4d_hospital01_apartment', team_a_score: 100, team_b_score: 150 });
    const mp = db.prepare('SELECT * FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, IDS[0]) as any;
    expect(mp.si_damage).toBe(1000);
    expect(JSON.parse(mp.stats_json).sidmg).toBe('1000');
    // ratings applied
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 8 });
    const winner = db.prepare('SELECT * FROM player_ratings WHERE player_id = ?').get(IDS[4]) as any;
    expect(winner.wins).toBe(1);
  });

  it('refuses already-completed or aborted matches', () => {
    completeMatch(db, matchId, dumpFor(matchId));
    expect(completeMatch(db, matchId, dumpFor(matchId))).toBe(false);
    const other = seedLiveMatch(db); // fresh match, then abort it
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(other);
    expect(completeMatch(db, other, dumpFor(other))).toBe(false);
  });

  it('rolls back atomically when a mid-transaction write fails', () => {
    // Pre-insert a conflicting match_maps row (same match_id + ordinal 0) so the
    // transaction's own INSERT for ordinal 0 hits the PRIMARY KEY and throws.
    db.prepare(
      'INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, 0, ?, 0, 0)',
    ).run(matchId, 'conflict_placeholder');

    expect(() => completeMatch(db, matchId, dumpFor(matchId))).toThrow();

    const m = db.prepare('SELECT state, ended_at FROM matches WHERE id = ?').get(matchId) as any;
    expect(m.state).toBe('live');
    expect(m.ended_at).toBeNull();
    // Only the pre-existing conflict row remains. Nothing from completeMatch was inserted.
    const maps = db.prepare('SELECT COUNT(*) n FROM match_maps WHERE match_id = ?').get(matchId) as any;
    expect(maps.n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 0 });
    const mp = db.prepare('SELECT si_damage FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, IDS[0]) as any;
    expect(mp.si_damage).toBe(0); // player stat update also rolled back

    // Clear the conflict and retry. completeMatch should now succeed cleanly.
    db.prepare('DELETE FROM match_maps WHERE match_id = ? AND ordinal = 0').run(matchId);
    expect(completeMatch(db, matchId, dumpFor(matchId))).toBe(true);
    const m2 = db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as any;
    expect(m2.state).toBe('completed');
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 8 });
  });

  it('persists skill stats keyed by roster slot', () => {
    const d: Dump = { ...dumpFor(matchId), skillDetect: true, skills: [
      { steamid: IDS[0], stats: { skeets: 2, tank_damage: 1699 } },
    ] };
    expect(completeMatch(db, matchId, d)).toBe(true);
    const rows = db.prepare(
      'SELECT stat, value FROM match_player_stats WHERE match_id = ? AND player_id = ? ORDER BY stat',
    ).all(matchId, IDS[0]);
    expect(rows).toEqual([{ stat: 'skeets', value: 2 }, { stat: 'tank_damage', value: 1699 }]);
  });

  it('writes no skill-detect stats when skilldetect was 0, but still writes native ones', () => {
    const d: Dump = { ...dumpFor(matchId), skillDetect: false, skills: [
      { steamid: IDS[0], stats: { skeets: 9, tank_damage: 500 } },
    ] };
    completeMatch(db, matchId, d);
    expect(db.prepare(
      "SELECT value FROM match_player_stats WHERE match_id = ? AND stat = 'skeets'",
    ).all(matchId)).toEqual([]);
    // tank_damage does not need skill_detect, so it survives.
    expect(db.prepare(
      "SELECT value FROM match_player_stats WHERE match_id = ? AND stat = 'tank_damage'",
    ).get(matchId)).toEqual({ value: 500 });
  });

  it('skips skill stats for a steamid not on the roster instead of throwing', () => {
    const d: Dump = { ...dumpFor(matchId), skillDetect: true, skills: [
      { steamid: '76561199999999999', stats: { skeets: 3 } },
    ] };
    // Must not throw: foreign_keys is ON, so an unguarded insert would abort the
    // whole completion transaction and lose the match result.
    expect(() => completeMatch(db, matchId, d)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_player_stats').get()).toEqual({ n: 0 });
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as any).state).toBe('completed');
  });
});
