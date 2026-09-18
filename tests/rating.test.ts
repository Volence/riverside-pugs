import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { displaySr, applyMatchRatings, ratedForMaps, matchForecast } from '../src/rating.js';
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

describe('ratedForMaps', () => {
  it('rates a player who played at least half the maps, and everyone when no maps are recorded', () => {
    expect(ratedForMaps(0, 4)).toBe(true);
    expect(ratedForMaps(2, 4)).toBe(true);  // played maps 2 and 3 of 0..3: half
    expect(ratedForMaps(3, 4)).toBe(false); // played the last map only
    expect(ratedForMaps(1, 2)).toBe(true);
    expect(ratedForMaps(1, 1)).toBe(false);
    expect(ratedForMaps(5, 0)).toBe(true);
  });
});

describe('applyMatchRatings', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); });

  it('skips a sub who joined after half the maps, keeps their row, rates the rest', () => {
    const matchId = seedCompletedMatch(db, 'b');
    const insMap = db.prepare('INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, ?, ?, 0, 0)');
    for (let i = 0; i < 4; i++) insMap.run(matchId, i, `m${i}`);
    db.prepare('UPDATE match_players SET joined_map = 3 WHERE match_id = ? AND player_id = ?').run(matchId, IDS[7]);
    db.prepare('UPDATE match_players SET joined_map = 2 WHERE match_id = ? AND player_id = ?').run(matchId, IDS[6]);
    applyMatchRatings(db, matchId);
    const hist = db.prepare('SELECT player_id FROM rating_history WHERE match_id = ?').all(matchId) as { player_id: string }[];
    expect(hist).toHaveLength(7);
    expect(hist.map((h) => h.player_id)).not.toContain(IDS[7]);
    expect(hist.map((h) => h.player_id)).toContain(IDS[6]);
    expect(ensureRating(db, IDS[7]).wins).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM match_players WHERE match_id = ?').get(matchId) as any).n).toBe(8);
  });

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

describe('matchForecast', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); });

  /** Give one team a real skill edge, then record the match so the forecast
   *  has mu_before/sigma_before to read. */
  const seedLopsided = (): number => {
    const matchId = seedCompletedMatch(db, 'a');
    for (const id of IDS) ensureRating(db, id);
    const up = db.prepare('UPDATE player_ratings SET mu = ?, sigma = ? WHERE player_id = ?');
    for (const id of IDS.slice(0, 4)) up.run(32, 3, id);
    for (const id of IDS.slice(4)) up.run(20, 3, id);
    applyMatchRatings(db, matchId);
    return matchId;
  };

  it('reads the ratings as they stood before the match, not after it', () => {
    const matchId = seedLopsided();
    const f = matchForecast(db, matchId)!;
    // mu 32 sigma 3 -> (32 - 6) * 100, and mu 20 sigma 3 -> (20 - 6) * 100.
    expect(f.srA).toBe(2600);
    expect(f.srB).toBe(1400);
    expect(f.srGap).toBe(1200);
  });

  // The report that found this: match 40 read "1012 SR vs 1126 SR, 114 SR to
  // Team B" next to "50% to win" each, which looks broken. It was not: team A
  // had the HIGHER mu (25.564 vs 25.556) and the whole SR gap came from team
  // B's lower sigma. SR subtracts twice the uncertainty; the forecast uses
  // skill. The panel has to be able to say which is which.
  // SR alone cannot show who was favoured, because it folds skill and
  // uncertainty into one number. The panel needs both halves separately.
  it('reports mean skill and mean uncertainty per team', () => {
    const matchId = seedCompletedMatch(db, 'a');
    for (const id of IDS) ensureRating(db, id);
    const up = db.prepare('UPDATE player_ratings SET mu = ?, sigma = ? WHERE player_id = ?');
    for (const id of IDS.slice(0, 4)) up.run(25, 7.7, id);
    for (const id of IDS.slice(4)) up.run(25, 7.1, id);
    applyMatchRatings(db, matchId);

    const f = matchForecast(db, matchId)!;
    expect(f.muA).toBeCloseTo(25, 6);
    expect(f.muB).toBeCloseTo(25, 6);
    expect(f.sigmaA).toBeCloseTo(7.7, 6);
    expect(f.sigmaB).toBeCloseTo(7.1, 6);
  });

  it('reports the skill gap separately from the SR gap, because they can disagree', () => {
    const matchId = seedCompletedMatch(db, 'a');
    for (const id of IDS) ensureRating(db, id);
    const up = db.prepare('UPDATE player_ratings SET mu = ?, sigma = ? WHERE player_id = ?');
    // Equal skill. Team B is merely more certain of it.
    for (const id of IDS.slice(0, 4)) up.run(25, 7.7, id);
    for (const id of IDS.slice(4)) up.run(25, 7.1, id);
    applyMatchRatings(db, matchId);

    const f = matchForecast(db, matchId)!;
    expect(f.srGap).toBeLessThan(-100);      // team B leads on SR
    expect(f.muGap).toBeCloseTo(0, 6);       // and not at all on skill
    expect(f.winProbA).toBeCloseTo(0.5, 2);
  });

  it('gives the stronger team the higher win probability, and the two sum to one', () => {
    const matchId = seedLopsided();
    const f = matchForecast(db, matchId)!;
    expect(f.winProbA).toBeGreaterThan(0.5);
    expect(f.winProbA).toBeGreaterThan(f.winProbB);
    expect(f.winProbA + f.winProbB).toBeCloseTo(1, 6);
  });

  it('calls an even match even', () => {
    const matchId = seedCompletedMatch(db, 'a');
    for (const id of IDS) ensureRating(db, id);
    applyMatchRatings(db, matchId);
    const f = matchForecast(db, matchId)!;
    expect(f.srGap).toBe(0);
    expect(f.winProbA).toBeCloseTo(0.5, 6);
  });

  // A live match has no history yet: applyMatchRatings only runs at
  // completion. Current ratings ARE the pre-match ratings while it is running,
  // which is exactly what an admin watching it wants.
  it('falls back to current ratings for a match still in flight', () => {
    const matchId = seedCompletedMatch(db, 'a');
    db.prepare("UPDATE matches SET state = 'live', winner = NULL WHERE id = ?").run(matchId);
    for (const id of IDS) ensureRating(db, id);
    const up = db.prepare('UPDATE player_ratings SET mu = ?, sigma = ? WHERE player_id = ?');
    for (const id of IDS.slice(0, 4)) up.run(32, 3, id);
    for (const id of IDS.slice(4)) up.run(20, 3, id);

    const f = matchForecast(db, matchId)!;
    expect(f.source).toBe('current');
    expect(f.srA).toBe(2600);
    expect(f.srB).toBe(1400);
    expect(f.winProbA).toBeGreaterThan(0.5);
  });

  it('says which ratings a completed match was forecast from', () => {
    const f = matchForecast(db, seedLopsided())!;
    expect(f.source).toBe('history');
  });

  // The trap the fallback must not fall into: for a match completed long ago,
  // current ratings are several matches of hindsight later, so no forecast is
  // far better than a confident wrong one.
  it('does not fall back to current ratings for a completed match', () => {
    const matchId = seedCompletedMatch(db, 'a');
    for (const id of IDS) ensureRating(db, id);
    expect(matchForecast(db, matchId)).toBeNull();
  });

  it('is null for a match with no rating history to read', () => {
    const matchId = seedCompletedMatch(db, 'a');
    expect(matchForecast(db, matchId)).toBeNull();
  });

  // A sub who played under half the maps is never rated, so they have no
  // history row and must not be counted into their team's strength either.
  it('counts only the players who were actually rated', () => {
    const matchId = seedCompletedMatch(db, 'a');
    const insMap = db.prepare('INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, ?, ?, 0, 0)');
    for (let i = 0; i < 4; i++) insMap.run(matchId, i, `m${i}`);
    for (const id of IDS) ensureRating(db, id);
    const up = db.prepare('UPDATE player_ratings SET mu = ?, sigma = ? WHERE player_id = ?');
    for (const id of IDS.slice(0, 4)) up.run(30, 3, id);
    for (const id of IDS.slice(4)) up.run(30, 3, id);
    // One team B player is a late sub on 30 mu, and one is a ringer nobody
    // should credit team B for.
    up.run(40, 3, IDS[7]);
    db.prepare('UPDATE match_players SET joined_map = 3 WHERE match_id = ? AND player_id = ?').run(matchId, IDS[7]);
    applyMatchRatings(db, matchId);
    const f = matchForecast(db, matchId)!;
    expect(f.ratedA).toBe(4);
    expect(f.ratedB).toBe(3);
    expect(f.srB).toBe(2400); // the 40 mu sub excluded, so the same as team A
    expect(f.srGap).toBe(0);
  });
});
