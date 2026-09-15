import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { playerMapBreakdown, mapDetail, mapIndex } from '../src/playerStats.js';

const ME = '76561198000000001';
const OTHER = '76561198000000002';

let db: DB;

/** A completed match with per-map scores and end-of-map stat snapshots. */
function seedMatch(
  id: number,
  maps: { map: string; a: number; b: number }[],
  snapshots: Record<number, Record<string, Record<string, number>>>,
  myTeam: 'a' | 'b' = 'a',
): void {
  db.prepare(
    "INSERT INTO matches (id, season_id, state, campaign, team_a_score, team_b_score, winner) VALUES (?, 1, 'completed', 'dead_air', 0, 0, 'a')",
  ).run(id);
  db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(id, ME, myTeam);
  db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)')
    .run(id, OTHER, myTeam === 'a' ? 'b' : 'a');

  maps.forEach((m, i) => {
    db.prepare(
      'INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, ?, ?, ?, ?)',
    ).run(id, i, m.map, m.a, m.b);
  });
  for (const [ordinal, byPlayer] of Object.entries(snapshots)) {
    for (const [pid, stats] of Object.entries(byPlayer)) {
      db.prepare(
        'INSERT INTO match_live_map_stats (match_id, ordinal, player_id, stats_json) VALUES (?, ?, ?, ?)',
      ).run(id, Number(ordinal), pid, JSON.stringify(stats));
    }
  }
}

/** Two closed halves for map `ordinal` of match `id`. `reliable` false marks
 *  half 2 as one the plugin could not attribute, which is the shape match 18
 *  left behind: a score of 0 in match_maps that was never a result. */
function seedRounds(id: number, ordinal: number, reliable = true): void {
  const ins = db.prepare(
    "INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, reliable, ended_at) VALUES (?, ?, ?, ?, ?, ?, '2026-09-14 00:00:00')",
  );
  ins.run(id, ordinal, 1, 'a', 100, 1);
  ins.run(id, ordinal, 2, 'b', 100, reliable ? 1 : 0);
}

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: ME, name: 'me', avatar: null }, []);
  upsertPlayer(db, { steamid: OTHER, name: 'them', avatar: null }, []);
});

describe('playerMapBreakdown', () => {
  it('returns nothing for a player with no completed matches', () => {
    expect(playerMapBreakdown(db, ME)).toEqual([]);
  });

  it('aggregates the same map across different matches', () => {
    // Snapshots are cumulative, so map 2's own stats are the difference.
    seedMatch(1, [{ map: 'airport01', a: 300, b: 100 }], { 0: { [ME]: { ck: 10 } } });
    seedMatch(2, [{ map: 'airport01', a: 200, b: 400 }], { 0: { [ME]: { ck: 4 } } });

    const rows = playerMapBreakdown(db, ME);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ map: 'airport01', games: 2, wins: 1, losses: 1 });
    expect(rows[0].stats.ck).toBe(14);
  });

  it('scores each map from the player own team perspective', () => {
    // Same scoreline, opposite team: a win for one is a loss for the other.
    seedMatch(1, [{ map: 'airport01', a: 300, b: 100 }], {}, 'b');
    expect(playerMapBreakdown(db, ME)[0]).toMatchObject({ wins: 0, losses: 1 });
  });

  it('counts a drawn map as neither a win nor a loss', () => {
    seedMatch(1, [{ map: 'airport01', a: 200, b: 200 }], {});
    expect(playerMapBreakdown(db, ME)[0]).toMatchObject({ games: 1, wins: 0, losses: 0 });
  });

  it('lets a player win maps inside a match they lost overall', () => {
    seedMatch(1, [
      { map: 'airport01', a: 400, b: 100 },
      { map: 'airport02', a: 50, b: 900 },
    ], {});
    const rows = playerMapBreakdown(db, ME);
    expect(rows.find((r) => r.map === 'airport01')).toMatchObject({ wins: 1, losses: 0 });
    expect(rows.find((r) => r.map === 'airport02')).toMatchObject({ wins: 0, losses: 1 });
  });

  it('derives per-map stats as the difference between consecutive snapshots', () => {
    seedMatch(1, [
      { map: 'airport01', a: 1, b: 0 },
      { map: 'airport02', a: 1, b: 0 },
    ], {
      0: { [ME]: { ck: 10, sidmg: 100 } },
      1: { [ME]: { ck: 25, sidmg: 260 } },
    });
    const rows = playerMapBreakdown(db, ME);
    expect(rows.find((r) => r.map === 'airport01')!.stats).toEqual({ ck: 10, sidmg: 100 });
    expect(rows.find((r) => r.map === 'airport02')!.stats).toEqual({ ck: 15, sidmg: 160 });
  });

  it('excludes hp, since summing end-of-map health across maps is meaningless', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], { 0: { [ME]: { hp: 80, ck: 3 } } });
    expect(playerMapBreakdown(db, ME)[0].stats).toEqual({ ck: 3 });
  });

  it('still counts games for a match with no stat snapshots at all', () => {
    // Matches played before per-map capture existed must not vanish from the
    // record; they contribute win/loss with an empty stat bag.
    seedMatch(1, [{ map: 'airport01', a: 300, b: 100 }], {});
    expect(playerMapBreakdown(db, ME)[0]).toMatchObject({ games: 1, wins: 1, stats: {} });
  });

  it('never attributes another player stats to this one', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {
      0: { [ME]: { ck: 5 }, [OTHER]: { ck: 999 } },
    });
    expect(playerMapBreakdown(db, ME)[0].stats.ck).toBe(5);
  });

  it('counts an unrecorded map as played but as neither a win nor a loss', () => {
    // Match 18 shape: the stored 0 for one side is not a result, so the map
    // must not become a win for the other side.
    seedMatch(1, [{ map: 'airport01', a: 300, b: 0 }], { 0: { [ME]: { ck: 7 } } });
    seedRounds(1, 0, false);
    const row = playerMapBreakdown(db, ME)[0];
    expect(row).toMatchObject({ games: 1, wins: 0, losses: 0 });
    // Stats were captured independently of the score and still count.
    expect(row.stats.ck).toBe(7);
  });

  it('orders by games played, most first', () => {
    seedMatch(1, [{ map: 'rare', a: 1, b: 0 }], {});
    seedMatch(2, [{ map: 'common', a: 1, b: 0 }], {});
    seedMatch(3, [{ map: 'common', a: 1, b: 0 }], {});
    expect(playerMapBreakdown(db, ME).map((r) => r.map)).toEqual(['common', 'rare']);
  });
});

describe('mapDetail', () => {
  it('returns null for a map nobody has played', () => {
    expect(mapDetail(db, 'l4d_vs_nowhere')).toBeNull();
  });

  it('aggregates everyone record on one map with average scores', () => {
    seedMatch(1, [{ map: 'airport01', a: 300, b: 100 }], { 0: { [ME]: { ck: 10 } } });
    seedMatch(2, [{ map: 'airport01', a: 100, b: 300 }], { 0: { [ME]: { ck: 6 } } });

    const d = mapDetail(db, 'airport01')!;
    expect(d.played).toBe(2);
    expect(d.avgTeamA).toBe(200);
    expect(d.avgTeamB).toBe(200);

    const mine = d.players.find((p) => p.steamid === ME)!;
    expect(mine).toMatchObject({ games: 2, wins: 1, losses: 1 });
    expect(mine.stats.ck).toBe(16);
  });

  it('includes both teams, scored from each side own perspective', () => {
    seedMatch(1, [{ map: 'airport01', a: 400, b: 50 }], {});
    const d = mapDetail(db, 'airport01')!;
    expect(d.players.find((p) => p.steamid === ME)).toMatchObject({ wins: 1, losses: 0 });
    expect(d.players.find((p) => p.steamid === OTHER)).toMatchObject({ wins: 0, losses: 1 });
  });

  it('ignores matches that are not completed', () => {
    seedMatch(1, [{ map: 'airport01', a: 300, b: 100 }], {});
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = 1").run();
    expect(mapDetail(db, 'airport01')).toBeNull();
  });

  it('leaves an unrecorded map out of the averages and the win/loss columns', () => {
    seedMatch(1, [{ map: 'airport01', a: 300, b: 100 }], {});
    seedMatch(2, [{ map: 'airport01', a: 0, b: 900 }], {});
    seedRounds(2, 0, false);
    const d = mapDetail(db, 'airport01')!;
    // Still played twice: the map happened, only its score is unknown.
    expect(d.played).toBe(2);
    expect(d.avgTeamA).toBe(300);
    expect(d.avgTeamB).toBe(100);
    expect(d.players.find((p) => p.steamid === ME)).toMatchObject({ games: 2, wins: 1, losses: 0 });
  });

  it('reports the average as unknown, not 0, when no playing of the map was recorded', () => {
    seedMatch(1, [{ map: 'airport01', a: 0, b: 0 }], {});
    seedRounds(1, 0, false);
    const d = mapDetail(db, 'airport01')!;
    expect(d.played).toBe(1);
    expect(d.avgTeamA).toBeNull();
    expect(d.avgTeamB).toBeNull();
  });

  it('agrees with playerMapBreakdown for the same player and map', () => {
    // The two views share a source, so they must never disagree.
    seedMatch(1, [{ map: 'airport01', a: 300, b: 100 }], { 0: { [ME]: { ck: 12, sidmg: 300 } } });
    const fromPlayer = playerMapBreakdown(db, ME).find((r) => r.map === 'airport01')!;
    const fromMap = mapDetail(db, 'airport01')!.players.find((p) => p.steamid === ME)!;
    expect(fromMap.stats).toEqual(fromPlayer.stats);
    expect(fromMap.wins).toBe(fromPlayer.wins);
    expect(fromMap.games).toBe(fromPlayer.games);
  });
});

describe('mapIndex', () => {
  it('is empty when nothing has been played', () => {
    expect(mapIndex(db)).toEqual([]);
  });

  it('lists each played map once with its campaign and averages', () => {
    seedMatch(1, [
      { map: 'l4d_vs_airport01_greenhouse', a: 300, b: 100 },
      { map: 'l4d_vs_airport02_offices', a: 100, b: 200 },
    ], {});
    seedMatch(2, [{ map: 'l4d_vs_airport01_greenhouse', a: 100, b: 300 }], {});

    const idx = mapIndex(db);
    expect(idx).toHaveLength(2);
    const first = idx.find((r) => r.map === 'l4d_vs_airport01_greenhouse')!;
    expect(first).toMatchObject({ played: 2, campaign: 'dead_air', avgTeamA: 200, avgTeamB: 200 });
  });

  it('averages only recorded playings, and says so with null when there are none', () => {
    seedMatch(1, [{ map: 'l4d_vs_airport01_greenhouse', a: 300, b: 100 }], {});
    seedMatch(2, [{ map: 'l4d_vs_airport01_greenhouse', a: 0, b: 0 }], {});
    seedRounds(2, 0, false);
    seedMatch(3, [{ map: 'l4d_vs_airport02_offices', a: 0, b: 0 }], {});
    seedRounds(3, 0, false);

    const idx = mapIndex(db);
    expect(idx.find((r) => r.map === 'l4d_vs_airport01_greenhouse'))
      .toMatchObject({ played: 2, avgTeamA: 300, avgTeamB: 100 });
    expect(idx.find((r) => r.map === 'l4d_vs_airport02_offices'))
      .toMatchObject({ played: 1, avgTeamA: null, avgTeamB: null });
  });

  it('leaves campaign null for a map the campaign table does not know', () => {
    // Better than guessing: an unknown map must not be filed under a real
    // campaign just because it was played.
    seedMatch(1, [{ map: 'c5m1_waterfront', a: 1, b: 0 }], {});
    expect(mapIndex(db)[0].campaign).toBeNull();
  });

  it('ignores matches that never completed', () => {
    seedMatch(1, [{ map: 'l4d_vs_airport01_greenhouse', a: 1, b: 0 }], {});
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = 1").run();
    expect(mapIndex(db)).toEqual([]);
  });
});
