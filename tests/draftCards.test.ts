import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { currentSeasonId, upsertPlayer } from '../src/players.js';
import { displaySr, UNRATED_SR } from '../src/rating.js';
import { playerCard } from '../src/events/draftCards.js';
import { pairChemistry } from '../src/chemistry.js';

const X = '76561199000000801';
const Y = '76561199000000802';
const Z = '76561199000000803';

function setup(): DB {
  const db = openDb(':memory:');
  for (const [s, n] of [[X, 'Xan'], [Y, 'Yul'], [Z, 'Zed']] as const) upsertPlayer(db, { steamid: s, name: n, avatar: null }, []);
  return db;
}

/** One match; X's survivor numbers and stats ride on it, everyone else has zeros. */
function match(db: DB, o: {
  kind?: 'pug' | 'scrim' | 'tournament'; state?: 'completed' | 'aborted'; voided?: boolean; winner: 'a' | 'b' | 'draw';
  teams: Record<string, 'a' | 'b'>; si?: number; ck?: number; stats?: Record<string, number>;
}): number {
  const id = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, kind, ended_at, winner, voided_at) VALUES (?, ?, 'no_mercy', ?, '2026-09-01 10:00:00', ?, ?)",
  ).run(currentSeasonId(db), o.state ?? 'completed', o.kind ?? 'pug', o.winner, o.voided ? '2026-09-02 10:00:00' : null).lastInsertRowid);
  for (const [s, team] of Object.entries(o.teams)) {
    db.prepare('INSERT INTO match_players (match_id, player_id, team, si_damage, common_kills) VALUES (?, ?, ?, ?, ?)')
      .run(id, s, team, s === X ? o.si ?? 0 : 0, s === X ? o.ck ?? 0 : 0);
  }
  for (const [k, v] of Object.entries(o.stats ?? {})) {
    db.prepare('INSERT INTO match_player_stats (match_id, player_id, stat, value) VALUES (?, ?, ?, ?)').run(id, X, k, v);
  }
  return id;
}

describe('a player card', () => {
  it('counts completed, unvoided PUGs only, for form and survivor play', () => {
    const db = setup();
    match(db, { winner: 'a', teams: { [X]: 'a' }, si: 300, ck: 20 });
    match(db, { winner: 'b', teams: { [X]: 'a' }, si: 100, ck: 40 });
    match(db, { winner: 'draw', teams: { [X]: 'a' }, si: 200, ck: 30 });
    match(db, { kind: 'scrim', winner: 'a', teams: { [X]: 'a' }, si: 9999, ck: 999 });
    match(db, { kind: 'tournament', winner: 'a', teams: { [X]: 'a' }, si: 9999, ck: 999 });
    match(db, { state: 'aborted', winner: 'a', teams: { [X]: 'a' }, si: 9999, ck: 999 });
    match(db, { voided: true, winner: 'a', teams: { [X]: 'a' }, si: 9999, ck: 999 });
    const c = playerCard(db, X);
    expect(c).toMatchObject({ steamid: X, name: 'Xan', avatar: null, pugs: 3, form: ['D', 'L', 'W'], survivor: { siDamage: 200, commonKills: 30 } });
  });

  it('averages infected play, names the best class and lists the skill counters with totals', () => {
    const db = setup();
    match(db, { winner: 'a', teams: { [X]: 'a' }, stats: { damage_as_si: 500, dps_landed: 2, dmg_as_hunter: 300, dmg_as_smoker: 150, skeets: 3, crowns: 1, times_skeeted: 4 } });
    match(db, { winner: 'a', teams: { [X]: 'a' }, stats: { damage_as_si: 100, dmg_as_smoker: 200, skeets: 1 } });
    match(db, { kind: 'scrim', winner: 'a', teams: { [X]: 'a' }, stats: { skeets: 50, dmg_as_tank: 9999 } });
    const c = playerCard(db, X);
    expect(c.infected).toEqual({ damageAsSi: 300, dpsLanded: 1 });
    expect(c.bestClass).toEqual({ cls: 'smoker', damage: 350 });
    expect(c.skills).toEqual([
      { key: 'skeets', label: 'Skeets', total: 4 },
      { key: 'crowns', label: 'Crowns', total: 1 },
      { key: 'dps_landed', label: 'DPs landed', total: 2 },
    ]);
  });

  it('shows current-season SR and the SR after each of the last 10 rated games, oldest first', () => {
    const db = setup();
    const season = currentSeasonId(db);
    db.prepare('INSERT INTO player_ratings (player_id, season_id, mu, sigma) VALUES (?, ?, 30, 2)').run(X, season);
    for (let k = 0; k < 12; k++) {
      const id = match(db, { winner: 'a', teams: { [X]: 'a' } });
      db.prepare('INSERT INTO rating_history (player_id, match_id, season_id, mu_before, sigma_before, mu_after, sigma_after) VALUES (?, ?, ?, 25, 8, ?, 4)')
        .run(X, id, season, 20 + k);
    }
    const c = playerCard(db, X);
    expect(c.sr).toBe(Math.round(displaySr(30, 2)));
    expect(c.trend).toEqual(Array.from({ length: 10 }, (_, i) => Math.round(displaySr(22 + i, 4))));
    expect(c.form).toHaveLength(10);
  });

  it('is empty, not broken, for a player with no PUGs', () => {
    const c = playerCard(setup(), Y);
    expect(c).toEqual({
      steamid: Y, name: 'Yul', avatar: null, sr: Math.round(UNRATED_SR), trend: [], pugs: 0, form: [],
      survivor: { siDamage: 0, commonKills: 0 }, infected: { damageAsSi: 0, dpsLanded: 0 }, bestClass: null, skills: [],
    });
  });
});

describe('chemistry between two players', () => {
  it('counts PUGs together and against, from a\'s side, with aliases resolved and other kinds left out', () => {
    const db = setup();
    match(db, { winner: 'a', teams: { [X]: 'a', [Y]: 'a' } });
    match(db, { winner: 'b', teams: { [X]: 'a', [Y]: 'a' } });
    match(db, { winner: 'a', teams: { [X]: 'a', [Y]: 'b' } });
    match(db, { kind: 'scrim', winner: 'a', teams: { [X]: 'a', [Y]: 'a' } });
    // Z is Y's alt: a PUG with Z on X's team is a PUG with Y.
    db.prepare("INSERT INTO player_aliases (steamid, canonical_id, created_at, created_by) VALUES (?, ?, '2026-09-01', 'admin')").run(Z, Y);
    match(db, { winner: 'a', teams: { [X]: 'a', [Z]: 'a' } });
    expect(pairChemistry(db, X, Y)).toEqual({ together: 3, wonTogether: 2, against: 1, wonAgainst: 1 });
    expect(pairChemistry(db, Y, X)).toEqual({ together: 3, wonTogether: 2, against: 1, wonAgainst: 0 });
    expect(pairChemistry(db, X, '76561199000000899')).toEqual({ together: 0, wonTogether: 0, against: 0, wonAgainst: 0 });
  });
});
