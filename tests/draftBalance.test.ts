import { describe, it, expect } from 'vitest';
import { balanceAroundCaptains, balanceScore, type BalancePlayer } from '../src/events/draftBalance.js';

const mk = (id: string, sr: number, order: number): BalancePlayer => ({ steamid: id, sr, order });
const spreadOf = (sums: number[]) => (Math.max(...sums) - Math.min(...sums)) / 4;

describe('balanceAroundCaptains', () => {
  it('finds the minimum spread over every split of a two-team pool', () => {
    const caps = [mk('c0', 1000, 0), mk('c1', 1500, 1)];
    const srs = [1600, 1400, 1300, 1200, 1100, 900];
    const pool = srs.map((s, i) => mk(`p${i}`, s, i));
    // Brute force: every choice of 3 of 6 for captain 0, the rest to captain 1.
    let best = Infinity;
    let splits = 0;
    for (let m = 0; m < 64; m++) {
      const pick = [0, 1, 2, 3, 4, 5].filter((i) => m & (1 << i));
      if (pick.length !== 3) continue;
      splits++;
      const a = 1000 + pick.reduce((t, i) => t + srs[i], 0);
      const b = 1500 + srs.reduce((t, s) => t + s, 0) - pick.reduce((t, i) => t + srs[i], 0);
      best = Math.min(best, spreadOf([a, b]));
    }
    expect(splits).toBe(20);
    const out = balanceAroundCaptains(caps, pool);
    expect(out).toHaveLength(2);
    expect(out.map((t) => t.captain)).toEqual(['c0', 'c1']);
    const got = Math.max(...out.map((t) => t.avgSr)) - Math.min(...out.map((t) => t.avgSr));
    expect(got).toBeCloseTo(best, 9);
    for (const t of out) expect(t.players).toHaveLength(3);
    expect(new Set(out.flatMap((t) => t.players)).size).toBe(6);
  });

  it('beats or matches the snake deal and is deterministic', () => {
    const caps = Array.from({ length: 5 }, (_, i) => mk(`c${i}`, 1500 + 40 * i, i));
    const pool = Array.from({ length: 15 }, (_, i) => mk(`p${i}`, 1000 + 25 * i, 100 + i));
    const out = balanceAroundCaptains(caps, pool);
    // Snake deal reference.
    const cs = [...caps].sort((a, b) => a.sr - b.sr || a.order - b.order);
    const ps = [...pool].sort((a, b) => b.sr - a.sr || a.order - b.order);
    const snake = cs.map((c) => ({ captain: c, players: [] as BalancePlayer[] }));
    ps.forEach((p, k) => {
      const round = Math.floor(k / 5);
      const pos = k % 5;
      snake[round % 2 === 0 ? pos : 4 - pos]!.players.push(p);
    });
    const [snakeSpread] = balanceScore(snake);
    const byId = new Map([...caps, ...pool].map((p) => [p.steamid, p]));
    const [spread] = balanceScore(out.map((t) => ({ captain: byId.get(t.captain)!, players: t.players.map((s) => byId.get(s)!) })));
    expect(spread).toBeLessThanOrEqual(snakeSpread + 1e-9);
    expect(balanceAroundCaptains(caps, pool)).toEqual(out);
    expect(out.map((t) => t.captain)).toEqual(caps.map((c) => c.steamid));
  });

  it('keeps the snake deal in signup order when every SR is equal', () => {
    const caps = [mk('c0', 1200, 0), mk('c1', 1200, 1)];
    const pool = Array.from({ length: 6 }, (_, i) => mk(`p${i}`, 1200, i));
    const out = balanceAroundCaptains(caps, pool);
    expect(out[0]!.players).toEqual(['p0', 'p3', 'p4']);
    expect(out[1]!.players).toEqual(['p1', 'p2', 'p5']);
  });

  it('puts a far-above pool star on the weakest captain', () => {
    const caps = [mk('c0', 1500, 0), mk('c1', 1000, 1), mk('c2', 1300, 2)];
    const pool = [mk('star', 2500, 3), ...Array.from({ length: 8 }, (_, i) => mk(`p${i}`, 1180 + 10 * i, 4 + i))];
    const out = balanceAroundCaptains(caps, pool);
    expect(out.find((t) => t.captain === 'c1')!.players).toContain('star');
  });

  it('reports averages and totals over four players', () => {
    const caps = [mk('c0', 1000, 0), mk('c1', 2000, 1)];
    const pool = Array.from({ length: 6 }, (_, i) => mk(`p${i}`, 1000, i));
    const out = balanceAroundCaptains(caps, pool);
    expect(out[0]!.totalSr).toBe(4000);
    expect(out[0]!.avgSr).toBe(1000);
    expect(out[1]!.totalSr).toBe(5000);
  });

  it('throws on wrong sizes', () => {
    const c = (n: number) => Array.from({ length: n }, (_, i) => mk(`c${i}`, 1000, i));
    const p = (n: number) => Array.from({ length: n }, (_, i) => mk(`p${i}`, 1000, i));
    expect(() => balanceAroundCaptains(c(1), p(3))).toThrow();
    expect(() => balanceAroundCaptains(c(2), p(5))).toThrow();
    expect(() => balanceAroundCaptains(c(2), p(7))).toThrow();
  });
});
