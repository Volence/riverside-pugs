import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { seedPlayers, seedMatch, type SeedMatch } from './weeklyFixtures.js';
import { leaderboardData, profileData } from '../src/playerQueries.js';
import { playerStandings } from '../src/standings.js';
import { listSeasons } from '../src/seasons.js';
import { playerMapBreakdown, mapIndex, mapDetail } from '../src/playerStats.js';
import { endorsementSummary, allTitles } from '../src/endorsements.js';
import { chemistryFor } from '../src/chemistry.js';
import { searchPlayers } from '../src/admin/players.js';

let db: DB;
let ids: string[];
const lines = () => ids.map((id, i) => ({
  id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b',
  fixed: { si_damage: 100, si_kills: 5, common_kills: 20, revives: 1, ff_dealt: 3 },
  stats: { skeets: 2 },
}));

/** seedMatch plus a match_maps row, so mapIndex/mapDetail (which join
 *  match_maps rather than reading matches.campaign) have something to see.
 *  Without this every seeded match is invisible to those two functions and
 *  the snapshot's map fields would stay blind to kind, hiding a real bug. */
function seedMatchWithMap(db: DB, o: SeedMatch): number {
  const id = seedMatch(db, o);
  db.prepare(
    'INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, 1, ?, ?, ?)',
  ).run(id, o.campaign ?? 'no_mercy', o.a ?? 500, o.b ?? 400);
  return id;
}

/** Every aggregate we care about, as one comparable snapshot. */
function snapshot() {
  return {
    leaderboard: leaderboardData(db, 1),
    profile: profileData(db, ids[0], null),
    standings: playerStandings(db, 1, ids[0]),
    seasons: listSeasons(db),
    breakdown: playerMapBreakdown(db, ids[0]),
    mapIndex: mapIndex(db),
    mapDetail: mapDetail(db, 'no_mercy'),
    endorse: endorsementSummary(db, ids[0]),
    titles: [...allTitles(db).entries()],
    chemistry: chemistryFor(db, ids[0]),
    search: searchPlayers(db, ''),
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  ids = seedPlayers(db, 8);
  seedMatchWithMap(db, { endedAt: '2026-09-20 12:00:00', lines: lines() });
  seedMatchWithMap(db, { endedAt: '2026-09-20 14:00:00', voided: true, lines: lines() });
});

describe('PUG aggregates ignore scrims and tournament matches', () => {
  it.each(['scrim', 'tournament'] as const)('a completed %s changes nothing PUG-facing', (kind) => {
    const before = snapshot();
    seedMatchWithMap(db, { endedAt: '2026-09-21 12:00:00', kind, visibility: kind === 'scrim' ? 'participants' : 'public', lines: lines() });
    expect(snapshot()).toEqual(before);
  });

  it('a second PUG does change them (the snapshot is sensitive)', () => {
    const before = snapshot();
    seedMatchWithMap(db, { endedAt: '2026-09-21 12:00:00', lines: lines() });
    expect(snapshot()).not.toEqual(before);
  });
});
