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
export const TREND_WINDOW = 10;
export const PER_MAP_MIN_ROUNDS = 5;
const ORDER: Verdict[] = ['real', 'too_early', 'noise', 'no_data'];

/** 32-bit FNV-1a. Used only to turn a "metric|phase" key into a per-row
 *  seed offset, not for anything security-sensitive. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function compareSides(db: DB, a: SideQuery, b: SideQuery,
  opts: { phases: 'all' | 'split'; reps?: number; seed?: number }): CompareResult {
  const t0 = Date.now();
  const phases: Phase[] = opts.phases === 'split' ? ['all', ...SUB_PHASES] : ['all'];
  const da = loadSide(db, a, phases), db2 = loadSide(db, b, phases);
  const seed = opts.seed ?? SEED;
  const reps = opts.reps ?? REPS;

  const rows: CompareRow[] = [];
  for (const m of METRICS) for (const phase of phases) {
    const sa = da.samples.get(rowKey(m.id, phase)) ?? [];
    const sb = db2.samples.get(rowKey(m.id, phase)) ?? [];
    if (sa.length === 0 && sb.length === 0) continue;
    const base = { metric: m.id, group: m.group, description: m.description, phase, nA: sa.length, nB: sb.length };
    const { shared, excluded } = sharedMaps(sa, sb);
    const w = mapWeights(sa, shared);
    const va = shared.length ? weightedValue(sa, w) : null;
    const vb = shared.length ? weightedValue(sb, w) : null;
    // Each row gets its own PRNG stream (seeded from the whole-round seed plus
    // a hash of its own metric+phase) so splitting whole-round metrics out by
    // sub-phase can never perturb another row's bootstrap draws: a row's lo,
    // hi and p depend only on its own data, not on which other rows or phases
    // happen to be requested alongside it.
    const rand = mulberry32((seed ^ fnv1a(`${m.id}|${phase}`)) >>> 0);
    const boot = va !== null && vb !== null ? bootstrapDiff(sa, sb, w, reps, rand) : null;
    const diff = va !== null && vb !== null ? vb - va : null;
    rows.push({
      ...base, a: va, b: vb, diff, rel: diff !== null && va ? diff / Math.abs(va) : null,
      lo: boot?.lo ?? null, hi: boot?.hi ?? null, p: boot?.p ?? null,
      verdict: 'no_data', moreMatches: boot && diff !== null ? matchesNeeded(diff, boot.seA, boot.seB, sb.length) : null,
      excludedMaps: excluded,
    });
  }
  // Benjamini-Hochberg runs as two separate families: whole-round rows
  // (phase 'all') and sub-phase rows. Otherwise turning phase splitting on
  // would change the whole-round p-value cutoffs (more rows in the same
  // family shifts everyone's rank), and a whole-round verdict would flip
  // depending on whether the sub-phase breakdown was also requested.
  const allIdx: number[] = [], subIdx: number[] = [];
  rows.forEach((r, i) => (r.phase === 'all' ? allIdx : subIdx).push(i));
  const sigAll = benjaminiHochberg(allIdx.map((i) => rows[i].p), FDR);
  const sigSub = benjaminiHochberg(subIdx.map((i) => rows[i].p), FDR);
  const sig = new Array<boolean>(rows.length).fill(false);
  allIdx.forEach((idx, k) => { sig[idx] = sigAll[k]; });
  subIdx.forEach((idx, k) => { sig[idx] = sigSub[k]; });
  rows.forEach((r, i) => {
    r.verdict = verdictOf({ hasData: r.p !== null, significant: sig[i], nA: r.nA, nB: r.nB });
    if (r.verdict !== 'too_early') r.moreMatches = null;
  });
  // Among real rows, a null rel (side A was 0, so no relative change is
  // defined) sorts first, ahead of every finite-rel real row.
  const relKey = (r: CompareRow) => (r.verdict === 'real' && r.rel === null ? Infinity : Math.abs(r.rel ?? 0));
  rows.sort((x, y) => ORDER.indexOf(x.verdict) - ORDER.indexOf(y.verdict)
    || relKey(y) - relKey(x)
    || Math.abs(y.diff ?? 0) - Math.abs(x.diff ?? 0)
    || x.metric.localeCompare(y.metric) || x.phase.localeCompare(y.phase));

  const counts = { real: 0, too_early: 0, noise: 0, no_data: 0 } as Record<Verdict, number>;
  for (const r of rows) counts[r.verdict]++;
  const sa = da.summary, sb = db2.summary;
  const muDiff = sa.meanMu !== null && sb.meanMu !== null ? Math.abs(sa.meanMu - sb.meanMu) : 0;
  const gapDiff = sa.meanGap !== null && sb.meanGap !== null ? Math.abs(sa.meanGap - sb.meanGap) : 0;
  const oneSideMissingRatings = (sa.meanMu === null) !== (sb.meanMu === null);
  const skill = oneSideMissingRatings
    ? 'Ratings are unavailable for one side, so the skill check could not run.'
    : muDiff > SKILL_BANNER_MU || gapDiff > SKILL_BANNER_MU
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
      ORDER BY value, rm.match_id DESC, rm.ordinal, rm.half`).all(...fb.params, metric, phase) as ExampleRound[];
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
