import { describe, it, expect } from 'vitest';
import { endorsable } from './endorse';

describe('endorsable', () => {
  it('is a completed PUG only; an older server with no kind reads as a PUG', () => {
    expect(endorsable({ state: 'completed', kind: 'pug' })).toBe(true);
    expect(endorsable({ state: 'completed' })).toBe(true);
    expect(endorsable({ state: 'completed', kind: 'scrim' })).toBe(false);
    expect(endorsable({ state: 'completed', kind: 'tournament' })).toBe(false);
    expect(endorsable({ state: 'aborted', kind: 'pug' })).toBe(false);
  });
});
