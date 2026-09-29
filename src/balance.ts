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

export function balanceTeams(players: RatedPlayer[]): BalanceResult {
  const n = players.length;
  if (n !== 4 && n !== 6 && n !== 8) throw new Error(`balanceTeams needs 4, 6 or 8 players, got ${n}`);
  const ratings = players.map((p) => rating({ mu: p.mu, sigma: p.sigma }));
  const all = Array.from({ length: n }, (_, i) => i);

  let best: BalanceResult | null = null;
  // player 0 always on team A; choose the rest of A from indices 1..n-1, in
  // the same lexicographic order the old fixed 8-player loops used, so the
  // 8-player answer (ties included) is unchanged.
  for (const rest of combos(n, n / 2 - 1)) {
    const aIdx = [0, ...rest];
    const bIdx = all.filter((x) => !aIdx.includes(x));
    const [pA] = predictWin([aIdx.map((x) => ratings[x]), bIdx.map((x) => ratings[x])]);
    if (!best || Math.abs(pA - 0.5) < Math.abs(best.pWinA - 0.5)) {
      best = {
        teamA: aIdx.map((x) => players[x].steamid),
        teamB: bIdx.map((x) => players[x].steamid),
        pWinA: pA,
      };
    }
  }
  return best!;
}
