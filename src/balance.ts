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

export function balanceTeams(players: RatedPlayer[]): BalanceResult {
  if (players.length !== 8) throw new Error(`balanceTeams needs exactly 8 players, got ${players.length}`);
  const ratings = players.map((p) => rating({ mu: p.mu, sigma: p.sigma }));

  let best: BalanceResult | null = null;
  // player 0 always on team A; choose 3 teammates from indices 1..7
  for (let i = 1; i <= 5; i++) {
    for (let j = i + 1; j <= 6; j++) {
      for (let k = j + 1; k <= 7; k++) {
        const aIdx = [0, i, j, k];
        const bIdx = [1, 2, 3, 4, 5, 6, 7].filter((x) => !aIdx.includes(x));
        const [pA] = predictWin([aIdx.map((x) => ratings[x]), bIdx.map((x) => ratings[x])]);
        if (!best || Math.abs(pA - 0.5) < Math.abs(best.pWinA - 0.5)) {
          best = {
            teamA: aIdx.map((x) => players[x].steamid),
            teamB: bIdx.map((x) => players[x].steamid),
            pWinA: pA,
          };
        }
      }
    }
  }
  return best!;
}
