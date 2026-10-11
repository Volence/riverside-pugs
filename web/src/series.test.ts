import { describe, it, expect } from 'vitest';
import { notCountedLabel, seriesLine } from './series';

describe('series text', () => {
  it('mirrors the server line', () => {
    expect(seriesLine('Test', 1, 1, 'big BAD boys', 0)).toBe('Test 1 - 1 big BAD boys');
    expect(seriesLine('Rats', 0, 0, 'Mice', 1)).toBe('Rats 0 - 0 Mice, 1 draw');
    expect(seriesLine('Rats', 2, 1, 'Mice', 2)).toBe('Rats 2 - 1 Mice, 2 draws');
  });
  it('says which games do not count', () => {
    expect(notCountedLabel({ state: 'completed' })).toBeNull();
    expect(notCountedLabel({ state: 'live' })).toBeNull();
    expect(notCountedLabel({ state: 'pending' })).toBeNull();
    expect(notCountedLabel({ state: 'configuring' })).toBeNull();
    expect(notCountedLabel({ state: 'aborted' })).toBe('Not finished, not counted');
    expect(notCountedLabel({ state: 'aborted', voided: true })).toBe('Voided, not counted');
  });
});
