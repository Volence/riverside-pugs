// scripts/win-backtest.ts
// Backtest the win chance line on a copy of the prod DB.
// Usage: npx tsx scripts/win-backtest.ts --db <copy of prod pug.db> --part form [--write]
//
// The split is the one from 2026-10-10: completed, unvoided PUGs ordered by
// ended_at, the oldest 70% train and the newest 30% test. The base model
// (buildWinModel) is built from train halves only, so test matches are
// priced from history they could have had.
//
// Every half-end point of a match is scored against its result, the opening
// point included and the last one left out (nothing is left to predict
// there; it is 1 or 0 for every model). Drawn matches are left out. Matches
// whose score cannot carry a line (matchWinLine null) are left out too.
//
// The reliability gate: every 10%-wide bin of calls with at least
// GATE_MIN_N points must have been won within GATE_MAX_POINTS of its mean
// call. Each model scored prints PASS or FAIL with the bins that miss.
//
// Train points are priced by a base model built from those same halves, so
// their percentiles are in-sample. That biases the fitted strengths only;
// test scoring uses a model that never saw the test halves.
//
// --part form fits FormParams (src/winForm.ts) on train by maximum likelihood,
// a coarse grid then coordinate descent, and prints Brier, log loss and a
// 10-bin reliability table on test for: today's model, today's model with
// its temperature refitted on train (to tell form from recalibration), form
// without SI damage, and form with and without SI damage on matches with
// data feeds.
//
// Feeds (match_si_lives) only exist from about match 628 on, which on the
// 2026-10-28 copy is entirely inside the test 30%, so SI damage cannot be
// fitted on the train split. It gets a split of its own inside the feed
// matches instead: the oldest 70% of them fit the SI damage strength (and a
// temperature, for form alone as well, so recalibration on newer matches is
// not mistaken for SI damage), the newest 30% judge it. The SI medians come
// from the fitting part only. SI damage stays in only if it lowers Brier on
// that newest 30% and passes the reliability gate there.
//
// --write saves the winner to src/winForm.fitted.json with "gate": "pass"
// when form has lower Brier than today's model on test AND passes the gate;
// otherwise it saves it with "gate": "fail", the Brier numbers and the bins
// that missed, as the record of why the setting stays off (the runtime loads
// the params either way; the win_chance_form setting is the guard).
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DB } from '../src/db.js';
import { completedPug } from '../src/matchKinds.js';
import {
  buildWinModel, CALIBRATION, matchWinLine, winChance, type HalfRow, type PlayedHalf, type WinModel,
} from '../src/winProb.js';
import { halfKey, teamForm, type FormParams } from '../src/winForm.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dbPath = arg('db');
const part = arg('part');
if (!dbPath || part !== 'form') {
  console.error('usage: tsx scripts/win-backtest.ts --db <copy of prod pug.db> --part form [--write]');
  process.exit(1);
}
if (resolve(dbPath).endsWith('/data/pug.db')) { console.error('refusing to run against data/pug.db; pass a copy with --db'); process.exit(1); }
const write = process.argv.includes('--write');
const db: DB = new Database(dbPath, { readonly: true });

/** A map needs this many train halves with feeds for its own SI damage median. */
const SI_MIN_HALVES = 10;
/** Reliability gate: bins with at least this many points ... */
const GATE_MIN_N = 30;
/** ... must be won within this many percentage points of their mean call. */
const GATE_MAX_POINTS = 5;
const TRAIN_SHARE = 0.7;

// ---- the split -------------------------------------------------------------

const matches = db.prepare(
  `SELECT id, team_a_score AS a, team_b_score AS b FROM matches m
   WHERE ${completedPug('m')} AND m.voided_at IS NULL ORDER BY m.ended_at, m.id`,
).all() as { id: number; a: number; b: number }[];
const cut = Math.round(matches.length * TRAIN_SHARE);
const trainIds = new Set(matches.slice(0, cut).map((m) => m.id));

const halfRows = (db.prepare(
  `SELECT mr.match_id AS matchId, mm.map AS map, mr.score AS score, mr.survivors_alive AS alive
   FROM match_rounds mr
   JOIN match_maps mm ON mm.match_id = mr.match_id AND mm.ordinal = mr.ordinal
   JOIN matches m ON m.id = mr.match_id
   WHERE ${completedPug('m')} AND m.voided_at IS NULL AND mr.reliable = 1`,
).all() as { matchId: number; map: string; score: number; alive: number | null }[]);
const trainHalves: HalfRow[] = halfRows.filter((r) => trainIds.has(r.matchId))
  .map((r) => ({ map: r.map, score: r.score, made: r.alive === null ? null : r.alive > 0 }));
const model: WinModel = buildWinModel(trainHalves);

// ---- SI damage per half, normalised to the map's train median ----------------

const siRows = db.prepare(
  `SELECT l.match_id AS matchId, l.ordinal, l.half, mm.map, SUM(l.dmg) AS dmg
   FROM match_si_lives l JOIN match_maps mm ON mm.match_id = l.match_id AND mm.ordinal = l.ordinal
   GROUP BY l.match_id, l.ordinal, l.half`,
).all() as { matchId: number; ordinal: number; half: number; map: string; dmg: number }[];
function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// The feed matches, oldest first, split for the SI damage fit (see the top).
const siMatchIds = new Set(siRows.map((r) => r.matchId));
const feedMatches = matches.filter((m) => siMatchIds.has(m.id) && m.a !== m.b);
const siFitIds = new Set(feedMatches.slice(0, Math.round(feedMatches.length * TRAIN_SHARE)).map((m) => m.id));
const trainSi = siRows.filter((r) => siFitIds.has(r.matchId));
const pooledSi = trainSi.length ? median(trainSi.map((r) => r.dmg)) : median(siRows.map((r) => r.dmg));
const siMedian = new Map<string, number>();
for (const map of new Set(trainSi.map((r) => r.map))) {
  const own = trainSi.filter((r) => r.map === map).map((r) => r.dmg);
  if (own.length >= SI_MIN_HALVES) siMedian.set(map, median(own));
}
const siByMatch = new Map<number, Map<string, number>>();
for (const r of siRows) {
  const norm = r.dmg / (siMedian.get(r.map) ?? pooledSi) - 1;
  let m = siByMatch.get(r.matchId);
  if (!m) siByMatch.set(r.matchId, m = new Map());
  m.set(halfKey(r.ordinal, r.half), norm);
}

// ---- the points to score -----------------------------------------------------

interface Point { matchId: number; train: boolean; feeds: boolean; siFit: boolean; n: number; gap: number; restA: string[]; restB: string[]; y: number }
interface MatchData { id: number; played: PlayedHalf[]; si?: Map<string, number> }

const roundsOf = db.prepare(
  `SELECT mr.ordinal, mr.half, mr.surv_team AS survTeam, mr.score, mm.map
   FROM match_rounds mr JOIN match_maps mm ON mm.match_id = mr.match_id AND mm.ordinal = mr.ordinal
   WHERE mr.match_id = ? ORDER BY mr.ordinal, mr.half`,
);
const points: Point[] = [];
const data = new Map<number, MatchData>();
let skipped = 0;
let draws = 0;
for (const m of matches) {
  if (m.a === m.b) { draws += 1; continue; }
  if (!matchWinLine(db, m.id, model)) { skipped += 1; continue; }
  const played = roundsOf.all(m.id) as PlayedHalf[];
  const si = siByMatch.get(m.id);
  data.set(m.id, { id: m.id, played, si });
  let gap = 0;
  for (let n = 0; n < played.length; n++) {
    if (n > 0) gap += played[n - 1].survTeam === 'a' ? played[n - 1].score : -played[n - 1].score;
    const later = played.slice(n);
    points.push({
      matchId: m.id, train: trainIds.has(m.id), feeds: si !== undefined, siFit: siFitIds.has(m.id), n, gap,
      restA: later.filter((r) => r.survTeam === 'a').map((r) => r.map),
      restB: later.filter((r) => r.survTeam === 'b').map((r) => r.map),
      y: m.a > m.b ? 1 : 0,
    });
  }
}

// ---- scoring -----------------------------------------------------------------

const logitOf = (p: number) => { const q = Math.min(1 - 1e-9, Math.max(1e-9, p)); return Math.log(q / (1 - q)); };
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Uncalibrated chance (temperature 1) for each point under `params`
 *  (null: no form). `useSi` passes the match's SI damage terms. */
function rawChances(pts: Point[], params: FormParams | null, useSi: boolean): number[] {
  return pts.map((pt) => {
    if (!params) return winChance(model, pt.gap, pt.restA, pt.restB, { calibration: 1 });
    const md = data.get(pt.matchId)!;
    const t = teamForm(model, md.played.slice(0, pt.n), useSi ? md.si : undefined, params);
    return winChance(model, pt.gap, pt.restA, pt.restB, { tiltA: t.a, tiltB: t.b, calibration: 1 });
  });
}
const calibrate = (raw: number[], c: number) => raw.map((p) => sigmoid(c * logitOf(p)));
function logLoss(ps: number[], pts: Point[]): number {
  let s = 0;
  ps.forEach((p, i) => { const q = Math.min(1 - 1e-12, Math.max(1e-12, p)); s -= pts[i].y ? Math.log(q) : Math.log(1 - q); });
  return s / ps.length;
}
function brier(ps: number[], pts: Point[]): number {
  return ps.reduce((s, p, i) => s + (p - pts[i].y) ** 2, 0) / ps.length;
}
/** The temperature with the lowest log loss: golden section on 0.3..3. */
function fitCalibration(raw: number[], pts: Point[]): number {
  let lo = 0.3; let hi = 3;
  const g = (Math.sqrt(5) - 1) / 2;
  const f = (c: number) => logLoss(calibrate(raw, c), pts);
  let x1 = hi - g * (hi - lo); let x2 = lo + g * (hi - lo);
  let f1 = f(x1); let f2 = f(x2);
  for (let i = 0; i < 40; i++) {
    if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = f(x1); }
    else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = f(x2); }
  }
  return Math.round(((lo + hi) / 2) * 1000) / 1000;
}

/** Train log loss for `params` with its best temperature, which it returns filled in. */
function trainLoss(pts: Point[], params: FormParams, useSi: boolean): { loss: number; params: FormParams } {
  const raw = rawChances(pts, params, useSi);
  const calibration = fitCalibration(raw, pts);
  return { loss: logLoss(calibrate(raw, calibration), pts), params: { ...params, calibration } };
}

/** Coarse grid over the named keys, then coordinate descent with halving steps. */
function fit(pts: Point[], start: FormParams, grid: Partial<Record<keyof FormParams, number[]>>, useSi: boolean): { loss: number; params: FormParams } {
  const keys = Object.keys(grid) as (keyof FormParams)[];
  let best = trainLoss(pts, start, useSi);
  const combos: FormParams[] = [start];
  for (const k of keys) {
    const next: FormParams[] = [];
    for (const c of combos) for (const v of grid[k]!) next.push({ ...c, [k]: v });
    combos.splice(0, combos.length, ...next);
  }
  for (const c of combos) {
    const r = trainLoss(pts, c, useSi);
    if (r.loss < best.loss) best = r;
  }
  const step = new Map(keys.map((k) => [k, Math.max(0.02, Math.abs(best.params[k]) / 4 || 0.05)]));
  for (let round = 0; round < 6; round++) {
    let moved = false;
    for (const k of keys) {
      for (const dir of [1, -1]) {
        const v = best.params[k] + dir * step.get(k)!;
        if (k === 'shrink' && v < 0) continue;
        const r = trainLoss(pts, { ...best.params, [k]: v }, useSi);
        if (r.loss < best.loss - 1e-7) { best = r; moved = true; }
      }
      step.set(k, step.get(k)! / 2);
    }
    if (!moved && round > 1) break;
  }
  return best;
}

interface Bin { label: string; n: number; called: number; won: number }
function bins(ps: number[], pts: Point[]): Bin[] {
  const out: Bin[] = [];
  for (let b = 0; b < 10; b++) {
    const idx = ps.map((p, i) => [p, i] as const).filter(([p]) => (b === 9 ? p >= 0.9 : p >= b / 10 && p < (b + 1) / 10));
    const n = idx.length;
    out.push({
      label: `${b * 10}-${b * 10 + 10}%`, n,
      called: n ? idx.reduce((s, [p]) => s + p, 0) / n : NaN,
      won: n ? idx.reduce((s, [, i]) => s + pts[i].y, 0) / n : NaN,
    });
  }
  return out;
}
function reliability(bs: Bin[]): string {
  const rows: string[] = ['| Called | n | Called mean | Won |', '|---|---|---|---|'];
  for (const b of bs) {
    rows.push(b.n === 0 ? `| ${b.label} | 0 | | |`
      : `| ${b.label} | ${b.n} | ${(b.called * 100).toFixed(1)}% | ${(b.won * 100).toFixed(1)}% |`);
  }
  return rows.join('\n');
}
/** The bins that miss the reliability gate, described; empty is a pass. */
function gateMisses(bs: Bin[]): string[] {
  return bs.filter((b) => b.n >= GATE_MIN_N && Math.abs(b.called - b.won) * 100 > GATE_MAX_POINTS)
    .map((b) => `${b.label} (n ${b.n}): called ${(b.called * 100).toFixed(1)}%, won ${(b.won * 100).toFixed(1)}%`);
}

/** 95% interval of the Brier difference (a minus b), resampling whole
 *  matches so a match's points stay together. Seeded, so reruns agree. */
function bootstrapDiff(a: number[], b: number[], pts: Point[]): [number, number] {
  const byMatch = new Map<number, number[]>();
  pts.forEach((pt, i) => { const l = byMatch.get(pt.matchId); if (l) l.push(i); else byMatch.set(pt.matchId, [i]); });
  const groups = [...byMatch.values()];
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const diffs: number[] = [];
  for (let r = 0; r < 2000; r++) {
    let d = 0; let n = 0;
    for (let g = 0; g < groups.length; g++) {
      for (const i of groups[Math.floor(rand() * groups.length)]) { d += (a[i] - pts[i].y) ** 2 - (b[i] - pts[i].y) ** 2; n += 1; }
    }
    diffs.push(d / n);
  }
  diffs.sort((x, y) => x - y);
  return [diffs[50], diffs[1949]];
}

const f4 = (x: number) => x.toFixed(5);
interface Scored { brier: number; logLoss: number; gate: boolean; misses: string[] }
function report(label: string, ps: number[], pts: Point[]): Scored {
  const b = brier(ps, pts);
  const l = logLoss(ps, pts);
  const bs = bins(ps, pts);
  const misses = gateMisses(bs);
  const gate = misses.length === 0;
  console.log(`\n### ${label}\n\nBrier ${f4(b)}, log loss ${f4(l)}, points ${pts.length}\n\n${reliability(bs)}`);
  console.log(`\nGate ${gate ? 'PASS' : 'FAIL'} (bins with n >= ${GATE_MIN_N} within ${GATE_MAX_POINTS} points)${gate ? '' : `: ${misses.join('; ')}`}`);
  return { brier: b, logLoss: l, gate, misses };
}

// ---- run ---------------------------------------------------------------------

const train = points.filter((p) => p.train);
const test = points.filter((p) => !p.train);
const siFit = points.filter((p) => p.feeds && p.siFit);
const siTest = points.filter((p) => p.feeds && !p.siFit);
const nm = (pts: Point[]) => new Set(pts.map((p) => p.matchId)).size;
console.log(`# Win chance backtest, part form\n\nDB ${dbPath}\n`);
console.log(`Completed unvoided PUGs ${matches.length} (train ${cut}, test ${matches.length - cut}); draws left out ${draws}, no line ${skipped}.`);
console.log(`Train halves for the base model ${trainHalves.length}. Points: train ${train.length} (${nm(train)} matches), test ${test.length} (${nm(test)} matches).`);
console.log(`With data feeds: ${nm(siFit) + nm(siTest)} matches (${nm(points.filter((p) => p.feeds && p.train))} in train); SI fit ${siFit.length} points (${nm(siFit)} matches), SI test ${siTest.length} (${nm(siTest)} matches). SI medians: ${siMedian.size} maps own, pooled ${pooledSi}.`);

const todayRawTrain = rawChances(train, null, false);
const todayRawTest = rawChances(test, null, false);
const todayRefit = fitCalibration(todayRawTrain, train);

const noForm: FormParams = { survivor: 0, infected: 0, siDamage: 0, shrink: 2, calibration: CALIBRATION };
// infected stays 0: in a two-team match it is the same numbers as survivor
// form with the sign flipped (see src/winForm.ts), so the fit cannot tell
// them apart and survivor carries both.
const form = fit(train, noForm, { survivor: [0, 0.1, 0.2, 0.3, 0.5], shrink: [0.5, 1, 2, 4, 8] }, false);
console.log(`\nFitted on train, form without SI damage: ${JSON.stringify(form.params)} (train log loss ${f4(form.loss)})`);
console.log(`Train log loss, today's model ${f4(logLoss(calibrate(todayRawTrain, CALIBRATION), train))}, refitted ${f4(logLoss(calibrate(todayRawTrain, todayRefit), train))}`);
const formRefit = trainLoss(siFit, form.params, false);
const formSi = fit(siFit, form.params, { siDamage: [-0.2, 0, 0.1, 0.2, 0.4, 0.6] }, true);
console.log(`Fitted on the SI fit matches: form alone, temperature only ${JSON.stringify(formRefit.params)} (log loss ${f4(formRefit.loss)}); form with SI damage ${JSON.stringify(formSi.params)} (log loss ${f4(formSi.loss)})`);

console.log('\n## Test, every match');
const todayTestP = calibrate(todayRawTest, CALIBRATION);
const today = report(`Today's model (CALIBRATION ${CALIBRATION})`, todayTestP, test);
report(`Today's model, temperature refitted on train (${todayRefit})`, calibrate(todayRawTest, todayRefit), test);
const formTestP = calibrate(rawChances(test, form.params, false), form.params.calibration);
const formTest = report('Form, no SI damage', formTestP, test);
const ci = bootstrapDiff(formTestP, todayTestP, test);
console.log(`\nForm minus today, Brier: ${f4(formTest.brier - today.brier)}, 95% interval ${f4(ci[0])} to ${f4(ci[1])} (2,000 resamples of test matches)`);

console.log('\n## SI test: the newest 30% of matches with data feeds');
report(`Today's model (CALIBRATION ${CALIBRATION})`, calibrate(rawChances(siTest, null, false), CALIBRATION), siTest);
report('Form, no SI damage (train params)', calibrate(rawChances(siTest, form.params, false), form.params.calibration), siTest);
const formFeeds = report(`Form, no SI damage, temperature refitted on the SI fit matches (${formRefit.params.calibration})`,
  calibrate(rawChances(siTest, formRefit.params, false), formRefit.params.calibration), siTest);
const formSiFeeds = report('Form with SI damage', calibrate(rawChances(siTest, formSi.params, true), formSi.params.calibration), siTest);

// SI damage stays only if it lowers Brier on its own held-out matches and
// passes the gate there.
const keepSi = formSiFeeds.brier < formFeeds.brier && formSiFeeds.gate;
const winner = keepSi ? formSi.params : form.params;
const beats = formTest.brier < today.brier && formTest.gate;
console.log(`\nForm ${beats ? 'PASSES' : 'FAILS'}: Brier ${f4(formTest.brier)} vs today's ${f4(today.brier)} on test (${formTest.brier < today.brier ? 'lower' : 'not lower'}), reliability gate ${formTest.gate ? 'PASS' : 'FAIL'}. SI damage ${keepSi ? 'kept' : 'left out'} (Brier ${f4(formSiFeeds.brier)} vs ${f4(formFeeds.brier)} on the SI test matches, gate ${formSiFeeds.gate ? 'PASS' : 'FAIL'}).`);
const saved = {
  ...winner,
  gate: beats ? 'pass' : 'fail',
  testBrier: { today: Number(f4(today.brier)), form: Number(f4(formTest.brier)) },
  ...(beats ? {} : { failingBins: formTest.misses }),
};
console.log(`Winner: ${JSON.stringify(saved)}`);
if (write) {
  writeFileSync(new URL('../src/winForm.fitted.json', import.meta.url), `${JSON.stringify(saved, null, 2)}\n`);
  console.log(`Wrote src/winForm.fitted.json (gate ${saved.gate})`);
}
