// web/src/routes/event/draft/draftText.test.ts
import { describe, it, expect } from 'vitest';
import type { DraftPickView, PlayerCardView } from '../../../api';
import { freshPicks, sortedPool, trendText } from './draftText';

const pick = (pickNo: number, at: string, steamid = `p${pickNo}`): DraftPickView => ({ pickNo, round: 1, captain: 'c', steamid, name: steamid, auto: false, at });
const card = (name: string, sr: number) => ({ steamid: name, name, sr } as PlayerCardView);

describe('freshPicks', () => {
  it('marks everything seen on the first load and reveals nothing', () => {
    const r = freshPicks(null, [pick(1, 'a')]);
    expect(r.fresh).toEqual([]);
    expect(freshPicks(r.seen, [pick(1, 'a'), pick(2, 'b')]).fresh).toEqual([pick(2, 'b')]);
  });
  it('reveals a pick made again after an undo', () => {
    const r = freshPicks(null, [pick(1, 'a'), pick(2, 'b')]);
    expect(freshPicks(r.seen, [pick(1, 'a'), pick(2, 'c', 'p9')]).fresh).toEqual([pick(2, 'c', 'p9')]);
  });
});

describe('sortedPool', () => {
  const pool = [card('bob', 1200), card('Cy', 1350), card('di', 1200)];
  it('sorts by SR, ties by name, or by name, and filters by name ignoring case', () => {
    expect(sortedPool(pool, '', 'sr').map((c) => c.name)).toEqual(['Cy', 'bob', 'di']);
    expect(sortedPool(pool, '', 'name').map((c) => c.name)).toEqual(['bob', 'Cy', 'di']);
    expect(sortedPool(pool, ' C', 'sr').map((c) => c.name)).toEqual(['Cy']);
  });
});

describe('trendText', () => {
  it('says how far SR moved over the trend, or nothing with under two points', () => {
    expect(trendText([1000, 1020, 1044])).toBe('+44 SR across the last 3 rated games');
    expect(trendText([1000, 980])).toBe('-20 SR across the last 2 rated games');
    expect(trendText([1000])).toBeNull();
  });
});
