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
});
