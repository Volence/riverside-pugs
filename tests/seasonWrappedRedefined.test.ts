import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { computeWrapped, REDEFINED_STATS, REDEFINED_STATS_FROM_MATCH } from '../src/seasonWrapped.js';
import { setSetting } from '../src/settings.js';
import { seedMatch, seedPlayers } from './weeklyFixtures.js';

/** Owner 2026-10-23: five stats changed definition at match 324, so Wrapped
 *  counts them only from that match on, and their per-match rates divide by
 *  the games from that match on. */

let db: DB;
let ids: string[];

/** The next match gets id `n`: AUTOINCREMENT continues from sqlite_sequence. */
function nextMatchId(n: number): void {
  db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'matches'").run(n - 1);
}

beforeEach(() => {
  db = openDb(':memory:');
  ids = seedPlayers(db, 2);
  // Everyone gets the full deck (signature cards) from one game.
  setSetting(db, 'standing_min_games', '1');
  // sqlite_sequence has no row for matches until the first insert.
  seedMatch(db, { endedAt: '2026-09-20 20:00:00', lines: [] });
});

describe('Wrapped and the stats redefined at match 324', () => {
  it('names the five stats and the match', () => {
    expect(REDEFINED_STATS_FROM_MATCH).toBe(324);
    expect([...REDEFINED_STATS].sort()).toEqual(['biles_landed', 'clears', 'insta_clears', 'self_clears', 'survivors_biled']);
  });

  it('counts a redefined stat only from match 324, and rates it over the games from there', () => {
    const line = (stats: Record<string, number>) => [{ id: ids[0], team: 'a' as const, stats }, { id: ids[1], team: 'b' as const }];
    // Two old-definition games with big numbers, then one new-definition game.
    nextMatchId(300);
    seedMatch(db, { endedAt: '2026-09-25 20:00:00', lines: line({ clears: 40, biles_landed: 30, skeets: 2 }) });
    seedMatch(db, { endedAt: '2026-09-26 20:00:00', lines: line({ clears: 40, biles_landed: 30, skeets: 2 }) });
    nextMatchId(REDEFINED_STATS_FROM_MATCH);
    seedMatch(db, { endedAt: '2026-09-30 20:00:00', lines: line({ clears: 6, biles_landed: 3, skeets: 2 }) });

    const { community, players } = computeWrapped(db, 1);
    // Season totals: only the new-definition game for the redefined keys,
    // every game for the rest.
    expect(community.totals.clears).toBe(6);
    expect(community.totals.biles_landed).toBe(3);
    expect(community.totals.skeets).toBe(6);

    // Per match: 6 clears over the ONE game since 324, not over all three.
    const me = players.find((p) => p.steamid === ids[0])!;
    const sig = Object.fromEntries((me.signature ?? []).map((s) => [s.key, s.perMatch]));
    expect(sig.clears).toBe(6);
    expect(sig.biles_landed).toBe(3);
    expect(sig.skeets).toBe(2);
  });
});
