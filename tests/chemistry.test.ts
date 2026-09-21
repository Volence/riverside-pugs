import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import { setSetting } from '../src/settings.js';
import { chemistryFor } from '../src/chemistry.js';
import { profileData } from '../src/playerQueries.js';

const ME = '76561198000000001';
const ANN = '76561198000000002';
const BOB = '76561198000000003';
const CAT = '76561198000000004';
const DAN = '76561198000000005';
const ALT = '76561198000000009';

let db: DB;
let nextId = 1;

/** One match: `a` and `b` are the two rosters, `winner` who took it. */
function seed(winner: 'a' | 'b' | 'draw', a: string[], b: string[], state = 'completed'): number {
  const id = nextId++;
  db.prepare(
    "INSERT INTO matches (id, season_id, state, campaign, winner, ended_at) VALUES (?, 1, ?, 'no_mercy', ?, datetime('now'))",
  ).run(id, state, winner);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  for (const p of a) ins.run(id, p, 'a');
  for (const p of b) ins.run(id, p, 'b');
  return id;
}

beforeEach(() => {
  db = openDb(':memory:');
  nextId = 1;
  for (const [id, name] of [[ME, 'me'], [ANN, 'ann'], [BOB, 'bob'], [CAT, 'cat'], [DAN, 'dan'], [ALT, 'ann-alt']] as const) {
    upsertPlayer(db, { steamid: id, name, avatar: null }, []);
  }
});

describe('chemistryFor', () => {
  it('most played with is a plain count of shared same-team matches, with no threshold', () => {
    seed('a', [ME, ANN], [CAT]);
    seed('b', [ME, ANN], [CAT]);
    seed('a', [ME, ANN], [DAN]);
    seed('a', [ME, BOB], [DAN]);
    const c = chemistryFor(db, ME);
    expect(c.mostPlayedWith).toEqual({ steamid: ANN, name: 'ann', games: 3, wins: 2, winRate: 2 / 3 });
    // Default chemistry_min_games is 5 and nobody has 5 shared games.
    expect(c.bestWith).toBeNull();
    expect(c.worstAgainst).toBeNull();
  });

  it('best with is the highest same-team win rate among pairs that clear the threshold', () => {
    setSetting(db, 'chemistry_min_games', '2');
    seed('a', [ME, ANN], [CAT]);
    seed('b', [ME, ANN], [CAT]);
    seed('a', [ME, BOB], [DAN]);
    seed('a', [ME, BOB], [DAN]);
    // One game with cat at 100% must not beat bob: it is under the threshold.
    seed('a', [ME, CAT], [DAN]);
    const c = chemistryFor(db, ME);
    expect(c.bestWith).toEqual({ steamid: BOB, name: 'bob', games: 2, wins: 2, winRate: 1 });
  });

  it('worst against is the lowest win rate against an opponent, from my side of the result', () => {
    setSetting(db, 'chemistry_min_games', '2');
    seed('b', [ME], [CAT, DAN]);
    seed('b', [ME], [CAT]);
    seed('a', [ME], [DAN]);
    const c = chemistryFor(db, ME);
    expect(c.worstAgainst).toEqual({ steamid: CAT, name: 'cat', games: 2, wins: 0, winRate: 0 });
  });

  it('a draw is a game that is not a win', () => {
    setSetting(db, 'chemistry_min_games', '2');
    seed('draw', [ME, ANN], [CAT]);
    seed('a', [ME, ANN], [CAT]);
    expect(chemistryFor(db, ME).bestWith).toMatchObject({ steamid: ANN, games: 2, wins: 1, winRate: 0.5 });
  });

  it('ignores aborted matches, which is also what excludes a voided one', () => {
    seed('a', [ME, ANN], [CAT]);
    seed('a', [ME, BOB], [CAT], 'aborted');
    seed('a', [ME, BOB], [CAT], 'aborted');
    expect(chemistryFor(db, ME).mostPlayedWith?.steamid).toBe(ANN);
  });

  it('folds an alias into its canonical account, so an alt is not a separate teammate', () => {
    addAlias(db, { steamid: ALT, canonical: ANN, by: 'test' });
    seed('a', [ME, ANN], [CAT]);
    seed('a', [ME, ALT], [CAT]);
    seed('a', [ME, BOB], [CAT]);
    const c = chemistryFor(db, ME);
    expect(c.mostPlayedWith).toMatchObject({ steamid: ANN, name: 'ann', games: 2 });
  });

  it('resolves the subject through the alias table too', () => {
    addAlias(db, { steamid: ALT, canonical: ANN, by: 'test' });
    seed('a', [ME, ANN], [CAT]);
    expect(chemistryFor(db, ALT).mostPlayedWith?.steamid).toBe(ME);
  });

  it('is all nulls for somebody who has played nothing', () => {
    expect(chemistryFor(db, ME)).toEqual({ mostPlayedWith: null, bestWith: null, worstAgainst: null });
  });

  it('breaks ties by more games, then by name, so the line does not flicker', () => {
    seed('a', [ME, BOB], [CAT]);
    seed('a', [ME, ANN], [CAT]);
    expect(chemistryFor(db, ME).mostPlayedWith?.steamid).toBe(ANN);
  });
});

describe('profileData chemistry', () => {
  it('carries the three lines on the profile payload', () => {
    seed('a', [ME, ANN], [CAT]);
    const got = profileData(db, ME, null)!;
    expect(got.chemistry.mostPlayedWith?.steamid).toBe(ANN);
    expect(got.chemistry.bestWith).toBeNull();
  });
});
