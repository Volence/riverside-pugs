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
  /** A round of `id` on map `ordinal`, with `surv` playing survivors. */
  function seedRound(
    id: number, ordinal: number, half: number, surv: 'a' | 'b', alive: number | null,
  ): void {
    db.prepare(
      `INSERT INTO match_rounds
         (match_id, ordinal, half, surv_team, score, reliable, started_at, ended_at, survivors_alive)
       VALUES (?, ?, ?, ?, 100, 1, '2026-09-20 00:00:00', '2026-09-20 00:02:00', ?)`,
    ).run(id, ordinal, half, surv, alive);
  }

  // Worst first: the reason to read this list is to find the maps you lose on,
  // and putting those at the top is the whole point of sorting it at all.
  it('orders maps by win rate, weakest first, rather than by games played', () => {
    seedMatch(1, [{ map: 'strong', a: 9, b: 1 }, { map: 'weak', a: 1, b: 9 }], {});
    seedMatch(2, [{ map: 'strong', a: 9, b: 1 }], {});
    const rows = playerMapBreakdown(db, ME);
    expect(rows.map((r) => r.map)).toEqual(['weak', 'strong']);
    // and not by games, which would have put `strong` (2) ahead of `weak` (1)
    expect(rows[0].wins).toBe(0);
    expect(rows[1].games).toBe(2);
  });

  it('counts survival only for the halves this player played as survivor', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {}, 'a');
    seedRound(1, 0, 1, 'a', 3);  // mine, survived
    seedRound(1, 0, 2, 'b', 4);  // the other team's half, not mine
    const row = playerMapBreakdown(db, ME).find((r) => r.map === 'airport01')!;
    expect(row.survivalMeasured).toBe(1);
    expect(row.survived).toBe(1);
  });

  it('counts a wipe against you and ignores an unmeasured round', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {}, 'a');
    seedRound(1, 0, 1, 'a', 0);     // mine, wiped
    seedRound(1, 0, 2, 'a', null);  // mine, never measured
    const row = playerMapBreakdown(db, ME).find((r) => r.map === 'airport01')!;
    expect(row.survivalMeasured).toBe(1);
    expect(row.survived).toBe(0);
  });

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
    // (300 + 100 + 100 + 300) / (2 playings * 2 teams)
    expect(d.avgScore).toBe(200);

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
    // Only match 1 is recorded: (300 + 100) / 2.
    expect(d.avgScore).toBe(200);
    expect(d.players.find((p) => p.steamid === ME)).toMatchObject({ games: 2, wins: 1, losses: 0 });
  });

  it('reports the average as unknown, not 0, when no playing of the map was recorded', () => {
    seedMatch(1, [{ map: 'airport01', a: 0, b: 0 }], {});
    seedRounds(1, 0, false);
    const d = mapDetail(db, 'airport01')!;
    expect(d.played).toBe(1);
    expect(d.avgScore).toBeNull();
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
    expect(first).toMatchObject({ played: 2, campaign: 'dead_air', avgScore: 200 });
  });

  it('averages only recorded playings, and says so with null when there are none', () => {
    seedMatch(1, [{ map: 'l4d_vs_airport01_greenhouse', a: 300, b: 100 }], {});
    seedMatch(2, [{ map: 'l4d_vs_airport01_greenhouse', a: 0, b: 0 }], {});
    seedRounds(2, 0, false);
    seedMatch(3, [{ map: 'l4d_vs_airport02_offices', a: 0, b: 0 }], {});
    seedRounds(3, 0, false);

    const idx = mapIndex(db);
    expect(idx.find((r) => r.map === 'l4d_vs_airport01_greenhouse'))
      .toMatchObject({ played: 2, avgScore: 200 });
    expect(idx.find((r) => r.map === 'l4d_vs_airport02_offices'))
      .toMatchObject({ played: 1, avgScore: null });
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

describe('combined team averages', () => {
  it('reports one average survivor score rather than a per-team pair', () => {
    // team_a_score on a map is that team's score WHILE THEY HELD SURVIVOR, so
    // A and B are two samples of the same quantity, not two rivals. The old
    // avgTeamA/avgTeamB pair printed half the sample each and invited a
    // comparison between arbitrary labels that balanceTeams assigns.
    seedMatch(1, [{ map: 'airport01', a: 200, b: 400 }], {});
    seedRounds(1, 0);
    expect(mapDetail(db, 'airport01')!.avgScore).toBe(300);
  });

  it('averages over every half played, not every match', () => {
    seedMatch(1, [{ map: 'airport01', a: 100, b: 200 }], {});
    seedRounds(1, 0);
    seedMatch(2, [{ map: 'airport01', a: 300, b: 400 }], {});
    seedRounds(2, 0);
    // (100 + 200 + 300 + 400) / 4 halves
    expect(mapDetail(db, 'airport01')!.avgScore).toBe(250);
  });

  it('leaves the average null when no playing was recorded', () => {
    seedMatch(1, [{ map: 'airport01', a: 0, b: 0 }], {});
    seedRounds(1, 0, false);
    expect(mapDetail(db, 'airport01')!.avgScore).toBeNull();
  });

  it('gives mapIndex the same combined average', () => {
    seedMatch(1, [{ map: 'airport01', a: 200, b: 400 }], {});
    seedRounds(1, 0);
    expect(mapIndex(db).find((r) => r.map === 'airport01')!.avgScore).toBe(300);
  });
});

describe('per-map averages', () => {
  it('divides a player total by the maps they played', () => {
    // Cumulative snapshots: 100 then 300 means the second map contributed 200.
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }, { map: 'airport01', a: 1, b: 0 }], {
      0: { [ME]: { ck: 100 } },
      1: { [ME]: { ck: 300 } },
    });
    seedRounds(1, 0);
    seedRounds(1, 1);
    const row = playerMapBreakdown(db, ME)[0];
    expect(row.games).toBe(2);
    expect(row.stats.ck).toBe(300);
    expect(row.avgStats.ck).toBe(150);
  });

  it('averages every stat, not a chosen few', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }, { map: 'airport01', a: 1, b: 0 }], {
      0: { [ME]: { ck: 10, sidmg: 500, tank_damage: 40 } },
      1: { [ME]: { ck: 30, sidmg: 700, tank_damage: 60 } },
    });
    seedRounds(1, 0);
    seedRounds(1, 1);
    // Diffed: ck 10 then 20, sidmg 500 then 200, tank 40 then 20.
    const row = playerMapBreakdown(db, ME)[0];
    expect(row.avgStats).toMatchObject({ ck: 15, sidmg: 350, tank_damage: 30 });
  });

  it('omits an average for a stat that was never measured', () => {
    // Absent must stay absent: a zero average would claim the player did the
    // thing badly rather than that nobody recorded it.
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {});
    seedRounds(1, 0);
    expect(playerMapBreakdown(db, ME)[0].avgStats).toEqual({});
  });

  it('gives the map page a per-player average too', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }, { map: 'airport01', a: 1, b: 0 }], {
      0: { [ME]: { ck: 100 } },
      1: { [ME]: { ck: 300 } },
    });
    seedRounds(1, 0);
    seedRounds(1, 1);
    const me = mapDetail(db, 'airport01')!.players.find((p) => p.steamid === ME)!;
    expect(me.stats.ck).toBe(300);
    expect(me.avgStats.ck).toBe(150);
  });

  it('gives the map an overall average across everyone who played it', () => {
    // "What does anyone usually get here", the map's own baseline, as opposed
    // to any one player's.
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {
      0: { [ME]: { ck: 100 }, [OTHER]: { ck: 200 } },
    });
    seedRounds(1, 0);
    expect(mapDetail(db, 'airport01')!.avgStats.ck).toBe(150);
  });
});

describe('a player who joined partway through a match', () => {
  it('is not credited maps that were played before they arrived', () => {
    // joined_map is the ordinal a sub was rostered on. Totals hid this,
    // because their contribution to the earlier maps really is zero; an
    // average exposes it by dividing by maps they never played.
    seedMatch(1, [
      { map: 'airport01', a: 1, b: 0 }, { map: 'airport02', a: 1, b: 0 },
      { map: 'airport03', a: 1, b: 0 }, { map: 'airport04', a: 1, b: 0 },
    ], { 2: { [ME]: { ck: 100 } }, 3: { [ME]: { ck: 200 } } });
    for (let i = 0; i < 4; i++) seedRounds(1, i);
    db.prepare('UPDATE match_players SET joined_map = 2 WHERE match_id = 1 AND player_id = ?').run(ME);

    const rows = playerMapBreakdown(db, ME);
    expect(rows.map((r) => r.map).sort()).toEqual(['airport03', 'airport04']);
    expect(rows.find((r) => r.map === 'airport03')!.avgStats.ck).toBe(100);
  });

  it('is left off the map page for maps played before they arrived', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }, { map: 'airport02', a: 1, b: 0 }], {});
    seedRounds(1, 0);
    seedRounds(1, 1);
    db.prepare('UPDATE match_players SET joined_map = 1 WHERE match_id = 1 AND player_id = ?').run(ME);
    expect(mapDetail(db, 'airport01')!.players.map((p) => p.steamid)).toEqual([OTHER]);
    expect(mapDetail(db, 'airport02')!.players.map((p) => p.steamid).sort()).toEqual([ME, OTHER].sort());
  });

  it('still counts the map as played for everyone who was there from the start', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {});
    seedRounds(1, 0);
    expect(mapDetail(db, 'airport01')!.played).toBe(1);
  });
});

describe('map round aggregates', () => {
  /** A closed half with an explicit duration and survival reading. */
  /** `at` defaults to after SURVIVAL_TRUSTED_FROM, so a round counts towards
   *  survival unless a test deliberately backdates it. */
  function seedHalf(
    id: number, ordinal: number, half: number,
    opts: { seconds: number; alive: number | null; reliable?: boolean; at?: string },
  ): void {
    const at = opts.at ?? '2026-09-20 00:00:00';
    db.prepare(
      `INSERT INTO match_rounds
         (match_id, ordinal, half, surv_team, score, reliable, started_at, ended_at, survivors_alive)
       VALUES (?, ?, ?, 'a', 100, ?, ?,
               datetime(?, '+' || ? || ' seconds'), ?)`,
    ).run(id, ordinal, half, opts.reliable === false ? 0 : 1, at, at, opts.seconds, opts.alive);
  }

  it('reports fastest, average and slowest round in seconds', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {});
    seedHalf(1, 0, 1, { seconds: 120, alive: 2 });
    seedHalf(1, 0, 2, { seconds: 300, alive: 0 });
    const d = mapDetail(db, 'airport01')!;
    expect(d.rounds).toMatchObject({ fastestSec: 120, slowestSec: 300, avgSec: 210, attempts: 2 });
  });

  it('computes survival rate from the survivor count, counting a wipe as a loss', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {});
    seedHalf(1, 0, 1, { seconds: 100, alive: 3 });
    seedHalf(1, 0, 2, { seconds: 100, alive: 0 });
    expect(mapDetail(db, 'airport01')!.rounds.survivalPct).toBe(50);
  });

  it('leaves survival null when no round was measured, rather than calling it 0%', () => {
    // Every round played before the plugin emitted alive= has survivors_alive
    // NULL. Treating those as wipes would report every historic map as lethal.
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {});
    seedHalf(1, 0, 1, { seconds: 100, alive: null });
    seedHalf(1, 0, 2, { seconds: 100, alive: null });
    const d = mapDetail(db, 'airport01')!;
    expect(d.rounds.survivalPct).toBeNull();
    // Timing is independent and still known.
    expect(d.rounds.avgSec).toBe(100);
  });

  // Rounds from before the 2026-09-18 fix counted INCAPACITATED, PINNED and
  // LEDGED players as alive, so a wipe read as a survival. They are repaired
  // in place from their replay's final frame by
  // scripts/repair-survivors-alive.ts rather than excluded, since every
  // measured round has a replay and the frames carry those states. So this
  // layer has no cutoff: whatever is stored is taken at face value.
  it('counts an old round the same as a new one, since the data is repaired in place', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {});
    seedHalf(1, 0, 1, { seconds: 100, alive: 0, at: '2026-09-14 00:00:00' });
    seedHalf(1, 0, 2, { seconds: 100, alive: 2 });
    const d = mapDetail(db, 'airport01')!;
    expect(d.rounds.measured).toBe(2);
    expect(d.rounds.survivalPct).toBe(50);
  });

  it('counts only the rounds it could measure towards survival', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {});
    seedHalf(1, 0, 1, { seconds: 100, alive: 4 });
    seedHalf(1, 0, 2, { seconds: 100, alive: null });
    // One measured round, survived: 100%, not 50%.
    expect(mapDetail(db, 'airport01')!.rounds.survivalPct).toBe(100);
  });

  it('ignores an unreliable round entirely', () => {
    // Same rule the scores already use: a round the plugin could not attribute
    // is not an observation.
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {});
    seedHalf(1, 0, 1, { seconds: 100, alive: 4 });
    seedHalf(1, 0, 2, { seconds: 9999, alive: 0, reliable: false });
    const d = mapDetail(db, 'airport01')!;
    expect(d.rounds).toMatchObject({ attempts: 1, fastestSec: 100, slowestSec: 100 });
    expect(d.rounds.survivalPct).toBe(100);
  });

  it('reports nulls rather than zeros for a map with no closed rounds', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {});
    const d = mapDetail(db, 'airport01')!;
    expect(d.rounds).toMatchObject({
      attempts: 0, fastestSec: null, avgSec: null, slowestSec: null, survivalPct: null,
    });
  });

  it('skips a round that never closed, so an open one cannot be a 0-second record', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {});
    seedHalf(1, 0, 1, { seconds: 200, alive: 1 });
    db.prepare(
      "INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, reliable, started_at) VALUES (1, 0, 2, 'b', 0, 1, '2026-09-14 00:00:00')",
    ).run();
    expect(mapDetail(db, 'airport01')!.rounds).toMatchObject({ attempts: 1, fastestSec: 200 });
  });

  it('carries the same aggregate on the campaign index', () => {
    seedMatch(1, [{ map: 'airport01', a: 1, b: 0 }], {});
    seedHalf(1, 0, 1, { seconds: 120, alive: 2 });
    seedHalf(1, 0, 2, { seconds: 300, alive: 0 });
    const row = mapIndex(db).find((r) => r.map === 'airport01')!;
    expect(row.rounds).toMatchObject({ attempts: 2, avgSec: 210, survivalPct: 50 });
  });
});
