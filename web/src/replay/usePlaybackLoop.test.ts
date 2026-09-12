import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { PUBLISH_INTERVAL_MS, usePlayback } from './playback';

/* The pure `advance` function is tested next door. This covers the part that
 * is not pure: that the hook's requestAnimationFrame loop is actually wired
 * up, keeps rescheduling, and stops moving when paused.
 *
 * Worth having because a frozen clock is indistinguishable on screen from a
 * paused one, so nothing else in the suite would notice the loop dying.
 *
 * The clock the loop owns is `tRef`, which advances on every animation frame
 * and is what the canvas interpolates from; `tMs` is the same clock published
 * to state about ten times a second for the DOM. These tests assert on the
 * ref, because that is now where "the loop is running" is visible, and then
 * separately that the published copy follows it. Asserting only on `tMs`
 * would no longer distinguish a dead loop from a loop between publishes. */
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
    expect(result.current.tRef.current).toBe(0);

    act(() => { raf.tick(16); raf.tick(16); raf.tick(16); });
    expect(result.current.tRef.current).toBeGreaterThan(0);
  });

  it('keeps rescheduling rather than stopping after one frame', () => {
    const raf = driveRaf();
    const { result } = renderHook(() => usePlayback(10_000));

    act(() => { raf.tick(16); });
    const afterOne = result.current.tRef.current;
    act(() => { raf.tick(16); raf.tick(16); raf.tick(16); });
    expect(result.current.tRef.current).toBeGreaterThan(afterOne);
  });

  it('stops advancing while paused and resumes on play', () => {
    const raf = driveRaf();
    const { result } = renderHook(() => usePlayback(10_000));

    act(() => { raf.tick(16); });
    act(() => { result.current.pause(); });
    act(() => { raf.tick(16); raf.tick(16); });
    const whilePaused = result.current.tRef.current;
    act(() => { raf.tick(16); });
    expect(result.current.tRef.current).toBe(whilePaused);

    act(() => { result.current.play(); });
    act(() => { raf.tick(16); });
    expect(result.current.tRef.current).toBeGreaterThan(whilePaused);
  });

  // A hidden tab suspends rAF entirely. The cap is what stops the whole
  // absence arriving as one step when it resumes.
  it('caps a single step so returning to a hidden tab does not skip the replay', () => {
    const raf = driveRaf();
    const { result } = renderHook(() => usePlayback(10_000));

    act(() => { raf.tick(40_000); });
    expect(result.current.tRef.current).toBeLessThanOrEqual(100);
  });

  /* The split's own risk: two rates reading one clock could drift apart, and
   * a readout that disagrees with the map is worse than a slow readout. */
  it('publishes the ref to state, never leading it and never trailing by more than a tick', () => {
    const raf = driveRaf();
    const { result } = renderHook(() => usePlayback(600_000));

    act(() => { for (let i = 0; i < 60; i++) raf.tick(1000 / 60); });

    expect(result.current.tMs).toBeGreaterThan(0);
    expect(result.current.tMs).toBeLessThanOrEqual(result.current.tRef.current);
    expect(result.current.tRef.current - result.current.tMs)
      .toBeLessThanOrEqual(PUBLISH_INTERVAL_MS);
  });

  // The clock stops changing at the end of a round, so a publish gated on
  // "did it move this frame" would leave the readout permanently short of
  // the end it is sitting on.
  it('publishes the final moment once the clock has stopped at the end', () => {
    const raf = driveRaf();
    const { result } = renderHook(() => usePlayback(500));

    act(() => { for (let i = 0; i < 60; i++) raf.tick(1000 / 60); });

    expect(result.current.tRef.current).toBe(500);
    expect(result.current.tMs).toBe(500);
  });

  // Seeking has to land on the canvas at once. The canvas only ever reads
  // the ref, so a seek that set state alone would leave the map a tenth of a
  // second behind the thumb the user is dragging.
  it('seeks the ref and the state together, without waiting for a publish', () => {
    const raf = driveRaf();
    const { result } = renderHook(() => usePlayback(10_000));

    act(() => { raf.tick(16); });
    act(() => { result.current.seek(4321); });

    expect(result.current.tRef.current).toBe(4321);
    expect(result.current.tMs).toBe(4321);
  });

  it('clamps a seek to the round and unpins a live viewer', () => {
    const raf = driveRaf();
    const { result } = renderHook(() => usePlayback(10_000, { live: true }));
    expect(result.current.following).toBe(true);

    act(() => { result.current.seek(99_999); });
    expect(result.current.tRef.current).toBe(10_000);
    expect(result.current.following).toBe(false);

    act(() => { result.current.seek(-5); });
    expect(result.current.tRef.current).toBe(0);
  });
});
