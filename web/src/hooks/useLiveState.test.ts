// web/src/hooks/useLiveState.test.ts
import { describe, it, expect } from 'vitest';
import { wakesLiveState } from './useLiveState';

describe('wakesLiveState', () => {
  it('refetches the queue for everything but a draft room change (plan D2b1 Ruling 10)', () => {
    expect(wakesLiveState('refresh')).toBe(true);
    expect(wakesLiveState('live')).toBe(true);
    expect(wakesLiveState(null)).toBe(true);
    expect(wakesLiveState('draft:4')).toBe(false);
  });
});
