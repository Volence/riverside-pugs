import { useEffect, useRef, useState } from 'preact/hooks';
import { fmtClock, secondsLeft } from '../format';

/** Seconds remaining, re-rendered as the clock ticks. Polls at 250ms so the
 *  displayed second flips close to when it actually changes rather than up to
 *  a full second late. */
export function useSecondsLeft(deadline: number): number {
  const [left, setLeft] = useState(() => secondsLeft(deadline));
  useEffect(() => {
    setLeft(secondsLeft(deadline));
    const id = setInterval(() => setLeft(secondsLeft(deadline)), 250);
    return () => clearInterval(id);
  }, [deadline]);
  return left;
}

/** A hero countdown with a draining bar.
 *
 *  The bar is not animated per tick. It is set to full width, then on the next
 *  frame to zero with `transition: width <remaining>ms linear`. The browser
 *  interpolates it, so a smooth bar costs no per-frame JavaScript and does not
 *  stutter when the tab is throttled. The digits still tick from a timer,
 *  because those must show a truthful number rather than an interpolated one. */
export function Countdown({ deadline, left }: { deadline: number; left: number }) {
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const remaining = Math.max(0, deadline - Date.now());
    el.style.transition = 'none';
    el.style.width = '100%';
    void el.offsetWidth; // force a reflow so the reset lands before the transition
    el.style.transition = `width ${remaining}ms linear`;
    el.style.width = '0%';
  }, [deadline]);

  return (
    <div class="countdown">
      <div class="hero countdown__digits">{fmtClock(left)}</div>
      <div class="countdown__track">
        <div class="countdown__bar" ref={bar} />
      </div>
    </div>
  );
}
