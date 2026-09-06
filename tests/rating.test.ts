import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { displaySr, applyMatchRatings } from '../src/rating.js';
import { upsertPlayer, ensureRating } from '../src/players.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);

function seedCompletedMatch(db: DB, winner: 'a' | 'b' | 'draw'): number {
  for (const id of IDS) upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
  const matchId = Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign, winner, team_a_score, team_b_score, ended_at) VALUES (1, 'completed', 'no_mercy', ?, 100, 200, datetime('now'))")
      .run(winner).lastInsertRowid,
  );
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  return matchId;
}

describe('displaySr', () => {
  it('is round((mu - 2*sigma) * 100), floored at 0', () => {
    expect(displaySr(25, 25 / 3)).toBe(833); // openskill defaults
    expect(displaySr(30, 5)).toBe(2000);
    expect(displaySr(1, 10)).toBe(0); // floor
  });
});

describe('applyMatchRatings', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); });

  it('raises winners, lowers losers, records history and W/L', () => {
    const matchId = seedCompletedMatch(db, 'b');
    applyMatchRatings(db, matchId);
    const a0 = ensureRating(db, IDS[0]); // team a, lost
    const b0 = ensureRating(db, IDS[4]); // team b, won
    expect(b0.mu).toBeGreaterThan(25);
    expect(a0.mu).toBeLessThan(25);
    expect(b0.sigma).toBeLessThan(25 / 3); // sigma shrinks with information
    expect(b0.wins).toBe(1);
    expect(b0.losses).toBe(0);
    expect(a0.wins).toBe(0);
    expect(a0.losses).toBe(1);
    const hist = db.prepare('SELECT * FROM rating_history WHERE match_id = ?').all(matchId) as any[];
    expect(hist).toHaveLength(8);
    expect(hist[0].mu_before).toBe(25);
  });

  it('draw: mus barely move, no wins/losses counted', () => {
    const matchId = seedCompletedMatch(db, 'draw');
    applyMatchRatings(db, matchId);
    const r = ensureRating(db, IDS[0]);
    expect(r.wins).toBe(0);
    expect(r.losses).toBe(0);
    expect(Math.abs(r.mu - 25)).toBeLessThan(0.5); // equal teams draw ≈ no shift
    expect(r.sigma).toBeLessThan(25 / 3); // draws still convey information
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 8 });
  });

  it('is idempotent: second call is a no-op', () => {
    const matchId = seedCompletedMatch(db, 'a');
    applyMatchRatings(db, matchId);
    const first = ensureRating(db, IDS[0]).mu;
    applyMatchRatings(db, matchId);
    expect(ensureRating(db, IDS[0]).mu).toBe(first);
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 8 });
  });

  it('ignores non-completed matches', () => {
    const matchId = seedCompletedMatch(db, 'a');
    db.prepare("UPDATE matches SET state = 'live', winner = NULL WHERE id = ?").run(matchId);
    applyMatchRatings(db, matchId);
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history').get()).toEqual({ n: 0 });
  });

  it('uses the match season, not the current season', () => {
    const matchId = seedCompletedMatch(db, 'a');
    // close season 1, open season 2. The match still belongs to season 1
    db.prepare("UPDATE seasons SET ended_at = datetime('now') WHERE id = 1").run();
    db.prepare("INSERT INTO seasons (name) VALUES ('Season 2')").run();
    applyMatchRatings(db, matchId);
    const row = db.prepare('SELECT season_id FROM rating_history WHERE match_id = ? LIMIT 1').get(matchId) as any;
    expect(row.season_id).toBe(1);
  });
});
