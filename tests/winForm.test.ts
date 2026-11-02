import { describe, it, expect } from 'vitest';
import { buildWinModel, winChance, type HalfRow, type PlayedHalf } from '../src/winProb.js';
import { halfPercentile, teamForm, tilt, type FormParams } from '../src/winForm.js';

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

const PARAMS: FormParams = { survivor: 0.5, infected: 0, siDamage: 0, shrink: 2, calibration: 1 };

const mean = (d: Float64Array) => d.reduce((s, p, i) => s + p * i, 0);
const sum = (d: Float64Array) => d.reduce((s, p) => s + p, 0);

describe('tilt', () => {
  const model = buildWinModel(history());
  const d = model.dist('m1');

  it('leaves the distribution as it is at zero', () => {
    expect([...tilt(d, 0)]).toEqual([...d]);
  });

  it('moves the mean up for a positive tilt, down for a negative one, and keeps a distribution', () => {
    const up = tilt(d, 0.5);
    const down = tilt(d, -0.5);
    expect(mean(up)).toBeGreaterThan(mean(d));
    expect(mean(down)).toBeLessThan(mean(d));
    expect(sum(up)).toBeCloseTo(1, 9);
    expect(sum(down)).toBeCloseTo(1, 9);
  });

  it('leaves a single spike alone, since it has no spread to tilt along', () => {
    const spike = new Float64Array(5);
    spike[2] = 1;
    expect([...tilt(spike, 1)]).toEqual([...spike]);
  });
});

describe('halfPercentile', () => {
  const model = buildWinModel(history());

  it('rises with the score and stays inside 0..1', () => {
    const ps = [0, 60, 300, 640, 760, 2000].map((s) => halfPercentile(model, 'm1', s));
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThanOrEqual(ps[i - 1]);
    expect(ps[0]).toBeGreaterThanOrEqual(0);
    expect(ps.at(-1)!).toBeLessThanOrEqual(1);
  });

  it('puts a top make high and a wipe low', () => {
    expect(halfPercentile(model, 'm1', 720)).toBeGreaterThan(0.8);
    expect(halfPercentile(model, 'm1', 40)).toBeLessThan(0.2);
  });
});

describe('teamForm', () => {
  const model = buildWinModel(history());
  const top = (ordinal: number, half: number, survTeam: 'a' | 'b'): PlayedHalf =>
    ({ ordinal, half, survTeam, score: 740, map: 'm1' });
  const typical = (ordinal: number, half: number, survTeam: 'a' | 'b'): PlayedHalf =>
    ({ ordinal, half, survTeam, score: 340, map: 'm1' });

  it('is zero before anything is played, so the opening point is today\'s', () => {
    expect(teamForm(model, [], undefined, PARAMS)).toEqual({ a: 0, b: 0 });
    expect(winChance(model, 0, ['m1', 'm2'], ['m1', 'm2'], { tiltA: 0, tiltB: 0 }))
      .toBe(winChance(model, 0, ['m1', 'm2'], ['m1', 'm2']));
  });

  it('tilts a team up after two top survivor halves, and lifts its chance', () => {
    const played = [top(0, 1, 'a'), typical(0, 2, 'b'), typical(1, 1, 'b'), top(1, 2, 'a')];
    const form = teamForm(model, played, undefined, PARAMS);
    expect(form.a).toBeGreaterThan(0);
    const plain = winChance(model, 0, ['m1', 'm2'], ['m1', 'm2'], { calibration: 1 });
    const withForm = winChance(model, 0, ['m1', 'm2'], ['m1', 'm2'], { tiltA: form.a, tiltB: form.b, calibration: 1 });
    expect(withForm).toBeGreaterThan(plain);
  });

  it('shrinks toward zero with fewer halves played', () => {
    const one = teamForm(model, [top(0, 1, 'a')], undefined, PARAMS).a;
    const two = teamForm(model, [top(0, 1, 'a'), typical(0, 2, 'b'), typical(1, 1, 'b'), top(1, 2, 'a')], undefined, PARAMS).a;
    expect(one).toBeGreaterThan(0);
    expect(two).toBeGreaterThan(one);
  });

  it('counts a team\'s infected form against the other team\'s survivor halves', () => {
    const infectedOnly: FormParams = { ...PARAMS, survivor: 0, infected: 0.5 };
    // B held A to wipes: B's infected form is good, so A's halves to come tilt down.
    const wipes = [{ ...typical(0, 1, 'a'), score: 40 }, typical(0, 2, 'b')];
    expect(teamForm(model, wipes, undefined, infectedOnly).a).toBeLessThan(0);
  });

  it('counts SI damage dealt by a team against the other team\'s halves to come', () => {
    const siOnly: FormParams = { ...PARAMS, survivor: 0, siDamage: 0.5 };
    const played = [typical(0, 1, 'a'), typical(0, 2, 'b')];
    // B's infected (in A's half 0:1) dealt 50% more than the map's norm.
    const form = teamForm(model, played, new Map([['0:1', 0.5]]), siOnly);
    expect(form.a).toBeLessThan(0);
    expect(form.b).toBe(0);
  });

  it('keeps the chance antisymmetric: swapping the teams mirrors it', () => {
    const played = [top(0, 1, 'a'), typical(0, 2, 'b')];
    const swapped = played.map((r) => ({ ...r, survTeam: r.survTeam === 'a' ? 'b' as const : 'a' as const }));
    const f = teamForm(model, played, undefined, PARAMS);
    const g = teamForm(model, swapped, undefined, PARAMS);
    expect(g).toEqual({ a: f.b, b: f.a });
    const p = winChance(model, 400, ['m2'], ['m2'], { tiltA: f.a, tiltB: f.b, calibration: 1.1 });
    const q = winChance(model, -400, ['m2'], ['m2'], { tiltA: g.a, tiltB: g.b, calibration: 1.1 });
    expect(p + q).toBeCloseTo(1, 9);
  });
});
