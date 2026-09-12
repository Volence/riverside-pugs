import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export const SPEEDS = [0.5, 1, 2, 4] as const;

/** Longest real-time step the clock will take in one go.
 *
 *  requestAnimationFrame stops firing while a tab is backgrounded, so the
 *  next frame after coming back reports the whole stall as elapsed. Uncapped,
 *  that advances a saved replay by the entire time you were away in a single
 *  step: tab out for forty seconds and you lose your place. Capping means the
 *  clock pauses in effect rather than skipping, which is what someone who
 *  tabbed away expects to find when they come back. A live viewer is
 *  unaffected either way, because following pins to the newest frame. */
export const MAX_STEP_MS = 100;

/**
 * Where the clock lands after `elapsedMs` of real time.
 *
 * Pure and separate from the hook because this is the part with a decision in
 * it. `following` is the live behaviour: rather than advancing toward an end
 * that is itself moving, the clock simply sits on the newest frame. That is
 * what makes a live view look live instead of drifting a little further
 * behind every time the tab is backgrounded and rAF stops firing.
 */
export function advance(
  tMs: number, elapsedMs: number, speed: number, endMs: number, following: boolean,
): number {
  if (following) return endMs;
  const step = elapsedMs > MAX_STEP_MS ? MAX_STEP_MS : elapsedMs;
  const next = tMs + step * speed;
  if (next >= endMs) return endMs;
  return next < 0 ? 0 : next;
}

export function usePlayback(endMs: number, opts: { live?: boolean } = {}): {
  tMs: number; playing: boolean; speed: number; following: boolean;
  play(): void; pause(): void; toggle(): void;
  seek(t: number): void; setSpeed(s: number): void; follow(): void;
} {
  const [tMs, setTMs] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  // A live viewer starts pinned to the newest frame. Scrubbing anywhere
  // unpins it, so someone rewinding to look at a death is not yanked back to
  // live a second later.
  const [following, setFollowing] = useState(Boolean(opts.live));

  const endRef = useRef(endMs);
  endRef.current = endMs;
  const stateRef = useRef({ playing, speed, following });
  stateRef.current = { playing, speed, following };

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const step = (now: number): void => {
      const elapsed = now - last;
      last = now;
      const s = stateRef.current;
      if (s.playing) {
        setTMs((t) => advance(t, elapsed, s.speed, endRef.current, s.following));
      }
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seek = useCallback((t: number) => {
    setFollowing(false);
    setTMs(Math.max(0, Math.min(t, endRef.current)));
  }, []);

  return {
    tMs, playing, speed, following,
    play: useCallback(() => setPlaying(true), []),
    pause: useCallback(() => setPlaying(false), []),
    toggle: useCallback(() => setPlaying((p) => !p), []),
    seek,
    setSpeed: useCallback((s: number) => setSpeed(s), []),
    follow: useCallback(() => { setFollowing(true); setPlaying(true); }, []),
  };
}
