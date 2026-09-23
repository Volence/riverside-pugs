# Balance Dashboard (piece 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin page that compares two groups of balance patches metric by metric, with map-mix adjustment, match-level bootstrap ranges, false-alarm control and a verdict per row (real change, too early, probably noise, no data), plus a quick check per row (trend, per map, example replays).

**Architecture:** Pure statistics in `src/metrics/compare/stats.ts`; a loader that turns `round_metrics` + `round_metric_context` into per-match, per-map sums for each side; `compareSides` and `metricDetail` that build the responses; two admin GET routes with an in-memory cache invalidated by a metrics write counter. The web side adds a Balance admin desk (Compare + Patches), the Compare page with a Ranked / By topic switch, and a quick check with hand-drawn SVG.

**Tech Stack:** TypeScript, better-sqlite3, Fastify, Preact + preact-iso, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-balance-dashboard-design.md`

## Global Constraints

- No em dashes anywhere: code, comments, UI text, docs, commit messages.
- Every `db` function takes `db: DB` first. Every admin route starts with `requireAdmin`.
- Only rounds of matches with `state = 'completed' AND voided_at IS NULL` count.
- Verdict thresholds: real = passes Benjamini-Hochberg at 10% AND each side has at least 10 matches; noise = does not pass AND both sides have at least 30 matches; otherwise too early; no data when a side has no rows.
- Bootstrap: 1000 resamples of whole matches per side, fixed seed, 95% percentile interval.
- Map weights come from side A. Maps on only one side are excluded and listed.
- Skill banner when the sides differ by more than 1.0 mu in mean team rating or in mean survivor-minus-infected gap.
- Do not touch `src/balance.ts` or `src/roundStats.ts`.
- Work only in `/home/volence/l4d/pug/.claude/worktrees/balance-dashboard` (branch `worktree-balance-dashboard`).

## Decisions made while planning

1. **"Too early" is decided by match counts only** (fewer than 30 matches on a side). The spec's "or the interval is still wide" has no crisp definition; the "about N more matches" estimate carries that information instead.
2. **Map weights are fixed from the full side A** and reused in every bootstrap replicate; a replicate missing a map renormalizes over the maps it has.
3. **Phases:** the API takes `phases=all` (whole-round rows only, the default) or `phases=split` (whole-round plus the four sub-phases). "One phase only" is a client-side filter over the split response.
4. **Units** are inferred on the web from the metric id (shares and rates shown as percent, `_s` seconds, `_min` minutes), not stored.
5. **Cache invalidation** uses a generation counter bumped by `writeRoundMetrics`.
6. **Seeded PRNG:** mulberry32, copied into `src/` (it exists only in `tests/inputSim.ts`).

## File map

| File | Responsibility |
|---|---|
| `src/metrics/compare/stats.ts` | Pure: PRNG, quantile, map weights, weighted value, bootstrap, BH, matches needed, verdict |
| `src/metrics/compare/types.ts` | Response types shared by backend and (mirrored) web |
| `src/metrics/compare/load.ts` | DB to per-side samples and side summary |
| `src/metrics/compare/compare.ts` | `compareSides`, `metricDetail` |
| `src/metrics/compare/cache.ts` | Generation-keyed memo |
| `src/metrics/store.ts` | Add the generation counter |
| `src/routes/admin.ts` | Two GET routes |
| `src/balancePatches.ts` | Alert text points to Admin > Balance > Patches |
| `web/src/api.ts` | Types and client calls |
| `web/src/routes/admin/adminRoutes.ts`, `web/src/routes/Admin.tsx` | Balance desk, tabs, redirect |
| `web/src/routes/admin/balance/format.ts` | Value formatting and URL state |
| `web/src/routes/admin/balance/Compare.tsx` | Controls, chips, views |
| `web/src/routes/admin/balance/QuickCheck.tsx` | Detail panel with SVG trend and per-map bars |
| `web/src/styles/app.css` | A few classes |

---

### Task 1: Statistics core

**Files:**
- Create: `src/metrics/compare/stats.ts`
- Test: `tests/metrics/compareStats.test.ts`

**Interfaces:**
- Produces:
  - `mulberry32(seed: number): () => number`
  - `quantile(sorted: number[], q: number): number`
  - `type MapSums = { num: number; den: number }`, `type MatchSample = Map<string, MapSums>`
  - `sharedMaps(a: MatchSample[], b: MatchSample[]): { shared: string[]; excluded: string[] }`
  - `mapWeights(a: MatchSample[], shared: string[]): Map<string, number>`
  - `weightedValue(side: MatchSample[], weights: Map<string, number>): number | null`
  - `bootstrapDiff(a: MatchSample[], b: MatchSample[], weights: Map<string, number>, reps: number, rand: () => number): { lo: number; hi: number; p: number; se: number } | null`
  - `benjaminiHochberg(ps: (number | null)[], q: number): boolean[]`
  - `matchesNeeded(diff: number, se: number, n: number): number | null`
  - `type Verdict = 'real' | 'too_early' | 'noise' | 'no_data'`; `verdictOf(o: { hasData: boolean; significant: boolean; nA: number; nB: number }): Verdict`
  - constants `REAL_MIN_MATCHES = 10`, `NOISE_MIN_MATCHES = 30`, `FDR = 0.1`, `REPS = 1000`, `SEED = 20260923`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/metrics/compareStats.test.ts
import { describe, expect, it } from 'vitest';
import {
  benjaminiHochberg, bootstrapDiff, mapWeights, matchesNeeded, mulberry32, quantile,
  sharedMaps, verdictOf, weightedValue, type MatchSample,
} from '../../src/metrics/compare/stats.js';

const m = (entries: [string, number, number][]): MatchSample =>
  new Map(entries.map(([map, num, den]) => [map, { num, den }]));

describe('compare statistics', () => {
  it('mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(1), b = mulberry32(1);
    const xs = Array.from({ length: 5 }, () => a());
    expect(xs).toEqual(Array.from({ length: 5 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('quantile interpolates linearly', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
  });

  it('splits shared and excluded maps', () => {
    const a = [m([['x', 1, 2], ['y', 1, 2]])];
    const b = [m([['y', 1, 2], ['z', 1, 2]])];
    expect(sharedMaps(a, b)).toEqual({ shared: ['y'], excluded: ['x', 'z'] });
  });

  it('weights maps by side A denominator and reweights side B to that mix', () => {
    const a = [m([['x', 1, 1]]), m([['x', 1, 1]]), m([['y', 0, 1]]), m([['y', 0, 1]]), m([['y', 0, 1]]), m([['y', 0, 1]])];
    const b = [m([['x', 3, 4]]), m([['y', 1, 4]])];
    const w = mapWeights(a, ['x', 'y']);
    expect(w.get('x')).toBeCloseTo(2 / 6);
    expect(w.get('y')).toBeCloseTo(4 / 6);
    expect(weightedValue(a, w)).toBeCloseTo(2 / 6);
    expect(weightedValue(b, w)).toBeCloseTo((2 / 6) * 0.75 + (4 / 6) * 0.25);
  });

  it('weightedValue renormalizes over maps present and is null with none', () => {
    const w = new Map([['x', 0.5], ['y', 0.5]]);
    expect(weightedValue([m([['x', 1, 2]])], w)).toBeCloseTo(0.5);
    expect(weightedValue([], w)).toBeNull();
  });

  it('bootstrap finds a clear difference and not a null one', () => {
    const hi = Array.from({ length: 40 }, () => m([['x', 8, 10]]));
    const lo = Array.from({ length: 40 }, () => m([['x', 2, 10]]));
    const w = new Map([['x', 1]]);
    const clear = bootstrapDiff(lo, hi, w, 500, mulberry32(7))!;
    expect(clear.lo).toBeGreaterThan(0);
    expect(clear.p).toBeLessThan(0.01);
    const mixed = Array.from({ length: 40 }, (_, i) => m([['x', i % 2 ? 8 : 2, 10]]));
    const none = bootstrapDiff(mixed, mixed, w, 500, mulberry32(7))!;
    expect(none.lo).toBeLessThan(0);
    expect(none.hi).toBeGreaterThan(0);
    expect(none.p).toBeGreaterThan(0.2);
  });

  it('bootstrap is null when a side is empty', () => {
    expect(bootstrapDiff([], [m([['x', 1, 1]])], new Map([['x', 1]]), 10, mulberry32(1))).toBeNull();
  });

  it('Benjamini-Hochberg at 10%', () => {
    expect(benjaminiHochberg([0.01, 0.04, 0.2, null], 0.1)).toEqual([true, true, false, false]);
    expect(benjaminiHochberg([0.08, 0.09, 0.5], 0.1)).toEqual([false, false, false]);
  });

  it('matches needed scales with (z * se / diff)^2', () => {
    expect(matchesNeeded(0.1, 0.1, 20)).toBe(Math.ceil(20 * (1.96 ** 2) - 20));
    expect(matchesNeeded(0, 0.1, 20)).toBeNull();
    expect(matchesNeeded(1, 0.01, 20)).toBe(0);
  });

  it('verdicts follow the thresholds', () => {
    expect(verdictOf({ hasData: false, significant: true, nA: 50, nB: 50 })).toBe('no_data');
    expect(verdictOf({ hasData: true, significant: true, nA: 10, nB: 12 })).toBe('real');
    expect(verdictOf({ hasData: true, significant: true, nA: 9, nB: 50 })).toBe('too_early');
    expect(verdictOf({ hasData: true, significant: false, nA: 30, nB: 31 })).toBe('noise');
    expect(verdictOf({ hasData: true, significant: false, nA: 29, nB: 60 })).toBe('too_early');
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run tests/metrics/compareStats.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/metrics/compare/stats.ts`**

```ts
/** Pure statistics for comparing two groups of patches. Everything here is
 *  deterministic given a seeded random source, so a comparison is reproducible. */

export const REAL_MIN_MATCHES = 10;
export const NOISE_MIN_MATCHES = 30;
export const FDR = 0.1;
export const REPS = 1000;
export const SEED = 20260923;
const Z95 = 1.96;

/** mulberry32: small, seedable, good enough for a bootstrap. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated quantile of an ascending array. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export type MapSums = { num: number; den: number };
/** One match's totals for one metric and phase, per map. */
export type MatchSample = Map<string, MapSums>;

function totalsByMap(side: MatchSample[]): Map<string, MapSums> {
  const out = new Map<string, MapSums>();
  for (const s of side) for (const [map, v] of s) {
    const t = out.get(map) ?? { num: 0, den: 0 };
    t.num += v.num; t.den += v.den;
    out.set(map, t);
  }
  return out;
}

export function sharedMaps(a: MatchSample[], b: MatchSample[]): { shared: string[]; excluded: string[] } {
  const ta = totalsByMap(a), tb = totalsByMap(b);
  const has = (t: Map<string, MapSums>, k: string) => (t.get(k)?.den ?? 0) > 0;
  const all = [...new Set([...ta.keys(), ...tb.keys()])].sort();
  return {
    shared: all.filter((k) => has(ta, k) && has(tb, k)),
    excluded: all.filter((k) => has(ta, k) !== has(tb, k)),
  };
}

/** Side A's share of the denominator on each shared map. */
export function mapWeights(a: MatchSample[], shared: string[]): Map<string, number> {
  const ta = totalsByMap(a);
  const total = shared.reduce((s, k) => s + (ta.get(k)?.den ?? 0), 0);
  return new Map(shared.map((k) => [k, total > 0 ? (ta.get(k)?.den ?? 0) / total : 0]));
}

/** Per-map rate combined with fixed weights; maps a sample lacks are dropped
 *  and the remaining weights renormalized. Null when no weighted map has data. */
export function weightedValue(side: MatchSample[], weights: Map<string, number>): number | null {
  const t = totalsByMap(side);
  let v = 0, wsum = 0;
  for (const [map, w] of weights) {
    const s = t.get(map);
    if (!s || s.den <= 0 || w <= 0) continue;
    v += w * (s.num / s.den);
    wsum += w;
  }
  return wsum > 0 ? v / wsum : null;
}

function resample(side: MatchSample[], rand: () => number): MatchSample[] {
  const out: MatchSample[] = new Array(side.length);
  for (let i = 0; i < side.length; i++) out[i] = side[Math.floor(rand() * side.length)];
  return out;
}

/** Bootstrap of B minus A by resampling whole matches on each side. */
export function bootstrapDiff(a: MatchSample[], b: MatchSample[], weights: Map<string, number>,
  reps: number, rand: () => number): { lo: number; hi: number; p: number; se: number } | null {
  if (a.length === 0 || b.length === 0) return null;
  const diffs: number[] = [];
  for (let r = 0; r < reps; r++) {
    const va = weightedValue(resample(a, rand), weights);
    const vb = weightedValue(resample(b, rand), weights);
    if (va !== null && vb !== null) diffs.push(vb - va);
  }
  if (diffs.length < 2) return null;
  diffs.sort((x, y) => x - y);
  const le = diffs.filter((d) => d <= 0).length / diffs.length;
  const ge = diffs.filter((d) => d >= 0).length / diffs.length;
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const se = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (diffs.length - 1));
  return { lo: quantile(diffs, 0.025), hi: quantile(diffs, 0.975), p: Math.min(1, 2 * Math.min(le, ge)), se };
}

/** Which p-values survive Benjamini-Hochberg at false discovery rate q. */
export function benjaminiHochberg(ps: (number | null)[], q: number): boolean[] {
  const idx = ps.map((p, i) => ({ p, i })).filter((x): x is { p: number; i: number } => x.p !== null)
    .sort((x, y) => x.p - y.p);
  const m = idx.length;
  let cut = -1;
  idx.forEach((x, k) => { if (x.p <= ((k + 1) / m) * q) cut = k; });
  const out = ps.map(() => false);
  for (let k = 0; k <= cut; k++) out[idx[k].i] = true;
  return out;
}

/** Extra matches per side for the current difference to clear a 95% interval,
 *  assuming the standard error shrinks with the square root of the sample. */
export function matchesNeeded(diff: number, se: number, n: number): number | null {
  if (diff === 0 || se <= 0 || n <= 0) return null;
  const factor = (Z95 * se / Math.abs(diff)) ** 2;
  return Math.max(0, Math.ceil(n * factor - n));
}

export type Verdict = 'real' | 'too_early' | 'noise' | 'no_data';

export function verdictOf(o: { hasData: boolean; significant: boolean; nA: number; nB: number }): Verdict {
  if (!o.hasData) return 'no_data';
  if (o.significant && o.nA >= REAL_MIN_MATCHES && o.nB >= REAL_MIN_MATCHES) return 'real';
  if (!o.significant && o.nA >= NOISE_MIN_MATCHES && o.nB >= NOISE_MIN_MATCHES) return 'noise';
  return 'too_early';
}
```

- [ ] **Step 4: Run and see them pass**

Run: `npx vitest run tests/metrics/compareStats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/metrics/compare/stats.ts tests/metrics/compareStats.test.ts
git commit -m "balance compare: pure statistics (bootstrap, map weights, BH, verdicts)"
```

---

### Task 2: Side loader and response types

**Files:**
- Create: `src/metrics/compare/types.ts`, `src/metrics/compare/load.ts`
- Test: `tests/metrics/compareLoad.test.ts`

**Interfaces:**
- Consumes: `MatchSample` (Task 1); `ENGINE` (`src/metrics/registry.ts`).
- Produces:
  - `type Origin = 'all' | 'queue' | 'in_game'`; `interface SideQuery { patchIds: number[]; origin: Origin; maps: string[] | null }`
  - `interface SideSummary { matches: number; rounds: number; meanMu: number | null; meanGap: number | null; olderEngineRounds: number; historical: boolean }`
  - `interface SideData { summary: SideSummary; samples: Map<string, MatchSample[]> }` keyed by `rowKey(metric, phase)`
  - `rowKey(metric: string, phase: Phase): string` (`${metric}|${phase}`)
  - `loadSide(db: DB, q: SideQuery, phases: Phase[]): SideData`
  - `sideFilterSql(q: SideQuery): { sql: string; params: (string | number)[] }` (shared WHERE fragment over `c` = round_metric_context and `m` = matches)

- [ ] **Step 1: Write `src/metrics/compare/types.ts`**

```ts
import type { Phase } from '../types.js';
import type { Verdict } from './stats.js';

export type Origin = 'all' | 'queue' | 'in_game';
export interface SideQuery { patchIds: number[]; origin: Origin; maps: string[] | null }

export interface SideSummary {
  matches: number;
  rounds: number;
  /** Mean of (survivor side mu + infected side mu) / 2 over rounds with ratings. */
  meanMu: number | null;
  /** Mean of (survivor side mu - infected side mu). */
  meanGap: number | null;
  /** Rounds whose context engine is not the current one (kept older definitions). */
  olderEngineRounds: number;
  historical: boolean;
}

export interface CompareRow {
  metric: string;
  group: string;
  description: string;
  phase: Phase;
  a: number | null;
  b: number | null;
  diff: number | null;
  rel: number | null;
  lo: number | null;
  hi: number | null;
  p: number | null;
  verdict: Verdict;
  moreMatches: number | null;
  excludedMaps: string[];
  nA: number;
  nB: number;
}

export interface CompareResult {
  a: SideSummary;
  b: SideSummary;
  rows: CompareRow[];
  counts: Record<Verdict, number>;
  banners: { skill: string | null; approximate: boolean };
  ms: number;
}

export interface TrendPoint { matchId: number; endedAt: string; patchId: number | null; side: 'a' | 'b'; value: number }
export interface MapBar { map: string; a: number; b: number; roundsA: number; roundsB: number }
export interface ExampleRound { matchId: number; ordinal: number; half: number; map: string | null; value: number }
export interface MetricDetail {
  metric: string;
  phase: Phase;
  trend: TrendPoint[];
  boundaries: { patchId: number; label: string; at: string }[];
  perMap: MapBar[];
  examples: ExampleRound[];
}
```

- [ ] **Step 2: Write the failing loader test**

```ts
// tests/metrics/compareLoad.test.ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { loadSide, rowKey } from '../../src/metrics/compare/load.js';
import { ENGINE } from '../../src/metrics/registry.js';

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO balance_patches (id, name, source, first_seen_at) VALUES (1, 'P1', 'historical', '2026-09-01 00:00:00'), (2, 'P2', 'detected', '2026-09-10 00:00:00')").run();
  const match = db.prepare("INSERT INTO matches (id, season_id, state, campaign, origin, ended_at, voided_at) VALUES (?, 1, ?, 'x', ?, '2026-09-20 00:00:00', ?)");
  match.run(1, 'completed', 'queue', null);
  match.run(2, 'completed', 'in_game', null);
  match.run(3, 'completed', 'queue', '2026-09-21 00:00:00');   // voided
  match.run(4, 'live', 'queue', null);                          // not completed
  const ctx = db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, map, origin, patch_id, surv_mu, inf_mu, has_replay, has_stats, engine, computed_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 0, ?, 'n')`);
  const row = db.prepare('INSERT INTO round_metrics VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const mid of [1, 2, 3, 4]) {
    ctx.run(mid, 0, 1, 'mapA', mid === 2 ? 'in_game' : 'queue', 26, 24, mid === 1 ? ENGINE + 'x' : ENGINE);
    ctx.run(mid, 1, 1, 'mapB', mid === 2 ? 'in_game' : 'queue', 26, 24, ENGINE);
    row.run(mid, 0, 1, 'round.saferoom', 'all', 1, 1);
    row.run(mid, 1, 1, 'round.saferoom', 'all', 0, 1);
    row.run(mid, 0, 1, 'round.saferoom', 'tank', 1, 1);
  }
  return db;
}

describe('loadSide', () => {
  it('sums per match and map for completed, unvoided matches in the patches', () => {
    const d = loadSide(setup(), { patchIds: [1], origin: 'all', maps: null }, ['all']);
    const s = d.samples.get(rowKey('round.saferoom', 'all'))!;
    expect(s).toHaveLength(2);
    expect(s[0].get('mapA')).toEqual({ num: 1, den: 1 });
    expect(s[0].get('mapB')).toEqual({ num: 0, den: 1 });
    expect(d.samples.has(rowKey('round.saferoom', 'tank'))).toBe(false);
    expect(d.summary).toMatchObject({ matches: 2, rounds: 4, meanMu: 25, meanGap: 2, olderEngineRounds: 1, historical: true });
  });

  it('filters by origin and map', () => {
    const q = loadSide(setup(), { patchIds: [1], origin: 'in_game', maps: ['mapA'] }, ['all', 'tank']);
    expect(q.summary.matches).toBe(1);
    expect(q.samples.get(rowKey('round.saferoom', 'all'))![0].has('mapB')).toBe(false);
    expect(q.samples.get(rowKey('round.saferoom', 'tank'))).toHaveLength(1);
  });

  it('is empty for patches with no rounds', () => {
    const d = loadSide(setup(), { patchIds: [2], origin: 'all', maps: null }, ['all']);
    expect(d.summary).toMatchObject({ matches: 0, rounds: 0, meanMu: null, historical: false });
    expect(d.samples.size).toBe(0);
  });
});
```

Check `balance_patches`, `matches`, `round_metric_context` NOT NULL columns in `src/db.ts` and adjust inserts if needed, keeping the assertions.

- [ ] **Step 3: Run and see it fail**

Run: `npx vitest run tests/metrics/compareLoad.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `src/metrics/compare/load.ts`**

```ts
import type { DB } from '../../db.js';
import { ENGINE } from '../registry.js';
import type { Phase } from '../types.js';
import type { MatchSample } from './stats.js';
import type { SideQuery, SideSummary } from './types.js';

export interface SideData { summary: SideSummary; samples: Map<string, MatchSample[]> }

export const rowKey = (metric: string, phase: Phase) => `${metric}|${phase}`;
const UNKNOWN_MAP = '(unknown map)';

/** WHERE fragment over c (round_metric_context) and m (matches). */
export function sideFilterSql(q: SideQuery): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = [];
  const parts = ["m.state = 'completed'", 'm.voided_at IS NULL'];
  parts.push(`c.patch_id IN (${q.patchIds.map(() => '?').join(',') || 'NULL'})`);
  params.push(...q.patchIds);
  if (q.origin !== 'all') { parts.push('c.origin = ?'); params.push(q.origin); }
  if (q.maps && q.maps.length > 0) {
    parts.push(`COALESCE(c.map, '${UNKNOWN_MAP}') IN (${q.maps.map(() => '?').join(',')})`);
    params.push(...q.maps);
  }
  return { sql: parts.join(' AND '), params };
}

export function loadSide(db: DB, q: SideQuery, phases: Phase[]): SideData {
  const f = sideFilterSql(q);
  const s = db.prepare(`
    SELECT COUNT(DISTINCT c.match_id) AS matches, COUNT(*) AS rounds,
           AVG(CASE WHEN c.surv_mu IS NOT NULL AND c.inf_mu IS NOT NULL THEN (c.surv_mu + c.inf_mu) / 2 END) AS meanMu,
           AVG(CASE WHEN c.surv_mu IS NOT NULL AND c.inf_mu IS NOT NULL THEN c.surv_mu - c.inf_mu END) AS meanGap,
           SUM(CASE WHEN c.engine != ? THEN 1 ELSE 0 END) AS older
    FROM round_metric_context c JOIN matches m ON m.id = c.match_id
    WHERE ${f.sql}`).get(ENGINE, ...f.params) as
    { matches: number; rounds: number; meanMu: number | null; meanGap: number | null; older: number | null };
  const historical = q.patchIds.length > 0 && (db.prepare(
    `SELECT COUNT(*) AS n FROM balance_patches WHERE source = 'historical' AND id IN (${q.patchIds.map(() => '?').join(',')})`,
  ).get(...q.patchIds) as { n: number }).n > 0;

  const rows = phases.length === 0 ? [] : db.prepare(`
    SELECT rm.match_id AS matchId, COALESCE(c.map, '${UNKNOWN_MAP}') AS map, rm.metric AS metric, rm.phase AS phase,
           SUM(rm.num) AS num, SUM(rm.den) AS den
    FROM round_metrics rm
    JOIN round_metric_context c ON c.match_id = rm.match_id AND c.ordinal = rm.ordinal AND c.half = rm.half
    JOIN matches m ON m.id = rm.match_id
    WHERE ${f.sql} AND rm.phase IN (${phases.map(() => '?').join(',')})
    GROUP BY rm.match_id, map, rm.metric, rm.phase
    ORDER BY rm.match_id`).all(...f.params, ...phases) as
    { matchId: number; map: string; metric: string; phase: Phase; num: number; den: number }[];

  const byKey = new Map<string, Map<number, MatchSample>>();
  for (const r of rows) {
    const k = rowKey(r.metric, r.phase);
    let perMatch = byKey.get(k);
    if (!perMatch) { perMatch = new Map(); byKey.set(k, perMatch); }
    let sample = perMatch.get(r.matchId);
    if (!sample) { sample = new Map(); perMatch.set(r.matchId, sample); }
    sample.set(r.map, { num: r.num, den: r.den });
  }
  const samples = new Map([...byKey].map(([k, v]) => [k, [...v.values()]] as const));
  return {
    summary: {
      matches: s.matches, rounds: s.rounds, meanMu: s.meanMu, meanGap: s.meanGap,
      olderEngineRounds: s.older ?? 0, historical,
    },
    samples,
  };
}
```

- [ ] **Step 5: Run and see it pass; typecheck**

Run: `npx vitest run tests/metrics/compareLoad.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/metrics/compare/types.ts src/metrics/compare/load.ts tests/metrics/compareLoad.test.ts
git commit -m "balance compare: load per-match, per-map sums for a group of patches"
```

---

### Task 3: compareSides and metricDetail

**Files:**
- Create: `src/metrics/compare/compare.ts`
- Test: `tests/metrics/compare.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2; `METRICS` (`src/metrics/registry.ts`), `SUB_PHASES`, `Phase`.
- Produces:
  - `compareSides(db: DB, a: SideQuery, b: SideQuery, opts: { phases: 'all' | 'split'; reps?: number; seed?: number }): CompareResult`
  - `metricDetail(db: DB, metric: string, phase: Phase, a: SideQuery, b: SideQuery): MetricDetail`
  - `SKILL_BANNER_MU = 1.0`, `TREND_WINDOW = 10`, `PER_MAP_MIN_ROUNDS = 5`.

Row rules: for each metric in `METRICS` and each wanted phase (`['all']`, or `['all', ...SUB_PHASES]` when split), skip the row when neither side has samples; otherwise compute shared/excluded maps, weights, values, bootstrap and `diff = b - a`, `rel = a !== 0 ? diff / Math.abs(a) : null`. A row with no shared maps or a null bootstrap is `no_data`. Run BH over the rows' p-values. `nA`/`nB` are the number of matches with samples for that row. `moreMatches` only for `too_early` rows. Sort: real (largest |rel|, then |diff|, first), too_early, noise, no_data; ties by metric id then phase.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/metrics/compare.test.ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.js';
import { compareSides, metricDetail } from '../../src/metrics/compare/compare.js';
import { ENGINE } from '../../src/metrics/registry.js';

/** Patch 1: 40 matches, saferoom 20%. Patch 2: 40 matches, saferoom 80%.
 *  tank.spawns identical on both. One map. */
function setup(nA = 40, nB = 40) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO balance_patches (id, name, source, first_seen_at) VALUES (1, 'Old', 'detected', '2026-09-01 00:00:00'), (2, 'New', 'detected', '2026-09-10 00:00:00')").run();
  const match = db.prepare("INSERT INTO matches (id, season_id, state, campaign, origin, ended_at) VALUES (?, 1, 'completed', 'x', 'queue', ?)");
  const ctx = db.prepare(`INSERT INTO round_metric_context (match_id, ordinal, half, map, origin, patch_id, surv_mu, inf_mu, has_replay, has_stats, engine, computed_at)
    VALUES (?, 0, ?, 'mapA', 'queue', ?, 25, 25, 0, 0, ?, 'n')`);
  const row = db.prepare('INSERT INTO round_metrics VALUES (?, 0, ?, ?, ?, ?, ?)');
  let id = 1;
  const add = (patch: number, n: number, safeEvery: number, day: number) => {
    for (let i = 0; i < n; i++, id++) {
      match.run(id, `2026-09-${String(day).padStart(2, '0')} 10:${String(i).padStart(2, '0')}:00`);
      for (const half of [1, 2]) {
        ctx.run(id, half, patch, ENGINE);
        row.run(id, half, 'round.saferoom', 'all', (i * 2 + half) % safeEvery === 0 ? 1 : 0, 1);
        row.run(id, half, 'tank.spawns', 'all', 1, 1);
      }
    }
  };
  add(1, nA, 5, 5);   // 1 in 5 rounds safe
  add(2, nB, 1, 15);  // x % 1 === 0 always holds: every side B round is safe
  return db;
}
const A = { patchIds: [1], origin: 'all' as const, maps: null };
const B = { patchIds: [2], origin: 'all' as const, maps: null };

describe('compareSides', () => {
  it('flags a large change as real and an unchanged metric as noise', () => {
    const r = compareSides(setup(), A, B, { phases: 'all', reps: 400 });
    const safe = r.rows.find((x) => x.metric === 'round.saferoom')!;
    expect(safe.a).toBeCloseTo(0.2, 2);
    expect(safe.b).toBeCloseTo(1, 2);
    expect(safe.verdict).toBe('real');
    const tank = r.rows.find((x) => x.metric === 'tank.spawns')!;
    expect(tank.verdict).toBe('noise');
    expect(r.rows[0].metric).toBe('round.saferoom');
    expect(r.counts.real).toBe(1);
    expect(r.a.matches).toBe(40);
  });

  it('calls a small sample too early and estimates matches needed', () => {
    const r = compareSides(setup(5, 5), A, B, { phases: 'all', reps: 400 });
    const tank = r.rows.find((x) => x.metric === 'tank.spawns')!;
    expect(tank.verdict).toBe('too_early');
    const safe = r.rows.find((x) => x.metric === 'round.saferoom')!;
    expect(safe.verdict).not.toBe('noise');
  });

  it('is reproducible with the default seed', () => {
    const db = setup();
    const x = compareSides(db, A, B, { phases: 'all', reps: 200 });
    const y = compareSides(db, A, B, { phases: 'all', reps: 200 });
    expect(x.rows.map((r) => [r.lo, r.hi])).toEqual(y.rows.map((r) => [r.lo, r.hi]));
  });

  it('shows the skill banner when ratings differ by more than 1 mu', () => {
    const db = setup();
    db.prepare('UPDATE round_metric_context SET surv_mu = 30, inf_mu = 30 WHERE patch_id = 2').run();
    expect(compareSides(db, A, B, { phases: 'all', reps: 50 }).banners.skill).toMatch(/rating/i);
  });
});

describe('metricDetail', () => {
  it('returns a time-ordered trend, per-map bars and side B examples', () => {
    const d = metricDetail(setup(), 'round.saferoom', 'all', A, B);
    expect(d.trend).toHaveLength(80);
    expect(d.trend[0].side).toBe('a');
    expect(d.trend[79].side).toBe('b');
    expect(d.perMap).toEqual([expect.objectContaining({ map: 'mapA', roundsA: 80, roundsB: 80 })]);
    expect(d.boundaries.map((b) => b.patchId)).toEqual([1, 2]);
    expect(d.examples.length).toBeGreaterThan(0);
    expect(d.examples.every((e) => e.matchId > 40)).toBe(true);
  });
});
```


- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run tests/metrics/compare.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/metrics/compare/compare.ts`**

```ts
import type { DB } from '../../db.js';
import { METRICS } from '../registry.js';
import { SUB_PHASES, type Phase } from '../types.js';
import { loadSide, rowKey, sideFilterSql } from './load.js';
import {
  benjaminiHochberg, bootstrapDiff, FDR, mapWeights, matchesNeeded, mulberry32, REPS, SEED,
  sharedMaps, verdictOf, weightedValue, type Verdict,
} from './stats.js';
import type { CompareResult, CompareRow, ExampleRound, MapBar, MetricDetail, SideQuery, TrendPoint } from './types.js';

export const SKILL_BANNER_MU = 1.0;
export const PER_MAP_MIN_ROUNDS = 5;
const ORDER: Verdict[] = ['real', 'too_early', 'noise', 'no_data'];

export function compareSides(db: DB, a: SideQuery, b: SideQuery,
  opts: { phases: 'all' | 'split'; reps?: number; seed?: number }): CompareResult {
  const t0 = Date.now();
  const phases: Phase[] = opts.phases === 'split' ? ['all', ...SUB_PHASES] : ['all'];
  const da = loadSide(db, a, phases), db2 = loadSide(db, b, phases);
  const rand = mulberry32(opts.seed ?? SEED);
  const reps = opts.reps ?? REPS;

  const rows: (CompareRow & { significant?: boolean })[] = [];
  for (const m of METRICS) for (const phase of phases) {
    const sa = da.samples.get(rowKey(m.id, phase)) ?? [];
    const sb = db2.samples.get(rowKey(m.id, phase)) ?? [];
    if (sa.length === 0 && sb.length === 0) continue;
    const base = { metric: m.id, group: m.group, description: m.description, phase, nA: sa.length, nB: sb.length };
    const { shared, excluded } = sharedMaps(sa, sb);
    const w = mapWeights(sa, shared);
    const va = shared.length ? weightedValue(sa, w) : null;
    const vb = shared.length ? weightedValue(sb, w) : null;
    const boot = va !== null && vb !== null ? bootstrapDiff(sa, sb, w, reps, rand) : null;
    const diff = va !== null && vb !== null ? vb - va : null;
    rows.push({
      ...base, a: va, b: vb, diff, rel: diff !== null && va ? diff / Math.abs(va) : null,
      lo: boot?.lo ?? null, hi: boot?.hi ?? null, p: boot?.p ?? null,
      verdict: 'no_data', moreMatches: boot && diff !== null ? matchesNeeded(diff, boot.se, Math.min(sa.length, sb.length)) : null,
      excludedMaps: excluded,
    });
  }
  const sig = benjaminiHochberg(rows.map((r) => r.p), FDR);
  rows.forEach((r, i) => {
    r.verdict = verdictOf({ hasData: r.p !== null, significant: sig[i], nA: r.nA, nB: r.nB });
    if (r.verdict !== 'too_early') r.moreMatches = null;
  });
  rows.sort((x, y) => ORDER.indexOf(x.verdict) - ORDER.indexOf(y.verdict)
    || Math.abs(y.rel ?? 0) - Math.abs(x.rel ?? 0)
    || Math.abs(y.diff ?? 0) - Math.abs(x.diff ?? 0)
    || x.metric.localeCompare(y.metric) || x.phase.localeCompare(y.phase));

  const counts = { real: 0, too_early: 0, noise: 0, no_data: 0 } as Record<Verdict, number>;
  for (const r of rows) counts[r.verdict]++;
  const sa = da.summary, sb = db2.summary;
  const muDiff = sa.meanMu !== null && sb.meanMu !== null ? Math.abs(sa.meanMu - sb.meanMu) : 0;
  const gapDiff = sa.meanGap !== null && sb.meanGap !== null ? Math.abs(sa.meanGap - sb.meanGap) : 0;
  const skill = muDiff > SKILL_BANNER_MU || gapDiff > SKILL_BANNER_MU
    ? `Team ratings differ between the sides (mean rating ${sa.meanMu?.toFixed(1)} vs ${sb.meanMu?.toFixed(1)}, survivor minus infected gap ${sa.meanGap?.toFixed(1)} vs ${sb.meanGap?.toFixed(1)}); part of any change may be the players, not the patch.`
    : null;
  return {
    a: sa, b: sb, rows, counts,
    banners: { skill, approximate: sa.historical || sb.historical },
    ms: Date.now() - t0,
  };
}

export function metricDetail(db: DB, metric: string, phase: Phase, a: SideQuery, b: SideQuery): MetricDetail {
  const fa = sideFilterSql(a), fb = sideFilterSql(b);
  const perMatch = (f: { sql: string; params: (string | number)[] }, side: 'a' | 'b') =>
    (db.prepare(`SELECT m.id AS matchId, m.ended_at AS endedAt, MIN(c.patch_id) AS patchId, SUM(rm.num) AS num, SUM(rm.den) AS den
      FROM round_metrics rm
      JOIN round_metric_context c ON c.match_id = rm.match_id AND c.ordinal = rm.ordinal AND c.half = rm.half
      JOIN matches m ON m.id = rm.match_id
      WHERE ${f.sql} AND rm.metric = ? AND rm.phase = ?
      GROUP BY m.id`).all(...f.params, metric, phase) as { matchId: number; endedAt: string; patchId: number | null; num: number; den: number }[])
      .filter((r) => r.den > 0)
      .map((r): TrendPoint => ({ matchId: r.matchId, endedAt: r.endedAt, patchId: r.patchId, side, value: r.num / r.den }));
  const trend = [...perMatch(fa, 'a'), ...perMatch(fb, 'b')]
    .sort((x, y) => x.endedAt.localeCompare(y.endedAt) || x.matchId - y.matchId);

  const ids = [...new Set([...a.patchIds, ...b.patchIds])];
  const boundaries = ids.length === 0 ? [] : (db.prepare(`SELECT id AS patchId, COALESCE(name, 'Unnamed patch') AS label, first_seen_at AS at
      FROM balance_patches WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY first_seen_at, id`).all(...ids) as
      { patchId: number; label: string; at: string }[]);

  const byMap = (f: { sql: string; params: (string | number)[] }) =>
    new Map((db.prepare(`SELECT COALESCE(c.map, '(unknown map)') AS map, SUM(rm.num) AS num, SUM(rm.den) AS den, COUNT(*) AS rounds
      FROM round_metrics rm
      JOIN round_metric_context c ON c.match_id = rm.match_id AND c.ordinal = rm.ordinal AND c.half = rm.half
      JOIN matches m ON m.id = rm.match_id
      WHERE ${f.sql} AND rm.metric = ? AND rm.phase = ?
      GROUP BY map`).all(...f.params, metric, phase) as { map: string; num: number; den: number; rounds: number }[])
      .map((r) => [r.map, r] as const));
  const ma = byMap(fa), mb = byMap(fb);
  const perMap: MapBar[] = [...ma.keys()].filter((k) => mb.has(k))
    .map((k) => ({ map: k, a: ma.get(k)!, b: mb.get(k)! }))
    .filter((x) => x.a.rounds >= PER_MAP_MIN_ROUNDS && x.b.rounds >= PER_MAP_MIN_ROUNDS && x.a.den > 0 && x.b.den > 0)
    .map((x) => ({ map: x.map, a: x.a.num / x.a.den, b: x.b.num / x.b.den, roundsA: x.a.rounds, roundsB: x.b.rounds }))
    .sort((x, y) => (y.roundsA + y.roundsB) - (x.roundsA + x.roundsB));

  const bRounds = db.prepare(`SELECT rm.match_id AS matchId, rm.ordinal AS ordinal, rm.half AS half, c.map AS map, rm.num / rm.den AS value
      FROM round_metrics rm
      JOIN round_metric_context c ON c.match_id = rm.match_id AND c.ordinal = rm.ordinal AND c.half = rm.half
      JOIN matches m ON m.id = rm.match_id
      WHERE ${fb.sql} AND rm.metric = ? AND rm.phase = ? AND rm.den > 0
      ORDER BY value`).all(...fb.params, metric, phase) as ExampleRound[];
  const picks = [...bRounds.slice(-3).reverse(), ...bRounds.slice(0, 2)];
  const seen = new Set<string>();
  const examples = picks.filter((e) => {
    const k = `${e.matchId}/${e.ordinal}/${e.half}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { metric, phase, trend, boundaries, perMap, examples };
}
```

- [ ] **Step 4: Run and see them pass; typecheck**

Run: `npx vitest run tests/metrics/compare.test.ts && npm run typecheck`
Expected: PASS. If the "too early" test's saferoom assertion is awkward, keep the tank assertion (the point of the test) and assert only that saferoom is not `noise`.

- [ ] **Step 5: Commit**

```bash
git add src/metrics/compare/compare.ts tests/metrics/compare.test.ts
git commit -m "balance compare: compareSides with verdicts and banners, metricDetail for the quick check"
```

---

### Task 4: Cache, generation counter and admin routes

**Files:**
- Create: `src/metrics/compare/cache.ts`
- Modify: `src/metrics/store.ts` (generation counter), `src/routes/admin.ts` (routes next to the balance patch routes), `src/balancePatches.ts` (alert text)
- Test: `tests/metrics/compareCache.test.ts`, `tests/balanceCompareRoutes.test.ts`

**Interfaces:**
- Produces:
  - `metricsGeneration(): number` exported from `src/metrics/store.ts`, incremented at the end of every successful `writeRoundMetrics` transaction.
  - `memo<T>(key: string, compute: () => T): T` in `cache.ts`: caches by `key` for the current `metricsGeneration()`, keeps at most 50 entries (drops the oldest).
  - `parseSideParams(q: Record<string, unknown>): { a: SideQuery; b: SideQuery } | string` (an error message string on bad input) in `cache.ts` or a small `params.ts` beside it.
  - Routes: `GET /api/admin/balance/compare?a=1,2&b=3&origin=all|queue|in_game&maps=m1,m2&phases=all|split` and `GET /api/admin/balance/metric?metric=<id>&phase=<phase>&a=...&b=...&origin=...&maps=...`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/metrics/compareCache.test.ts
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db.js';
import { memo, parseSideParams } from '../../src/metrics/compare/cache.js';
import { metricsGeneration, writeRoundMetrics } from '../../src/metrics/store.js';

describe('compare cache', () => {
  it('reuses a result until metrics are written', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (id, season_id, state, campaign) VALUES (1, 1, 'completed', 'x')").run();
    db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team) VALUES (1, 0, 1, 'a')").run();
    const fn = vi.fn(() => 42);
    memo('k', fn); memo('k', fn);
    expect(fn).toHaveBeenCalledTimes(1);
    const g = metricsGeneration();
    writeRoundMetrics(db, { matchId: 1, ordinal: 0, half: 1 }, [], { hasReplay: false, hasStats: false, replaySeen: false, engine: 'e' });
    expect(metricsGeneration()).toBe(g + 1);
    memo('k', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('parses and validates side parameters', () => {
    expect(parseSideParams({ a: '1,2', b: '3', origin: 'queue', maps: 'x,y' })).toEqual({
      a: { patchIds: [1, 2], origin: 'queue', maps: ['x', 'y'] },
      b: { patchIds: [3], origin: 'queue', maps: ['x', 'y'] },
    });
    expect(parseSideParams({ a: '1', b: '2' })).toMatchObject({ a: { origin: 'all', maps: null } });
    expect(typeof parseSideParams({ a: '', b: '2' })).toBe('string');
    expect(typeof parseSideParams({ a: '1;DROP', b: '2' })).toBe('string');
    expect(typeof parseSideParams({ a: '1', b: '2', origin: 'pub' })).toBe('string');
  });
});
```

Check the real `writeRoundMetrics` meta shape (`replaySeen` exists after piece 2) and adjust.

```ts
// tests/balanceCompareRoutes.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { authedCookie, stubOrchestrator } from './helpers.js';

const ADMIN = '76561198000000009';

describe('balance compare routes', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO balance_patches (id, name, source, first_seen_at) VALUES (1, 'Old', 'detected', '2026-09-01 00:00:00'), (2, 'New', 'detected', '2026-09-10 00:00:00')").run();
  });
  async function app(admin = true) {
    const a = await buildServer({ config: loadConfig({}), db, orchestrator: stubOrchestrator(), serverCleaner: async () => {}, serverExec: async () => {} });
    const cookies = await authedCookie(a, db, admin ? ADMIN : '76561198000000010');
    if (admin) db.prepare('UPDATE players SET is_admin = 1 WHERE steamid = ?').run(ADMIN);
    return { a, cookies };
  }

  it('returns a comparison', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/compare?a=1&b=2', cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rows: [], counts: { real: 0 } });
  });

  it('rejects bad parameters and unknown metrics', async () => {
    const { a, cookies } = await app();
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/compare?a=x&b=2', cookies })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/metric?metric=nope&phase=all&a=1&b=2', cookies })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/metric?metric=round.saferoom&phase=lunch&a=1&b=2', cookies })).statusCode).toBe(400);
  });

  it('returns metric detail', async () => {
    const { a, cookies } = await app();
    const res = await a.inject({ method: 'GET', url: '/api/admin/balance/metric?metric=round.saferoom&phase=all&a=1&b=2', cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ metric: 'round.saferoom', trend: [], perMap: [] });
  });

  it('refuses a non-admin', async () => {
    const { a, cookies } = await app(false);
    expect((await a.inject({ method: 'GET', url: '/api/admin/balance/compare?a=1&b=2', cookies })).statusCode).toBe(403);
  });
});
```

Match the non-admin status to what `makeRequireAdmin` really returns (the patches test uses 403).

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run tests/metrics/compareCache.test.ts tests/balanceCompareRoutes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the generation counter to `src/metrics/store.ts`**

```ts
let generation = 0;
/** Bumped after every metrics write so cached comparisons know to recompute. */
export function metricsGeneration(): number { return generation; }
```

and in `writeRoundMetrics`, after the transaction function returns successfully: `generation++;`

- [ ] **Step 4: Implement `src/metrics/compare/cache.ts`**

```ts
import { metricsGeneration } from '../store.js';
import type { Origin, SideQuery } from './types.js';

const MAX_ENTRIES = 50;
const entries = new Map<string, { gen: number; value: unknown }>();

export function memo<T>(key: string, compute: () => T): T {
  const gen = metricsGeneration();
  const hit = entries.get(key);
  if (hit && hit.gen === gen) return hit.value as T;
  const value = compute();
  entries.delete(key);
  entries.set(key, { gen, value });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  return value;
}

const IDS_RE = /^\d{1,9}(,\d{1,9}){0,99}$/;
const MAP_RE = /^[A-Za-z0-9_()\- ]{1,64}$/;
const ORIGINS: Origin[] = ['all', 'queue', 'in_game'];

export function parseSideParams(q: Record<string, unknown>): { a: SideQuery; b: SideQuery } | string {
  const ids = (v: unknown) => (typeof v === 'string' && IDS_RE.test(v) ? v.split(',').map(Number) : null);
  const a = ids(q.a), b = ids(q.b);
  if (!a || !b) return 'a and b must be comma-separated patch ids';
  const origin = (q.origin ?? 'all') as Origin;
  if (!ORIGINS.includes(origin)) return 'origin must be all, queue or in_game';
  let maps: string[] | null = null;
  if (typeof q.maps === 'string' && q.maps !== '') {
    maps = q.maps.split(',');
    if (maps.length > 50 || !maps.every((m) => MAP_RE.test(m))) return 'maps must be a comma-separated list of map names';
  }
  return { a: { patchIds: a, origin, maps }, b: { patchIds: b, origin, maps } };
}
```

- [ ] **Step 5: Add the routes in `src/routes/admin.ts`**, next to the balance patch routes:

```ts
  app.get('/api/admin/balance/compare', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const q = req.query as Record<string, unknown>;
    const sides = parseSideParams(q);
    if (typeof sides === 'string') return reply.code(400).send({ error: sides });
    const phases = q.phases === 'split' ? 'split' : 'all';
    const key = `compare|${JSON.stringify(sides)}|${phases}`;
    const result = memo(key, () => compareSides(db, sides.a, sides.b, { phases }));
    if (result.ms > 2000) console.warn(`[balance] compare took ${result.ms} ms for ${key}`);
    return result;
  });

  app.get('/api/admin/balance/metric', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const q = req.query as Record<string, unknown>;
    const sides = parseSideParams(q);
    if (typeof sides === 'string') return reply.code(400).send({ error: sides });
    const metric = typeof q.metric === 'string' ? q.metric : '';
    if (!METRICS.some((m) => m.id === metric)) return reply.code(400).send({ error: 'unknown metric' });
    const phase = q.phase as Phase;
    if (!(['all', ...SUB_PHASES] as string[]).includes(String(phase))) return reply.code(400).send({ error: 'unknown phase' });
    return memo(`metric|${metric}|${phase}|${JSON.stringify(sides)}`, () => metricDetail(db, metric, phase, sides.a, sides.b));
  });
```

Imports: `compareSides`, `metricDetail` from `../metrics/compare/compare.js`; `memo`, `parseSideParams` from `../metrics/compare/cache.js`; `METRICS` from `../metrics/registry.js`; `SUB_PHASES`, `type Phase` from `../metrics/types.js`.

- [ ] **Step 6: Update the alert text in `src/balancePatches.ts`**: "name it in Admin > Setup > Patches" becomes "name it in Admin > Balance > Patches". Update any test asserting the old text.

- [ ] **Step 7: Run tests, typecheck, full suite**

Run: `npx vitest run tests/metrics tests/balanceCompareRoutes.test.ts tests/balancePatches.test.ts && npm run typecheck && npx vitest run`
Expected: PASS (the known flaky `tests/server.test.ts` malformed-URL case may fail; nothing else).

- [ ] **Step 8: Commit**

```bash
git add src/metrics/compare/cache.ts src/metrics/store.ts src/routes/admin.ts src/balancePatches.ts tests/metrics/compareCache.test.ts tests/balanceCompareRoutes.test.ts
git commit -m "balance compare: cached admin routes for comparisons and metric detail"
```

---

### Task 5: Web API client, Balance desk and routing

**Files:**
- Modify: `web/src/api.ts`, `web/src/routes/admin/adminRoutes.ts`, `web/src/routes/Admin.tsx`
- Create: `web/src/routes/admin/balance/Compare.tsx` (placeholder component rendering "Compare" so routing can be tested; Task 7 fills it)
- Test: `web/src/routes/admin/adminRoutes.test.ts`, `web/src/routes/admin.test.tsx` (update / add cases)

**Interfaces:**
- Produces in `web/src/api.ts`: types `Verdict`, `CompareRow`, `SideSummary`, `CompareResult`, `TrendPoint`, `MapBar`, `ExampleRound`, `MetricDetail` (mirrors of `src/metrics/compare/types.ts`), `interface CompareQuery { a: number[]; b: number[]; origin: 'all' | 'queue' | 'in_game'; maps: string[]; phases: 'all' | 'split' }`, and `adminApi.balanceCompare(q: CompareQuery, signal?)`, `adminApi.balanceMetric(q: CompareQuery, metric: string, phase: string, signal?)`.
- Produces in `adminRoutes.ts`: `Desk` includes `'balance'`; `DESKS` gains `{ key: 'balance', label: 'Balance', path: '/admin/balance' }`; `BALANCE_TABS = [{ key: 'compare', label: 'Compare', path: '/admin/balance' }, { key: 'patches', label: 'Patches', path: '/admin/balance/patches' }]`; `patches` removed from `SETUP_TABS`; `parseAdminPath` handles `/admin/balance` (default `compare`) and `/admin/balance/patches`; `legacyRedirect` maps `/admin/setup/patches` to `/admin/balance/patches` for admins.

- [ ] **Step 1: Tests first**

In `adminRoutes.test.ts`, replace the old patches case with:

```ts
it('parses the balance desk', () => {
  expect(parseAdminPath('/admin/balance', { isAdmin: true })).toEqual({ desk: 'balance', section: 'compare', param: null });
  expect(parseAdminPath('/admin/balance/patches', { isAdmin: true })).toEqual({ desk: 'balance', section: 'patches', param: null });
  expect(parseAdminPath('/admin/balance/nope', { isAdmin: true })).toMatchObject({ desk: 'balance', section: 'unknown' });
  expect(parseAdminPath('/admin/balance', { isAdmin: false })).toMatchObject({ desk: 'people' });
});

it('redirects the old patches page', () => {
  expect(legacyRedirect('/admin/setup/patches', '', true)).toBe('/admin/balance/patches');
});
```

and add `/admin/balance` and `/admin/balance/patches` to the `ADMIN_ROUTE_PATHS` URL list test. In `admin.test.tsx`, add a shell test that `/admin/balance/patches` renders the patches page (mock `adminApi.balancePatches` / `balanceDrift` as that file does for other pages) and that the desk tab "Balance" is present for an admin.

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run web/src/routes/admin`
Expected: FAIL.

- [ ] **Step 3: Implement**

`adminRoutes.ts`: add the type member, `DESKS` entry, `BALANCE_TABS`, remove `patches` from `SETUP_TABS`, and in `parseAdminPath` (before the `live` branch):

```ts
  if (desk === 'balance') {
    const section = a === '' ? 'compare' : a;
    return BALANCE_TABS.some((t) => t.key === section)
      ? { desk: 'balance', section, param: null }
      : { ...NOWHERE, desk: 'balance' };
  }
```

In `legacyRedirect`, before the non-admin check: `if (isAdmin && (path === '/admin/setup/patches' || path === '/admin/setup/patches/')) return '/admin/balance/patches';`

`Admin.tsx`: `const sections = r.desk === 'people' ? PEOPLE_TABS : r.desk === 'setup' ? SETUP_TABS : r.desk === 'balance' ? BALANCE_TABS : [];` and in the render switch replace the setup patches line with:

```tsx
{r.desk === 'balance' && r.section === 'compare' && <Compare />}
{r.desk === 'balance' && r.section === 'patches' && <AdminPatches />}
```

`web/src/routes/admin/balance/Compare.tsx` for now:

```tsx
export function Compare() {
  return <div class="stack"><p class="muted">Compare</p></div>;
}
```

`web/src/api.ts`: add the mirrored types and:

```ts
function compareParams(q: CompareQuery): string {
  const p = new URLSearchParams({ a: q.a.join(','), b: q.b.join(','), origin: q.origin, phases: q.phases });
  if (q.maps.length) p.set('maps', q.maps.join(','));
  return p.toString();
}
// in adminApi:
  balanceCompare: (q: CompareQuery, signal?: AbortSignal) => get<CompareResult>(`/api/admin/balance/compare?${compareParams(q)}`, signal),
  balanceMetric: (q: CompareQuery, metric: string, phase: string, signal?: AbortSignal) =>
    get<MetricDetail>(`/api/admin/balance/metric?${compareParams(q)}&metric=${encodeURIComponent(metric)}&phase=${encodeURIComponent(phase)}`, signal),
```

- [ ] **Step 4: Run tests, typecheck, build**

Run: `npx vitest run web/src/routes && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/routes/admin/adminRoutes.ts web/src/routes/admin/adminRoutes.test.ts web/src/routes/Admin.tsx web/src/routes/admin.test.tsx web/src/routes/admin/balance/Compare.tsx
git commit -m "admin: Balance desk with Compare and Patches, old patches path redirects"
```

---

### Task 6: Formatting and URL state helpers

**Files:**
- Create: `web/src/routes/admin/balance/format.ts`
- Test: `web/src/routes/admin/balance/format.test.ts`

**Interfaces:**
- Produces:
  - `isShareMetric(id: string): boolean` (true for ids ending in `_rate`, `_share`, for `round.saferoom`, `round.phase_share`, and every `weapons.*`)
  - `fmtValue(id: string, v: number | null): string` (share: `"23%"`; `_s`: `"104 s"`; `_min`: `"4.4 min"`; otherwise up to 2 decimals trimmed; null: `"n/a"`)
  - `fmtChange(id: string, row: { diff: number | null; rel: number | null; lo: number | null; hi: number | null }): { main: string; range: string }` (share: points, e.g. `"+6 pts"`, range `"[-3, +15]"`; else relative percent `"+33%"` with range in the metric's units)
  - `VERDICT_LABEL: Record<Verdict, string>` = `{ real: 'real change', too_early: 'too early', noise: 'probably noise', no_data: 'no data' }`
  - `GROUP_LABEL: Record<string, string>` for `outcomes, tank, witch, hunter, smoker, boomer, si, weapons, pace` (`si` shows as "Special infected")
  - `readCompareQuery(search: string, patchIds: number[]): CompareQuery & { view: 'ranked' | 'topic' }` (defaults: `b` = the newest patch id, `a` = the one before it, origin `all`, maps `[]`, phases `all`, view `ranked`; ids not in `patchIds` are dropped; an empty side after dropping falls back to its default)
  - `writeCompareQuery(q: CompareQuery & { view: 'ranked' | 'topic' }): string` (a `?a=..&b=..` search string; omits defaults for origin, phases and view)

`patchIds` passed in are ordered oldest to newest.

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/routes/admin/balance/format.test.ts
import { describe, expect, it } from 'vitest';
import { fmtChange, fmtValue, isShareMetric, readCompareQuery, writeCompareQuery } from './format';

describe('balance formatting', () => {
  it('knows share metrics', () => {
    expect(isShareMetric('round.saferoom')).toBe(true);
    expect(isShareMetric('tank.killed_rate')).toBe(true);
    expect(isShareMetric('weapons.hold.smg')).toBe(true);
    expect(isShareMetric('tank.lifetime_s')).toBe(false);
  });
  it('formats values by unit', () => {
    expect(fmtValue('round.saferoom', 0.234)).toBe('23%');
    expect(fmtValue('tank.lifetime_s', 104.25)).toBe('104 s');
    expect(fmtValue('round.length_min', 4.439)).toBe('4.4 min');
    expect(fmtValue('hunter.skeet_rate', null)).toBe('n/a');
    expect(fmtValue('tank.spawns', 0.9612)).toBe('0.96');
  });
  it('formats changes as points for shares and percent otherwise', () => {
    expect(fmtChange('round.saferoom', { diff: 0.06, rel: 0.26, lo: -0.03, hi: 0.15 })).toEqual({ main: '+6 pts', range: '[-3, +15]' });
    expect(fmtChange('tank.lifetime_s', { diff: 12, rel: 0.12, lo: 2, hi: 23 })).toEqual({ main: '+12%', range: '[+2 s, +23 s]' });
    expect(fmtChange('tank.spawns', { diff: null, rel: null, lo: null, hi: null })).toEqual({ main: 'n/a', range: '' });
  });
  it('reads and writes the comparison in the URL', () => {
    expect(readCompareQuery('', [1, 2, 3])).toEqual({ a: [2], b: [3], origin: 'all', maps: [], phases: 'all', view: 'ranked' });
    const q = readCompareQuery('?a=1,2&b=3&origin=queue&view=topic&phases=split', [1, 2, 3]);
    expect(q).toEqual({ a: [1, 2], b: [3], origin: 'queue', maps: [], phases: 'split', view: 'topic' });
    expect(readCompareQuery('?a=99&b=3', [1, 2, 3]).a).toEqual([2]);
    expect(writeCompareQuery({ a: [1, 2], b: [3], origin: 'all', maps: [], phases: 'all', view: 'ranked' })).toBe('?a=1%2C2&b=3');
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run web/src/routes/admin/balance/format.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `format.ts`**

```ts
import type { CompareQuery, Verdict } from '../../../api';

export const VERDICT_LABEL: Record<Verdict, string> = {
  real: 'real change', too_early: 'too early', noise: 'probably noise', no_data: 'no data',
};
export const GROUP_LABEL: Record<string, string> = {
  outcomes: 'Outcomes', tank: 'Tank', witch: 'Witch', hunter: 'Hunter', smoker: 'Smoker',
  boomer: 'Boomer', si: 'Special infected', weapons: 'Weapons', pace: 'Pace',
};

export function isShareMetric(id: string): boolean {
  return id.startsWith('weapons.') || id === 'round.saferoom' || /_(rate|share)$/.test(id);
}
const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)));
const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '-' : '');

export function fmtValue(id: string, v: number | null): string {
  if (v === null) return 'n/a';
  if (isShareMetric(id)) return `${Math.round(v * 100)}%`;
  if (id.endsWith('_s')) return `${Math.round(v)} s`;
  if (id.endsWith('_min')) return `${trim(v, 1)} min`;
  return trim(v, 2);
}

function unitAbs(id: string, v: number): string {
  if (id.endsWith('_s')) return `${Math.round(Math.abs(v))} s`;
  if (id.endsWith('_min')) return `${trim(Math.abs(v), 1)} min`;
  return trim(Math.abs(v), 2);
}

export function fmtChange(id: string, r: { diff: number | null; rel: number | null; lo: number | null; hi: number | null }): { main: string; range: string } {
  if (r.diff === null) return { main: 'n/a', range: '' };
  const range = (f: (v: number) => string) => (r.lo === null || r.hi === null ? '' : `[${f(r.lo)}, ${f(r.hi)}]`);
  if (isShareMetric(id)) {
    const pts = (v: number) => `${sign(Math.round(v * 100))}${Math.abs(Math.round(v * 100))}`;
    return { main: `${pts(r.diff)} pts`, range: range(pts) };
  }
  const main = r.rel === null ? `${sign(r.diff)}${unitAbs(id, r.diff)}` : `${sign(r.rel)}${Math.abs(Math.round(r.rel * 100))}%`;
  return { main, range: range((v) => `${sign(v)}${unitAbs(id, v)}`) };
}

type View = 'ranked' | 'topic';
export function readCompareQuery(search: string, patchIds: number[]): CompareQuery & { view: View } {
  const p = new URLSearchParams(search);
  const known = new Set(patchIds);
  const ids = (k: string) => (p.get(k) ?? '').split(',').filter(Boolean).map(Number).filter((n) => known.has(n));
  const newest = patchIds[patchIds.length - 1];
  const prev = patchIds[patchIds.length - 2];
  const a = ids('a'), b = ids('b');
  const origin = p.get('origin');
  return {
    a: a.length ? a : prev !== undefined ? [prev] : [],
    b: b.length ? b : newest !== undefined ? [newest] : [],
    origin: origin === 'queue' || origin === 'in_game' ? origin : 'all',
    maps: (p.get('maps') ?? '').split(',').filter(Boolean),
    phases: p.get('phases') === 'split' ? 'split' : 'all',
    view: p.get('view') === 'topic' ? 'topic' : 'ranked',
  };
}

export function writeCompareQuery(q: CompareQuery & { view: View }): string {
  const p = new URLSearchParams({ a: q.a.join(','), b: q.b.join(',') });
  if (q.origin !== 'all') p.set('origin', q.origin);
  if (q.maps.length) p.set('maps', q.maps.join(','));
  if (q.phases !== 'all') p.set('phases', q.phases);
  if (q.view !== 'ranked') p.set('view', q.view);
  return `?${p.toString()}`;
}
```

- [ ] **Step 4: Run and see them pass**

Run: `npx vitest run web/src/routes/admin/balance/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/admin/balance/format.ts web/src/routes/admin/balance/format.test.ts
git commit -m "admin balance: value formatting and comparison URL state"
```

---

### Task 7: Compare page (controls, chips, Ranked and By topic views)

**Files:**
- Modify: `web/src/routes/admin/balance/Compare.tsx`
- Modify: `web/src/styles/app.css` (a few classes, below)
- Test: `web/src/routes/admin/balance/Compare.test.tsx`

**Interfaces:**
- Consumes: `adminApi.balancePatches`, `adminApi.balanceCompare` (Task 5), format helpers (Task 6), `QuickCheck` (Task 8; until Task 8 lands, render a plain `<div class="balance-check">Quick check</div>` placeholder component inside this file and replace the import in Task 8).
- Behaviour:
  - Loads the patch list, then reads the comparison from `location.search` with `readCompareQuery(search, patchIdsOldestFirst)`; every control change calls `route('/admin/balance' + writeCompareQuery(next), true)`.
  - Controls: two patch checkbox lists (side A, side B) newest first with `label (N rounds)`; origin select (All rated / Queue only / In-game only); phases select (Whole round only / Include phase splits); a Ranked / By topic chip pair; a phase filter select shown when phases is split (All / Tank / Witch / Event / Normal / Whole round).
  - Banners: skill (`result.banners.skill`), approximate ("Includes historical patches: dates are approximate"), and "Side A and side B are the same" when the id sets are equal, "Pick at least one patch on each side" when a side is empty (no request made).
  - Summary chips: `N real changes`, `N too early`, `N probably noise`, `N no data`; clicking one filters the rows to that verdict (click again to clear).
  - Ranked view: one `table.admin-table` with columns Metric, Phase, A, B, Change, Verdict. Metric cell shows the registry description. Change cell shows `main` and, muted, `range`. Verdict cell has class `verdict verdict--<verdict>` and, for too early, "about N more matches" when `moreMatches` is not null.
  - By topic view: one section per group in `GROUP_LABEL` order with a heading "Tank (1 real, 1 too early, 5 noise)" and the same table for that group's rows.
  - Clicking a row toggles an expanded row directly below it containing `<QuickCheck query={q} metric={row.metric} phase={row.phase} row={row} />`.
  - Side headers above the table: "A: N matches, M rounds" and "B: ...", each followed by "(K rounds use an older metric definition)" when `olderEngineRounds` is non-zero.

CSS to add to `web/src/styles/app.css` (keep braces balanced; `app.css.test.ts` checks):

```css
.verdict--real { color: var(--win); font-weight: 600; }
.verdict--too_early { color: var(--rating); }
.verdict--noise { color: var(--text-muted); }
.verdict--no_data { color: var(--text-muted); font-style: italic; }
.balance-controls { display: flex; flex-wrap: wrap; gap: var(--sp-4); align-items: flex-start; }
.balance-side { display: flex; flex-direction: column; gap: var(--sp-1); max-height: 12rem; overflow-y: auto; }
.balance-banner { border-left: 3px solid var(--rating); padding: var(--sp-2) var(--sp-3); background: var(--surface-2); }
.balance-check { padding: var(--sp-3); background: var(--surface-2); }
```

- [ ] **Step 1: Write the failing render test** (mock pattern from `AdminPatches.test.tsx`; render inside `LocationProvider` so `useLocation` works, and set the URL with `history.replaceState(null, '', '/admin/balance')` first)

```tsx
// web/src/routes/admin/balance/Compare.test.tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { LocationProvider } from 'preact-iso';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: { balancePatches: vi.fn(), balanceCompare: vi.fn(), balanceMetric: vi.fn() } }));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
const { Compare } = await import('./Compare');
afterEach(cleanup);

const patches = [
  { id: 1, number: 1, name: 'Sky pounce fix', notes: '', source: 'historical', firstSeenAt: '2026-09-21 20:10:00', reviewed: true, rounds: 216, servers: [] },
  { id: 2, number: 2, name: 'Saferoom lock', notes: '', source: 'historical', firstSeenAt: '2026-09-22 21:36:00', reviewed: true, rounds: 136, servers: [] },
];
const side = { matches: 40, rounds: 80, meanMu: 25, meanGap: 0, olderEngineRounds: 0, historical: true };
const row = (metric: string, group: string, verdict: string, over = {}) => ({
  metric, group, description: `${metric} description`, phase: 'all', a: 0.18, b: 0.24, diff: 0.06, rel: 0.33, lo: 0.01, hi: 0.1,
  p: 0.01, verdict, moreMatches: verdict === 'too_early' ? 60 : null, excludedMaps: [], nA: 40, nB: 40, ...over,
});
const result = {
  a: side, b: side, ms: 5,
  rows: [row('hunter.skeet_rate', 'hunter', 'real'), row('tank.killed_rate', 'tank', 'too_early'), row('round.saferoom', 'outcomes', 'noise')],
  counts: { real: 1, too_early: 1, noise: 1, no_data: 0 },
  banners: { skill: null, approximate: true },
};

function renderAt(search = '') {
  history.replaceState(null, '', `/admin/balance${search}`);
  mockAdmin.balancePatches.mockResolvedValue({ patches });
  mockAdmin.balanceCompare.mockResolvedValue(result);
  return render(<LocationProvider><Compare /></LocationProvider>);
}

describe('Compare', () => {
  it('defaults to newest vs previous and shows the ranked rows with verdicts', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText('hunter.skeet_rate description')).toBeTruthy());
    expect(mockAdmin.balanceCompare).toHaveBeenCalledWith(expect.objectContaining({ a: [1], b: [2] }), expect.anything());
    expect(screen.getByText('real change')).toBeTruthy();
    expect(screen.getByText(/about 60 more matches/)).toBeTruthy();
    expect(screen.getByText(/approximate/i)).toBeTruthy();
  });

  it('groups rows by topic', async () => {
    renderAt('?a=1&b=2&view=topic');
    await waitFor(() => expect(screen.getByText(/Hunter \(1 real/)).toBeTruthy());
    expect(screen.getByText(/Tank \(.*1 too early/)).toBeTruthy();
  });

  it('filters by a summary chip', async () => {
    renderAt();
    await waitFor(() => screen.getByText('hunter.skeet_rate description'));
    fireEvent.click(screen.getByText(/1 probably noise/));
    await waitFor(() => expect(screen.queryByText('hunter.skeet_rate description')).toBeNull());
    expect(screen.getByText('round.saferoom description')).toBeTruthy();
  });

  it('asks for patches on both sides when one is empty', async () => {
    mockAdmin.balancePatches.mockResolvedValue({ patches: [patches[0]] });
    mockAdmin.balanceCompare.mockResolvedValue(result);
    history.replaceState(null, '', '/admin/balance');
    render(<LocationProvider><Compare /></LocationProvider>);
    await waitFor(() => expect(screen.getByText(/at least one patch on each side/i)).toBeTruthy());
    expect(mockAdmin.balanceCompare).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run web/src/routes/admin/balance/Compare.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `Compare.tsx`**

```tsx
import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { adminApi, type CompareRow, type PatchSummary, type Verdict } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty, Panel } from '../../../components/bits';
import { fmtChange, fmtValue, GROUP_LABEL, readCompareQuery, VERDICT_LABEL, writeCompareQuery } from './format';
import { QuickCheck } from './QuickCheck';

const VERDICTS: Verdict[] = ['real', 'too_early', 'noise', 'no_data'];
const PHASE_FILTERS = ['any', 'all', 'tank', 'witch', 'event', 'normal'] as const;
const patchLabel = (p: PatchSummary) => `${p.name ?? `Unnamed patch ${p.number}`} (${p.rounds} rounds)`;

export function Compare() {
  const { route } = useLocation();
  const patches = useFetch((s) => adminApi.balancePatches(s), []);
  const list = patches.data?.patches ?? [];
  const oldestFirst = list.map((p) => p.id);
  const q = readCompareQuery(location.search, oldestFirst);
  const set = (next: Partial<typeof q>) => route(`/admin/balance${writeCompareQuery({ ...q, ...next })}`, true);
  const ready = list.length > 0 && q.a.length > 0 && q.b.length > 0;
  const same = ready && q.a.length === q.b.length && q.a.every((id) => q.b.includes(id));
  const key = JSON.stringify([q.a, q.b, q.origin, q.maps, q.phases]);
  const cmp = useFetch((s) => (ready && !same ? adminApi.balanceCompare(q, s) : Promise.resolve(null)), [key, ready, same]);
  const [only, setOnly] = useState<Verdict | null>(null);
  const [phaseFilter, setPhaseFilter] = useState<(typeof PHASE_FILTERS)[number]>('any');
  const [open, setOpen] = useState<string | null>(null);

  if (patches.error) return <Empty>Could not load patches.</Empty>;
  if (!patches.data) return <p class="muted">Loading...</p>;

  const toggle = (sideKey: 'a' | 'b', id: number) => {
    const cur = q[sideKey];
    set({ [sideKey]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] } as Partial<typeof q>);
  };
  const newestFirst = [...list].reverse();
  const result = cmp.data;
  const rows = (result?.rows ?? []).filter((r) => (only ? r.verdict === only : true)
    && (phaseFilter === 'any' ? true : r.phase === phaseFilter));

  const table = (rs: CompareRow[]) => (
    <div class="table-wrap">
      <table class="admin-table">
        <thead><tr><th>Metric</th><th>Phase</th><th>A</th><th>B</th><th>Change</th><th>Verdict</th></tr></thead>
        <tbody>
          {rs.flatMap((r) => {
            const k = `${r.metric}|${r.phase}`;
            const ch = fmtChange(r.metric, r);
            const main = (
              <tr key={k} class="is-clickable" onClick={() => setOpen(open === k ? null : k)}>
                <td>{r.description}</td>
                <td>{r.phase === 'all' ? 'whole round' : r.phase}</td>
                <td>{fmtValue(r.metric, r.a)}</td>
                <td>{fmtValue(r.metric, r.b)}</td>
                <td>{ch.main} <span class="muted">{ch.range}</span></td>
                <td class={`verdict verdict--${r.verdict}`}>
                  {VERDICT_LABEL[r.verdict]}
                  {r.verdict === 'too_early' && r.moreMatches !== null && <span class="muted">, about {r.moreMatches >= 500 ? '500+' : r.moreMatches} more matches</span>}
                </td>
              </tr>
            );
            return open === k
              ? [main, <tr key={`${k}-check`}><td colSpan={6}><QuickCheck query={q} row={r} /></td></tr>]
              : [main];
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div class="stack">
      <Panel>
        <div class="balance-controls">
          {(['a', 'b'] as const).map((sk) => (
            <fieldset class="balance-side" key={sk}>
              <legend>Side {sk.toUpperCase()}</legend>
              {newestFirst.map((p) => (
                <label key={p.id}>
                  <input type="checkbox" checked={q[sk].includes(p.id)} onChange={() => toggle(sk, p.id)} /> {patchLabel(p)}
                </label>
              ))}
            </fieldset>
          ))}
          <label>Games
            <select value={q.origin} onChange={(e) => set({ origin: (e.target as HTMLSelectElement).value as typeof q.origin })}>
              <option value="all">All rated</option><option value="queue">Queue only</option><option value="in_game">In-game only</option>
            </select>
          </label>
          <label>Phases
            <select value={q.phases} onChange={(e) => set({ phases: (e.target as HTMLSelectElement).value as typeof q.phases })}>
              <option value="all">Whole round only</option><option value="split">Include phase splits</option>
            </select>
          </label>
          {q.phases === 'split' && (
            <label>Show
              <select value={phaseFilter} onChange={(e) => setPhaseFilter((e.target as HTMLSelectElement).value as typeof phaseFilter)}>
                <option value="any">Every phase</option><option value="all">Whole round</option><option value="tank">Tank alive</option>
                <option value="witch">Witch near</option><option value="event">Event</option><option value="normal">Normal play</option>
              </select>
            </label>
          )}
          <div class="admin-sections">
            <button type="button" class={`chip${q.view === 'ranked' ? ' is-on' : ''}`} onClick={() => set({ view: 'ranked' })}>Ranked</button>
            <button type="button" class={`chip${q.view === 'topic' ? ' is-on' : ''}`} onClick={() => set({ view: 'topic' })}>By topic</button>
          </div>
        </div>
      </Panel>

      {!ready && <p class="balance-banner">Pick at least one patch on each side.</p>}
      {same && <p class="balance-banner">Side A and side B are the same.</p>}
      {cmp.error && <Empty>Could not load the comparison.</Empty>}
      {result && (
        <>
          {result.banners.skill && <p class="balance-banner">{result.banners.skill}</p>}
          {result.banners.approximate && <p class="balance-banner">Includes historical patches: their dates are approximate.</p>}
          <p class="muted">
            {(['a', 'b'] as const).map((sk) => {
              const s = result[sk];
              return <span key={sk}>{sk.toUpperCase()}: {s.matches} matches, {s.rounds} rounds{s.olderEngineRounds > 0 && ` (${s.olderEngineRounds} rounds use an older metric definition)`}. </span>;
            })}
          </p>
          <div class="admin-sections">
            {VERDICTS.map((v) => (
              <button key={v} type="button" class={`chip${only === v ? ' is-on' : ''}`} onClick={() => setOnly(only === v ? null : v)}>
                {result.counts[v]} {v === 'real' ? 'real changes' : VERDICT_LABEL[v]}
              </button>
            ))}
          </div>
          <Panel class="panel--table">
            {q.view === 'ranked'
              ? table(rows)
              : Object.keys(GROUP_LABEL).map((g) => {
                const rs = rows.filter((r) => r.group === g);
                if (rs.length === 0) return null;
                const c = VERDICTS.map((v) => [v, rs.filter((r) => r.verdict === v).length] as const).filter(([, n]) => n > 0)
                  .map(([v, n]) => `${n} ${v === 'real' ? 'real' : VERDICT_LABEL[v]}`).join(', ');
                return <section key={g}><h3>{GROUP_LABEL[g]} ({c})</h3>{table(rs)}</section>;
              })}
          </Panel>
        </>
      )}
    </div>
  );
}
```

Until Task 8, create `web/src/routes/admin/balance/QuickCheck.tsx` with a stub so this compiles:

```tsx
import type { CompareQuery, CompareRow } from '../../../api';
export function QuickCheck(_: { query: CompareQuery; row: CompareRow }) {
  return <div class="balance-check">Quick check</div>;
}
```

Adapt `Panel`'s props, `useFetch` deps and `location.search` access to the real APIs (read `AdminPatches.tsx`); record deviations in the report.

- [ ] **Step 4: Run tests, typecheck, build**

Run: `npx vitest run web/src/routes/admin && npm run typecheck && npm run build && npx vitest run web/src/styles`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/admin/balance/Compare.tsx web/src/routes/admin/balance/QuickCheck.tsx web/src/routes/admin/balance/Compare.test.tsx web/src/styles/app.css
git commit -m "admin balance: Compare page with patch groups, verdict chips, Ranked and By topic views"
```

---

### Task 8: Quick check with SVG trend and per-map bars

**Files:**
- Modify: `web/src/routes/admin/balance/QuickCheck.tsx`
- Create: `web/src/routes/admin/balance/charts.ts` (pure geometry)
- Test: `web/src/routes/admin/balance/charts.test.ts`, `web/src/routes/admin/balance/QuickCheck.test.tsx`

**Interfaces:**
- Consumes: `adminApi.balanceMetric` (Task 5), format helpers (Task 6).
- Produces:
  - `rolling(values: number[], window: number): number[]` (trailing mean; first entries average what is available)
  - `trendGeometry(points: { t: number; v: number }[], w: number, h: number, pad?: number): { x: (t: number) => number; y: (v: number) => number } | null` (null with fewer than 2 points; y flips so larger values are higher; a flat series sits mid-height)
  - `QuickCheck({ query, row })`: fetches detail; shows the numbers line ("A 23% (40 matches, 80 rounds) vs B 29% (38 matches, 76 rounds). Change +6 pts, likely range [-3, +15]." plus "about N more matches" and "Excluded maps: ..." when present); an SVG trend (per-match dots coloured by side, rolling mean line with window 10, vertical dashed lines at patch boundaries with their labels as `<title>`); per-map bars (HTML rows reusing `BarRow` from `components/bits.tsx` if its props fit, else two thin divs per map scaled to the larger value); example replays as links `/match/<id>?ordinal=<o>&half=<h>` labelled "Match #id, map, half h: value".

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/routes/admin/balance/charts.test.ts
import { describe, expect, it } from 'vitest';
import { rolling, trendGeometry } from './charts';

describe('chart geometry', () => {
  it('rolling mean over a trailing window', () => {
    expect(rolling([1, 2, 3, 4], 2)).toEqual([1, 1.5, 2.5, 3.5]);
  });
  it('maps time to x and value to an upward y', () => {
    const g = trendGeometry([{ t: 0, v: 0 }, { t: 10, v: 1 }], 100, 50, 5)!;
    expect(g.x(0)).toBe(0);
    expect(g.x(10)).toBe(100);
    expect(g.y(1)).toBeLessThan(g.y(0));
  });
  it('is null with fewer than two points and centres a flat series', () => {
    expect(trendGeometry([{ t: 0, v: 1 }], 100, 50)).toBeNull();
    const g = trendGeometry([{ t: 0, v: 1 }, { t: 1, v: 1 }], 100, 50)!;
    expect(g.y(1)).toBe(25);
  });
});
```

```tsx
// web/src/routes/admin/balance/QuickCheck.test.tsx
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockAdmin } = vi.hoisted(() => ({ mockAdmin: { balanceMetric: vi.fn() } }));
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return { ...actual, adminApi: { ...actual.adminApi, ...mockAdmin } };
});
const { QuickCheck } = await import('./QuickCheck');
afterEach(cleanup);

const query = { a: [1], b: [2], origin: 'all' as const, maps: [], phases: 'all' as const };
const row = {
  metric: 'round.saferoom', group: 'outcomes', description: 'Saferoom', phase: 'all' as const, a: 0.23, b: 0.29, diff: 0.06,
  rel: 0.26, lo: -0.03, hi: 0.15, p: 0.2, verdict: 'too_early' as const, moreMatches: 60, excludedMaps: ['l4d_vs_airport05_runway'], nA: 40, nB: 38,
};

describe('QuickCheck', () => {
  it('shows the numbers, chart, map bars and replay links', async () => {
    mockAdmin.balanceMetric.mockResolvedValue({
      metric: 'round.saferoom', phase: 'all',
      trend: [
        { matchId: 1, endedAt: '2026-09-21 21:00:00', patchId: 1, side: 'a', value: 0.5 },
        { matchId: 2, endedAt: '2026-09-23 01:00:00', patchId: 2, side: 'b', value: 0 },
      ],
      boundaries: [{ patchId: 1, label: 'Sky pounce fix', at: '2026-09-21 20:10:00' }, { patchId: 2, label: 'Saferoom lock', at: '2026-09-22 21:36:00' }],
      perMap: [{ map: 'l4d_vs_hospital01_apartment', a: 0.2, b: 0.3, roundsA: 20, roundsB: 18 }],
      examples: [{ matchId: 2, ordinal: 0, half: 1, map: 'l4d_vs_hospital01_apartment', value: 1 }],
    });
    const { container } = render(<QuickCheck query={query} row={row} />);
    await waitFor(() => expect(screen.getByText(/Excluded maps/)).toBeTruthy());
    expect(screen.getByText(/about 60 more matches/)).toBeTruthy();
    expect(container.querySelector('svg')).toBeTruthy();
    expect(screen.getByText(/l4d_vs_hospital01_apartment/, { selector: '.balance-map *, .balance-map' })).toBeTruthy();
    const link = container.querySelector('a[href="/match/2?ordinal=0&half=1"]');
    expect(link).toBeTruthy();
  });
});
```

If the `selector` option in the map assertion does not fit the markup you build, assert on a `data-testid="balance-map"` container instead; say so in the report.

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run web/src/routes/admin/balance`
Expected: FAIL.

- [ ] **Step 3: Implement `charts.ts`**

```ts
export function rolling(values: number[], window: number): number[] {
  return values.map((_, i) => {
    const from = Math.max(0, i - window + 1);
    const slice = values.slice(from, i + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

export function trendGeometry(points: { t: number; v: number }[], w: number, h: number, pad = 6) {
  if (points.length < 2) return null;
  const ts = points.map((p) => p.t), vs = points.map((p) => p.v);
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const v0 = Math.min(...vs), v1 = Math.max(...vs);
  return {
    x: (t: number) => (t1 === t0 ? w / 2 : ((t - t0) / (t1 - t0)) * w),
    y: (v: number) => (v1 === v0 ? h / 2 : h - pad - ((v - v0) / (v1 - v0)) * (h - pad * 2)),
  };
}
```

- [ ] **Step 4: Implement `QuickCheck.tsx`**

```tsx
import { adminApi, type CompareQuery, type CompareRow } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty } from '../../../components/bits';
import { rolling, trendGeometry } from './charts';
import { fmtChange, fmtValue } from './format';

const W = 800, H = 160;
const time = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`);

export function QuickCheck({ query, row }: { query: CompareQuery; row: CompareRow }) {
  const d = useFetch((s) => adminApi.balanceMetric(query, row.metric, row.phase, s), [JSON.stringify(query), row.metric, row.phase]);
  const ch = fmtChange(row.metric, row);
  const detail = d.data;
  const pts = (detail?.trend ?? []).map((p) => ({ t: time(p.endedAt), v: p.value, side: p.side }));
  const g = trendGeometry(pts, W, H);
  const mean = rolling(pts.map((p) => p.v), 10);
  const maxBar = Math.max(1e-9, ...(detail?.perMap ?? []).flatMap((m) => [m.a, m.b]));

  return (
    <div class="balance-check stack">
      <p>
        A {fmtValue(row.metric, row.a)} ({row.nA} matches) vs B {fmtValue(row.metric, row.b)} ({row.nB} matches).
        Change {ch.main}{ch.range && <>, likely range {ch.range}</>}.
        {row.verdict === 'too_early' && row.moreMatches !== null && <> Needs about {row.moreMatches >= 500 ? '500+' : row.moreMatches} more matches.</>}
      </p>
      {row.excludedMaps.length > 0 && <p class="muted">Excluded maps (only on one side): {row.excludedMaps.join(', ')}</p>}
      {d.error && <Empty>Could not load the detail.</Empty>}
      {detail && (
        <>
          {g ? (
            <svg class="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${row.description} over time`}>
              {detail.boundaries.map((b) => (
                <line key={b.patchId} x1={g.x(time(b.at))} x2={g.x(time(b.at))} y1={0} y2={H} stroke="var(--border-strong)" stroke-dasharray="4 4">
                  <title>{b.label}</title>
                </line>
              ))}
              {pts.map((p, i) => (
                <circle key={i} cx={g.x(p.t)} cy={g.y(p.v)} r={3} fill={p.side === 'a' ? 'var(--text-muted)' : 'var(--rating)'} />
              ))}
              <polyline points={pts.map((p, i) => `${g.x(p.t).toFixed(1)},${g.y(mean[i]).toFixed(1)}`).join(' ')} />
            </svg>
          ) : <p class="muted">Not enough matches for a trend yet.</p>}
          {detail.perMap.length > 0 && (
            <div class="balance-map" data-testid="balance-map">
              {detail.perMap.map((m) => (
                <div key={m.map}>
                  <div>{m.map} <span class="muted">({m.roundsA} vs {m.roundsB} rounds)</span></div>
                  <div class="bar__track"><div class="bar__fill bar__fill--neutral" style={{ width: `${(m.a / maxBar) * 100}%` }} /></div>
                  <div class="bar__track"><div class="bar__fill bar__fill--good" style={{ width: `${(m.b / maxBar) * 100}%` }} /></div>
                  <div class="muted">A {fmtValue(row.metric, m.a)}, B {fmtValue(row.metric, m.b)}</div>
                </div>
              ))}
            </div>
          )}
          {detail.examples.length > 0 && (
            <ul class="admin-list">
              {detail.examples.map((e) => (
                <li key={`${e.matchId}-${e.ordinal}-${e.half}`}>
                  <a href={`/match/${e.matchId}?ordinal=${e.ordinal}&half=${e.half}`}>
                    Match #{e.matchId}, {e.map ?? 'unknown map'}, half {e.half}: {fmtValue(row.metric, e.value)}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
```

Check the bar class names against `app.css` (`bar__track`, `bar__fill--neutral`, `bar__fill--good`) and add a height rule under `.balance-map .bar__track` if the existing one depends on a parent; keep braces balanced.

- [ ] **Step 5: Run tests, typecheck, build**

Run: `npx vitest run web/src/routes/admin && npm run typecheck && npm run build && npx vitest run web/src/styles`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/admin/balance/QuickCheck.tsx web/src/routes/admin/balance/charts.ts web/src/routes/admin/balance/charts.test.ts web/src/routes/admin/balance/QuickCheck.test.tsx web/src/styles/app.css
git commit -m "admin balance: quick check with trend, per-map bars and example replays"
```

---

### Task 9: Check against a copy of production

**Files:**
- Create (not committed): a scratch script under `.superpowers/sdd/2026-09-23-balance-dashboard/`

This task produces evidence, not product code.

- [ ] **Step 1: Copy the production database locally, read-only on the box**

```bash
mkdir -p /tmp/claude-1000/dash-check
scp root@45.32.199.85:'/home/pug/app/data/pug.db*' /tmp/claude-1000/dash-check/
```

Never write to the box. No other command there.

- [ ] **Step 2: Run the comparison**

A scratch `tsx` script that opens the copy with `openDb`, reads `listPatches`, and calls `compareSides` for (a) "Sky pounce fix" vs "Saferoom lock" and (b) "Anti-bait horde and stumble door" + "Map fixes" vs "Sky pounce fix" + "Saferoom lock", both `phases: 'all'` and `'split'`. Print: time taken, counts per verdict, every real change with its values and range, the 10 largest too-early rows, and the banners. Also call `metricDetail` for `round.saferoom` and one tank metric and print the lengths of trend, perMap and examples.

- [ ] **Step 3: Sanity-check by hand and report**

In the report: timings (must be under 2 s for `split`; if not, report and stop), whether real changes are plausible (a real change needs the shift to be large relative to its range), whether match counts per side match `round_metric_context`, and any row that looks wrong with its numbers. Delete the local copy afterwards.

- [ ] **Step 4: No commit** (unless a bug fix was needed; bugs found go to the report under "Bugs found", not fixed here).

---

## Ship notes (not a task)

Web only: `deploy-web.sh` after merge. No schema change, no plugin change. Check the page loads for an admin and that `/admin/setup/patches` redirects.

## Self-review notes

- Spec coverage: sides as patch groups (Tasks 2, 6, 7), Ranked / By topic and every metric shown (Task 7), quick check with numbers, trend, per map, examples (Tasks 3, 8), map reweighting, bootstrap, BH, verdicts, matches needed (Tasks 1, 3), skill and approximate banners (Tasks 3, 7), game type and map filters (Tasks 2, 4, 7), URL state (Task 6), Balance desk with Compare and Patches plus redirect (Task 5), server-side cache (Task 4), older-definition note (Task 7 side header line), production check (Task 9).
- Types: `CompareQuery`, `CompareRow`, `MetricDetail`, `SideQuery`, `Verdict` consistent across tasks.
