import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installStaleBundleReload, RELOAD_GAP_MS } from './staleBundle';

describe('installStaleBundleReload', () => {
  let reload: ReturnType<typeof vi.fn>;
  let win: Window;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T13:00:00Z'));
    sessionStorage.clear();
    reload = vi.fn();
    const target = new EventTarget();
    win = Object.assign(target, { sessionStorage, location: { reload } }) as unknown as Window;
    installStaleBundleReload(win);
  });

  afterEach(() => vi.useRealTimers());

  const fail = () => {
    const e = new Event('vite:preloadError', { cancelable: true });
    win.dispatchEvent(e);
    return e;
  };

  it('reloads once when a lazy chunk fails to load, and swallows the error', () => {
    const e = fail();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('does not loop: a second failure inside the gap stays put', () => {
    fail();
    vi.advanceTimersByTime(RELOAD_GAP_MS - 1);
    const e = fail();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
  });

  it('reloads again once the gap has passed', () => {
    fail();
    vi.advanceTimersByTime(RELOAD_GAP_MS);
    fail();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
