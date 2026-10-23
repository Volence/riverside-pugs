// web/src/hooks/useLiveState.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/preact';

const mockApi = vi.hoisted(() => ({
  me: vi.fn(async () => ({ steamid: '1', status: 'active' })),
  state: vi.fn(async () => ({})),
}));
vi.mock('../api', async (orig) => ({ ...(await orig<typeof import('../api')>()), api: mockApi }));

const { wakesLiveState, useLiveState } = await import('./useLiveState');

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

/** Stands in for the browser's WebSocket so a test can open and drop it. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  close(): void {}
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); FakeSocket.all = []; });

describe('useLiveState reconnect', () => {
  it('refetches once when the socket comes back, not on the first open', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderHook(() => useLiveState());
    await waitFor(() => expect(mockApi.me).toHaveBeenCalledTimes(1));
    FakeSocket.all[0]!.onopen!();
    await Promise.resolve();
    expect(mockApi.me).toHaveBeenCalledTimes(1);
    // The web restarts: the socket drops and the retry opens a new one.
    FakeSocket.all[0]!.onclose!();
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.onopen!();
    await waitFor(() => expect(mockApi.me).toHaveBeenCalledTimes(2));
  });
});
