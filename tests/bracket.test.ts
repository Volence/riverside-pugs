import { describe, it, expect } from 'vitest';
import {
  BracketError, bracketComplete, bracketGroups, bracketMatches, bracketRanks, createBracket, reportResult, type BracketData,
} from '../src/events/bracket.js';
import type { ResultInput } from '../src/events/validate.js';

const aWins: ResultInput = { winner: 'a', scoreA: 10, scoreB: 5, forfeit: false };
const bWins: ResultInput = { winner: 'b', scoreA: 5, scoreB: 10, forfeit: false };
const ready = (d: BracketData) => bracketMatches(d).filter((m) => m.state === 'ready');
/** Plays every ready match with `pick` until none is left. */
async function playAll(d: BracketData, pick: (m: ReturnType<typeof bracketMatches>[number]) => ResultInput): Promise<BracketData> {
  for (let i = 0; i < 64 && ready(d).length > 0; i++) for (const m of ready(d)) d = await reportResult(d, m.bmId, pick(m));
  return d;
}

describe('bracket', () => {
  it('single elimination of 5 gives the top 3 seeds byes and shows no bye matches', async () => {
    const d = await createBracket('single_elim', { thirdPlace: false }, [101, 102, 103, 104, 105]);
    expect(ready(d).map((m) => [m.a, m.b])).toEqual([[104, 105]]);
    expect(bracketMatches(d).every((m) => m.a !== null || m.state === 'pending')).toBe(true);
    const done = await playAll(d, () => aWins);
    expect(bracketComplete(done)).toBe(true);
    expect((await bracketRanks(done))[0]).toEqual({ entryId: 101, rank: 1 });
  });

  it('survives a JSON round trip and never mutates its input', async () => {
    const d = await createBracket('single_elim', { thirdPlace: true }, [1, 2, 3, 4]);
    const copy = JSON.parse(JSON.stringify(d)) as BracketData;
    const before = JSON.stringify(copy);
    const after = await reportResult(copy, ready(copy)[0]!.bmId, aWins);
    expect(JSON.stringify(copy)).toBe(before);
    expect(bracketMatches(after).filter((m) => m.state === 'done')).toHaveLength(1);
  });

  it('third place: semifinal losers meet, and ranks are 1 to 4', async () => {
    const d = await playAll(await createBracket('single_elim', { thirdPlace: true }, [1, 2, 3, 4]), () => aWins);
    expect(bracketMatches(d).filter((m) => m.group === 2)).toHaveLength(1);
    expect((await bracketRanks(d)).map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it('double elimination: no reset match when the upper winner takes the grand final', async () => {
    const d = await playAll(await createBracket('double_elim', { grandFinalReset: true }, [1, 2, 3, 4]), () => aWins);
    expect(bracketMatches(d).filter((m) => m.group === 3).map((m) => m.round)).toEqual([1]);
    expect(bracketComplete(d)).toBe(true);
    expect((await bracketRanks(d))[0]).toEqual({ entryId: 1, rank: 1 });
  });

  it('double elimination: the reset appears when the lower side wins the first grand final', async () => {
    let d = await createBracket('double_elim', { grandFinalReset: true }, [1, 2, 3, 4]);
    d = await playAll(d, (m) => (m.group === 3 ? bWins : aWins));
    const gf = bracketMatches(d).filter((m) => m.group === 3);
    expect(gf.map((m) => [m.round, m.state])).toEqual([[1, 'done'], [2, 'done']]);
    expect(bracketComplete(d)).toBe(true);
  });

  it('a forfeit advances the other side and is marked', async () => {
    const d = await createBracket('single_elim', { thirdPlace: false }, [1, 2]);
    const after = await reportResult(d, ready(d)[0]!.bmId, { winner: 'b', scoreA: null, scoreB: null, forfeit: true });
    expect(bracketMatches(after)[0]).toMatchObject({ state: 'done', winner: 2, forfeit: true, scoreA: null, scoreB: null });
  });

  it('a correction is taken until the next match is played, then refused as locked', async () => {
    let d = await createBracket('single_elim', { thirdPlace: false }, [1, 2, 3, 4]);
    const [m1, m2] = ready(d);
    d = await reportResult(d, m1!.bmId, aWins);
    d = await reportResult(d, m1!.bmId, bWins);
    expect(bracketMatches(d).find((m) => m.bmId === m1!.bmId)!.winner).toBe(m1!.b);
    d = await reportResult(d, m2!.bmId, aWins);
    const final = ready(d)[0]!;
    expect([final.a, final.b]).toContain(m1!.b);
    d = await reportResult(d, final.bmId, aWins);
    await expect(reportResult(d, m1!.bmId, aWins)).rejects.toMatchObject({ code: 'locked' });
    await expect(reportResult(d, m1!.bmId, aWins)).rejects.toBeInstanceOf(BracketError);
  });

  it('refuses a result for a match whose teams are not both known', async () => {
    const d = await createBracket('single_elim', { thirdPlace: false }, [1, 2, 3, 4]);
    const pending = bracketMatches(d).find((m) => m.state === 'pending')!;
    await expect(reportResult(d, pending.bmId, aWins)).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('round robin of 7 in 2 groups: groups of 4 and 3, every pair inside a group once', async () => {
    const d = await createBracket('round_robin', { groups: 2 }, [1, 2, 3, 4, 5, 6, 7]);
    const g = bracketGroups(d);
    const sizes = [1, 2].map((n) => [...g.values()].filter((x) => x === n).length).sort();
    expect(sizes).toEqual([3, 4]);
    expect(bracketMatches(d)).toHaveLength(6 + 3);
    expect(bracketMatches(d).every((m) => g.get(m.a!) === m.group && g.get(m.b!) === m.group)).toBe(true);
    expect(bracketComplete(await playAll(d, () => aWins))).toBe(true);
  });

  it('caps groups so every group has at least 2 teams, and refuses fewer than 2 entries', async () => {
    const d = await createBracket('round_robin', { groups: 4 }, [1, 2, 3, 4, 5]);
    expect(new Set(bracketGroups(d).values()).size).toBe(2);
    await expect(createBracket('single_elim', { thirdPlace: false }, [1])).rejects.toMatchObject({ code: 'too_few' });
  });
});
