import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { buildWinModel, winChance, matchWinLine, winModel, type HalfRow } from '../src/winProb.js';

/** A spread of made and wiped halves on two maps, roughly our real shape:
 *  makes several times a wipe, one map easier than the other. */
function history(): HalfRow[] {
  const rows: HalfRow[] = [];
  for (let i = 0; i < 60; i++) {
    rows.push({ map: 'm1', score: i % 3 === 0 ? 600 + (i % 7) * 20 : 40 + (i % 5) * 10, made: i % 3 === 0 });
    rows.push({ map: 'm2', score: i % 2 === 0 ? 800 + (i % 7) * 20 : 60 + (i % 5) * 10, made: i % 2 === 0 });
  }
  return rows;
}

describe('winChance', () => {
  const model = buildWinModel(history());

  it('is certain once nothing is left to play', () => {
    expect(winChance(model, 10, [], [])).toBe(1);
    expect(winChance(model, -10, [], [])).toBe(0);
    expect(winChance(model, 0, [], [])).toBe(0.5);
  });

  it('is even for a level score with the same halves left on both sides', () => {
    expect(winChance(model, 0, ['m1', 'm2'], ['m1', 'm2'])).toBeCloseTo(0.5, 6);
  });

  it('is antisymmetric: swapping the teams mirrors the chance', () => {
    const p = winChance(model, 150, ['m2'], ['m1', 'm2']);
    const q = winChance(model, -150, ['m1', 'm2'], ['m2']);
    expect(p + q).toBeCloseTo(1, 6);
  });

  it('rises with the lead and falls with the halves the other team still has', () => {
    const lead = [0, 100, 300, 700, 1200].map((g) => winChance(model, g, ['m1'], ['m1']));
    for (let i = 1; i < lead.length; i++) expect(lead[i]).toBeGreaterThan(lead[i - 1]);
    expect(winChance(model, 300, [], ['m1'])).toBeLessThan(winChance(model, 300, ['m1'], ['m1']));
  });

  it('treats a lead bigger than any score ever made on the halves left as near certain', () => {
    expect(winChance(model, 2500, [], ['m2'])).toBeGreaterThan(0.999);
  });

  it('prices a never-played map from the pooled shape instead of failing', () => {
    const p = winChance(model, 0, ['new_map'], ['m1']);
    expect(p).toBeGreaterThan(0.05);
    expect(p).toBeLessThan(0.95);
  });

  it('answers 50% from an empty history rather than dividing by zero', () => {
    const empty = buildWinModel([]);
    expect(winChance(empty, 0, ['m1'], ['m1'])).toBeCloseTo(0.5, 6);
    expect(Number.isFinite(winChance(empty, 100, ['m1'], ['m1']))).toBe(true);
  });
});

describe('matchWinLine', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); });

  /** A finished match from `halves`: one [team, score] per half in play
   *  order, maps named m1/m2 alternately. Returns the match id. */
  function seed(halves: ['a' | 'b', number][], state = 'completed'): number {
    const a = halves.filter(([t]) => t === 'a').reduce((n, [, s]) => n + s, 0);
    const b = halves.filter(([t]) => t === 'b').reduce((n, [, s]) => n + s, 0);
    const id = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, winner, team_a_score, team_b_score) VALUES (1, ?, 'no_mercy', ?, ?, ?)",
    ).run(state, a > b ? 'a' : b > a ? 'b' : 'draw', a, b).lastInsertRowid);
    for (let o = 0; o < halves.length / 2; o++) {
      const [ta, sa] = halves[o * 2];
      const [tb, sb] = halves[o * 2 + 1];
      db.prepare('INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, ?, ?, ?, ?)')
        .run(id, o, o % 2 ? 'm2' : 'm1', ta === 'a' ? sa : sb, ta === 'a' ? sb : sa);
      const ins = db.prepare(
        "INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, survivors_alive, ended_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
      );
      ins.run(id, o, 1, ta, sa, sa > 300 ? 2 : 0);
      ins.run(id, o, 2, tb, sb, sb > 300 ? 2 : 0);
    }
    return id;
  }

  // A comeback: team A wipes three times while B makes once, then A makes
  // the last map's saferoom with B wiped.
  const comeback: ['a' | 'b', number][] = [
    ['a', 60], ['b', 640], ['b', 80], ['a', 70], ['a', 50], ['b', 60], ['b', 70], ['a', 900],
  ];

  it('starts at 50%, has a point per half, and ends certain for the winner', () => {
    const line = matchWinLine(db, seed(comeback), buildWinModel(history()))!;
    expect(line.points).toHaveLength(9);
    expect(line.points[0]).toMatchObject({ ordinal: null, scoreA: 0, scoreB: 0 });
    expect(line.points[0].pA).toBeCloseTo(0.5, 6);
    expect(line.points[8]).toMatchObject({ ordinal: 3, half: 2, scoreA: 1080, scoreB: 850, pA: 1 });
  });

  it('names the biggest swing and how low the winner sank', () => {
    const line = matchWinLine(db, seed(comeback), buildWinModel(history()))!;
    // B's make on map 1 or A's on map 4: whichever moved the needle most.
    expect([2, 8]).toContain(line.turning);
    expect(line.winnerLow!.p).toBeLessThan(0.3);
    expect(line.points[line.winnerLow!.index].pA).toBe(line.winnerLow!.p);
  });

  it('has no winner low point for a draw', () => {
    const line = matchWinLine(db, seed([['a', 100], ['b', 100]]), buildWinModel(history()))!;
    expect(line.winnerLow).toBeNull();
    expect(line.points.at(-1)!.pA).toBe(0.5);
  });

  it('is null for a match that is not completed', () => {
    expect(matchWinLine(db, seed(comeback, 'aborted'), buildWinModel(history()))).toBeNull();
    expect(matchWinLine(db, 9999, buildWinModel(history()))).toBeNull();
  });

  it('is null when the rounds do not add up to the stored result', () => {
    const id = seed(comeback);
    db.prepare('UPDATE matches SET team_a_score = team_a_score + 5 WHERE id = ?').run(id);
    expect(matchWinLine(db, id, buildWinModel(history()))).toBeNull();
  });

  it('is null when a map is missing a half or a score was never read', () => {
    const missing = seed(comeback);
    db.prepare('DELETE FROM match_rounds WHERE match_id = ? AND ordinal = 3 AND half = 2').run(missing);
    expect(matchWinLine(db, missing, buildWinModel(history()))).toBeNull();

    const unread = seed(comeback);
    db.prepare('UPDATE match_rounds SET reliable = 0 WHERE match_id = ? AND ordinal = 1').run(unread);
    expect(matchWinLine(db, unread, buildWinModel(history()))).toBeNull();
  });

  it('builds its model from the completed PUGs in the DB when none is passed', () => {
    seed(comeback);
    const line = matchWinLine(db, seed(comeback))!;
    expect(line.halves).toBe(16);
    expect(winModel(db)).toBe(winModel(db));
  });
});
