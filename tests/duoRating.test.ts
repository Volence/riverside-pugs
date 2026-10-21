import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { applyMatchRatings, matchForecast, recomputeSeasonRatings } from '../src/rating.js';
import { upsertPlayer } from '../src/players.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000010${i}`);
let db: DB;

function match(winner: 'a' | 'b', duoBonus: number | null): number {
  const id = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, winner, ended_at) VALUES (1, 'completed', 'no_mercy', ?, datetime('now'))",
  ).run(winner).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team, duo_partner, duo_bonus) VALUES (?, ?, ?, ?, ?)');
  IDS.forEach((p, i) => {
    const inDuo = duoBonus !== null && i < 2; // IDS[0] + IDS[1] duo on team a
    ins.run(id, p, i < 4 ? 'a' : 'b', inDuo ? IDS[1 - i] : null, inDuo ? duoBonus : null);
  });
  return id;
}

const mu = (p: string) => (db.prepare('SELECT mu FROM player_ratings WHERE player_id = ?').get(p) as { mu: number }).mu;
const sigma = (p: string) => (db.prepare('SELECT sigma FROM player_ratings WHERE player_id = ?').get(p) as { sigma: number }).sigma;

function fresh() {
  db = openDb(':memory:');
  for (const id of IDS) upsertPlayer(db, { steamid: id, name: id, avatar: null }, []);
}

describe('duo bonus in ratings', () => {
  beforeEach(fresh);

  it('a duo with bonus 0 rates exactly like no duo', () => {
    applyMatchRatings(db, match('a', null));
    const plainMu = IDS.map(mu);
    const plainSigma = IDS.map(sigma);
    fresh();
    applyMatchRatings(db, match('a', 0));
    IDS.forEach((p, i) => {
      expect(mu(p)).toBe(plainMu[i]);
      expect(sigma(p)).toBe(plainSigma[i]);
    });
  });

  it('a duo win gains less, the losers lose less, the duo team solos are unaffected', () => {
    applyMatchRatings(db, match('a', null));
    const plain = IDS.map(mu);
    fresh();
    applyMatchRatings(db, match('a', 2));
    const duo = IDS.map(mu);
    expect(duo[0]).toBeLessThan(plain[0]); // duo member gains less
    expect(duo[1]).toBeLessThan(plain[1]);
    expect(duo[2]).toBeCloseTo(plain[2], 10); // solo teammate rated as without the duo
    expect(duo[3]).toBeCloseTo(plain[3], 10);
    expect(duo[4]).toBeGreaterThan(plain[4]); // opponents lose less
  });

  it('a duo loss costs more and the winners gain more', () => {
    applyMatchRatings(db, match('b', null));
    const plain = IDS.map(mu);
    fresh();
    applyMatchRatings(db, match('b', 2));
    const duo = IDS.map(mu);
    expect(duo[0]).toBeLessThan(plain[0]);
    expect(duo[4]).toBeGreaterThan(plain[4]);
  });

  it('a season recompute reproduces the same numbers from the stored bonus', () => {
    applyMatchRatings(db, match('a', 2));
    const live = IDS.map(mu);
    recomputeSeasonRatings(db, 1);
    expect(IDS.map(mu)).toEqual(live);
  });

  it('forecast gives the bonus-aware chance next to the plain one', () => {
    const m = match('a', 2);
    applyMatchRatings(db, m);
    const f = matchForecast(db, m)!;
    expect(f.winProbAWithDuo).not.toBeNull();
    expect(f.winProbAWithDuo!).toBeGreaterThan(f.winProbA);
    const m2 = match('a', null);
    applyMatchRatings(db, m2);
    expect(matchForecast(db, m2)!.winProbAWithDuo).toBeNull();
  });
});
