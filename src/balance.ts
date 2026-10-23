import { rating, predictWin } from 'openskill';

export interface RatedPlayer {
  steamid: string;
  mu: number;
  sigma: number;
}

export interface BalanceResult {
  teamA: string[];
  teamB: string[];
  pWinA: number;
}

/** Every way to choose `k` of the indices 1..n-1 (player 0 is always on team A). */
function combos(n: number, k: number): number[][] {
  const out: number[][] = [];
  const pick = (start: number, acc: number[]) => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i < n; i++) { acc.push(i); pick(i + 1, acc); acc.pop(); }
  };
  pick(1, []);
  return out;
}

/** One way to split the players, with team A's rating odds (openskill
 *  predictWin, the same forecast the balancer has always used). */
export interface Split {
  teamA: string[];
  teamB: string[];
  pWinA: number;
}

/**
 * Every split that keeps each group (duo) together, in the order the
 * balancer has always walked them: player 0 always on team A, the rest of A
 * chosen from indices 1..n-1 in lexicographic order.
 */
export function validSplits(players: RatedPlayer[], opts: { groups?: [string, string][] } = {}): Split[] {
  const n = players.length;
  if (n !== 4 && n !== 6 && n !== 8) throw new Error(`balanceTeams needs 4, 6 or 8 players, got ${n}`);
  const ratings = players.map((p) => rating({ mu: p.mu, sigma: p.sigma }));
  const all = Array.from({ length: n }, (_, i) => i);
  // Duos (src/duos.ts) must share a team: a split that separates one is not
  // a candidate. A group naming someone not here is ignored.
  const index = new Map(players.map((p, i) => [p.steamid, i]));
  const groups = (opts.groups ?? [])
    .map(([x, y]) => [index.get(x), index.get(y)])
    .filter((g): g is [number, number] => g[0] !== undefined && g[1] !== undefined);

  const out: Split[] = [];
  for (const rest of combos(n, n / 2 - 1)) {
    const aIdx = [0, ...rest];
    if (groups.some(([x, y]) => aIdx.includes(x) !== aIdx.includes(y))) continue;
    const bIdx = all.filter((x) => !aIdx.includes(x));
    const [pA] = predictWin([aIdx.map((x) => ratings[x]), bIdx.map((x) => ratings[x])]);
    out.push({
      teamA: aIdx.map((x) => players[x].steamid),
      teamB: bIdx.map((x) => players[x].steamid),
      pWinA: pA,
    });
  }
  return out;
}

export function balanceTeams(players: RatedPlayer[], opts: { groups?: [string, string][] } = {}): BalanceResult {
  let best: BalanceResult | null = null;
  // The first split closest to even wins (strict <), in the same
  // lexicographic order the old fixed 8-player loops used, so the 8-player
  // answer (ties included) is unchanged.
  for (const s of validSplits(players, opts)) {
    if (!best || Math.abs(s.pWinA - 0.5) < Math.abs(best.pWinA - 0.5)) best = s;
  }
  if (!best) throw new Error('balanceTeams: no split keeps every group together');
  return best;
}
