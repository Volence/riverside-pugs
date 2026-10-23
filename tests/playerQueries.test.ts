import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { leaderboardData, profileData } from '../src/playerQueries.js';
import { setSetting } from '../src/settings.js';
import { ME, OTHER, seedMatch } from './playerStats.test.js';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: ME, name: 'me', avatar: null }, []);
  upsertPlayer(db, { steamid: OTHER, name: 'them', avatar: null }, []);
});

describe('profileData byMap campaign labels', () => {
  it('tells each by-map row which campaign it belongs to', () => {
    // seed a completed match on a dlc4 map and one on a stock map
    seedMatch(db, 1, [{ map: 'c1m2_streets', a: 1, b: 0 }], {});
    seedMatch(db, 2, [{ map: 'l4d_vs_hospital01_apartment', a: 1, b: 0 }], {});
    const got = profileData(db, ME, null)!.byMap;
    const dc = got.find((r) => r.map === 'c1m2_streets');
    expect(dc?.campaignName).toBe('Dead Center');
    const nm = got.find((r) => r.map === 'l4d_vs_hospital01_apartment');
    expect(nm?.campaignName).toBe('No Mercy');
  });

  // An unattributable map must not break the row or invent a campaign.
  it('leaves campaignName null for a map it cannot place', () => {
    seedMatch(db, 1, [{ map: 'de_dust2', a: 1, b: 0 }], {});
    const got = profileData(db, ME, null)!.byMap;
    expect(got.find((r) => r.map === 'de_dust2')?.campaignName).toBeNull();
  });
});

// Owner 2026-10-23: the leaderboard reads stats per game, so each row carries
// its completed-PUG count and the board its per-game minimum.
describe('leaderboardData per-game inputs', () => {
  it('sends statGames per row and the standing_min_games gate', () => {
    seedMatch(db, 1, [{ map: 'l4d_vs_hospital01_apartment', a: 1, b: 0 }], {});
    seedMatch(db, 2, [{ map: 'l4d_vs_hospital01_apartment', a: 1, b: 0 }], {});
    db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma, wins, losses) VALUES (?, 1, 25, 8, 2, 0)').run(ME);
    setSetting(db, 'standing_min_games', '7');
    const lb = leaderboardData(db, 1)!;
    expect(lb.statMinGames).toBe(7);
    const me = lb.rows.find((r) => r.steamid === ME)!;
    expect(me.statGames).toBe(2);
    expect(me.stats).not.toHaveProperty('statGames');
  });
});
