import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/preact';
import type { WidgetPayload } from '../../../src/widgetTypes';
import { DEFAULT_DELAY_MS } from '../../../src/replayTail';
import { LIVE_NUDGE_MS, NUDGE_JITTER_MS, REFRESH_NUDGE_MS, WIDGET_POLL_MS, sessionSince, useWidgetData, widgetApiPath } from './useWidgetData';

const ID = '76561198000000001';

function payload(name: string): WidgetPayload {
  return {
    serverNow: 0, theme: null, player: { steamid: ID, name },
    live: null, rating: null, session: null, last: null, queue: null,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Let the mocked fetch resolve and Preact flush the rerender. */
async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Stands in for the site's /ws hub: `say` delivers a broadcast by name. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  close() { /* nothing to tear down */ }
  say(event: string) { this.onmessage?.({ data: JSON.stringify({ event }) }); }
}

/** Broadcast to every open fake socket and let the timers settle. */
async function broadcast(event: string) {
  await act(async () => {
    for (const s of FakeSocket.all) s.say(event);
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  try { localStorage.clear(); } catch { /* none */ }
});

describe('widgetApiPath', () => {
  it('builds the endpoint URL with tz and since', () => {
    expect(widgetApiPath(ID, 1234, 60)).toBe(`/api/widget/${ID}?tz=60&since=1234`);
    expect(widgetApiPath(ID, null, -300)).toBe(`/api/widget/${ID}?tz=-300&since=`);
  });

  it('defaults tz to minutes east of UTC from this browser', () => {
    expect(widgetApiPath(ID, null)).toBe(`/api/widget/${ID}?tz=${-new Date().getTimezoneOffset()}&since=`);
  });
});

describe('useWidgetData', () => {
  it('loads, then shows the data', async () => {
    fetchMock.mockResolvedValueOnce(json(payload('Alice')));
    const { result } = renderHook(() => useWidgetData(ID, { since: 5 }));
    expect(result.current).toEqual({ kind: 'loading' });
    await flush();
    expect(result.current).toEqual({ kind: 'ok', data: payload('Alice') });
    expect(String(fetchMock.mock.calls[0][0])).toBe(widgetApiPath(ID, 5));
  });

  it('keeps the last data when a poll fails', async () => {
    fetchMock
      .mockResolvedValueOnce(json(payload('Alice')))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(json({ error: 'boom' }, 500))
      .mockResolvedValueOnce(json(payload('Bob')));
    const { result } = renderHook(() => useWidgetData(ID, { since: null }));
    await flush();
    expect(result.current).toEqual({ kind: 'ok', data: payload('Alice') });
    await act(async () => { await vi.advanceTimersByTimeAsync(WIDGET_POLL_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ kind: 'ok', data: payload('Alice') });
    await act(async () => { await vi.advanceTimersByTimeAsync(WIDGET_POLL_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual({ kind: 'ok', data: payload('Alice') });
    await act(async () => { await vi.advanceTimersByTimeAsync(WIDGET_POLL_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.current).toEqual({ kind: 'ok', data: payload('Bob') });
  });

  it('becomes gone on 404', async () => {
    fetchMock
      .mockResolvedValueOnce(json(payload('Alice')))
      .mockResolvedValueOnce(json({ error: 'no such player' }, 404));
    const { result } = renderHook(() => useWidgetData(ID, { since: null }));
    await flush();
    expect(result.current.kind).toBe('ok');
    await act(async () => { await vi.advanceTimersByTimeAsync(WIDGET_POLL_MS); });
    expect(result.current).toEqual({ kind: 'gone' });
  });

  it('polls immediately when the page becomes visible', async () => {
    fetchMock.mockImplementation(async () => json(payload('Alice')));
    renderHook(() => useWidgetData(ID, { since: null }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The chain restarts from that poll rather than doubling up.
    await act(async () => { await vi.advanceTimersByTimeAsync(WIDGET_POLL_MS - 1); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vis.mockRestore();
  });

  it('stops polling on unmount', async () => {
    fetchMock.mockImplementation(async () => json(payload('Alice')));
    const { unmount } = renderHook(() => useWidgetData(ID, { since: null }));
    await flush();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(WIDGET_POLL_MS * 3); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('useWidgetData broadcasts', () => {
  const after = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fetchMock.mockImplementation(async () => json(payload('Alice')));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('waits out the live delay before fetching after a "live" broadcast', () => {
    // Sooner and it asks before the new score is released, then shows it
    // only on the next regular poll.
    expect(LIVE_NUDGE_MS).toBeGreaterThan(DEFAULT_DELAY_MS);
  });

  it('listens on the site hub', async () => {
    renderHook(() => useWidgetData(ID, { since: null }));
    await flush();
    expect(FakeSocket.all.map((s) => new URL(s.url).pathname)).toEqual(['/ws']);
  });

  it('fetches once the live delay has passed after a "live" broadcast', async () => {
    renderHook(() => useWidgetData(ID, { since: null }));
    await flush();
    await broadcast('live');
    await after(LIVE_NUDGE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await after(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Then back on the regular timer from that fetch.
    await after(WIDGET_POLL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await after(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fetches soon after a "refresh" broadcast', async () => {
    renderHook(() => useWidgetData(ID, { since: null }));
    await flush();
    await broadcast('refresh');
    await after(REFRESH_NUDGE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await after(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('spreads the fetch by up to the jitter', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    renderHook(() => useWidgetData(ID, { since: null }));
    await flush();
    await broadcast('refresh');
    await after(REFRESH_NUDGE_MS + NUDGE_JITTER_MS / 2 - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await after(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores other broadcasts', async () => {
    renderHook(() => useWidgetData(ID, { since: null }));
    await flush();
    await broadcast('server_chat');
    await after(WIDGET_POLL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never pushes a sooner poll later', async () => {
    renderHook(() => useWidgetData(ID, { since: null }));
    await flush();
    // The regular poll is due in 5 s; a "live" nudge would be later.
    await after(WIDGET_POLL_MS - 5000);
    await broadcast('live');
    await after(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a nudge that arrives while a fetch is in flight', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock
      .mockResolvedValueOnce(json(payload('Alice')))
      .mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }))
      .mockImplementation(async () => json(payload('Bob')));
    const { result } = renderHook(() => useWidgetData(ID, { since: null }));
    await flush();
    await after(WIDGET_POLL_MS); // second fetch starts and hangs
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await broadcast('refresh');
    await act(async () => { release(json(payload('Alice'))); await vi.advanceTimersByTimeAsync(0); });
    await after(REFRESH_NUDGE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual({ kind: 'ok', data: payload('Bob') });
  });

  it('keeps polling when a nudge comes due during a slow fetch', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock
      .mockResolvedValueOnce(json(payload('Alice')))
      .mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }))
      .mockImplementation(async () => json(payload('Bob')));
    const { result } = renderHook(() => useWidgetData(ID, { since: null }));
    await flush();
    await after(WIDGET_POLL_MS); // second fetch starts and hangs
    await broadcast('refresh');
    await after(REFRESH_NUDGE_MS); // the nudge comes due while it hangs
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { release(json(payload('Alice'))); await vi.advanceTimersByTimeAsync(0); });
    // The missed nudge runs straight after, then the regular chain carries on.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual({ kind: 'ok', data: payload('Bob') });
    await after(WIDGET_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('closes its socket on unmount', async () => {
    const { unmount } = renderHook(() => useWidgetData(ID, { since: null }));
    await flush();
    const close = vi.spyOn(FakeSocket.all[0], 'close');
    unmount();
    expect(close).toHaveBeenCalled();
    await broadcast('live');
    await after(LIVE_NUDGE_MS + NUDGE_JITTER_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('sessionSince', () => {
  const KEY = `widget-session-${ID}`;
  const H = 3_600_000;
  const NOW = 1_800_000_000_000;

  it('starts a session at now when none is stored', () => {
    expect(sessionSince(ID, NOW, false)).toBe(NOW);
    expect(localStorage.getItem(KEY)).toBe(String(NOW));
  });

  it('keeps a stored session younger than 12 h', () => {
    localStorage.setItem(KEY, String(NOW - 11 * H));
    expect(sessionSince(ID, NOW, false)).toBe(NOW - 11 * H);
  });

  it('starts a new session when the stored one is older than 12 h', () => {
    localStorage.setItem(KEY, String(NOW - 13 * H));
    expect(sessionSince(ID, NOW, false)).toBe(NOW);
    expect(localStorage.getItem(KEY)).toBe(String(NOW));
  });

  it('starts a new session on reset', () => {
    localStorage.setItem(KEY, String(NOW - H));
    expect(sessionSince(ID, NOW, true)).toBe(NOW);
    expect(localStorage.getItem(KEY)).toBe(String(NOW));
  });

  it('treats garbage or a future time as no session', () => {
    localStorage.setItem(KEY, 'banana');
    expect(sessionSince(ID, NOW, false)).toBe(NOW);
    localStorage.setItem(KEY, String(NOW + H));
    expect(sessionSince(ID, NOW, false)).toBe(NOW);
  });

  it('still answers when storage throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(sessionSince(ID, NOW, false)).toBe(NOW);
    get.mockRestore(); set.mockRestore();
  });
});
