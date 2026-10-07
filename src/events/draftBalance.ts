// Pure draft balancer (plan D2a, ruling 3): teams of four around the captains by SR.
// No db and no imports. Deterministic: ties keep signup order, captains never move.

export interface BalancePlayer { steamid: string; sr: number; order: number }
export interface BalancedTeam { captain: string; players: string[]; avgSr: number; totalSr: number }

const TEAM_SIZE = 4;
const EPS = 1e-9;
const MAX_ITERATIONS = 1000;

type Side = { captain: BalancePlayer; players: BalancePlayer[] };

const sumOf = (t: Side): number => t.captain.sr + t.players.reduce((s, p) => s + p.sr, 0);

function scoreOfSums(sums: number[]): [number, number] {
  const avgs = sums.map((s) => s / TEAM_SIZE);
  const spread = Math.max(...avgs) - Math.min(...avgs);
  const mean = avgs.reduce((s, a) => s + a, 0) / avgs.length;
  return [spread, avgs.reduce((s, a) => s + (a - mean) * (a - mean), 0)];
}

/** The target for a given assignment: [spread, sumSquares]; lower is better, compared in that order. */
export function balanceScore(teams: { captain: BalancePlayer; players: BalancePlayer[] }[]): [number, number] {
  return scoreOfSums(teams.map(sumOf));
}

/** True when a is strictly better than b, beyond floating-point noise. */
function better(a: [number, number], b: [number, number]): boolean {
  if (a[0] < b[0] - EPS) return true;
  if (a[0] > b[0] + EPS) return false;
  return a[1] < b[1] - EPS;
}

/** Ruling 3. captains.length >= 2, pool.length === captains.length * 3, else throws. */
export function balanceAroundCaptains(captains: BalancePlayer[], pool: BalancePlayer[]): BalancedTeam[] {
  const n = captains.length;
  if (n < 2) throw new Error('need at least two captains');
  if (pool.length !== n * (TEAM_SIZE - 1)) throw new Error('pool must hold three players per captain');

  // Snake deal: weakest captain picks first, strongest pool player first.
  const order = [...captains].sort((a, b) => a.sr - b.sr || a.order - b.order);
  const ranked = [...pool].sort((a, b) => b.sr - a.sr || a.order - b.order);
  const sides: Side[] = order.map((captain) => ({ captain, players: [] }));
  ranked.forEach((p, k) => {
    const round = Math.floor(k / n);
    const pos = k % n;
    sides[round % 2 === 0 ? pos : n - 1 - pos]!.players.push(p);
  });

  // Hill-climb: best strictly improving pool swap, first found on equal improvement.
  const sums = sides.map(sumOf);
  let current = scoreOfSums(sums);
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let best: { a: number; i: number; b: number; j: number; score: [number, number] } | null = null;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        for (let i = 0; i < sides[a]!.players.length; i++) {
          for (let j = 0; j < sides[b]!.players.length; j++) {
            const delta = sides[b]!.players[j]!.sr - sides[a]!.players[i]!.sr;
            const trial = sums.slice();
            trial[a] = sums[a]! + delta;
            trial[b] = sums[b]! - delta;
            const score = scoreOfSums(trial);
            if (better(score, best ? best.score : current)) best = { a, i, b, j, score };
          }
        }
      }
    }
    if (!best) break;
    const sa = sides[best.a]!;
    const sb = sides[best.b]!;
    const moved = sa.players[best.i]!;
    sa.players[best.i] = sb.players[best.j]!;
    sb.players[best.j] = moved;
    sums[best.a] = sumOf(sa);
    sums[best.b] = sumOf(sb);
    current = best.score;
  }

  const byCaptain = new Map(sides.map((s) => [s.captain.steamid, s]));
  return captains.map((c) => {
    const s = byCaptain.get(c.steamid)!;
    const totalSr = sumOf(s);
    return { captain: c.steamid, players: s.players.map((p) => p.steamid), avgSr: totalSr / TEAM_SIZE, totalSr };
  });
}
