import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/preact';
import type { WidgetPayload } from '../../../src/widgetTypes';
import { WIDGET_POLL_MS, sessionSince, useWidgetData, widgetApiPath } from './useWidgetData';

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

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
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
