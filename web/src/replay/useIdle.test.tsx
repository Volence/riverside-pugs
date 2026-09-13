import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { useIdle, IDLE_MS } from './useIdle';

afterEach(() => { cleanup(); vi.useRealTimers(); });

function mount(active: boolean) {
  let api!: ReturnType<typeof useIdle>;
  function Host({ on }: { on: boolean }) {
    api = useIdle(on);
    return null;
  }
  const r = render(<Host on={active} />);
  return { get api() { return api; }, set(on: boolean) { r.rerender(<Host on={on} />); } };
}

describe('useIdle', () => {
  it('goes idle after the delay and wakes on demand', () => {
    vi.useFakeTimers();
    const h = mount(true);
    expect(h.api.idle).toBe(false);
    act(() => { vi.advanceTimersByTime(IDLE_MS); });
    expect(h.api.idle).toBe(true);
    act(() => h.api.wake());
    expect(h.api.idle).toBe(false);
    act(() => { vi.advanceTimersByTime(IDLE_MS - 1); });
    expect(h.api.idle).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(h.api.idle).toBe(true);
  });

  it('never goes idle while inactive, and resets when deactivated', () => {
    vi.useFakeTimers();
    const h = mount(false);
    act(() => { vi.advanceTimersByTime(IDLE_MS * 2); });
    expect(h.api.idle).toBe(false);
    h.set(true);
    act(() => { vi.advanceTimersByTime(IDLE_MS); });
    expect(h.api.idle).toBe(true);
    h.set(false);
    expect(h.api.idle).toBe(false);
  });
});
