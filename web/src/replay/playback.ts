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

/** How often the clock is published to Preact state.
 *
 *  The recording is 10Hz, so a health number, a status flag or a scrub
 *  position can only change ten times a second no matter how often it is
 *  re-rendered. Publishing on every animation frame instead re-rendered the
 *  whole viewer subtree sixty times a second to redraw identical text, and
 *  the match page mounts two viewers at once. The canvas keeps its per-frame
 *  clock in `tRef`, where interpolation actually needs it; everything made of
 *  DOM reads this slower tick. Matching the data's own rate is the point, so
 *  this number should follow the capture rate rather than be tuned. */
export const PUBLISH_INTERVAL_MS = 100;

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

export interface Playback {
  /**
   * The authoritative clock, advanced on every animation frame.
   *
   * Read this from a render loop that wants smooth motion: the canvas
   * interpolates between 10Hz frames, so it needs a time that moves at the
   * display's rate. Reading it during render would be a lie, because a ref
   * change does not schedule one.
   */
  tRef: { current: number };
  /** The same clock, published to state about ten times a second. Everything
   *  made of DOM reads this. It never leads `tRef` and never trails it by
   *  more than one tick, because it is only ever assigned `tRef.current`. */
  tMs: number;
  playing: boolean; speed: number; following: boolean;
  play(): void; pause(): void; toggle(): void;
  seek(t: number): void; setSpeed(s: number): void; follow(): void;
}

export function usePlayback(endMs: number, opts: { live?: boolean } = {}): Playback {
  const tRef = useRef(0);
  const [tMs, setTMs] = useState(0);
  /** What the DOM was last told. Compared against `tRef` so the loop can skip
   *  a publish that would not change anything, which is what keeps a paused
   *  viewer from re-rendering ten times a second for nothing. */
  const publishedRef = useRef(0);
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
    let lastPublish = last;

    const step = (now: number): void => {
      const elapsed = now - last;
      last = now;
      const s = stateRef.current;
      if (s.playing) {
        tRef.current = advance(tRef.current, elapsed, s.speed, endRef.current, s.following);
      }
      // Publishing is separate from advancing rather than folded into the
      // branch above, so the last moment of a finished round still reaches
      // the readout: the clock stops changing once it hits the end, and a
      // publish gated on "did it move this frame" would leave the numbers up
      // to one tick short of the end forever.
      if (tRef.current !== publishedRef.current && now - lastPublish >= PUBLISH_INTERVAL_MS) {
        lastPublish = now;
        publishedRef.current = tRef.current;
        setTMs(tRef.current);
      }
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Seeking writes the ref and the state together. The ref is what makes the
  // canvas jump on the very next animation frame instead of at the next
  // publish, and the state is what stops the scrub thumb springing back to
  // where it was for up to a tenth of a second after being dragged.
  const seek = useCallback((t: number) => {
    setFollowing(false);
    const clamped = Math.max(0, Math.min(t, endRef.current));
    tRef.current = clamped;
    publishedRef.current = clamped;
    setTMs(clamped);
  }, []);

  return {
    tRef, tMs, playing, speed, following,
    play: useCallback(() => setPlaying(true), []),
    pause: useCallback(() => setPlaying(false), []),
    toggle: useCallback(() => setPlaying((p) => !p), []),
    seek,
    setSpeed: useCallback((s: number) => setSpeed(s), []),
    follow: useCallback(() => { setFollowing(true); setPlaying(true); }, []),
  };
}
