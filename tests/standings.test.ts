import { describe, it, expect } from 'vitest';
import { standings, type TableEntry, type TableResult } from '../src/events/standings.js';

const ents = (n: number, out: number[] = []): TableEntry[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, seed: i + 1, out: out.includes(i + 1) }));
const win = (w: number, l: number, sw: number | null = null, sl: number | null = null): TableResult => ({ a: w, b: l, winner: w, scoreA: sw, scoreB: sl });
const bye = (id: number): TableResult => ({ a: id, b: null, winner: id, scoreA: null, scoreB: null });
const order = (rows: { entryId: number }[]) => rows.map((r) => r.entryId);

describe('standings', () => {
  it('counts wins, losses, byes, points and score difference; forfeits and byes add no score', () => {
    const rows = standings('swiss', ents(3), [win(1, 2, 1000, 800), bye(3), win(3, 1, null, null)], { rounds: 2 });
    const r = Object.fromEntries(rows.map((x) => [x.entryId, x]));
    expect(r[1]).toMatchObject({ played: 2, wins: 1, losses: 1, byes: 0, points: 1, scoreDiff: 200 });
    expect(r[2]).toMatchObject({ played: 1, wins: 0, losses: 1, points: 0, scoreDiff: -200 });
    expect(r[3]).toMatchObject({ played: 1, wins: 2, byes: 1, points: 2, scoreDiff: 0 });
    expect(rows.map((x) => x.rank)).toEqual([1, 2, 3]);
  });

  it('Swiss: points, then Buchholz (byes add 0), then score difference, then head-to-head, then seed', () => {
    // 1 and 2 both on 1 point with equal Buchholz. 2's score diff (49) beats 1's (4).
    const r1 = standings('swiss', ents(4), [win(1, 3, 10, 5), win(2, 4, 50, 0), win(3, 2, 10, 9), win(4, 1, 10, 9)], { rounds: 2 });
    // 1: beat 3(10-5), lost to 4(9-10) → 1 win, points=1, Buchholz=2 (opp[3,4] have 1,1), scoreDiff=4
    // 2: beat 4(50-0), lost to 3(9-10) → 1 win, points=1, Buchholz=2 (opp[4,3] have 1,1), scoreDiff=49
    expect(order(r1).slice(0, 2)).toEqual([2, 1]);
    // Equal Buchholz, so score difference decides.
    const r2 = standings('swiss', ents(4), [win(1, 3, 10, 9), win(2, 4, 50, 0)], { rounds: 1 });
    // 1: beat 3(10-9) → 1 win, points=1, Buchholz=0 (opp[3] has 0), scoreDiff=1
    // 2: beat 4(50-0) → 1 win, points=1, Buchholz=0 (opp[4] has 0), scoreDiff=50
    expect(order(r2)).toEqual([2, 1, 3, 4]);
    // Head-to-head alone: 1 and 2 both have 1 point, Buchholz 1, score diff 0; 2 beat 1 (seed would rank 1 first).
    const r3 = standings('swiss', ents(3), [bye(1), win(2, 1)], { rounds: 2 });
    // 1: bye, lost to 2 → 1 win (bye), 1 loss, points=1, Buchholz=1 (opp[2] has 1 pt), scoreDiff=0
    // 2: beat 1 → 1 win, points=1, Buchholz=1 (opp[1] has 1 pt), scoreDiff=0
    // 3: no results → 0 wins, points=0
    expect(order(r3)).toEqual([2, 1, 3]);
    // Nothing separates them: seed.
    expect(order(standings('swiss', ents(3), [], { rounds: 1 }))).toEqual([1, 2, 3]);
  });

  it('Swiss median Buchholz from 5 rounds drops the best and worst opponent', () => {
    const results = [win(1, 2), win(1, 3), win(1, 4), win(1, 5), win(1, 6), win(2, 3), win(2, 4), win(2, 5)];
    const at4 = standings('swiss', ents(6), results, { rounds: 4 }).find((x) => x.entryId === 1)!;
    const at5 = standings('swiss', ents(6), results, { rounds: 5 }).find((x) => x.entryId === 1)!;
    // Opponents' points: 2 has 3, 3 has 0, 4 has 0, 5 has 0, 6 has 0.
    expect(at4.buchholz).toBe(3);
    expect(at5.buchholz).toBe(0);
  });

  it('league and round robin: wins, then head-to-head among the tied teams, then score difference', () => {
    // 1, 2, 3 each 1 win in a cycle; h2h among the three is 1-1-1, so score difference decides.
    const cycle = [win(1, 2, 10, 0), win(2, 3, 30, 0), win(3, 1, 5, 0)];
    expect(order(standings('league', ents(3), cycle, { rounds: 2 }))).toEqual([2, 1, 3]);
    // Round robin: head-to-head decides even with worse score difference. 1 and 2 both have 2 wins.
    // 1: beat 2(5-100), beat 4(1-0), lost to 3(0-10) → 2 wins, scoreDiff=-104, h2h vs 2: beat
    // 2: lost to 1(100-5), beat 3(1-0), beat 4(3-0) → 2 wins, scoreDiff=99, h2h vs 1: lost
    const rr = standings('round_robin', ents(4), [win(1, 2, 5, 100), win(1, 4, 1, 0), win(2, 3, 1, 0), win(2, 4, 3, 0), win(3, 1, 10, 0)], { rounds: 2 });
    expect(order(rr).slice(0, 2)).toEqual([1, 2]);
    // Single head-to-head.
    expect(order(standings('round_robin', ents(2), [win(2, 1, 1, 0)], { rounds: 1 }))).toEqual([2, 1]);
  });

  it('Swiss: Buchholz tiebreaker with score difference pointing the other way', () => {
    const r = standings('swiss', ents(4), [win(1, 3, 10, 9), win(2, 4, 50, 0), win(3, 4, 10, 0)], { rounds: 2 });
    // 1: beat 3(10-9) → 1 win, points=1, Buchholz=1 (opp[3] has 1 pt), scoreDiff=+1
    // 2: beat 4(50-0) → 1 win, points=1, Buchholz=0 (opp[4] has 0 pts), scoreDiff=+50
    // 3: beat 4(10-0), lost to 1(9-10) → 1 win, 1 loss, points=1, Buchholz=1+0=1, scoreDiff=+9
    // 4: lost to 2, 3 → 0 wins, points=0, Buchholz=2 (opp[2,3] have 1,1 pts)
    // Within points=1: [1,2,3]. By Buchholz: 1 and 3 have 1, 2 has 0. So 2 is last. Then score diff: 3(+9) > 1(+1).
    expect(order(r)).toEqual([3, 1, 2, 4]);
  });

  it('league/round_robin: Buchholz decides after wins, head-to-head and score difference tie', () => {
    const r = standings('league', ents(4), [win(1, 3), win(2, 4), win(3, 4)], { rounds: 2 });
    // 1: beat 3 → 1 win, h2h in [1,2,3]={1:beat 3}, scoreDiff=0, Buchholz=1 (opp[3] has 1 win)
    // 2: beat 4 → 1 win, h2h in [1,2,3]={0}, scoreDiff=0, Buchholz=0 (opp[4] has 0 wins)
    // 3: beat 4, lost to 1 → 1 win, h2h in [1,2,3]={0}, scoreDiff=0, Buchholz=1 (opp[1,4] have 1,0)
    // 4: lost to 2, 3 → 0 wins
    // Within wins=1: [1,2,3]. By h2h: 1 beat 3 (others 0). Then [2,3] by Buchholz: 3 has 1, 2 has 0.
    expect(order(r)).toEqual([1, 3, 2, 4]);
  });

  it('puts out entries last whatever their record, and ignores results for unknown entries', () => {
    const rows = standings('swiss', ents(3, [1]), [win(1, 2), win(1, 3), win(99, 2)], { rounds: 2 });
    expect(order(rows)).toEqual([2, 3, 1]);
    expect(rows[2]).toMatchObject({ out: true, wins: 2, rank: 3 });
    expect(rows.find((x) => x.entryId === 2)!.losses).toBe(2);
  });
});
