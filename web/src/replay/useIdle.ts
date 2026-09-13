import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

/** How long without pointer movement before the theater chrome fades (spec 7.1). */
export const IDLE_MS = 2000;

/**
 * `idle` turns true `ms` after the last `wake` while `active`; it is never
 * true while inactive. The viewer calls `wake` from pointer movement and
 * focus so the toolbar comes back the moment someone reaches for it.
 */
export function useIdle(active: boolean, ms = IDLE_MS): { idle: boolean; wake(): void } {
  const [idle, setIdle] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const arm = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (activeRef.current) setIdle(true); }, ms);
  }, [ms]);

  const wake = useCallback(() => {
    setIdle(false);
    if (activeRef.current) arm();
  }, [arm]);

  useEffect(() => {
    if (!active) {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      setIdle(false);
      return;
    }
    arm();
    return () => { if (timer.current !== null) clearTimeout(timer.current); };
  }, [active, arm]);

  return { idle, wake };
}
