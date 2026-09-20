import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, ensureRating, currentSeasonId } from '../src/players.js';
import { mergePlayers } from '../src/mergePlayers.js';

const MAIN = '76561198005192652';
const ALT = '76561199861598482';
const OTHER = '76561197972484944';

let db: DB;

function match(id: number, state = 'completed'): void {
  db.prepare(
    "INSERT INTO matches (id, season_id, state, campaign, winner, ended_at) VALUES (?, 1, ?, 'dead_air', 'a', ?)",
  ).run(id, state, `2026-09-2${id} 00:00:00`);
}
function rosters(matchId: number, player: string, team: 'a' | 'b', stats: Partial<Record<string, number>> = {}): void {
  db.prepare(
    `INSERT INTO match_players (match_id, player_id, team, si_damage, si_kills, common_kills, ff_dealt, revives, joined_map)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(matchId, player, team, stats.si_damage ?? 0, stats.si_kills ?? 0, stats.common_kills ?? 0, stats.ff_dealt ?? 0, stats.revives ?? 0);
}
function stat(matchId: number, player: string, key: string, value: number): void {
  db.prepare('INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, ?, ?)')
    .run(matchId, player, key, value);
}

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [MAIN, ALT, OTHER]) upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []);
  for (const id of [MAIN, ALT, OTHER]) ensureRating(db, id);
});

describe('mergePlayers', () => {
  it('refuses to merge an account into itself, or an id it has never seen', () => {
    expect(() => mergePlayers(db, { from: MAIN, into: MAIN })).toThrow(/same/i);
    expect(() => mergePlayers(db, { from: '76561199999999999', into: MAIN })).toThrow(/not found/i);
    expect(() => mergePlayers(db, { from: ALT, into: '76561199999999999' })).toThrow(/not found/i);
  });

  it('moves a match only the alt played onto the main', () => {
    match(1);
    rosters(1, ALT, 'b', { si_damage: 3509, si_kills: 20, common_kills: 162, revives: 1 });
    stat(1, ALT, 'skeets', 4);

    mergePlayers(db, { from: ALT, into: MAIN });

    const row = db.prepare('SELECT * FROM match_players WHERE match_id = 1').get() as any;
    expect(row.player_id).toBe(MAIN);
    expect(row.si_damage).toBe(3509);
    expect((db.prepare('SELECT value FROM match_player_stats WHERE match_id = 1 AND player_id = ?').get(MAIN) as any).value).toBe(4);
  });

  // The shape match 65 actually had: both accounts rostered on the same team,
  // one of them a ghost that never connected and scored nothing.
  it('collapses a match both accounts were rostered in, summing their figures', () => {
    match(1);
    rosters(1, MAIN, 'b', { si_damage: 0, si_kills: 0, common_kills: 0, revives: 0 });
    rosters(1, ALT, 'b', { si_damage: 3509, si_kills: 20, common_kills: 162, revives: 1 });
    stat(1, MAIN, 'skeets', 0);
    stat(1, ALT, 'skeets', 7);

    mergePlayers(db, { from: ALT, into: MAIN });

    const rows = db.prepare('SELECT * FROM match_players WHERE match_id = 1').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].player_id).toBe(MAIN);
    expect(rows[0].si_damage).toBe(3509);
    expect(rows[0].si_kills).toBe(20);
    expect(rows[0].common_kills).toBe(162);
    expect(rows[0].revives).toBe(1);

    const stats = db.prepare('SELECT player_id, value FROM match_player_stats WHERE match_id = 1').all() as any[];
    expect(stats).toEqual([{ player_id: MAIN, value: 7 }]);
  });

  it('leaves the team it plays for alone and never touches anyone else', () => {
    match(1);
    rosters(1, OTHER, 'a', { si_damage: 100 });
    rosters(1, ALT, 'b', { si_damage: 200 });
    mergePlayers(db, { from: ALT, into: MAIN });

    const rows = db.prepare('SELECT player_id, team, si_damage FROM match_players WHERE match_id = 1 ORDER BY team').all() as any[];
    expect(rows).toEqual([
      { player_id: OTHER, team: 'a', si_damage: 100 },
      { player_id: MAIN, team: 'b', si_damage: 200 },
    ]);
  });

  it('deletes the alt entirely: no player row, no rating, no history', () => {
    match(1);
    rosters(1, ALT, 'b');
    mergePlayers(db, { from: ALT, into: MAIN });

    expect(db.prepare('SELECT 1 FROM players WHERE steamid = ?').get(ALT)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM player_ratings WHERE player_id = ?').get(ALT)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM rating_history WHERE player_id = ?').get(ALT)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM match_players WHERE player_id = ?').get(ALT)).toBeUndefined();
  });

  // The reason the merge exists at all: two ratings for one person, and four
  // matches scored as five-a-side.
  it('recomputes the season so the merged player holds exactly one rating', () => {
    match(1);
    rosters(1, MAIN, 'a');
    rosters(1, ALT, 'a');
    rosters(1, OTHER, 'b');

    mergePlayers(db, { from: ALT, into: MAIN });

    const ratings = db.prepare('SELECT player_id FROM player_ratings WHERE season_id = ? ORDER BY player_id')
      .all(currentSeasonId(db)) as any[];
    expect(ratings.map((r) => r.player_id)).toEqual([MAIN, OTHER].sort());
    // Rebuilt from the merged rosters, so the win is counted once.
    const hist = db.prepare('SELECT COUNT(*) AS n FROM rating_history WHERE player_id = ?').get(MAIN) as any;
    expect(hist.n).toBe(1);
  });

  it('carries scratch and audit rows across, and drops a duplicate rather than failing', () => {
    match(1, 'live');
    db.prepare('INSERT INTO match_live_players (match_id, player_id, stats_json) VALUES (1, ?, ?)').run(MAIN, '{}');
    db.prepare('INSERT INTO match_live_players (match_id, player_id, stats_json) VALUES (1, ?, ?)').run(ALT, '{"skeets":3}');
    db.prepare("INSERT INTO match_chat (match_id, seq, map_ordinal, half, t_ms, steamid, team, message) VALUES (1,1,0,1,0,?,'b','hi')").run(ALT);

    expect(() => mergePlayers(db, { from: ALT, into: MAIN })).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_live_players WHERE match_id = 1').get() as any).toEqual({ n: 1 });
    expect((db.prepare('SELECT steamid FROM match_chat').get() as any).steamid).toBe(MAIN);
  });

  it('reports what it moved, so a dry run can be read before it is committed', () => {
    match(1);
    rosters(1, ALT, 'b');
    stat(1, ALT, 'skeets', 2);
    const plan = mergePlayers(db, { from: ALT, into: MAIN, dryRun: true });

    expect(plan.matchesMoved).toBe(1);
    expect(plan.rowsByTable.match_players).toBe(1);
    expect(plan.rowsByTable.match_player_stats).toBe(1);
    // Nothing actually changed.
    expect(db.prepare('SELECT 1 FROM players WHERE steamid = ?').get(ALT)).toBeTruthy();
    expect((db.prepare('SELECT player_id FROM match_players WHERE match_id = 1').get() as any).player_id).toBe(ALT);
  });
});
