import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { seedPlayers, seedMatch, seedRating, type SeedMatch } from './weeklyFixtures.js';
import { setSetting } from '../src/settings.js';
import { leaderboardData, profileData } from '../src/playerQueries.js';
import { playerStandings } from '../src/standings.js';
import { listSeasons } from '../src/seasons.js';
import { playerMapBreakdown, mapIndex, mapDetail } from '../src/playerStats.js';
import { endorsementSummary, allTitles, type EndorseKind } from '../src/endorsements.js';
import { chemistryFor } from '../src/chemistry.js';
import { searchPlayers } from '../src/admin/players.js';

let db: DB;
let ids: string[];

/** Distinct per-player si_damage so playerStandings does not start as an
 *  8-way tie: id0 sits mid-pack (two players ahead of it) at baseline, which
 *  leaves room for `lines(boost)` to move its rank later. Every other fixed
 *  stat stays uniform; only sidmg needs to distinguish players here. */
const BASE_SIDMG = [140, 160, 150, 130, 120, 110, 100, 90];

/** One line per seeded player. `boostP0`, when given, overrides player 0's
 *  si_damage for this match only, so a single extra match can move id0's own
 *  standing without disturbing anyone else's totals. */
function lines(boostP0?: number) {
  return ids.map((id, i) => ({
    id, team: (i < 4 ? 'a' : 'b') as 'a' | 'b',
    fixed: {
      si_damage: i === 0 && boostP0 !== undefined ? boostP0 : BASE_SIDMG[i],
      si_kills: 5, common_kills: 20, revives: 1, ff_dealt: 3,
    },
    stats: { skeets: 2 },
  }));
}

/**
 * seedMatch, plus:
 *  - a match_maps row, so mapIndex/mapDetail (which join match_maps rather
 *    than reading matches.campaign) have something to see. Without this
 *    every seeded match is invisible to those two functions and the
 *    snapshot's map fields would stay blind to kind, hiding a real bug.
 *  - a rating_history row per player, but ONLY for a 'pug' match: that is
 *    what real match completion writes (Task 2: applyMatchRatings refuses
 *    scrims/tournaments), and leaderboardData/playerStandings both size their
 *    "games played" off this table. Seeding it for every kind would make the
 *    scrim/tournament cases pass for the wrong reason.
 */
function seedMatchWithMap(db: DB, o: SeedMatch): number {
  const id = seedMatch(db, o);
  db.prepare(
    'INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, 1, ?, ?, ?)',
  ).run(id, o.campaign ?? 'no_mercy', o.a ?? 500, o.b ?? 400);
  if ((o.kind ?? 'pug') === 'pug') {
    for (const pid of ids) seedRating(db, id, pid, [25, 8.33], [25, 8.33]);
  }
  return id;
}

function seedEndorsement(db: DB, matchId: number, fromId: string, toId: string, kind: EndorseKind): void {
  db.prepare(
    'INSERT INTO endorsements (match_id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(matchId, fromId, toId, kind, '2026-09-20 12:00:00');
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

  // player_ratings rows are what make leaderboardData.rows and
  // playerStandings' ranked gate non-empty in the first place. Real code
  // writes these from applyMatchRatings; this fixture inserts them directly
  // since match completion is not what this test exercises.
  const ratingsIns = db.prepare(
    'INSERT INTO player_ratings (player_id, season_id, mu, sigma, wins, losses) VALUES (?, 1, 25, 8.33, 1, 1)',
  );
  for (const pid of ids) ratingsIns.run(pid);

  // Lowered from the real defaults (STANDING_MIN_GAMES_DEFAULT = 10) so two
  // seeded matches are enough for id0 to clear the badge gate and actually
  // reach the converted queries at standings.ts:72/78, instead of
  // short-circuiting at the empty-object return on standings.ts:64.
  setSetting(db, 'standing_min_games', '2');
  // Lowered similarly (real defaults: 5 endorsements over 10 games) so one
  // endorsement over two matches already earns a title.
  setSetting(db, 'endorse_title_min', '1');
  setSetting(db, 'endorse_title_min_games', '1');

  const pugMatchId = seedMatchWithMap(db, { endedAt: '2026-09-20 12:00:00', lines: lines() });
  seedMatchWithMap(db, { endedAt: '2026-09-20 14:00:00', voided: true, lines: lines() });

  // One endorsement on the completed PUG so endorsementSummary/allTitles
  // start non-trivial (id0 already holds a title). Without this, every count
  // and the games denominator they feed stay at zero no matter which matches
  // are visible to them, and the converted filters at endorsements.ts:185/191
  // would never actually be exercised by this test.
  seedEndorsement(db, pugMatchId, ids[1], ids[0], 'caller');
});

describe('PUG aggregates ignore scrims and tournament matches', () => {
  it.each(['scrim', 'tournament'] as const)('a completed %s changes nothing PUG-facing', (kind) => {
    const before = snapshot();
    // Boosted (2000) rather than plain lines(): every fixed/skill query here
    // is a PER-MATCH RATE (sum / matches played), and a same-shaped extra
    // match leaves that rate unchanged whether or not it is wrongly counted,
    // which would let a broken kind filter through undetected. A wildly
    // different total perturbs the rate detectably if it leaks in.
    const id = seedMatchWithMap(db, {
      endedAt: '2026-09-21 12:00:00', kind, visibility: kind === 'scrim' ? 'participants' : 'public', lines: lines(2000),
    });
    // Also try to endorse through it: if endorsements.ts's kind filter ever
    // regresses, this is what would leak an extra count/title change.
    seedEndorsement(db, id, ids[2], ids[0], 'caller');
    expect(snapshot()).toEqual(before);
  });

  it('a second PUG does change them (the snapshot is sensitive), field by field', () => {
    const before = snapshot();
    const id = seedMatchWithMap(db, { endedAt: '2026-09-21 12:00:00', lines: lines(1000) });
    // A second endorsement of a DIFFERENT kind on this match ties caller vs.
    // clutch at 1-1, which deterministically flips id0's title from 'caller'
    // to null (titleFromCounts refuses a tie: src/endorsements.ts). That
    // exercises endorse.title and the allTitles map (titles) together,
    // instead of leaving an untouched endorsements table frozen.
    seedEndorsement(db, id, ids[3], ids[0], 'clutch');
    const after = snapshot();

    // Asserted per key, not as one object, because a whole-object
    // "not.toEqual" can pass even when most fields never moved: it only
    // takes ONE sensitive field (e.g. breakdown, which needs no seeding at
    // all) to make the aggregate object differ, while leaderboard.rows,
    // standings and endorse/titles stayed structurally frozen (empty array,
    // {}, all-zero counts) and so never actually exercised the converted
    // queries this test exists to protect. Every key below is expected to
    // move; none is excluded.
    for (const key of Object.keys(before) as (keyof ReturnType<typeof snapshot>)[]) {
      expect(after[key], `expected snapshot key "${key}" to change after a second PUG`).not.toEqual(before[key]);
    }
  });
});
