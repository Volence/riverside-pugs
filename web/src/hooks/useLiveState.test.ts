// web/src/hooks/useLiveState.test.ts
import { describe, it, expect } from 'vitest';
import { wakesLiveState } from './useLiveState';

describe('wakesLiveState', () => {
  it('refetches the queue only for refresh (or an unreadable frame)', () => {
    expect(wakesLiveState('refresh')).toBe(true);
    expect(wakesLiveState(null)).toBe(true);
  });

  it('ignores the live feed and the page-specific events', () => {
    expect(wakesLiveState('live')).toBe(false);
    expect(wakesLiveState('draft:4')).toBe(false);
    expect(wakesLiveState('event_room')).toBe(false);
    expect(wakesLiveState('server_chat')).toBe(false);
  });
});
