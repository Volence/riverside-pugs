/**
 * First values for duo_bonus_min_sr / duo_bonus_max_sr (spec section 8), on
 * a COPY of the production database:
 *
 *   cp pug.db /tmp/pug-copy.db && npx tsx scripts/duo-calibrate.ts /tmp/pug-copy.db
 *
 * 1. Pairs who already landed on the same team often (5+ completed PUGs)
 *    stand in for duos: find the bonus b (mu, both members) that makes their
 *    predicted win rate match their actual one, for the bottom half and the
 *    top quarter of such pairs by average mu.
 * 2. Forced-pair drift: replay each past 8-player lobby with a random pair
 *    forced together and report how far the best split moves from 50%.
 */
import { rating, predictWin } from 'openskill';
import { openDb } from '../src/db.js';
import { balanceTeams } from '../src/balance.js';

const path = process.argv[2];
if (!path || !path.includes('copy')) {
  console.error('usage: duo-calibrate.ts <path containing "copy">');
  process.exit(2);
}
const db = openDb(path);

type Hist = { match_id: number; player_id: string; team: 'a' | 'b'; mu: number; sigma: number; winner: 'a' | 'b' | 'draw' };
const hist = db.prepare(
  `SELECT rh.match_id, rh.player_id, mp.team, rh.mu_before AS mu, rh.sigma_before AS sigma, m.winner
   FROM rating_history rh
   JOIN match_players mp ON mp.match_id = rh.match_id AND mp.player_id = rh.player_id
   JOIN matches m ON m.id = rh.match_id
   WHERE m.state = 'completed' AND m.kind = 'pug' AND m.winner IN ('a','b')`,
).all() as Hist[];
const byMatch = new Map<number, Hist[]>();
for (const h of hist) byMatch.set(h.match_id, [...(byMatch.get(h.match_id) ?? []), h]);

// 1. Frequent same-team pairs.
const pairGames = new Map<string, { m: number; team: 'a' | 'b' }[]>();
for (const [m, rows] of byMatch) {
  for (const t of ['a', 'b'] as const) {
    const side = rows.filter((r) => r.team === t).map((r) => r.player_id).sort();
    for (let i = 0; i < side.length; i++) for (let j = i + 1; j < side.length; j++) {
      const k = `${side[i]}|${side[j]}`;
      pairGames.set(k, [...(pairGames.get(k) ?? []), { m, team: t }]);
    }
  }
}
const frequent = [...pairGames].filter(([, g]) => g.length >= 5);

function predictedWithBonus(pair: string[], m: number, team: 'a' | 'b', b: number): number {
  const rows = byMatch.get(m)!;
  const side = (t: 'a' | 'b') => rows.filter((r) => r.team === t)
    .map((r) => rating({ mu: r.mu + (t === team && pair.includes(r.player_id) ? b : 0), sigma: r.sigma }));
  const [pa] = predictWin([side('a'), side('b')]);
  return team === 'a' ? pa : 1 - pa;
}

function fitBonus(pairs: typeof frequent): number {
  const games = pairs.flatMap(([k, g]) => g.map((x) => ({ pair: k.split('|'), ...x })));
  const actual = games.filter((g) => byMatch.get(g.m)![0].winner === g.team).length / Math.max(1, games.length);
  let best = 0, bestErr = Infinity;
  for (let b = 0; b <= 5; b += 0.05) {
    const pred = games.reduce((n, g) => n + predictedWithBonus(g.pair, g.m, g.team, b), 0) / Math.max(1, games.length);
    if (Math.abs(pred - actual) < bestErr) { bestErr = Math.abs(pred - actual); best = b; }
  }
  return best;
}

const avgMu = ([k, g]: (typeof frequent)[number]) => {
  const [x, y] = k.split('|');
  const rows = byMatch.get(g[g.length - 1].m)!;
  return ((rows.find((r) => r.player_id === x)?.mu ?? 25) + (rows.find((r) => r.player_id === y)?.mu ?? 25)) / 2;
};
const sorted = [...frequent].sort((p, q) => avgMu(p) - avgMu(q));
const bottom = sorted.slice(0, Math.floor(sorted.length / 2));
const top = sorted.slice(Math.floor(sorted.length * 0.75));
console.log(`frequent pairs: ${frequent.length}`);
console.log(`fitted bonus, bottom half: ${(fitBonus(bottom) * 100).toFixed(0)} SR  -> proposed duo_bonus_min_sr`);
console.log(`fitted bonus, top quarter: ${(fitBonus(top) * 100).toFixed(0)} SR  -> proposed duo_bonus_max_sr`);

// 2. Forced-pair drift.
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const drift: { free: number; forced: number }[] = [];
for (const rows of byMatch.values()) {
  if (rows.length !== 8) continue;
  const players = rows.map((r) => ({ steamid: r.player_id, mu: r.mu, sigma: r.sigma }));
  const i = Math.floor(rnd() * 8);
  let j = Math.floor(rnd() * 7);
  if (j >= i) j++;
  drift.push({
    free: Math.abs(balanceTeams(players).pWinA - 0.5),
    forced: Math.abs(balanceTeams(players, { groups: [[players[i].steamid, players[j].steamid]] }).pWinA - 0.5),
  });
}
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
console.log(`forced-pair drift over ${drift.length} lobbies: free ${(avg(drift.map((d) => d.free)) * 100).toFixed(2)} pts from 50%, forced ${(avg(drift.map((d) => d.forced)) * 100).toFixed(2)} pts`);
