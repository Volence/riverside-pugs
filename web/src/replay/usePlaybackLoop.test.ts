import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { usePlayback } from './playback';

/* The pure `advance` function is tested next door. This covers the part that
 * is not pure: that the hook's requestAnimationFrame loop is actually wired
 * up, keeps rescheduling, and stops moving when paused.
 *
 * Worth having because a frozen clock is indistinguishable on screen from a
 * paused one, so nothing else in the suite would notice the loop dying. */
function driveRaf() {
  let cbs: FrameRequestCallback[] = [];
  let now = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cbs.push(cb);
    return cbs.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => { cbs = []; });
  vi.stubGlobal('performance', { now: () => now });
  return {
    /** Fire one animation frame `ms` after the previous one. */
    tick(ms: number) {
      now += ms;
      const due = cbs;
      cbs = [];
      for (const cb of due) cb(now);
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('usePlayback loop', () => {
  it('advances the clock as frames fire', () => {
    const raf = driveRaf();
    const { result } = renderHook(() => usePlayback(10_000));
    expect(result.current.tMs).toBe(0);

    act(() => { raf.tick(16); raf.tick(16); raf.tick(16); });
    expect(result.current.tMs).toBeGreaterThan(0);
  });

  it('keeps rescheduling rather than stopping after one frame', () => {
    const raf = driveRaf();
    const { result } = renderHook(() => usePlayback(10_000));

    act(() => { raf.tick(16); });
    const afterOne = result.current.tMs;
    act(() => { raf.tick(16); raf.tick(16); raf.tick(16); });
    expect(result.current.tMs).toBeGreaterThan(afterOne);
  });

  it('stops advancing while paused and resumes on play', () => {
    const raf = driveRaf();
    const { result } = renderHook(() => usePlayback(10_000));

    act(() => { raf.tick(16); });
    act(() => { result.current.pause(); });
    act(() => { raf.tick(16); raf.tick(16); });
    const whilePaused = result.current.tMs;
    act(() => { raf.tick(16); });
    expect(result.current.tMs).toBe(whilePaused);

    act(() => { result.current.play(); });
    act(() => { raf.tick(16); });
    expect(result.current.tMs).toBeGreaterThan(whilePaused);
  });

  // A hidden tab suspends rAF entirely. The cap is what stops the whole
  // absence arriving as one step when it resumes.
  it('caps a single step so returning to a hidden tab does not skip the replay', () => {
    const raf = driveRaf();
    const { result } = renderHook(() => usePlayback(10_000));

    act(() => { raf.tick(40_000); });
    expect(result.current.tMs).toBeLessThanOrEqual(100);
  });
});
