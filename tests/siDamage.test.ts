import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { netDamageAsSi, withNetDamageAsSi } from '../src/siDamage.js';
import { playerStandings } from '../src/standings.js';
import { computeWeek, NET_SI_DAMAGE_FROM_WEEK, addWeeks } from '../src/weeklyAwards.js';
import { playerCard } from '../src/events/draftCards.js';
import { buildMatchView } from '../src/cast/matchView.js';
import { computeWrapped } from '../src/seasonWrapped.js';
import { setSetting } from '../src/settings.js';
import { seedMatch, seedPlayers, seedRating } from './weeklyFixtures.js';

/** Owner 2026-10-23: Damage as SI is shown and ranked net of the part that
 *  only drained incapped survivors (dmg_to_incapped). Stored rows keep the
 *  gross figure; every reader subtracts through src/siDamage.ts. */

describe('netDamageAsSi', () => {
  it('takes damage to incapped survivors off, never below zero', () => {
    expect(netDamageAsSi({ damage_as_si: 1000, dmg_to_incapped: 280 })).toBe(720);
    expect(netDamageAsSi({ damage_as_si: 10, dmg_to_incapped: 40 })).toBe(0);
    // A bag from before dmg_to_incapped existed reads as its gross total.
    expect(netDamageAsSi({ damage_as_si: 500 })).toBe(500);
    expect(netDamageAsSi({})).toBe(0);
  });

  it('strips float noise from averages', () => {
    expect(netDamageAsSi({ damage_as_si: 45.3, dmg_to_incapped: 12.1 })).toBe(33.2);
  });

  it('replaces damage_as_si in a copy and keeps On incapped as its own key', () => {
    const raw = { damage_as_si: 900, dmg_to_incapped: 300, skeets: 2 };
    expect(withNetDamageAsSi(raw)).toEqual({ damage_as_si: 600, dmg_to_incapped: 300, skeets: 2 });
    expect(raw.damage_as_si).toBe(900);
    // No damage_as_si: no invented zero.
    expect(withNetDamageAsSi({ skeets: 1 })).toEqual({ skeets: 1 });
  });
});

describe('Damage as SI readers use the net figure', () => {
  let db: DB;
  let ids: string[];
  beforeEach(() => {
    db = openDb(':memory:');
    ids = seedPlayers(db, 3);
  });

  /** p0 farms bleedouts (big gross, mostly on incapped), p1 does clean
   *  damage. Gross ranks p0 first; net ranks p1 first. */
  const farmer = { damage_as_si: 1000, dmg_to_incapped: 700 };
  const clean = { damage_as_si: 800, dmg_to_incapped: 50 };

  it('ranks the profile badge on the net figure', () => {
    setSetting(db, 'standing_min_games', '1');
    const m = seedMatch(db, {
      endedAt: '2026-10-20 20:00:00',
      lines: [{ id: ids[0], team: 'a', stats: farmer }, { id: ids[1], team: 'b', stats: clean }],
    });
    for (const id of ids.slice(0, 2)) {
      db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma, wins, losses) VALUES (?, 1, 25, 8, 1, 0)').run(id);
      seedRating(db, m, id, [25, 8], [25, 8]);
    }
    expect(playerStandings(db, 1, ids[1]).damage_as_si).toEqual({ rank: 1, of: 2 });
    expect(playerStandings(db, 1, ids[0]).damage_as_si).toEqual({ rank: 2, of: 2 });
  });

  it('nets the weekly award from NET_SI_DAMAGE_FROM_WEEK on, and leaves earlier weeks gross', () => {
    const before = addWeeks(NET_SI_DAMAGE_FROM_WEEK, -1);
    const lines = [{ id: ids[0], team: 'a' as const, stats: farmer }, { id: ids[1], team: 'b' as const, stats: clean }];
    // Monday evening: inside each week (weeks turn at Monday 12:00 UTC).
    seedMatch(db, { endedAt: `${before} 20:00:00`, lines });
    seedMatch(db, { endedAt: `${NET_SI_DAMAGE_FROM_WEEK} 20:00:00`, lines });
    const total = (week: string) => computeWeek(db, week).find((a) => a.key === 'damage_as_si' && a.kind === 'total')!.winners[0];
    expect(total(before)).toMatchObject({ steamid: ids[0], value: 1000 });
    expect(total(NET_SI_DAMAGE_FROM_WEEK)).toMatchObject({ steamid: ids[1], value: 750 });
  });

  it('nets the draft card average', () => {
    seedMatch(db, { endedAt: '2026-10-20 20:00:00', lines: [{ id: ids[0], team: 'a', stats: farmer }] });
    expect(playerCard(db, ids[0]).infected.damageAsSi).toBe(300);
  });

  it('nets the cast box score', () => {
    const m = seedMatch(db, {
      endedAt: '2026-10-20 20:00:00',
      lines: [{ id: ids[0], team: 'a', stats: farmer }, { id: ids[1], team: 'b', stats: clean }],
    });
    const view = buildMatchView(db, m, { overrides: { a: {}, b: {} } })!;
    expect(view.teams.a.players[0].stats).toMatchObject({ damage_as_si: 300, dmg_to_incapped: 700 });
    expect(view.teams.b.players[0].stats).toMatchObject({ damage_as_si: 750 });
  });

  it('nets Wrapped leaders and totals', () => {
    setSetting(db, 'standing_min_games', '1');
    seedMatch(db, {
      endedAt: '2026-10-20 20:00:00',
      lines: [{ id: ids[0], team: 'a', stats: farmer }, { id: ids[1], team: 'b', stats: clean }],
    });
    const { community } = computeWrapped(db, 1);
    expect(community.leaders.damage_as_si.map((l) => [l.steamid, l.value])).toEqual([[ids[1], 750], [ids[0], 300]]);
    expect(community.totals.damage_as_si).toBe(1050);
    expect(community.totals.dmg_to_incapped).toBe(750);
  });
});
