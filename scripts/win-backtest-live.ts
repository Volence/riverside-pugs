// scripts/win-backtest-live.ts
// The live half model's fit and validation, run as
// `scripts/win-backtest.ts --part live`.
//
// Folds. Completed, unvoided PUGs ordered by ended_at are cut into six equal
// blocks. Fold k (1 to 5) trains on blocks 0 to k-1 and tests on block k, so
// every test match is later than everything its models saw. Each fold builds
// its own base model (buildWinModel, with and without the per-half base) from
// its train halves, and fits its own live params on its train matches' half
// snapshots (scripts/win-dataset.ts writes them, one half per line). Every
// number printed for a test block comes from models that never saw it.
//
// Half-end points (the opening point and the point after every half but the
// last, as in --part form) are scored for today's line and for the per-half
// base (BuildOpts.perHalf). The base with the lower pooled Brier is the one
// the live model is fitted and scored on.
//
// Mid-half points are scored in each test half at fixed times into the half
// (60, 180, 300 and 480 s, for halves still being played then) and 10 s
// after the tank spawns and after it dies, from the snapshots' tank state.
// Fixed times and tank events pick a half on its past only; a share of the
// half's own length would pick on its future (long halves are made halves).
// Three numbers per point: the live model; its frozen baseline, the
// half-end line at the previous half end on the same base, so the gap is
// what the in-half state adds; and today's public line frozen the same way.
//
// Who survives first on a map not yet started is not known at a point: the
// first map is team A's, every later one the leader's after the map before.
// Maps not yet started are priced as if the team leading at the point
// (team A on a tie) survives first on them; that only matters for the
// per-half base.
//
// The gate, all of which must hold to write the params:
//   - the live model has a lower pooled Brier than its frozen baseline at
//     every checkpoint type;
//   - every reliability bin of the live model's mid-half calls (pooled over
//     the checkpoints) with n >= GATE_MIN_N is won within GATE_MAX_POINTS of
//     its mean call;
//   - the tank spawn alone: of all spawns, the share where the live number
//     moved more than 3 points between the last snapshot before the spawn
//     and 10 s after it is under 5%.
//
// With --write and a pass, src/winLive/halfModel.fitted.json gets the newest
// fold's params (fitted on every match but the newest block), with the base
// they were fitted on and the test numbers as a record. A fail writes
// nothing: the committed file stays neutral.
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { DB } from '../src/db.js';
import { completedPug } from '../src/matchKinds.js';
import {
  BIN, buildWinModel, halfBase, matchWinLine, winChanceDists, type HalfRow, type WinModel,
} from '../src/winProb.js';
import type { Snapshot } from '../src/winLive/snapshot.js';
import {
  classOf, classProbs, FEATURES, featureVector, predictHalf, progressCandidates, PROGRESS_FEATURES, type HalfModelParams,
} from '../src/winLive/halfModel.js';
import {
  bins, bootstrapDiff, brier, f4, GATE_MAX_POINTS, GATE_MIN_N, gateMisses, report, type Outcome,
} from './win-backtest-score.js';

export interface LiveContext {
  db: DB;
  dbPath: string;
  /** Completed, unvoided PUGs, oldest first, with their final scores. */
  matches: { id: number; a: number; b: number }[];
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
/** A bin's chance never counts as less than this in the bin log loss. */
const LIVE_BIN_EPS = 1e-4;

/** Time-ordered folds: FOLDS + 1 blocks, each fold tests on one block. */
const FOLDS = 5;
/** Fixed checkpoints, ms into the half. */
const CHECK_TIMES_MS = [60_000, 180_000, 300_000, 480_000];
/** Tank checkpoints sit this long after the spawn or death is first seen. */
const TANK_AFTER_MS = 10_000;
/** A checkpoint takes the first snapshot at or after its time, if within this. */
const SNAP_SLACK_MS = 5_000;
/** The tank spawn check: a move above this ... */
const SPAWN_MOVE = 0.03;
/** ... in no more than this share of spawns. */
const SPAWN_SHARE_MAX = 0.05;
/** The sanity table's times into the half (newest fold, mean predicted against actual). */
const LIVE_SANITY_TIMES_MS = [0, 60_000, 180_000, 300_000, 480_000];

const CHECK_KINDS = [...CHECK_TIMES_MS.map((t) => `${t / 1000} s`), 'tank spawn +10 s', 'tank death +10 s'];

function quantile(sorted: number[], q: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : 0;
}
const median = (xs: number[]) => quantile([...xs].sort((x, y) => x - y), 0.5);
const pc = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Every half of the dataset, keyed by match, ordinal and half. */
async function readHalves(path: string): Promise<{ halves: Map<string, DatasetHalf>; unreadable: number }> {
  const halves = new Map<string, DatasetHalf>();
  let unreadable = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let h: DatasetHalf;
    try { h = JSON.parse(line) as DatasetHalf; } catch { unreadable += 1; continue; }
    if (!Number.isInteger(h.matchId)) { unreadable += 1; continue; }
    halves.set(halfId(h.matchId, h.ordinal, h.half), h);
  }
  return { halves, unreadable };
}
const halfId = (matchId: number, ordinal: number, half: number) => `${matchId}:${ordinal}:${half}`;

// ---- the fit -----------------------------------------------------------------

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
 *  the time quantiles when progress is unknown), whether its progress was
 *  known, its true class and its half's base class shares (halfBase, so the
 *  per-half base when the model has it). Snapshots with nobody alive are
 *  left out: the point mass rule prices those. `dropped` counts halves whose
 *  true class has no share in their base (they cannot be scored). */
interface LiveRows { x: Float64Array[][]; progKnown: boolean[]; y: number[]; shares: Float64Array[]; dropped: number }
function liveRows(model: WinModel, halves: DatasetHalf[], rules: Pick<HalfModelParams, 'progByTime'>): LiveRows {
  const K = LIVE_CLASS_EDGES.length + 1;
  const sharesOf = new Map<string, Float64Array>();
  const shares = (map: string, half: 1 | 2) => {
    const key = `${half}:${map}`;
    let s = sharesOf.get(key);
    if (s) return s;
    s = new Float64Array(K);
    const d = halfBase(model, map, half);
    for (let i = 0; i < d.length; i++) s[classOf((i * BIN) / model.scale(map), LIVE_CLASS_EDGES)] += d[i];
    sharesOf.set(key, s);
    return s;
  };
  const rows: LiveRows = { x: [], progKnown: [], y: [], shares: [], dropped: 0 };
  for (const h of halves) {
    const y = classOf(h.score / model.scale(h.map), LIVE_CLASS_EDGES);
    const sh = shares(h.map, h.half);
    if (!(sh[y] > 0)) { rows.dropped += 1; continue; }
    h.snaps.forEach((s, i) => {
      if (i % LIVE_SAMPLE_EVERY !== 0 || s.alive <= 0) return;
      const progs = progressCandidates({ ...LIVE_NEUTRAL, progByTime: rules.progByTime }, s);
      rows.x.push(progs.map((p) => featureVector(s, p, h.half)));
      rows.progKnown.push(s.prog !== null);
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

/** Maximum likelihood with an L2 penalty, by Adam. A snapshot with unknown
 *  progress counts through its marginal (the mean over its candidates), so
 *  its gradient weights each candidate by how well it explains the class,
 *  and it trains only the features not made from progress: the progress
 *  weights learn from snapshots that knew their progress. */
function fitWeights(rows: LiveRows): number[][] {
  const K = LIVE_CLASS_EDGES.length + 1;
  const F = FEATURES.length;
  const w = Array.from({ length: K }, () => new Array<number>(F).fill(0));
  const m = new Float64Array(K * F);
  const v = new Float64Array(K * F);
  const lr = 0.05; const b1 = 0.9; const b2 = 0.999;
  const n = rows.y.length;
  const fromProgress = FEATURES.map((f) => PROGRESS_FEATURES.has(f));
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
          for (let f = 0; f < F; f++) if (rows.progKnown[r] || !fromProgress[f]) g[c * F + f] += e * x[f];
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

/** The live params fitted on these halves. */
function fitLive(model: WinModel, halves: DatasetHalf[]): { params: HalfModelParams; dropped: number } {
  const rules = fitProgressRules(model, halves);
  const rows = liveRows(model, halves, rules);
  return { params: { ...LIVE_NEUTRAL, ...rules, weights: fitWeights(rows) }, dropped: rows.dropped };
}

/** Bin log loss, mean predicted score against the actual one and class
 *  shares predicted against actual, at fixed times into the half over the
 *  halves still being played then. */
function liveSanity(model: WinModel, label: string, halves: DatasetHalf[], params: HalfModelParams): void {
  const K = params.classEdges.length + 1;
  console.log(`\n### ${label}\n\n| Time | n | Bin log loss | Mean predicted | Mean actual | Class shares predicted / actual |\n|---|---|---|---|---|---|`);
  for (const t of LIVE_SANITY_TIMES_MS) {
    let ll = 0; let pred = 0; let act = 0; let n = 0;
    const pcs = new Float64Array(K); const ac = new Float64Array(K);
    for (const h of halves) {
      const s = h.snaps.find((x) => x.tMs >= t);
      if (!s || s.tMs - t > SNAP_SLACK_MS) continue;
      const d = predictHalf(model, params, h.map, 0, s, h.half);
      const sc = model.scale(h.map);
      ll -= Math.log(Math.max(LIVE_BIN_EPS, d[Math.min(d.length - 1, Math.round(h.score / BIN))]));
      d.forEach((p, i) => { pred += p * i * BIN; pcs[classOf((i * BIN) / sc, params.classEdges)] += p; });
      ac[classOf(h.score / sc, params.classEdges)] += 1;
      act += h.score;
      n += 1;
    }
    if (n === 0) continue;
    const shares = (xs: Float64Array) => [...xs].map((x) => (x / n).toFixed(2)).join(' ');
    console.log(`| ${t / 1000} s | ${n} | ${(ll / n).toFixed(4)} | ${(pred / n).toFixed(1)} | ${(act / n).toFixed(1)} | ${shares(pcs)} / ${shares(ac)} |`);
  }
}

// ---- points ------------------------------------------------------------------

interface Round { ordinal: number; half: 1 | 2; survTeam: 'a' | 'b'; score: number; map: string }
/** A survivor half still to play at a point, with the turn it is priced as. */
interface Slot { team: 'a' | 'b'; map: string; half: 1 | 2 }

/** The halves from `from` on. Maps up to `started` (ordinal) keep their
 *  real turn order; later ones are priced with the team leading on `gap`
 *  (team A on a tie) surviving first, as the game would order the next map. */
function restSlots(played: Round[], from: number, gap: number, started: number): Slot[] {
  const leader = gap < 0 ? 'b' : 'a';
  return played.slice(from).map((r) => ({
    team: r.survTeam, map: r.map,
    half: r.ordinal <= started ? r.half : r.survTeam === leader ? 1 : 2,
  }));
}

/** Team A's chance with each slot priced by `dist`. */
function chance(gap: number, slots: Slot[], dist: (s: Slot, i: number) => Float64Array): number {
  const a: Float64Array[] = [];
  const b: Float64Array[] = [];
  slots.forEach((s, i) => (s.team === 'a' ? a : b).push(dist(s, i)));
  return winChanceDists(gap, a, b);
}

interface EndPoint extends Outcome { matchId: number; fold: number; kind: 'opening' | 'after A' | 'after B'; today: number; perHalf: number }
interface MidPoint extends Outcome {
  matchId: number; fold: number; kind: string; survTeam: 'a' | 'b';
  /** The live model, its frozen baseline on the same base, today's line frozen. */
  live: number; frozen: number; today: number;
}
interface SpawnMove { move: number; quiet: boolean }

/** Whether two snapshots differ only trivially apart from the tank: the
 *  same alive and down counts, health within 10, progress within 5. */
function quiet(a: Snapshot, b: Snapshot): boolean {
  const prog = a.prog === null || b.prog === null ? a.prog === b.prog : Math.abs(a.prog - b.prog) <= 5;
  return a.alive === b.alive && a.down === b.down && Math.abs(a.health - b.health) <= 10 && prog;
}

function at(snaps: Snapshot[], t: number): Snapshot | null {
  const s = snaps.find((x) => x.tMs >= t);
  return s && s.tMs - t <= SNAP_SLACK_MS ? s : null;
}

/** A half's checkpoints: the fixed times, then the tank ones. */
function checkpoints(snaps: Snapshot[]): { kind: string; snap: Snapshot }[] {
  const out: { kind: string; snap: Snapshot }[] = [];
  CHECK_TIMES_MS.forEach((t, i) => { const s = at(snaps, t); if (s) out.push({ kind: CHECK_KINDS[i], snap: s }); });
  const spawn = snaps.findIndex((s) => s.tank !== 'pending');
  const spawnSnap = spawn >= 0 ? at(snaps, snaps[spawn].tMs + TANK_AFTER_MS) : null;
  if (spawnSnap) out.push({ kind: 'tank spawn +10 s', snap: spawnSnap });
  const death = snaps.findIndex((s) => s.tank === 'dead');
  const deathSnap = death >= 0 ? at(snaps, snaps[death].tMs + TANK_AFTER_MS) : null;
  if (deathSnap) out.push({ kind: 'tank death +10 s', snap: deathSnap });
  return out;
}

// ---- run ---------------------------------------------------------------------

export async function runLive({ db, dbPath, matches, halvesPath, write }: LiveContext): Promise<void> {
  const { halves, unreadable } = await readHalves(halvesPath);
  const block = new Map(matches.map((m, i) => [m.id, Math.floor((i * (FOLDS + 1)) / matches.length)]));
  const rounds = db.prepare(
    `SELECT mr.match_id AS matchId, mr.ordinal, mr.half, mr.surv_team AS survTeam, mr.score, mm.map,
            mr.survivors_alive AS alive, mr.reliable
     FROM match_rounds mr
     JOIN match_maps mm ON mm.match_id = mr.match_id AND mm.ordinal = mr.ordinal
     JOIN matches m ON m.id = mr.match_id
     WHERE ${completedPug('m')} AND m.voided_at IS NULL ORDER BY mr.match_id, mr.ordinal, mr.half`,
  ).all() as (Round & { matchId: number; alive: number | null; reliable: number })[];
  const roundsOf = new Map<number, Round[]>();
  for (const r of rounds) {
    const l = roundsOf.get(r.matchId);
    if (l) l.push(r); else roundsOf.set(r.matchId, [r]);
  }
  // The matches scored: decided, and with a score that can carry a line
  // (matchWinLine checks the shape only; the model it prices with is unused).
  const empty = buildWinModel([]);
  const scored = new Set(matches.filter((m) => m.a !== m.b && matchWinLine(db, m.id, empty) !== null).map((m) => m.id));
  const result = new Map(matches.map((m) => [m.id, m.a > m.b ? 1 : 0]));

  console.log(`# Win chance backtest, part live\n\nDB ${dbPath}, halves ${halvesPath}\n`);
  console.log(`Completed unvoided PUGs ${matches.length} in ${FOLDS + 1} time-ordered blocks; scored (decided, with a line) ${scored.size}. Dataset halves ${halves.size} (progress: ${['feeds', 'map', 'none'].map((k) => `${k} ${[...halves.values()].filter((h) => h.progSource === k).length}`).join(', ')}); lines dropped as unreadable ${unreadable}.`);

  // Pass 1: each fold's base models and half-end points.
  interface Fold { k: number; train: Set<number>; test: number[]; today: WinModel; perHalf: WinModel }
  const folds: Fold[] = [];
  const ends: EndPoint[] = [];
  for (let k = 1; k <= FOLDS; k++) {
    const train = new Set(matches.filter((m) => block.get(m.id)! < k).map((m) => m.id));
    const test = matches.filter((m) => block.get(m.id) === k && scored.has(m.id)).map((m) => m.id);
    const rows: HalfRow[] = rounds.filter((r) => train.has(r.matchId) && r.reliable === 1)
      .map((r) => ({ map: r.map, score: r.score, made: r.alive === null ? null : r.alive > 0, half: r.half }));
    const fold: Fold = { k, train, test, today: buildWinModel(rows), perHalf: buildWinModel(rows, Date.now(), { perHalf: true }) };
    folds.push(fold);
    for (const id of test) {
      const played = roundsOf.get(id)!;
      let gap = 0;
      for (let n = 0; n < played.length; n++) {
        if (n > 0) gap += played[n - 1].survTeam === 'a' ? played[n - 1].score : -played[n - 1].score;
        const slots = restSlots(played, n, gap, n > 0 ? played[n - 1].ordinal : -1);
        ends.push({
          matchId: id, fold: k, y: result.get(id)!,
          kind: n === 0 ? 'opening' : played[n - 1].survTeam === 'a' ? 'after A' : 'after B',
          today: chance(gap, slots, (s) => fold.today.dist(s.map)),
          perHalf: chance(gap, slots, (s) => fold.perHalf.distHalf!(s.map, s.half)),
        });
      }
    }
  }

  console.log('\n## Folds\n\n| Fold | Train matches | Test matches scored | Half-end points |\n|---|---|---|---|');
  for (const f of folds) console.log(`| ${f.k} | ${f.train.size} | ${f.test.length} | ${ends.filter((p) => p.fold === f.k).length} |`);

  console.log('\n## Half-end points: today\'s line against the per-half base\n\n| Fold | n | Today | Per-half |\n|---|---|---|---|');
  for (const f of folds) {
    const pts = ends.filter((p) => p.fold === f.k);
    console.log(`| ${f.k} | ${pts.length} | ${f4(brier(pts.map((p) => p.today), pts))} | ${f4(brier(pts.map((p) => p.perHalf), pts))} |`);
  }
  const endToday = report('Half-end, today\'s line, pooled', ends.map((p) => p.today), ends);
  const endSplit = report('Half-end, per-half base, pooled', ends.map((p) => p.perHalf), ends);
  const endCi = bootstrapDiff(ends.map((p) => p.perHalf), ends.map((p) => p.today), ends);
  console.log(`\nPer-half minus today, Brier ${f4(endSplit.brier - endToday.brier)}, 95% interval ${f4(endCi[0])} to ${f4(endCi[1])}`);
  for (const kind of ['opening', 'after A', 'after B'] as const) {
    const pts = ends.filter((p) => p.kind === kind);
    binsByKind(`Half-end ${kind}`, pts, [['today', pts.map((p) => p.today)], ['per-half', pts.map((p) => p.perHalf)]]);
  }
  const baseName = endSplit.brier < endToday.brier ? 'perHalf' : 'today';
  console.log(`\nBase for the live model: ${baseName} (pooled half-end Brier ${f4(endSplit.brier)} per-half against ${f4(endToday.brier)} today).`);

  // Pass 2: each fold's live params on the chosen base, and the mid-half points.
  const mids: MidPoint[] = [];
  const spawns: SpawnMove[] = [];
  let mismatched = 0;
  let newest: { params: HalfModelParams; model: WinModel; halves: DatasetHalf[] } | null = null;
  console.log('\n## Live params per fold\n\n| Fold | Train halves with snapshots | wipePerProg | floorPerProg | Dropped (no base share) | Test halves with snapshots |\n|---|---|---|---|---|---|');
  for (const f of folds) {
    const model = baseName === 'perHalf' ? f.perHalf : f.today;
    const trainHalves = [...halves.values()].filter((h) => f.train.has(h.matchId));
    const { params, dropped } = fitLive(model, trainHalves);
    const testHalves: DatasetHalf[] = [];
    for (const id of f.test) {
      const played = roundsOf.get(id)!;
      let gap = 0;
      played.forEach((r, i) => {
        if (i > 0) gap += played[i - 1].survTeam === 'a' ? played[i - 1].score : -played[i - 1].score;
        const h = halves.get(halfId(id, r.ordinal, r.half));
        if (!h) return;
        if (h.score !== r.score || h.map !== r.map || h.survTeam !== r.survTeam) { mismatched += 1; return; }
        testHalves.push(h);
        const slots = restSlots(played, i, gap, r.ordinal);
        const base = (s: Slot) => halfBase(model, s.map, s.half);
        const frozen = chance(gap, slots, base);
        const today = chance(gap, slots, (s) => f.today.dist(s.map));
        const live = (snap: Snapshot) => chance(gap, slots, (s, j) => (j === 0 ? predictHalf(model, params, s.map, 0, snap, s.half) : base(s)));
        for (const c of checkpoints(h.snaps)) {
          mids.push({ matchId: id, fold: f.k, kind: c.kind, survTeam: r.survTeam, y: result.get(id)!, live: live(c.snap), frozen, today });
        }
        const spawn = h.snaps.findIndex((s) => s.tank !== 'pending');
        const after = spawn > 0 ? at(h.snaps, h.snaps[spawn].tMs + TANK_AFTER_MS) : null;
        if (after) {
          const before = h.snaps[spawn - 1];
          spawns.push({ move: Math.abs(live(after) - live(before)), quiet: quiet(before, after) });
        }
      });
    }
    console.log(`| ${f.k} | ${trainHalves.length} | ${params.wipePerProg} | ${params.floorPerProg} | ${dropped} | ${testHalves.length} |`);
    if (f.k === FOLDS) newest = { params, model, halves: testHalves };
  }
  console.log(`\nTest halves left out because the dataset disagrees with the DB on score, map or team: ${mismatched}.`);

  // Brier per checkpoint type, per fold and pooled.
  console.log('\n## Mid-half points: Brier per checkpoint\n\nPooled over the five test blocks. Frozen: the half-end line at the previous half end on the live model\'s base. Today: today\'s public line frozen the same way.\n');
  console.log('| Checkpoint | n | Live | Frozen | Today frozen | Live minus frozen (95% interval) |\n|---|---|---|---|---|---|');
  const beatsAt = new Map<string, boolean>();
  for (const kind of CHECK_KINDS) {
    const pts = mids.filter((p) => p.kind === kind);
    if (pts.length === 0) { beatsAt.set(kind, false); continue; }
    const live = pts.map((p) => p.live);
    const frozen = pts.map((p) => p.frozen);
    const bl = brier(live, pts); const bf = brier(frozen, pts);
    const ci = bootstrapDiff(live, frozen, pts);
    beatsAt.set(kind, bl < bf);
    console.log(`| ${kind} | ${pts.length} | ${f4(bl)} | ${f4(bf)} | ${f4(brier(pts.map((p) => p.today), pts))} | ${f4(bl - bf)} (${f4(ci[0])} to ${f4(ci[1])}) |`);
  }
  console.log('\nPer fold, live / frozen / today frozen:\n');
  console.log(`| Checkpoint | ${folds.map((f) => `Fold ${f.k}`).join(' | ')} |\n|---|${folds.map(() => '---|').join('')}`);
  for (const kind of CHECK_KINDS) {
    const cells = folds.map((f) => {
      const pts = mids.filter((p) => p.kind === kind && p.fold === f.k);
      if (pts.length === 0) return 'n 0';
      return `n ${pts.length}: ${f4(brier(pts.map((p) => p.live), pts))} / ${f4(brier(pts.map((p) => p.frozen), pts))} / ${f4(brier(pts.map((p) => p.today), pts))}`;
    });
    console.log(`| ${kind} | ${cells.join(' | ')} |`);
  }

  const liveAll = report('Mid-half, live model, pooled over the checkpoints', mids.map((p) => p.live), mids);
  report('Mid-half, frozen baseline (same base), pooled', mids.map((p) => p.frozen), mids);
  report('Mid-half, today\'s line frozen, pooled', mids.map((p) => p.today), mids);
  for (const team of ['a', 'b'] as const) {
    const pts = mids.filter((p) => p.survTeam === team);
    binsByKind(`Mid-half, team ${team.toUpperCase()} surviving`, pts, [['live', pts.map((p) => p.live)], ['frozen', pts.map((p) => p.frozen)]]);
  }

  // The tank spawn alone.
  const over = spawns.filter((s) => s.move > SPAWN_MOVE).length;
  const share = spawns.length ? over / spawns.length : 0;
  const quietOnes = spawns.filter((s) => s.quiet);
  console.log(`\n## Tank spawn\n\nLast snapshot before the spawn against 10 s after it, live model, ${spawns.length} spawns in the test halves.`);
  console.log(`- All spawns: moved more than ${SPAWN_MOVE * 100} points in ${over} (${pc(share)}); median move ${(median(spawns.map((s) => s.move)) * 100).toFixed(2)} points.`);
  console.log(`- Quiet spawns only (same alive and down, health within 10, progress within 5): ${quietOnes.length}, moved more than ${SPAWN_MOVE * 100} points in ${quietOnes.filter((s) => s.move > SPAWN_MOVE).length} (${pc(quietOnes.length ? quietOnes.filter((s) => s.move > SPAWN_MOVE).length / quietOnes.length : 0)}); median ${(median(quietOnes.map((s) => s.move)) * 100).toFixed(2)} points.`);

  if (newest) {
    liveSanity(newest.model, `Newest fold (${FOLDS}), base distribution`, newest.halves, { ...LIVE_NEUTRAL, progByTime: newest.params.progByTime });
    liveSanity(newest.model, `Newest fold (${FOLDS}), live model`, newest.halves, newest.params);
  }

  // The gate.
  const losing = CHECK_KINDS.filter((k) => !beatsAt.get(k));
  const spawnOk = share < SPAWN_SHARE_MAX;
  const pass = losing.length === 0 && liveAll.gate && spawnOk;
  console.log(`\n## Gate: ${pass ? 'PASS' : 'FAIL'}\n`);
  console.log(`- Live beats frozen at every checkpoint: ${losing.length === 0 ? 'yes' : `no (${losing.join(', ')})`}`);
  console.log(`- Reliability (bins with n >= ${GATE_MIN_N} within ${GATE_MAX_POINTS} points): ${liveAll.gate ? 'PASS' : `FAIL: ${liveAll.misses.join('; ')}`}`);
  console.log(`- Tank spawn moves over ${SPAWN_MOVE * 100} points under ${SPAWN_SHARE_MAX * 100}%: ${spawnOk ? 'yes' : 'no'} (${pc(share)})`);
  if (newest) console.log(`\nNewest fold's params (fitted on blocks 0 to ${FOLDS - 1}): ${JSON.stringify({ ...newest.params, progByTime: '(omitted)' })}`);
  if (write && pass && newest) {
    const saved = {
      ...newest.params,
      base: baseName,
      gate: 'pass',
      testBrier: Object.fromEntries(CHECK_KINDS.map((kind) => {
        const pts = mids.filter((p) => p.kind === kind);
        return [kind, { live: Number(f4(brier(pts.map((p) => p.live), pts))), frozen: Number(f4(brier(pts.map((p) => p.frozen), pts))) }];
      })),
    };
    writeFileSync(new URL('../src/winLive/halfModel.fitted.json', import.meta.url), `${JSON.stringify(saved, null, 2)}\n`);
    console.log('Wrote src/winLive/halfModel.fitted.json');
  } else if (write) {
    console.log('Gate failed: src/winLive/halfModel.fitted.json left as it is.');
  }
}

/** Compact reliability bins, one column pair per model, for one point type. */
function binsByKind(label: string, pts: Outcome[], models: [string, number[]][]): void {
  const tables = models.map(([, ps]) => bins(ps, pts));
  console.log(`\n### ${label} (${pts.length} points)\n`);
  console.log(`| Called | ${models.map(([n]) => `${n} n | called | won`).join(' | ')} |\n|---|${models.map(() => '---|---|---|').join('')}`);
  for (let b = 0; b < 10; b++) {
    const cells = tables.map((t) => (t[b].n ? `${t[b].n} | ${pc(t[b].called)} | ${pc(t[b].won)}` : '0 | |'));
    console.log(`| ${tables[0][b].label} | ${cells.join(' | ')} |`);
  }
  console.log(`\nGate: ${models.map(([n, ps]) => { const m = gateMisses(bins(ps, pts)); return `${n} ${m.length ? `FAIL (${m.join('; ')})` : 'PASS'}`; }).join('; ')}`);
}
