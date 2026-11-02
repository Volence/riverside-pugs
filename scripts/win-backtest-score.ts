// scripts/win-backtest-score.ts
// Scoring shared by the parts of scripts/win-backtest.ts: Brier, log loss,
// the 10-bin reliability table and its gate, and a match-level bootstrap.
// A scored point is anything with the outcome `y` (1: team A won) and, for
// the bootstrap, the match it belongs to.

/** Reliability gate: bins with at least this many points ... */
export const GATE_MIN_N = 30;
/** ... must be won within this many percentage points of their mean call. */
export const GATE_MAX_POINTS = 5;

export interface Outcome { y: number }
export interface MatchOutcome extends Outcome { matchId: number }

export function logLoss(ps: number[], pts: Outcome[]): number {
  let s = 0;
  ps.forEach((p, i) => { const q = Math.min(1 - 1e-12, Math.max(1e-12, p)); s -= pts[i].y ? Math.log(q) : Math.log(1 - q); });
  return s / ps.length;
}
export function brier(ps: number[], pts: Outcome[]): number {
  return ps.reduce((s, p, i) => s + (p - pts[i].y) ** 2, 0) / ps.length;
}

export interface Bin { label: string; n: number; called: number; won: number }
export function bins(ps: number[], pts: Outcome[]): Bin[] {
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
export function reliability(bs: Bin[]): string {
  const rows: string[] = ['| Called | n | Called mean | Won |', '|---|---|---|---|'];
  for (const b of bs) {
    rows.push(b.n === 0 ? `| ${b.label} | 0 | | |`
      : `| ${b.label} | ${b.n} | ${(b.called * 100).toFixed(1)}% | ${(b.won * 100).toFixed(1)}% |`);
  }
  return rows.join('\n');
}
/** The bins that miss the reliability gate, described; empty is a pass. */
export function gateMisses(bs: Bin[]): string[] {
  return bs.filter((b) => b.n >= GATE_MIN_N && Math.abs(b.called - b.won) * 100 > GATE_MAX_POINTS)
    .map((b) => `${b.label} (n ${b.n}): called ${(b.called * 100).toFixed(1)}%, won ${(b.won * 100).toFixed(1)}%`);
}

/** 95% interval of the Brier difference (a minus b), resampling whole
 *  matches so a match's points stay together. Seeded, so reruns agree. */
export function bootstrapDiff(a: number[], b: number[], pts: MatchOutcome[]): [number, number] {
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

export const f4 = (x: number) => x.toFixed(5);

export interface Scored { brier: number; logLoss: number; gate: boolean; misses: string[] }
/** Print one model's Brier, log loss, reliability table and gate line. */
export function report(label: string, ps: number[], pts: Outcome[]): Scored {
  const b = brier(ps, pts);
  const l = logLoss(ps, pts);
  const bs = bins(ps, pts);
  const misses = gateMisses(bs);
  const gate = misses.length === 0;
  console.log(`\n### ${label}\n\nBrier ${f4(b)}, log loss ${f4(l)}, points ${pts.length}\n\n${reliability(bs)}`);
  console.log(`\nGate ${gate ? 'PASS' : 'FAIL'} (bins with n >= ${GATE_MIN_N} within ${GATE_MAX_POINTS} points)${gate ? '' : `: ${misses.join('; ')}`}`);
  return { brier: b, logLoss: l, gate, misses };
}
