import { describe, it, expect } from 'vitest';
import { quantiles } from '../src/quantiles.js';

describe('quantiles', () => {
  it('returns null for an empty sample', () => {
    expect(quantiles([])).toBeNull();
  });

  it('puts every quantile on the value when there is only one', () => {
    expect(quantiles([7])).toEqual({ n: 1, p25: 7, p50: 7, p75: 7 });
  });

  it('takes the middle value of an odd sample', () => {
    expect(quantiles([1, 2, 3, 4, 5])).toEqual({ n: 5, p25: 2, p50: 3, p75: 4 });
  });

  it('interpolates between the middle pair of an even sample', () => {
    expect(quantiles([1, 2, 3, 4])).toEqual({ n: 4, p25: 1.8, p50: 2.5, p75: 3.3 });
  });

  it('does not care what order the sample arrives in', () => {
    expect(quantiles([5, 1, 4, 2, 3])).toEqual(quantiles([1, 2, 3, 4, 5]));
  });

  it('does not mutate the caller\'s array', () => {
    const sample = [3, 1, 2];
    quantiles(sample);
    expect(sample).toEqual([3, 1, 2]);
  });

  it('counts real zeros as samples rather than dropping them', () => {
    // A stored zero means the player scored nothing in a match that DID
    // measure the stat, so it belongs in the sample and drags the median down.
    // Only an absent row means "not measured", and that never reaches here.
    expect(quantiles([0, 0, 0, 8])).toEqual({ n: 4, p25: 0, p50: 0, p75: 2 });
  });

  it('is not moved far by one enormous night, which is the point', () => {
    const steady = [4, 5, 5, 6, 5];
    const spiked = [4, 5, 5, 6, 40];
    expect(quantiles(spiked)!.p50).toBe(quantiles(steady)!.p50);
  });

  it('rounds to one decimal', () => {
    expect(quantiles([0, 1])).toEqual({ n: 2, p25: 0.3, p50: 0.5, p75: 0.8 });
  });
});
