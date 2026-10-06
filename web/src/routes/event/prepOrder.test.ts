import { describe, it, expect } from 'vitest';
import { fullOrder, moveIn } from './prepOrder';

describe('prepOrder', () => {
  it('puts the saved order first, then the rest of the pool, dropping campaigns that left the pool', () => {
    expect(fullOrder(['a', 'b', 'c', 'd'], ['c', 'gone', 'a'])).toEqual(['c', 'a', 'b', 'd']);
    expect(fullOrder(['a', 'b'], [])).toEqual(['a', 'b']);
  });
  it('moves an item up or down and ignores a move off either end', () => {
    expect(moveIn(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveIn(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveIn(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});
