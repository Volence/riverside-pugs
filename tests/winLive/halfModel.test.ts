import { describe, it, expect } from 'vitest';
import { BIN, buildWinModel, winChance, type HalfRow, type WinModel } from '../../src/winProb.js';
import { tilt } from '../../src/winForm.js';
import type { Snapshot } from '../../src/winLive/snapshot.js';
import {
  FEATURES, HALF_PARAMS, predictHalf, wipeScore, type HalfModelParams,
} from '../../src/winLive/halfModel.js';

/** Same shape as tests/winProb.test.ts: makes several times a wipe, m2
 *  easier than m1. */
function history(): HalfRow[] {
  const rows: HalfRow[] = [];
  for (let i = 0; i < 60; i++) {
    rows.push({ map: 'm1', score: i % 3 === 0 ? 600 + (i % 7) * 20 : 40 + (i % 5) * 10, made: i % 3 === 0 });
    rows.push({ map: 'm2', score: i % 2 === 0 ? 800 + (i % 7) * 20 : 60 + (i % 5) * 10, made: i % 2 === 0 });
  }
  return rows;
}

/** Hand-built params (ruling R5): each feature leans every class by its
 *  place in the score order, so a positive strength pushes toward higher
 *  scores. Progress and a beaten tank help; lost health, deaths and downs hurt. */
const CLASS_EDGES = [0.04, 0.08, 0.12, 0.25, 0.7, 1.0, 1.3];
const STRENGTH: Record<(typeof FEATURES)[number], number> = {
  prog: 2, prog25: 0, prog50: 0, prog75: 0, aliveLost: -1, down: -0.5, healthLost: -0.4, tankDone: 0.5,
  half2Prog: 0, time: 0, time2m: 0, time5m: 0,
};
const K = CLASS_EDGES.length + 1;
const PARAMS: HalfModelParams = {
  classEdges: CLASS_EDGES,
  features: [...FEATURES],
  weights: Array.from({ length: K }, (_, c) => FEATURES.map((f) => STRENGTH[f] * (c - (K - 1) / 2) / ((K - 1) / 2))),
  wipePerProg: 0.13,
  floorPerProg: 0.05,
  wipeTop: 0.25,
  progByTime: { stepMs: 60_000, quantiles: [[0, 0, 0, 0, 0], [5, 10, 15, 20, 25], [10, 20, 30, 40, 50]] },
};

const START: Snapshot = {
  tMs: 0, prog: 0, alive: 4, down: 0, health: 400, tank: 'pending', tankHealthFrac: null, tankFlowGap: null,
};

const mean = (d: Float64Array) => d.reduce((s, p, i) => s + p * i, 0);
const sum = (d: Float64Array) => d.reduce((s, p) => s + p, 0);
const tv = (a: Float64Array, b: Float64Array) => a.reduce((s, p, i) => s + Math.abs(p - b[i]), 0) / 2;

/** The model with one extra "map" whose distribution is `d`, so winChance
 *  can price a predicted half against a whole half on m1. */
function withHalf(model: WinModel, d: Float64Array): WinModel {
  return { ...model, dist: (map) => (map === 'live' ? d : model.dist(map)) };
}

describe('predictHalf', () => {
  const model = buildWinModel(history());

  it('is the tilted base distribution exactly with no snapshot', () => {
    expect([...predictHalf(model, PARAMS, 'm1', 0, null)]).toEqual([...model.dist('m1')]);
    expect([...predictHalf(model, PARAMS, 'm1', 0.4, null)]).toEqual([...tilt(model.dist('m1'), 0.4)]);
  });

  it('stays on the base distribution at the start of the half', () => {
    for (const theta of [0, 0.3]) {
      const base = predictHalf(model, PARAMS, 'm1', theta, null);
      expect(tv(predictHalf(model, PARAMS, 'm1', theta, START), base)).toBeLessThan(0.02);
    }
  });

  it('barely moves when the tank spawns at full health', () => {
    const before = { ...START, prog: 40, health: 350 };
    const after: Snapshot = { ...before, tank: 'alive', tankHealthFrac: 1 };
    const chance = (s: Snapshot) => winChance(withHalf(model, predictHalf(model, PARAMS, 'm1', 0, s)), 0, ['live'], ['m1']);
    expect(Math.abs(chance(after) - chance(before))).toBeLessThan(0.03);
  });

  it('moves with the state: less health lowers the mean, more progress raises it', () => {
    const mid = { ...START, prog: 50, health: 320 };
    const at = (s: Snapshot) => mean(predictHalf(model, PARAMS, 'm1', 0, s));
    expect(at({ ...mid, health: 150 })).toBeLessThan(at(mid));
    expect(at({ ...mid, prog: 80 })).toBeGreaterThan(at(mid));
    expect(at({ ...mid, alive: 3, health: 240 })).toBeLessThan(at(mid));
    expect(at({ ...mid, tank: 'dead' })).toBeGreaterThan(at(mid));
  });

  it('keeps a distribution', () => {
    const d = predictHalf(model, PARAMS, 'm1', 0.2, { ...START, prog: 70, health: 90, alive: 2, down: 1, tank: 'alive', tankHealthFrac: 0.4 });
    expect(sum(d)).toBeCloseTo(1, 9);
    expect([...d].every((p) => p >= 0)).toBe(true);
  });

  it('never leaves a wiped score below what the distance already reached guarantees', () => {
    const prog = 80;
    const d = predictHalf(model, PARAMS, 'm1', 0, { ...START, prog, health: 60, alive: 1 });
    const floorBin = Math.floor((PARAMS.floorPerProg * prog / 100) * model.scale('m1') / BIN);
    for (let i = 0; i < floorBin; i++) expect(d[i]).toBe(0);
  });

  it('is a point mass at the wipe score for its progress once everyone is dead', () => {
    const d = predictHalf(model, PARAMS, 'm1', 0, { ...START, prog: 60, alive: 0, health: 0 });
    const peak = d.indexOf(Math.max(...d));
    expect(d[peak]).toBeCloseTo(1, 9);
    expect(Math.abs(peak * BIN - wipeScore(model, PARAMS, 'm1', 60))).toBeLessThanOrEqual(BIN);
  });

  it('marginalises progress it does not know rather than calling it 0%', () => {
    const late = { ...START, tMs: 120_000, health: 380 };
    const unknown = mean(predictHalf(model, PARAMS, 'm1', 0, { ...late, prog: null }));
    const zero = mean(predictHalf(model, PARAMS, 'm1', 0, { ...late, prog: 0 }));
    const known = mean(predictHalf(model, PARAMS, 'm1', 0, { ...late, prog: 30 }));
    expect(unknown).toBeGreaterThan(zero);
    expect(unknown).toBeCloseTo(known, -1);
  });

  it('uses the pooled shape for a map with no history and does not throw', () => {
    const d = predictHalf(model, PARAMS, 'unknown_map', 0, { ...START, prog: 50, health: 300 });
    expect(sum(d)).toBeCloseTo(1, 9);
    expect([...predictHalf(model, PARAMS, 'unknown_map', 0, null)]).toEqual([...model.dist('unknown_map')]);
  });

  it('returns the base for every snapshot when all weights are zero and the wipe rules are off', () => {
    const neutral: HalfModelParams = {
      ...PARAMS, weights: PARAMS.weights.map((w) => w.map(() => 0)), wipePerProg: 0, floorPerProg: 0,
    };
    const base = model.dist('m1');
    for (const s of [START, { ...START, prog: 90, alive: 0, health: 0 }, { ...START, prog: null, tMs: 90_000 }]) {
      expect(tv(predictHalf(model, neutral, 'm1', 0, s), base)).toBeLessThan(1e-12);
    }
  });

  it('ships neutral params until the validated fit replaces them', () => {
    expect(HALF_PARAMS.features).toEqual([...FEATURES]);
    expect(HALF_PARAMS.weights).toHaveLength(HALF_PARAMS.classEdges.length + 1);
    const s: Snapshot = { ...START, tMs: 200_000, prog: 70, health: 120, alive: 2, tank: 'dead' };
    expect(tv(predictHalf(model, HALF_PARAMS, 'm2', 0, s), model.dist('m2'))).toBeLessThan(1e-12);
  });
});
