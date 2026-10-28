// scripts/win-backtest-live.ts
// The live half model's fit, run as `scripts/win-backtest.ts --part live`
// (see that file's header for the split and the sanity check).
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { BIN, type WinModel } from '../src/winProb.js';
import type { Snapshot } from '../src/winLive/snapshot.js';
import {
  classOf, classProbs, FEATURES, featureVector, predictHalf, progressCandidates, type HalfModelParams,
} from '../src/winLive/halfModel.js';

export interface LiveContext {
  dbPath: string;
  /** The base model, built from train halves only. */
  model: WinModel;
  trainIds: Set<number>;
  /** Completed match ids, oldest first. */
  matchOrder: number[];
  halvesPath: string;
  write: boolean;
}

/** One recorded half from the dataset (scripts/win-dataset.ts). */
interface DatasetHalf {
  matchId: number; ordinal: number; half: 1 | 2; map: string; survTeam: 'a' | 'b'; score: number;
  made: boolean | null; endedAt: string | null; progSource: 'feeds' | 'map' | 'none'; feed: boolean; snaps: Snapshot[];
}

/** Class edges in units of the map's scale: four wipe bands (a wipe scores
 *  about 0.13 scale at 100% progress), made with losses, three made bands. */
const LIVE_CLASS_EDGES = [0.04, 0.08, 0.12, 0.25, 0.7, 1.0, 1.3];
/** Train on every third snapshot (15 s apart): neighbours say almost the same. */
const LIVE_SAMPLE_EVERY = 3;
const LIVE_PROG_STEP_MS = 30_000;
const LIVE_PROG_BUCKETS = 40;
const LIVE_PROG_QUANTILES = [0.1, 0.3, 0.5, 0.7, 0.9];
/** A time bucket needs this many samples for its own quantiles, else it copies the one before. */
const LIVE_PROG_MIN_N = 50;
/** Snapshots below this progress say too little about the wipe score per progress. */
const LIVE_RULE_MIN_PROG = 20;
/** The floor is this quantile of final score over progress made: a little room for bad progress data. */
const LIVE_FLOOR_QUANTILE = 0.01;
const LIVE_L2 = 1e-3;
const LIVE_ITERS = 400;
/** Share of the train matches (the oldest) the sanity fit uses; the rest check it. */
const LIVE_FIT_SHARE = 0.8;
/** The sanity check's times into the half. */
const LIVE_SANITY_TIMES_MS = [0, 60_000, 120_000, 180_000, 300_000, 420_000, 600_000];
/** A bin's chance never counts as less than this in the bin log loss. */
const LIVE_BIN_EPS = 1e-4;

function quantile(sorted: number[], q: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : 0;
}

/** The train halves of the dataset, streamed; test lines are dropped on their match id. */
async function readTrainHalves(path: string, trainIds: Set<number>): Promise<DatasetHalf[]> {
  const out: DatasetHalf[] = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const id = Number(/"matchId":(\d+)/.exec(line)?.[1]);
    if (!trainIds.has(id)) continue;
    out.push(JSON.parse(line) as DatasetHalf);
  }
  return out;
}

/** The progress rules and the time quantiles, from these halves. */
function fitProgressRules(model: WinModel, halves: DatasetHalf[]): Pick<HalfModelParams, 'wipePerProg' | 'floorPerProg' | 'progByTime'> {
  const perProgWiped: number[] = [];
  const perProgAny: number[] = [];
  const byBucket: number[][] = Array.from({ length: LIVE_PROG_BUCKETS }, () => []);
  for (const h of halves) {
    const u = h.score / model.scale(h.map);
    let last: number | null = null;
    for (const s of h.snaps) {
      if (s.prog === null) continue;
      last = s.prog;
      byBucket[Math.min(LIVE_PROG_BUCKETS - 1, Math.floor(s.tMs / LIVE_PROG_STEP_MS))].push(s.prog);
      if (s.prog >= LIVE_RULE_MIN_PROG) perProgAny.push(u / (s.prog / 100));
    }
    if (h.made === false && last !== null && last >= LIVE_RULE_MIN_PROG) perProgWiped.push(u / (last / 100));
  }
  perProgWiped.sort((x, y) => x - y);
  perProgAny.sort((x, y) => x - y);
  const quantiles: number[][] = [];
  for (const b of byBucket) {
    b.sort((x, y) => x - y);
    quantiles.push(b.length >= LIVE_PROG_MIN_N || quantiles.length === 0
      ? LIVE_PROG_QUANTILES.map((q) => Math.round(quantile(b, q) * 10) / 10)
      : quantiles[quantiles.length - 1]);
  }
  const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
  return {
    wipePerProg: r4(quantile(perProgWiped, 0.5)),
    floorPerProg: r4(quantile(perProgAny, LIVE_FLOOR_QUANTILE)),
    progByTime: { stepMs: LIVE_PROG_STEP_MS, quantiles },
  };
}

/** Training rows: each sampled snapshot's candidate feature vectors (one, or
 *  the time quantiles when progress is unknown), its true class and its map's
 *  base class shares. Snapshots with nobody alive are left out: the point
 *  mass rule prices those. */
interface LiveRows { x: Float64Array[][]; y: number[]; shares: Float64Array[] }
function liveRows(model: WinModel, halves: DatasetHalf[], rules: Pick<HalfModelParams, 'progByTime'>, use: (f: number) => boolean): LiveRows {
  const K = LIVE_CLASS_EDGES.length + 1;
  const sharesOf = new Map<string, Float64Array>();
  const shares = (map: string) => {
    let s = sharesOf.get(map);
    if (s) return s;
    s = new Float64Array(K);
    const d = model.dist(map);
    for (let i = 0; i < d.length; i++) s[classOf((i * BIN) / model.scale(map), LIVE_CLASS_EDGES)] += d[i];
    sharesOf.set(map, s);
    return s;
  };
  const rows: LiveRows = { x: [], y: [], shares: [] };
  for (const h of halves) {
    const y = classOf(h.score / model.scale(h.map), LIVE_CLASS_EDGES);
    const sh = shares(h.map);
    if (!(sh[y] > 0)) continue;
    h.snaps.forEach((s, i) => {
      if (i % LIVE_SAMPLE_EVERY !== 0 || s.alive <= 0) return;
      const progs = progressCandidates({ ...LIVE_NEUTRAL, progByTime: rules.progByTime }, s);
      rows.x.push(progs.map((p) => featureVector(s, p, h.half).map((v, f) => (use(f) ? v : 0))));
      rows.y.push(y);
      rows.shares.push(sh);
    });
  }
  return rows;
}

const LIVE_NEUTRAL: HalfModelParams = {
  classEdges: LIVE_CLASS_EDGES,
  features: [...FEATURES],
  weights: Array.from({ length: LIVE_CLASS_EDGES.length + 1 }, () => FEATURES.map(() => 0)),
  wipePerProg: 0,
  floorPerProg: 0,
  wipeTop: 0.25,
  progByTime: { stepMs: LIVE_PROG_STEP_MS, quantiles: [] },
};

/** Mean class log loss of `weights` on `rows`, progress marginalised over the candidates. */
function classLoss(rows: LiveRows, weights: number[][]): number {
  let s = 0;
  for (let n = 0; n < rows.y.length; n++) {
    let p = 0;
    for (const x of rows.x[n]) p += classProbs(rows.shares[n], weights, x)[rows.y[n]];
    s -= Math.log(Math.max(1e-12, p / rows.x[n].length));
  }
  return s / rows.y.length;
}

/** Maximum likelihood with an L2 penalty, by Adam. A snapshot with unknown
 *  progress counts through its marginal (the mean over its candidates), so
 *  its gradient weights each candidate by how well it explains the class. */
function fitWeights(rows: LiveRows): number[][] {
  const K = LIVE_CLASS_EDGES.length + 1;
  const F = FEATURES.length;
  const w = Array.from({ length: K }, () => new Array<number>(F).fill(0));
  const m = new Float64Array(K * F);
  const v = new Float64Array(K * F);
  const lr = 0.05; const b1 = 0.9; const b2 = 0.999;
  const n = rows.y.length;
  for (let it = 1; it <= LIVE_ITERS; it++) {
    const g = new Float64Array(K * F);
    for (let r = 0; r < n; r++) {
      const y = rows.y[r];
      const ps = rows.x[r].map((x) => classProbs(rows.shares[r], w, x));
      const tot = ps.reduce((s, p) => s + p[y], 0);
      ps.forEach((p, q) => {
        const resp = tot > 0 ? p[y] / tot : 1 / ps.length;
        const x = rows.x[r][q];
        for (let c = 0; c < K; c++) {
          const e = resp * (p[c] - (c === y ? 1 : 0));
          if (e === 0) continue;
          for (let f = 0; f < F; f++) g[c * F + f] += e * x[f];
        }
      });
    }
    for (let k = 0; k < K * F; k++) {
      const c = Math.floor(k / F); const f = k % F;
      const gk = g[k] / n + LIVE_L2 * w[c][f];
      m[k] = b1 * m[k] + (1 - b1) * gk;
      v[k] = b2 * v[k] + (1 - b2) * gk * gk;
      w[c][f] -= lr * (m[k] / (1 - b1 ** it)) / (Math.sqrt(v[k] / (1 - b2 ** it)) + 1e-8);
    }
  }
  return w.map((row) => row.map((x) => Math.round(x * 10_000) / 10_000));
}

/** Bin log loss, mean predicted score against the actual one and class
 *  shares predicted against actual, at fixed times into the half over the
 *  halves still being played then. A time picks halves on their past only;
 *  a share of each half's own length would pick on its future (long halves
 *  are made halves) and is no calibration check. */
function liveSanity(model: WinModel, label: string, halves: DatasetHalf[], params: HalfModelParams): void {
  const K = params.classEdges.length + 1;
  console.log(`\n### ${label}\n\n| Time | n | Bin log loss | Mean predicted | Mean actual | Class shares predicted / actual |\n|---|---|---|---|---|---|`);
  for (const t of LIVE_SANITY_TIMES_MS) {
    let ll = 0; let pred = 0; let act = 0; let n = 0;
    const pc = new Float64Array(K); const ac = new Float64Array(K);
    for (const h of halves) {
      const s = h.snaps.find((x) => x.tMs >= t);
      if (!s || s.tMs - t > 5_000) continue;
      const d = predictHalf(model, params, h.map, 0, s, h.half);
      const sc = model.scale(h.map);
      ll -= Math.log(Math.max(LIVE_BIN_EPS, d[Math.min(d.length - 1, Math.round(h.score / BIN))]));
      d.forEach((p, i) => { pred += p * i * BIN; pc[classOf((i * BIN) / sc, params.classEdges)] += p; });
      ac[classOf(h.score / sc, params.classEdges)] += 1;
      act += h.score;
      n += 1;
    }
    if (n === 0) continue;
    const shares = (xs: Float64Array) => [...xs].map((x) => (x / n).toFixed(2)).join(' ');
    console.log(`| ${t / 1000} s | ${n} | ${(ll / n).toFixed(4)} | ${(pred / n).toFixed(1)} | ${(act / n).toFixed(1)} | ${shares(pc)} / ${shares(ac)} |`);
  }
}

export async function runLive({ dbPath, model, trainIds, matchOrder, halvesPath: path, write }: LiveContext): Promise<void> {
  const halves = await readTrainHalves(path, trainIds);
  const order = new Map(matchOrder.map((id, i) => [id, i]));
  const trainMatchIds = [...new Set(halves.map((h) => h.matchId))].sort((a, b) => order.get(a)! - order.get(b)!);
  const fitIds = new Set(trainMatchIds.slice(0, Math.round(trainMatchIds.length * LIVE_FIT_SHARE)));
  const fitHalves = halves.filter((h) => fitIds.has(h.matchId));
  const checkHalves = halves.filter((h) => !fitIds.has(h.matchId));
  console.log(`# Win chance backtest, part live\n\nDB ${dbPath}, halves ${path}\n`);
  console.log(`Train halves ${halves.length} from ${trainMatchIds.length} matches (progress: ${['feeds', 'map', 'none'].map((k) => `${k} ${halves.filter((h) => h.progSource === k).length}`).join(', ')}).`);
  console.log(`Sanity split inside train: fit ${fitHalves.length} halves (${fitIds.size} matches), check ${checkHalves.length} halves.`);

  const rules = fitProgressRules(model, fitHalves);
  console.log(`\nProgress rules on the fit part: wipePerProg ${rules.wipePerProg}, floorPerProg ${rules.floorPerProg}.`);
  const variants: { name: string; use: (f: number) => boolean }[] = [
    { name: 'all features', use: () => true },
    { name: 'without half2Prog', use: (f) => FEATURES[f] !== 'half2Prog' },
    { name: 'without the time terms', use: (f) => !FEATURES[f].startsWith('time') },
    { name: 'without the progress hinges', use: (f) => !['prog25', 'prog50', 'prog75'].includes(FEATURES[f]) },
  ];
  const zero = LIVE_NEUTRAL.weights;
  const checkAll = liveRows(model, checkHalves, rules, () => true);
  console.log(`\nClass log loss on the check part (${checkAll.y.length} snapshots), base distribution ${classLoss(checkAll, zero).toFixed(4)}:`);
  let best: { name: string; weights: number[][]; loss: number; use: (f: number) => boolean } | null = null;
  for (const vr of variants) {
    const weights = fitWeights(liveRows(model, fitHalves, rules, vr.use));
    const loss = classLoss(liveRows(model, checkHalves, rules, vr.use), weights);
    console.log(`- ${vr.name}: ${loss.toFixed(4)}`);
    if (!best || loss < best.loss - 1e-4) best = { name: vr.name, weights, loss, use: vr.use };
  }
  const sanityParams: HalfModelParams = { ...LIVE_NEUTRAL, ...rules, weights: best!.weights };
  console.log(`\nKept: ${best!.name}.`);
  liveSanity(model, 'Check part, base distribution', checkHalves, { ...LIVE_NEUTRAL, progByTime: rules.progByTime });
  liveSanity(model, 'Check part, live model', checkHalves, sanityParams);
  liveSanity(model, 'Fit part (in sample), live model', fitHalves, sanityParams);

  // The params to keep: the kept features refitted on all of train.
  const allRules = fitProgressRules(model, halves);
  const params: HalfModelParams = {
    ...LIVE_NEUTRAL, ...allRules, weights: fitWeights(liveRows(model, halves, allRules, best!.use)),
  };
  console.log(`\nFitted on all of train: ${JSON.stringify({ ...params, progByTime: '(omitted)' })}`);
  if (write) {
    writeFileSync(new URL('../src/winLive/halfModel.fitted.json', import.meta.url), `${JSON.stringify(params, null, 2)}\n`);
    console.log('Wrote src/winLive/halfModel.fitted.json');
  }
}
