import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { profileData } from '../src/playerQueries.js';
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
