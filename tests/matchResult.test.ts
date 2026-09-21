import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { completeMatch } from '../src/matchResult.js';
import { upsertPlayer } from '../src/players.js';
import type { Dump } from '../src/dumpParse.js';
import { addAlias } from '../src/aliases.js';
import { subscribeAdminEvents } from '../src/adminFeed.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119900000000${i}`);

function seedLiveMatch(db: DB): number {
  for (const id of IDS) upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
  const matchId = Number(
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'no_mercy')").run().lastInsertRowid,
  );
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((id, i) => ins.run(matchId, id, i < 4 ? 'a' : 'b'));
  return matchId;
}

function dumpFor(matchId: number): Dump {
  return {
    matchId,
    maps: [
      { map: 'l4d_hospital01_apartment', a: 100, b: 150 },
      { map: 'l4d_hospital02_subway', a: 120, b: 160 },
    ],
    players: IDS.map((steamid, i) => ({
      steamid, team: i < 4 ? 'a' : 'b', sidmg: 1000 + i, sikill: i, ck: 200 + i, ff: 10 + i, rev: i % 3,
    })),
    skillDetect: false,
    skills: [],
    winner: 'b',
    totalA: 220,
    totalB: 310,
  };
}

describe('completeMatch', () => {
  let db: DB;
  let matchId: number;
  beforeEach(() => { db = openDb(':memory:'); matchId = seedLiveMatch(db); });

  it('persists match result, per-map scores, per-player stats, and ratings in one go', () => {
    expect(completeMatch(db, matchId, dumpFor(matchId))).toBe(true);
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as any;
    expect(m.state).toBe('completed');
    expect(m.team_a_score).toBe(220);
    expect(m.team_b_score).toBe(310);
    expect(m.winner).toBe('b');
    expect(m.ended_at).toBeTruthy();
    const maps = db.prepare('SELECT * FROM match_maps WHERE match_id = ? ORDER BY ordinal').all(matchId) as any[];
    expect(maps).toHaveLength(2);
    expect(maps[0]).toMatchObject({ ordinal: 0, map: 'l4d_hospital01_apartment', team_a_score: 100, team_b_score: 150 });
    const mp = db.prepare('SELECT * FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, IDS[0]) as any;
    expect(mp.si_damage).toBe(1000);
    expect(JSON.parse(mp.stats_json).sidmg).toBe('1000');
    // ratings applied
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 8 });
    const winner = db.prepare('SELECT * FROM player_ratings WHERE player_id = ?').get(IDS[4]) as any;
    expect(winner.wins).toBe(1);
  });

  it('refuses already-completed or aborted matches', () => {
    completeMatch(db, matchId, dumpFor(matchId));
    expect(completeMatch(db, matchId, dumpFor(matchId))).toBe(false);
    const other = seedLiveMatch(db); // fresh match, then abort it
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(other);
    expect(completeMatch(db, other, dumpFor(other))).toBe(false);
  });

  it('rolls back atomically when a mid-transaction write fails', () => {
    // Pre-insert a conflicting match_maps row (same match_id + ordinal 0) so the
    // transaction's own INSERT for ordinal 0 hits the PRIMARY KEY and throws.
    db.prepare(
      'INSERT INTO match_maps (match_id, ordinal, map, team_a_score, team_b_score) VALUES (?, 0, ?, 0, 0)',
    ).run(matchId, 'conflict_placeholder');

    expect(() => completeMatch(db, matchId, dumpFor(matchId))).toThrow();

    const m = db.prepare('SELECT state, ended_at FROM matches WHERE id = ?').get(matchId) as any;
    expect(m.state).toBe('live');
    expect(m.ended_at).toBeNull();
    // Only the pre-existing conflict row remains. Nothing from completeMatch was inserted.
    const maps = db.prepare('SELECT COUNT(*) n FROM match_maps WHERE match_id = ?').get(matchId) as any;
    expect(maps.n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 0 });
    const mp = db.prepare('SELECT si_damage FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, IDS[0]) as any;
    expect(mp.si_damage).toBe(0); // player stat update also rolled back

    // Clear the conflict and retry. completeMatch should now succeed cleanly.
    db.prepare('DELETE FROM match_maps WHERE match_id = ? AND ordinal = 0').run(matchId);
    expect(completeMatch(db, matchId, dumpFor(matchId))).toBe(true);
    const m2 = db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as any;
    expect(m2.state).toBe('completed');
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 8 });
  });

  it('persists skill stats keyed by roster slot', () => {
    const d: Dump = { ...dumpFor(matchId), skillDetect: true, skills: [
      { steamid: IDS[0], stats: { skeets: 2, tank_damage: 1699 } },
    ] };
    expect(completeMatch(db, matchId, d)).toBe(true);
    const rows = db.prepare(
      'SELECT stat, value FROM match_player_stats WHERE match_id = ? AND player_id = ? ORDER BY stat',
    ).all(matchId, IDS[0]);
    expect(rows).toEqual([{ stat: 'skeets', value: 2 }, { stat: 'tank_damage', value: 1699 }]);
  });

  it('writes no skill-detect stats when skilldetect was 0, but still writes native ones', () => {
    const d: Dump = { ...dumpFor(matchId), skillDetect: false, skills: [
      { steamid: IDS[0], stats: { skeets: 9, tank_damage: 500 } },
    ] };
    completeMatch(db, matchId, d);
    expect(db.prepare(
      "SELECT value FROM match_player_stats WHERE match_id = ? AND stat = 'skeets'",
    ).all(matchId)).toEqual([]);
    // tank_damage does not need skill_detect, so it survives.
    expect(db.prepare(
      "SELECT value FROM match_player_stats WHERE match_id = ? AND stat = 'tank_damage'",
    ).get(matchId)).toEqual({ value: 500 });
  });

  it('skips skill stats for a steamid not on the roster instead of throwing', () => {
    const d: Dump = { ...dumpFor(matchId), skillDetect: true, skills: [
      { steamid: '76561199999999999', stats: { skeets: 3 } },
    ] };
    // Must not throw: foreign_keys is ON, so an unguarded insert would abort the
    // whole completion transaction and lose the match result.
    expect(() => completeMatch(db, matchId, d)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_player_stats').get()).toEqual({ n: 0 });
    expect((db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as any).state).toBe('completed');
  });
});

// Audit 2026-09-21 item 23. Roster rows for a match started in game, and every
// late joiner on any match, are built from UDP MATCH_ROSTER lines. The dump
// comes over TCP RCON, so it decides who is rated.
describe('completeMatch reconciles the roster against the dump', () => {
  let db: DB;
  let matchId: number;
  let problems: { text: string; matchId?: number }[];
  let unsub: () => void;
  const GHOST = '76561199000000099';
  const ALT = '76561199000000077';

  beforeEach(() => {
    db = openDb(':memory:');
    matchId = seedLiveMatch(db);
    problems = [];
    unsub = subscribeAdminEvents((e) => { if (e.kind === 'problem') problems.push({ text: e.text, matchId: e.matchId }); });
  });
  afterEach(() => unsub());

  function addUdpRow(steamid: string, team: 'a' | 'b', name = 'ghost'): void {
    upsertPlayer(db, { steamid, name, avatar: null }, []);
    db.prepare("INSERT INTO match_players (match_id, player_id, team, source) VALUES (?, ?, ?, 'udp')").run(matchId, steamid, team);
  }

  it('leaves a UDP-rostered player the dump never mentions unrated, keeps the row and says so', () => {
    addUdpRow(GHOST, 'b');
    expect(completeMatch(db, matchId, dumpFor(matchId))).toBe(true);
    const row = db.prepare('SELECT rated, unrated_reason FROM match_players WHERE match_id = ? AND player_id = ?')
      .get(matchId, GHOST) as any;
    expect(row.rated).toBe(0);
    expect(row.unrated_reason).toBe('not_in_dump');
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ? AND player_id = ?').get(matchId, GHOST)).toEqual({ n: 0 });
    // The eight the dump does name are rated as an ordinary 4v4.
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 8 });
    expect(problems.some((p) => p.text.includes(GHOST) && p.matchId === matchId)).toBe(true);
  });

  it('rates a UDP-rostered player the dump does name', () => {
    addUdpRow(GHOST, 'b');
    const d = dumpFor(matchId);
    d.players.push({ steamid: GHOST, team: 'b', joinedMap: 0, sidmg: 5, sikill: 1, ck: 2, ff: 0, rev: 0 });
    completeMatch(db, matchId, d);
    const row = db.prepare('SELECT rated FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, GHOST) as any;
    expect(row.rated).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 9 });
    expect(problems).toEqual([]);
  });

  it('never unrates a player the website rostered, whatever the dump says', () => {
    const d = dumpFor(matchId);
    d.players = d.players.filter((p) => p.steamid !== IDS[3]);
    completeMatch(db, matchId, d);
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 8 });
  });

  it('takes the team of a UDP-rostered player from the dump', () => {
    addUdpRow(GHOST, 'a');
    const d = dumpFor(matchId);
    d.players.push({ steamid: GHOST, team: 'b', joinedMap: 0, sidmg: 0, sikill: 0, ck: 0, ff: 0, rev: 0 });
    completeMatch(db, matchId, d);
    expect(db.prepare('SELECT team FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, GHOST)).toEqual({ team: 'b' });
    expect(problems.some((p) => p.text.includes(GHOST))).toBe(true);
  });

  it('reports a STAT line for somebody who is not on the roster', () => {
    const d = dumpFor(matchId);
    d.players.push({ steamid: GHOST, team: 'a', joinedMap: 1, sidmg: 0, sikill: 0, ck: 0, ff: 0, rev: 0 });
    expect(completeMatch(db, matchId, d)).toBe(true);
    expect(problems.some((p) => p.text.includes(GHOST) && p.matchId === matchId)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) n FROM match_players WHERE match_id = ?').get(matchId)).toEqual({ n: 8 });
  });

  it("credits a merged alt's STAT and SKILL lines to the canonical account", () => {
    addAlias(db, { steamid: ALT, canonical: IDS[0], by: 'test' });
    const d = dumpFor(matchId);
    d.players[0] = { ...d.players[0], steamid: ALT, sidmg: 4321 };
    d.skillDetect = true;
    d.skills = [{ steamid: ALT, stats: { skeets: 3 } }];
    completeMatch(db, matchId, d);
    const mp = db.prepare('SELECT si_damage FROM match_players WHERE match_id = ? AND player_id = ?').get(matchId, IDS[0]) as any;
    expect(mp.si_damage).toBe(4321);
    expect(db.prepare("SELECT value FROM match_player_stats WHERE match_id = ? AND player_id = ? AND stat = 'skeets'")
      .get(matchId, IDS[0])).toEqual({ value: 3 });
    expect(problems).toEqual([]);
  });

  it('adds up one person who played the match on two accounts', () => {
    addAlias(db, { steamid: ALT, canonical: IDS[0], by: 'test' });
    const d = dumpFor(matchId);
    d.players.push({ steamid: ALT, team: 'a', joinedMap: 1, sidmg: 100, sikill: 2, ck: 3, ff: 4, rev: 5 });
    d.skillDetect = true;
    d.skills = [{ steamid: IDS[0], stats: { skeets: 1 } }, { steamid: ALT, stats: { skeets: 2, tank_damage: 50 } }];
    completeMatch(db, matchId, d);
    const mp = db.prepare('SELECT si_damage, si_kills, joined_map FROM match_players WHERE match_id = ? AND player_id = ?')
      .get(matchId, IDS[0]) as any;
    expect(mp).toEqual({ si_damage: 1100, si_kills: 2, joined_map: 0 });
    const stats = db.prepare('SELECT stat, value FROM match_player_stats WHERE match_id = ? AND player_id = ? ORDER BY stat')
      .all(matchId, IDS[0]);
    expect(stats).toEqual([{ stat: 'skeets', value: 3 }, { stat: 'tank_damage', value: 50 }]);
  });
});

describe('completeMatch refuses to rate less than a 2v2', () => {
  let db: DB;
  let problems: string[];
  let unsub: () => void;
  beforeEach(() => {
    db = openDb(':memory:');
    problems = [];
    unsub = subscribeAdminEvents((e) => { if (e.kind === 'problem') problems.push(e.text); });
  });
  afterEach(() => unsub());

  function seed(perSide: number): { matchId: number; dump: Dump } {
    const ids = [...IDS.slice(0, perSide), ...IDS.slice(4, 4 + perSide)];
    for (const id of ids) upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
    const matchId = Number(
      db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'live', 'no_mercy')").run().lastInsertRowid,
    );
    const ins = db.prepare("INSERT INTO match_players (match_id, player_id, team, source) VALUES (?, ?, ?, 'udp')");
    ids.forEach((id, i) => ins.run(matchId, id, i < perSide ? 'a' : 'b'));
    const dump = dumpFor(matchId);
    dump.players = dump.players.filter((p) => ids.includes(p.steamid));
    return { matchId, dump };
  }

  it('completes a 1v1 with its result and no rating change', () => {
    const { matchId, dump } = seed(1);
    expect(completeMatch(db, matchId, dump)).toBe(true);
    expect((db.prepare('SELECT state, winner FROM matches WHERE id = ?').get(matchId) as any)).toEqual({ state: 'completed', winner: 'b' });
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 0 });
    expect(problems.some((t) => t.includes(`#${matchId}`) && /unrated/i.test(t))).toBe(true);
  });

  it('rates a 2v2', () => {
    const { matchId, dump } = seed(2);
    completeMatch(db, matchId, dump);
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 4 });
    expect(problems).toEqual([]);
  });

  it('counts only rated players toward the minimum: a forged second player does not make a 1v1 a 2v2', () => {
    const { matchId, dump } = seed(1);
    for (const [id, team] of [['76561199000000091', 'a'], ['76561199000000092', 'b']] as const) {
      upsertPlayer(db, { steamid: id, name: 'forged', avatar: null }, []);
      db.prepare("INSERT INTO match_players (match_id, player_id, team, source) VALUES (?, ?, ?, 'udp')").run(matchId, id, team);
    }
    completeMatch(db, matchId, dump);
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 0 });
  });

  it('counts a sub who played too little as not rated toward the minimum', () => {
    const { matchId, dump } = seed(2);
    // Two maps in dumpFor; joining on map 2 of 2 is under half.
    dump.players[1] = { ...dump.players[1], joinedMap: 2 };
    completeMatch(db, matchId, dump);
    expect(db.prepare('SELECT COUNT(*) n FROM rating_history WHERE match_id = ?').get(matchId)).toEqual({ n: 0 });
  });
});
