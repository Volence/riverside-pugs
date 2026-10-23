import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { currentSeasonId } from '../src/players.js';
import {
  clampRedistribute, computeMultipliers, foldMirrors, mirrorOriginal, multiplierFor, roundToStep,
  SEASON_RATES_SQL, versusLadder, type LadderMap, type MapRate, type SeasonMultiplierTable,
} from '../src/mapMultipliers.js';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('clampRedistribute', () => {
  it('leaves values already in range alone', () => {
    expect(clampRedistribute([1, 1.2, 1.4, 1.5], 0.75, 1.75)).toEqual([1, 1.2, 1.4, 1.5]);
  });

  it('caps a value and shares its excess over the rest in proportion, keeping the total', () => {
    const out = clampRedistribute([0.5, 1, 2.5], 0, 2);
    expect(out[2]).toBe(2);
    // 0.5 excess over 0.5 and 1 (total 1.5): +1/6 and +1/3.
    expect(out[0]).toBeCloseTo(0.5 + 0.5 / 3, 12);
    expect(out[1]).toBeCloseTo(1 + 1 / 3, 12);
    expect(sum(out)).toBeCloseTo(4, 12);
  });

  it('raises a value under the floor and takes the shortfall from the others', () => {
    const out = clampRedistribute([0.5, 1.5, 2], 0.75, 1.75);
    expect(out[0]).toBe(0.75);
    expect(sum(out)).toBeCloseTo(4, 12);
    expect(out.every((v) => v >= 0.75 - 1e-12 && v <= 1.75 + 1e-12)).toBe(true);
  });

  it('repeats when the share pushes another value over', () => {
    // 3.0 caps at 1.75 (1.25 excess); 1.6 then goes over too.
    const out = clampRedistribute([3, 1.6, 0.8, 0.8], 0.75, 1.75);
    expect(out[0]).toBe(1.75);
    expect(out[1]).toBe(1.75);
    expect(sum(out)).toBeCloseTo(6.2, 12);
    expect(out[2]).toBeCloseTo(out[3], 12);
  });

  it('pins everything when the total cannot fit', () => {
    expect(clampRedistribute([5, 5], 0.75, 1.75)).toEqual([1.75, 1.75]);
  });
});

describe('roundToStep', () => {
  it('rounds to the nearest 0.05 without float dust', () => {
    expect(roundToStep(1.592, 0.05)).toBe(1.6);
    expect(roundToStep(0.765, 0.05)).toBe(0.75);
    expect(roundToStep(1.341, 0.05)).toBe(1.35);
    expect(roundToStep(1.375, 0.05)).toBe(1.4);
    expect(String(roundToStep(1.15 + 1e-9, 0.05))).toBe('1.15');
  });
});

const ladder = (mission: string, maps: string[], mods = [1, 1.2, 1.4, 1.5, 2]): LadderMap[] =>
  maps.map((map, i) => ({ map, mission, chapter: i + 1, chapters: maps.length, modifier: mods[i] }));
const rate = (map: string, r: number, matches = 120): MapRate => ({ map, matches, rounds: 1000, madeIt: Math.round(r * 1000) });

describe('computeMultipliers', () => {
  const da = ladder('Airport', ['a1', 'a2', 'a3', 'a4', 'a5']);

  it('reproduces Dead Air from the Season 0 saferoom rates (owner table 2026-10-23)', () => {
    const rates = new Map([rate('a1', 0.512), rate('a2', 0.246), rate('a3', 0.214), rate('a4', 0.394)].map((r) => [r.map, r]));
    const rows = computeMultipliers(da, rates);
    expect(rows.map((r) => r.after)).toEqual([0.75, 1.6, 1.75, 1, 2]);
    // The unrounded values keep the campaign's sum (5.1 over the four played maps).
    expect(sum(rows.slice(0, 4).map((r) => r.exact!))).toBeCloseTo(5.1, 9);
    expect(rows[4]).toMatchObject({ recalculated: false, after: 2, exact: null });
  });

  it('keeps the ladder for a map under the match threshold, and scales the rest to their own sum', () => {
    const rates = new Map([rate('a1', 0.3), rate('a2', 0.3), rate('a3', 0.15, 49), rate('a4', 0.3)].map((r) => [r.map, r]));
    const rows = computeMultipliers(da, rates);
    expect(rows[2]).toMatchObject({ after: 1.4, recalculated: false });
    // a1, a2, a4 equal rates: (1 + 1.2 + 1.5) / 3 each.
    expect(rows[0].after).toBe(roundToStep(3.7 / 3, 0.05));
    expect(rows[0].after).toBe(rows[1].after);
  });

  it('never recalculates a map nobody finished', () => {
    const rates = new Map([rate('a1', 0), rate('a2', 0.3), rate('a3', 0.3), rate('a4', 0.3)].map((r) => [r.map, r]));
    expect(computeMultipliers(da, rates)[0]).toMatchObject({ after: 1, recalculated: false });
  });

  it('leaves a campaign with no qualifying map untouched', () => {
    const rows = computeMultipliers(da, new Map());
    expect(rows.map((r) => r.after)).toEqual([1, 1.2, 1.4, 1.5, 2]);
  });
});

describe('mirrors', () => {
  const known = new Set(['l4d_vs_hospital01_apartment', 'c1m1_hotel', 'l4d_garage01_alleys']);

  it('maps a mirror name to its original only when the original is known', () => {
    expect(mirrorOriginal('l4d_vs_mhospital01_apartment', known)).toBe('l4d_vs_hospital01_apartment');
    expect(mirrorOriginal('mc1m1_hotel', known)).toBe('c1m1_hotel');
    expect(mirrorOriginal('l4d_mgarage01_alleys', known)).toBe('l4d_garage01_alleys');
    expect(mirrorOriginal('l4d_vs_hospital01_apartment', known)).toBeNull();
    expect(mirrorOriginal('l4d_vs_mystery01', known)).toBeNull();
  });

  it('folds a mirror\'s rounds into its original', () => {
    const folded = foldMirrors([
      { map: 'l4d_vs_hospital01_apartment', matches: 40, rounds: 80, madeIt: 20 },
      { map: 'l4d_vs_mhospital01_apartment', matches: 20, rounds: 40, madeIt: 10 },
    ], known);
    expect(folded.get('l4d_vs_hospital01_apartment')).toEqual({ map: 'l4d_vs_hospital01_apartment', matches: 60, rounds: 120, madeIt: 30 });
    expect(folded.size).toBe(1);
  });

  it('answers a mirror with its original\'s line', () => {
    const table: SeasonMultiplierTable = {
      season: 'Season 1', basedOn: 'Season 0', computedAt: '', rules: { minMatches: 50, min: 0.75, max: 1.75, step: 0.05 },
      maps: [{ map: 'l4d_vs_hospital01_apartment', mission: 'Hospital', chapter: 1, before: 1, after: 1.15, exact: 1.156, saferoomRate: 0.356, matches: 110, rounds: 216, recalculated: true }],
    };
    expect(multiplierFor(table, 'l4d_vs_mhospital01_apartment')).toEqual({ after: 1.15, before: 1, saferoomRate: 0.356, matches: 110, recalculated: true });
    expect(multiplierFor(table, 'c5m1_waterfront')).toBeNull();
  });
});

describe('versusLadder', () => {
  it('reads the versus chapters and their VersusModifier, defaulting to 1', () => {
    const text = `"mission" { "Name" "Hospital" "modes" {
      "coop" { "1" { "Map" "l4d_hospital01_apartment" } }
      "versus" {
        "2" { "Map" "l4d_vs_hospital02_subway" "VersusModifier" "1.2" }
        "1" { "Map" "l4d_vs_hospital01_apartment" }
      } } }`;
    expect(versusLadder(text)).toEqual([
      { map: 'l4d_vs_hospital01_apartment', mission: 'Hospital', chapter: 1, chapters: 2, modifier: 1 },
      { map: 'l4d_vs_hospital02_subway', mission: 'Hospital', chapter: 2, chapters: 2, modifier: 1.2 },
    ]);
  });
});

describe('SEASON_RATES_SQL', () => {
  it('counts completed matches of the season and rounds with any survivor alive', () => {
    const db = openDb(':memory:');
    const season = currentSeasonId(db);
    const match = (state: string, rounds: (number | null)[]) => {
      const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, ?, 'no_mercy')").run(season, state).lastInsertRowid);
      db.prepare("INSERT INTO match_maps (match_id, ordinal, map) VALUES (?, 1, 'l4d_vs_hospital01_apartment')").run(id);
      rounds.forEach((alive, half) => db.prepare(
        "INSERT INTO match_rounds (match_id, ordinal, half, surv_team, survivors_alive) VALUES (?, 1, ?, 'a', ?)",
      ).run(id, half + 1, alive));
    };
    match('completed', [4, 0]);
    match('completed', [1, null]);
    match('aborted', [4, 4]);
    const rows = db.prepare(SEASON_RATES_SQL).all(season);
    expect(rows).toEqual([{ map: 'l4d_vs_hospital01_apartment', matches: 2, rounds: 3, madeIt: 2 }]);
  });
});

describe('/api/maps multipliers', () => {
  it('shows the committed table only once Season 1 is live, mirrors included', async () => {
    const { loadConfig } = await import('../src/config.js');
    const { buildServer } = await import('../src/server.js');
    const { stubOrchestrator } = await import('./helpers.js');
    const db = openDb(':memory:');
    const app = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    try {
      const season = currentSeasonId(db);
      for (const map of ['l4d_vs_smalltown03_ranchhouse', 'l4d_vs_mhospital01_apartment', 'c2m1_highway']) {
        const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (?, 'completed', 'x')").run(season).lastInsertRowid);
        db.prepare('INSERT INTO match_maps (match_id, ordinal, map) VALUES (?, 1, ?)').run(id, map);
      }
      const get = (url: string) => app.inject({ method: 'GET', url }).then((r) => r.json());
      expect((await get('/api/maps')).multipliers).toBeNull();
      expect((await get('/api/maps/l4d_vs_smalltown03_ranchhouse')).multiplier).toBeNull();

      db.prepare('UPDATE seasons SET ranks = 1').run();
      const m = (await get('/api/maps')).multipliers;
      expect(m).toMatchObject({ season: 'Season 1', basedOn: 'Season 0', min: 0.75, max: 1.75, minMatches: 50 });
      expect(m.maps['l4d_vs_smalltown03_ranchhouse']).toMatchObject({ after: 1.75, before: 1.4, recalculated: true });
      expect(m.maps['l4d_vs_mhospital01_apartment']).toMatchObject({ after: 1.15, before: 1 });
      expect(m.maps['c2m1_highway']).toBeUndefined();
      expect((await get('/api/maps/l4d_vs_smalltown03_ranchhouse')).multiplier).toMatchObject({ after: 1.75 });
    } finally {
      await app.close();
    }
  });
});
