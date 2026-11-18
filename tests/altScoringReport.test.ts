import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { buildAltReport } from '../src/altScoringReport.js';

type DB = ReturnType<typeof openDb>;

interface Alt { ordinal: number; half: number; surv: 'a' | 'b'; walk: number; tank: number; door: number; ws?: number; walkMult?: number; rule?: string }

function match(db: DB, id: number, opts: { state?: string; kind?: string; voided?: boolean; winner?: string | null; a?: number; b?: number; campaign?: string } = {}): void {
  db.prepare(`INSERT INTO matches (id, season_id, state, campaign, team_a_score, team_b_score, winner, ended_at, kind, voided_at)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, opts.state ?? 'completed', opts.campaign ?? 'c_test', opts.a ?? 0, opts.b ?? 0,
    opts.winner === undefined ? 'a' : opts.winner, '2026-11-17 20:00:00', opts.kind ?? 'pug', opts.voided ? '2026-11-17 21:00:00' : null);
}

/** Four maps of two halves, team a survivor first each map, each half scoring `score`. */
function realRounds(db: DB, id: number, score = 400): void {
  for (let o = 0; o < 4; o++) {
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score) VALUES (?, ?, 1, 'a', ?), (?, ?, 2, 'b', ?)").run(id, o, score, id, o, score);
  }
}

function maps(db: DB, id: number, table: 'match_maps' | 'match_live_maps', names: string[]): void {
  names.forEach((m, o) => {
    if (table === 'match_maps') db.prepare('INSERT INTO match_maps (match_id, ordinal, map) VALUES (?, ?, ?)').run(id, o, m);
    else db.prepare('INSERT INTO match_live_maps (match_id, map, ordinal, team_a_score, team_b_score) VALUES (?, ?, ?, 0, 0)').run(id, m, o);
  });
}

function alt(db: DB, id: number, r: Alt): void {
  db.prepare(`INSERT INTO match_round_alt (match_id, ordinal, half, rule, surv_team, walk, tank, door, walk_mult, door_mult,
      ws, wt, wr, ts, tt, tr, ds, dt, dr, tank_pct, tank_by, tanks, survivors_in, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0, 0, 0, 0, 0, 0, 0, 55, 'surv', 1, 4, 'dump')`)
    .run(id, r.ordinal, r.half, r.rule ?? 'hr1', r.surv, r.walk, r.tank, r.door, r.walkMult ?? 1, r.ws ?? 255);
}

/** A real round for every alt half of the match, so it is complete. */
function realForAlt(db: DB, id: number): void {
  db.prepare(`INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score)
    SELECT match_id, ordinal, half, surv_team, 0 FROM match_round_alt WHERE match_id = ?`).run(id);
}

/** Eight alt halves; team b scores `bWalk` walking per half, team a 100. */
function fullAlt(db: DB, id: number, bWalk: number, count = 8): void {
  for (let i = 0; i < count; i++) {
    const ordinal = Math.floor(i / 2);
    const half = (i % 2) + 1;
    const surv = half === 1 ? 'a' : 'b';
    alt(db, id, { ordinal, half, surv, walk: surv === 'a' ? 100 : bWalk, tank: 50, door: 30 });
  }
}

describe('buildAltReport', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  });

  it('an empty database gives zeros and empty arrays', () => {
    expect(buildAltReport(db)).toEqual({
      summary: { matchesWithData: 0, complete: 0, differentWinner: 0, share: { walk: 0, tank: 0, door: 0 }, mismatchedHalves: 0 },
      maps: [],
      matches: [],
    });
  });

  describe('seeded with four matches', () => {
    beforeEach(() => {
      // (a) completed PUG, real winner a, alt winner b.
      match(db, 1, { winner: 'a', a: 1700, b: 1500 });
      realRounds(db, 1);
      maps(db, 1, 'match_maps', ['m1', 'm2', 'm3', 'm4']);
      fullAlt(db, 1, 300);
      // (b) completed PUG, one alt half missing.
      match(db, 2, { winner: 'b' });
      realRounds(db, 2);
      fullAlt(db, 2, 300, 7);
      // (c) voided PUG with every row.
      match(db, 3, { winner: 'a', voided: true });
      realRounds(db, 3);
      fullAlt(db, 3, 300);
      // (d) completed PUG with no alt rows.
      match(db, 4, { winner: 'a' });
      realRounds(db, 4);
    });

    it('counts and compares only counted matches', () => {
      const r = buildAltReport(db);
      expect(r.summary).toMatchObject({ matchesWithData: 3, complete: 1, differentWinner: 1 });
      expect(r.matches.map((m) => m.id)).toEqual([3, 2, 1]);
      const byId = new Map(r.matches.map((m) => [m.id, m]));
      expect(byId.get(1)).toMatchObject({
        campaign: 'c_test', endedAt: '2026-11-17 20:00:00', realA: 1700, realB: 1500, realWinner: 'a',
        altA: 4 * 180, altB: 4 * 380, altWinner: 'b', complete: true, differs: true, counted: true,
      });
      expect(byId.get(2)).toMatchObject({ complete: false, differs: null, counted: false });
      expect(byId.get(3)).toMatchObject({ complete: true, counted: false });
      expect(byId.has(4)).toBe(false);
    });

    it('shares are over counted matches and sum to 1', () => {
      const { share } = buildAltReport(db).summary;
      expect(share.walk + share.tank + share.door).toBeCloseTo(1, 9);
      // Match 1 only: walk 4x100 + 4x300, tank 8x50, door 8x30.
      const total = 1600 + 400 + 240;
      expect(share.walk).toBeCloseTo(1600 / total, 9);
      expect(share.tank).toBeCloseTo(400 / total, 9);
      expect(share.door).toBeCloseTo(240 / total, 9);
    });

    it('lists each half with its real score, map and stored parts', () => {
      const m1 = buildAltReport(db).matches.find((m) => m.id === 1)!;
      expect(m1.halves).toHaveLength(8);
      expect(m1.halves[0]).toEqual({
        ordinal: 0, half: 1, map: 'm1', survTeam: 'a', real: 400, walk: 100, tank: 50, door: 30, total: 180,
        tankPct: 55, tankBy: 'surv', survivorsIn: 4,
        // The fixture's stored parts are not its raw components' (ws 255 is 350 walking).
        mismatch: true,
      });
      expect(m1.halves[7]).toMatchObject({ ordinal: 3, half: 2, map: 'm4', survTeam: 'b', total: 380 });
      // Match 2 has no map rows: the name is empty, not an error.
      expect(buildAltReport(db).matches.find((m) => m.id === 2)!.halves[0].map).toBe('');
    });

    it('honours the match limit, newest first', () => {
      const r = buildAltReport(db, { limit: 1 });
      expect(r.matches.map((m) => m.id)).toEqual([3]);
      expect(r.summary.matchesWithData).toBe(3);
    });
  });

  it('flags a half whose stored parts differ from its raw components by more than 1', () => {
    match(db, 1);
    // ws 255 alone is 350 walking at multiplier 1; tank and door are 0 from zero raw.
    alt(db, 1, { ordinal: 0, half: 1, surv: 'a', walk: 355, tank: 0, door: 0, ws: 255 });
    alt(db, 1, { ordinal: 0, half: 2, surv: 'b', walk: 351, tank: 0, door: 0, ws: 255 });
    alt(db, 1, { ordinal: 1, half: 1, surv: 'a', walk: 350, tank: 0, door: 0, ws: 255 });
    // Under a 1.2 multiplier the same raw is 420.
    alt(db, 1, { ordinal: 1, half: 2, surv: 'b', walk: 420, tank: 0, door: 0, ws: 255, walkMult: 1.2 });
    const r = buildAltReport(db);
    expect(r.matches[0].halves.map((h) => h.mismatch)).toEqual([true, false, false, false]);
    expect(r.summary.mismatchedHalves).toBe(1);
  });

  it('counts mismatched halves over every match, not only the listed ones', () => {
    match(db, 1, { kind: 'scrim' });
    alt(db, 1, { ordinal: 0, half: 1, surv: 'a', walk: 300, tank: 0, door: 0, ws: 255 });
    match(db, 2);
    alt(db, 2, { ordinal: 0, half: 1, surv: 'a', walk: 350, tank: 0, door: 0, ws: 255 });
    const r = buildAltReport(db, { limit: 1 });
    expect(r.matches.map((m) => m.id)).toEqual([2]);
    expect(r.summary.mismatchedHalves).toBe(1);
  });

  it('a half without a real round has a null real score', () => {
    match(db, 1, { state: 'live', winner: null });
    alt(db, 1, { ordinal: 0, half: 1, surv: 'a', walk: 100, tank: 0, door: 0 });
    const m = buildAltReport(db).matches[0];
    expect(m.halves[0].real).toBeNull();
    expect(m).toMatchObject({ complete: false, differs: null, counted: false, realWinner: null });
  });

  it('a live match takes its map names from match_live_maps', () => {
    match(db, 1, { state: 'live', winner: null });
    maps(db, 1, 'match_live_maps', ['live1']);
    alt(db, 1, { ordinal: 0, half: 1, surv: 'a', walk: 100, tank: 0, door: 0 });
    expect(buildAltReport(db).matches[0].halves[0].map).toBe('live1');
  });

  it('only hr1 rows are reported', () => {
    match(db, 1);
    alt(db, 1, { ordinal: 0, half: 1, surv: 'a', walk: 100, tank: 0, door: 0, rule: 'other' });
    expect(buildAltReport(db).summary.matchesWithData).toBe(0);
  });

  it('scrims and unfinished matches are not counted', () => {
    match(db, 1, { kind: 'scrim' });
    realRounds(db, 1);
    fullAlt(db, 1, 300);
    match(db, 2, { state: 'aborted' });
    realRounds(db, 2);
    fullAlt(db, 2, 300);
    const r = buildAltReport(db);
    expect(r.summary).toMatchObject({ matchesWithData: 2, complete: 0, differentWinner: 0, share: { walk: 0, tank: 0, door: 0 } });
    expect(r.matches.every((m) => m.complete && !m.counted)).toBe(true);
  });

  it('per-map walking uses the raw components at multiplier 1', () => {
    match(db, 1);
    maps(db, 1, 'match_maps', ['m1']);
    // Stored walk is after a 1.2 multiplier; ws 255 alone is 350 at multiplier 1.
    alt(db, 1, { ordinal: 0, half: 1, surv: 'a', walk: 420, tank: 0, door: 0, ws: 255, walkMult: 1.2 });
    alt(db, 1, { ordinal: 0, half: 2, surv: 'b', walk: 210, tank: 0, door: 0, ws: 127.5, walkMult: 1.2 });
    realForAlt(db, 1);
    expect(buildAltReport(db).maps).toEqual([{ map: 'm1', halves: 2, avgWalkRaw: 262.5, suggestedWalkMult: null }]);
  });

  it('suggests a walk multiplier once a map has 100 halves', () => {
    match(db, 1);
    match(db, 2);
    match(db, 3);
    // Matches 1 and 2 play one map 50 times each (100 halves), match 3 one half of a third map.
    for (let o = 0; o < 50; o++) {
      db.prepare("INSERT INTO match_maps (match_id, ordinal, map) VALUES (1, ?, 'easy'), (2, ?, 'hard')").run(o, o);
      for (const half of [1, 2]) {
        alt(db, 1, { ordinal: o, half, surv: half === 1 ? 'a' : 'b', walk: 350, tank: 0, door: 0, ws: 255 });
        alt(db, 2, { ordinal: o, half, surv: half === 1 ? 'a' : 'b', walk: 175, tank: 0, door: 0, ws: 127.5 });
      }
    }
    db.prepare("INSERT INTO match_maps (match_id, ordinal, map) VALUES (3, 0, 'rare')").run();
    alt(db, 3, { ordinal: 0, half: 1, surv: 'a', walk: 350, tank: 0, door: 0, ws: 255 });
    for (const id of [1, 2, 3]) realForAlt(db, id);
    const byMap = new Map(buildAltReport(db).maps.map((m) => [m.map, m]));
    // Overall mean over 201 halves: (101 x 350 + 100 x 175) / 201.
    const overall = (101 * 350 + 100 * 175) / 201;
    expect(overall / 350).toBeCloseTo(0.751, 3);
    expect(byMap.get('easy')).toEqual({ map: 'easy', halves: 100, avgWalkRaw: 350, suggestedWalkMult: 0.75 });
    expect(byMap.get('hard')).toEqual({ map: 'hard', halves: 100, avgWalkRaw: 175, suggestedWalkMult: 1.5 });
    expect(byMap.get('rare')).toEqual({ map: 'rare', halves: 1, avgWalkRaw: 350, suggestedWalkMult: null });
  });

  it('suggests nothing for a map whose average walking is 0', () => {
    match(db, 1);
    for (let o = 0; o < 50; o++) {
      db.prepare("INSERT INTO match_maps (match_id, ordinal, map) VALUES (1, ?, 'flat')").run(o);
      for (const half of [1, 2]) alt(db, 1, { ordinal: o, half, surv: half === 1 ? 'a' : 'b', walk: 0, tank: 0, door: 0, ws: 0 });
    }
    realForAlt(db, 1);
    expect(buildAltReport(db).maps).toEqual([{ map: 'flat', halves: 100, avgWalkRaw: 0, suggestedWalkMult: null }]);
  });

  it('per-map walking counts only counted matches', () => {
    // Counted: one half on m1 at 350.
    match(db, 1);
    maps(db, 1, 'match_maps', ['m1']);
    alt(db, 1, { ordinal: 0, half: 1, surv: 'a', walk: 350, tank: 0, door: 0, ws: 255 });
    realForAlt(db, 1);
    // Voided, scrim, aborted, live and incomplete matches on m1 at 175 must not count.
    match(db, 2, { voided: true });
    match(db, 3, { kind: 'scrim' });
    match(db, 4, { state: 'aborted' });
    match(db, 5, { state: 'live', winner: null });
    match(db, 6);
    for (const id of [2, 3, 4, 5, 6]) {
      maps(db, id, id === 5 ? 'match_live_maps' : 'match_maps', ['m1']);
      alt(db, id, { ordinal: 0, half: 1, surv: 'a', walk: 175, tank: 0, door: 0, ws: 127.5 });
      alt(db, id, { ordinal: 0, half: 2, surv: 'b', walk: 175, tank: 0, door: 0, ws: 127.5 });
      if (id !== 6) realForAlt(db, id);
    }
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score) VALUES (6, 0, 1, 'a', 0)").run();
    const r = buildAltReport(db);
    expect(r.matches.filter((m) => m.counted).map((m) => m.id)).toEqual([1]);
    expect(r.maps).toEqual([{ map: 'm1', halves: 1, avgWalkRaw: 350, suggestedWalkMult: null }]);
  });
});
