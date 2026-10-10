import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { buildWinModel, winChance, matchWinLine, liveWinLine, winModel, type HalfRow } from '../src/winProb.js';
import { insertDraft, publishCampaign } from '../src/customCampaigns.js';
import { invalidateCampaignCache, setMissionsDirs } from '../src/campaignRegistry.js';

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

  it('moves smoothly with the gap: a 1 point lead is worth a little, not a whole score bucket', () => {
    const at = (g: number) => winChance(model, g, ['m1'], ['m1']);
    expect(at(1) - at(0)).toBeGreaterThan(0);
    // Before the fix any lead of 1 to 19 counted every tie as a win, so 1 and
    // 19 scored the same; now 1 point is a small fraction of 19's worth.
    expect(at(1) - at(0)).toBeLessThan((at(19) - at(0)) / 5);
    expect(at(1) + at(-1)).toBeCloseTo(1, 9);
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

describe('liveWinLine', () => {
  let db: DB;
  let id: number;
  const model = buildWinModel(history());
  beforeEach(() => {
    db = openDb(':memory:');
    setMissionsDirs([]);
    invalidateCampaignCache();
    // Five chapters, so the default stop map is the fourth: m1 m2 m1 m2.
    insertDraft(db, {
      slug: 'five', name: 'Five', vpkFilename: 'five.vpk', sizeBytes: 1, sha256: 'a'.repeat(64), uploadedBy: null,
    }, ['m1', 'm2', 'm1b', 'm2b', 'fin'].map((map, n) => ({ map, display: null, isFinale: n === 4 })));
    publishCampaign(db, 'five', 'Five');
    invalidateCampaignCache();
    id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'five')").run().lastInsertRowid);
  });
  afterEach(() => { setMissionsDirs([]); invalidateCampaignCache(); });

  const playMap = (ordinal: number, map: string) =>
    db.prepare('INSERT INTO match_live_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, ?, ?, 0, 0)').run(id, ordinal, map);
  const half = (ordinal: number, h: number, team: 'a' | 'b', score: number | null) =>
    db.prepare('INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ordinal, h, team, score ?? 0, score === null ? null : '2026-10-10 00:00:00');

  it('prices the opening point against all four planned maps', () => {
    const line = liveWinLine(db, id, 'five', model)!;
    expect(line.points).toHaveLength(1);
    expect(line.halvesLeft).toBe(8);
    expect(line.points[0].pA).toBeCloseTo(0.5, 6);
    expect(line.winnerLow).toBeNull();
  });

  it('counts the other team\'s half of the current map as still to play, and a half in progress too', () => {
    playMap(0, 'm1');
    half(0, 1, 'a', 640);
    let line = liveWinLine(db, id, 'five', model)!;
    expect(line.points).toHaveLength(2);
    expect(line.halvesLeft).toBe(7);
    expect(line.points[1].pA).toBeGreaterThan(0.5);
    expect(line.points[1].pA).toBeLessThan(1);

    half(0, 2, 'b', null); // B's half has started but not ended
    line = liveWinLine(db, id, 'five', model)!;
    expect(line.points).toHaveLength(2);
    expect(line.halvesLeft).toBe(7);
  });

  it('agrees with the same state priced directly', () => {
    playMap(0, 'm1'); playMap(1, 'm2');
    half(0, 1, 'a', 640); half(0, 2, 'b', 60); half(1, 1, 'b', 820);
    const line = liveWinLine(db, id, 'five', model)!;
    expect(line.points.at(-1)!.pA).toBeCloseTo(winChance(model, 640 - 880, ['m2', 'm1b', 'm2b'], ['m1b', 'm2b']), 9);
  });

  it('counts a finished half 1 before the map row exists, which is how the live feed writes it', () => {
    // match_live_maps only gains a row at MAP_RESULT, after both halves.
    half(0, 1, 'a', 640);
    const line = liveWinLine(db, id, 'five', model)!;
    expect(line.points).toHaveLength(2);
    expect(line.points[1]).toMatchObject({ ordinal: 0, half: 1, map: 'm1', scoreA: 640 });
    expect(line.halvesLeft).toBe(7);
  });

  it('is null for a score the plugin could not read, and for anything but a PUG', () => {
    half(0, 1, 'a', 640);
    db.prepare('UPDATE match_rounds SET reliable = 0 WHERE match_id = ?').run(id);
    expect(liveWinLine(db, id, 'five', model)).toBeNull();
    db.prepare('UPDATE match_rounds SET reliable = 1 WHERE match_id = ?').run(id);
    db.prepare("UPDATE matches SET kind = 'scrim' WHERE id = ?").run(id);
    expect(liveWinLine(db, id, 'five', model)).toBeNull();
  });

  it('is null when the maps played do not follow the plan, or the plan is unknown', () => {
    playMap(0, 'somewhere_else');
    half(0, 1, 'a', 100);
    expect(liveWinLine(db, id, 'five', model)).toBeNull();
    expect(liveWinLine(db, id, 'no_such_campaign', model)).toBeNull();
  });
});
