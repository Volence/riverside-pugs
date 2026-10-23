import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { upsertPlayer } from '../src/players.js';
import { balanceTeams, validSplits, type RatedPlayer } from '../src/balance.js';
import {
  STAT_BALANCE_MODEL, averageSiDamage, balanceLogSummary, chooseTeams, favourite, logBalance, playersMoved,
  recentBalanceLog, statBalanceConfig, statLines, statScore, statWinA,
} from '../src/statBalance.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

/** A finished match with the given SI damage per player. */
function finished(dmg: Record<string, number>, opts: { state?: string; kind?: string; voided?: boolean; season?: number } = {}): number {
  const id = Number(db.prepare(
    "INSERT INTO matches (season_id, state, campaign, kind, voided_at) VALUES (?, ?, 'no_mercy', ?, ?)",
  ).run(opts.season ?? 1, opts.state ?? 'completed', opts.kind ?? 'pug', opts.voided ? '2026-10-01 00:00:00' : null).lastInsertRowid);
  Object.entries(dmg).forEach(([p, d], i) => {
    upsertPlayer(db, { steamid: p, name: p, avatar: null }, []);
    db.prepare('INSERT INTO match_players (match_id, player_id, team, si_damage) VALUES (?, ?, ?, ?)').run(id, p, i % 2 ? 'b' : 'a', d);
  });
  return id;
}

const p = (steamid: string, mu: number, sigma = 5): RatedPlayer => ({ steamid, mu, sigma });

describe('S, the shrunk damage score', () => {
  it('shrinks by one average game and is zero under three games', () => {
    expect(STAT_BALANCE_MODEL.minGames).toBe(3);
    expect(statScore(9999, 1, 5000)).toBe(0);
    expect(statScore(12000, 2, 5000)).toBe(0);
    // (3*7000 + 5000) / 4 - 5000 = 1500
    expect(statScore(21000, 3, 5000)).toBeCloseTo(1500, 9);
    expect(statScore(0, 0, 5000)).toBe(0);
  });

  it('reads career completed, unvoided PUGs from every season', () => {
    finished({ x: 8000, y: 2000 });
    const s2 = Number(db.prepare("INSERT INTO seasons (name) VALUES ('Season 2')").run().lastInsertRowid);
    finished({ x: 8000, y: 2000 }, { season: s2 });
    finished({ x: 8000, y: 2000 });
    finished({ x: 99999, y: 99999 }, { voided: true });
    finished({ x: 99999, y: 99999 }, { kind: 'scrim' });
    finished({ x: 99999, y: 99999 }, { state: 'aborted' });
    finished({ z: 9999 }); // one freak game
    // Not real games: a row the rating step left out, and a sub from map 2.
    const unrated = finished({ x: 99999 });
    db.prepare("UPDATE match_players SET rated = 0 WHERE match_id = ?").run(unrated);
    const sub = finished({ x: 99999 });
    db.prepare("UPDATE match_players SET joined_map = 1 WHERE match_id = ?").run(sub);
    const avg = averageSiDamage(db);
    expect(avg).toBeCloseTo((3 * 8000 + 3 * 2000 + 9999) / 7, 6);
    const lines = statLines(db, ['x', 'y', 'z', 'nobody'], avg);
    expect(lines.get('x')!.games).toBe(3);
    expect(lines.get('x')!.rawPerGame).toBe(8000);
    expect(lines.get('x')!.shrunkPerGame).toBeCloseTo((24000 + avg) / 4, 6);
    expect(lines.get('x')!.s).toBeCloseTo((24000 + avg) / 4 - avg, 6);
    expect(lines.get('y')!.s).toBeLessThan(0);
    expect(lines.get('z')!.games).toBe(1);
    expect(lines.get('z')!.s).toBe(0);
    expect(lines.get('nobody')).toMatchObject({ games: 0, rawPerGame: null, s: 0 });
  });
});

describe('the stat-aware odds', () => {
  it('uses the fitted logit per team-total gap', () => {
    const mu = new Map([['a', 30], ['b', 25]]);
    const s = new Map([['a', 1000], ['b', 0]]);
    const z = STAT_BALANCE_MODEL.perMu * 5 + STAT_BALANCE_MODEL.perDamage * 1000;
    expect(statWinA(['a'], ['b'], mu, s)).toBeCloseTo(1 / (1 + Math.exp(-z)), 12);
    expect(statWinA(['b'], ['a'], mu, s)).toBeCloseTo(1 / (1 + Math.exp(z)), 12);
  });

  it('counts a mirrored split as nobody moved', () => {
    expect(playersMoved(['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h'])).toBe(0);
    expect(playersMoved(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'e'])).toBe(2);
    expect(playersMoved(['a', 'b', 'c', 'd'], ['a', 'b', 'e', 'f'])).toBe(4);
  });
});

// Eight equal ratings: every split is even by rating, so only stats can tell
// them apart. Two damage stars landing together is what the gate is for.
const EVEN = ['s1', 's2', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id) => p(id, 25));

describe('chooseTeams', () => {
  const on = { enabled: true, gate: 0.6, tolerance: 0.05 };
  const off = { ...on, enabled: false };

  it('off: the chosen split is exactly balanceTeams', () => {
    const players = [p('a', 35), p('b', 33), p('c', 31), p('d', 29), p('e', 24), p('f', 22), p('g', 20), p('h', 18)];
    const s = new Map(players.map((x, i) => [x.steamid, i * 400 - 1000]));
    const d = chooseTeams(players, s, off);
    const best = balanceTeams(players);
    expect(d.chosen.teamA).toEqual(best.teamA);
    expect(d.chosen.teamB).toEqual(best.teamB);
    expect(d.chosen.pWinA).toBe(best.pWinA);
    expect(d.gateFired).toBe(false);
    expect(d.moved).toBe(0);
  });

  it('under the gate the rating-best split stays even when enabled', () => {
    const s = new Map(EVEN.map((x) => [x.steamid, 0]));
    const d = chooseTeams(EVEN, s, on);
    expect(d.overGate).toBe(false);
    expect(d.gateFired).toBe(false);
    expect(d.chosen.teamA).toEqual(d.ratingBest.teamA);
  });

  it('over the gate, picks the split closest to 50% by stats within the rating tolerance', () => {
    // balanceTeams on equal players takes the first split, s1 s2 p1 p2: both
    // stars together, about 4000 damage of S ahead, stat odds ~78%.
    const s = new Map([['s1', 2000], ['s2', 2000], ...EVEN.slice(2).map((x) => [x.steamid, 0] as [string, number])]);
    const d = chooseTeams(EVEN, s, on);
    expect(d.ratingBest.teamA.slice(0, 2)).toEqual(['s1', 's2']);
    expect(favourite(d.ratingBest.statA)).toBeGreaterThan(0.6);
    expect(d.gateFired).toBe(true);
    expect(d.chosen.teamA.includes('s1')).not.toBe(d.chosen.teamA.includes('s2'));
    expect(d.chosen.statA).toBeCloseTo(0.5, 9);
    expect(d.moved).toBe(2);
  });

  it('never leaves the rating tolerance', () => {
    // The stars are also the top-rated pair: splitting them costs rating
    // balance. With 0 tolerance the only candidates are the rating ties.
    const players = [p('s1', 30), p('s2', 30), p('a', 25), p('b', 25), p('c', 25), p('d', 25), p('e', 20), p('f', 20)];
    const s = new Map(players.map((x) => [x.steamid, x.steamid.startsWith('s') ? 3000 : 0]));
    const tight = chooseTeams(players, s, { ...on, tolerance: 0 });
    const loose = chooseTeams(players, s, { ...on, tolerance: 0.2 });
    const limit = (tol: number) => Math.abs(tight.ratingBest.pWinA - 0.5) + tol + 1e-12;
    expect(Math.abs(tight.chosen.pWinA - 0.5)).toBeLessThanOrEqual(limit(0));
    expect(Math.abs(loose.chosen.pWinA - 0.5)).toBeLessThanOrEqual(limit(0.2));
    expect(Math.abs(loose.chosen.statA - 0.5)).toBeLessThanOrEqual(Math.abs(tight.chosen.statA - 0.5));
    // Brute force: nothing inside the tolerance is closer to even by stats.
    const mu = new Map(players.map((x) => [x.steamid, x.mu]));
    for (const sp of validSplits(players)) {
      if (Math.abs(sp.pWinA - 0.5) > limit(0.2)) continue;
      expect(Math.abs(statWinA(sp.teamA, sp.teamB, mu, s) - 0.5)).toBeGreaterThanOrEqual(Math.abs(loose.chosen.statA - 0.5) - 1e-12);
    }
  });

  it('keeps every duo together', () => {
    const s = new Map([['s1', 2000], ['s2', 2000], ...EVEN.slice(2).map((x) => [x.steamid, 0] as [string, number])]);
    // A duo of the two stars: the tie-break may not split them.
    const d = chooseTeams(EVEN, s, on, { groups: [['s1', 's2']] });
    expect(d.chosen.teamA.includes('s1')).toBe(d.chosen.teamA.includes('s2'));
    // A star duoed with a plain player: they stay together while the other star crosses over.
    const d2 = chooseTeams(EVEN, s, on, { groups: [['s1', 'p6']] });
    expect(d2.chosen.teamA.includes('s1')).toBe(d2.chosen.teamA.includes('p6'));
    expect(d2.chosen.teamA.includes('s1')).not.toBe(d2.chosen.teamA.includes('s2'));
  });
});

describe('settings', () => {
  it('ship off at gate 60 and tolerance 5', () => {
    expect(statBalanceConfig(db)).toEqual({ enabled: false, gate: 0.6, tolerance: 0.05 });
    setSetting(db, 'balance_stats_enabled', '1');
    setSetting(db, 'balance_stats_gate_pct', '65');
    setSetting(db, 'balance_stats_tolerance_pts', '3');
    expect(statBalanceConfig(db)).toEqual({ enabled: true, gate: 0.65, tolerance: 0.03 });
  });
});

describe('the log', () => {
  it('writes a row and summarises results joined from matches', () => {
    const s = new Map([['s1', 2000], ['s2', 2000], ...EVEN.slice(2).map((x) => [x.steamid, 0] as [string, number])]);
    const cfg = { enabled: true, gate: 0.6, tolerance: 0.05 };
    const d = chooseTeams(EVEN, s, cfg);
    const id = finished(Object.fromEntries(EVEN.map((x) => [x.steamid, 1000])));
    db.prepare("UPDATE matches SET winner = ? WHERE id = ?").run(d.chosen.statA >= 0.5 ? 'b' : 'a', id);
    logBalance(db, id, cfg, 5000, d, EVEN.map((x) => ({
      steamid: x.steamid, mu: x.mu, sigma: x.sigma, balanceMu: x.mu, games: 0, rawPerGame: null, shrunkPerGame: 5000, s: s.get(x.steamid)!,
    })));
    const row = db.prepare('SELECT * FROM match_balance_log WHERE match_id = ?').get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ enabled: 1, gate_fired: 1, over_gate: 1, moved: 2, stat_avg: 5000 });
    expect(JSON.parse(String(row.best_team_a))).toEqual(d.ratingBest.teamA);
    expect(JSON.parse(String(row.chosen_team_a))).toEqual(d.chosen.teamA);
    expect(JSON.parse(String(row.players_json))).toHaveLength(8);

    // A second match logged with the switch off and over the gate, won by its favourite.
    const d2 = chooseTeams(EVEN, s, { ...cfg, enabled: false });
    const id2 = finished(Object.fromEntries(EVEN.map((x) => [x.steamid, 1000])));
    db.prepare("UPDATE matches SET winner = ? WHERE id = ?").run(d2.chosen.statA >= 0.5 ? 'a' : 'b', id2);
    logBalance(db, id2, { ...cfg, enabled: false }, 5000, d2, []);

    const sum = balanceLogSummary(db);
    expect(sum.logged).toBe(2);
    expect(sum.enabledMatches).toBe(1);
    expect(sum.gateFireRate).toBe(1);
    expect(sum.firedChosen).toMatchObject({ matches: 1, decided: 1, favWon: 0 });
    expect(sum.firedRatingBestPredicted!).toBeGreaterThan(0.6);
    expect(sum.offOverGate).toMatchObject({ matches: 1, decided: 1, favWon: 1 });
    expect(recentBalanceLog(db, 10).map((r) => r.matchId)).toEqual([id2, id]);
  });
});
