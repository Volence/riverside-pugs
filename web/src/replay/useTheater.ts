import { useCallback, useEffect, useState } from 'preact/hooks';

/**
 * Theater is a layout state of the viewer, never a route (spec 7.1).
 *
 * Fullscreen is asked for but not relied on: a browser that refuses (or
 * has no API) still gets the fixed-position layout, and the two ways out,
 * Escape and leaving browser fullscreen, both land here. In real fullscreen
 * the browser eats the Escape and fires fullscreenchange instead, so both
 * listeners are needed. The body class lets the stylesheet stop the page
 * behind from scrolling without touching scroll position, which is what
 * "returns to the page with scroll position preserved" needs.
 */
export function useTheater(
  rootRef: { current: HTMLElement | null },
): { theater: boolean; enter(): void; exit(): void; toggle(): void } {
  const [theater, setTheater] = useState(false);

  const enter = useCallback(() => {
    setTheater(true);
    const el = rootRef.current;
    if (el && typeof el.requestFullscreen === 'function') {
      // Older engines may throw or return undefined rather than a promise;
      // a refusal (the user denied it, or an iframe forbids it) leaves the
      // fixed layout, which is enough.
      try {
        const p = el.requestFullscreen() as Promise<void> | undefined;
        p?.catch?.(() => {});
      } catch {
        /* ignore */
      }
    }
  }, [rootRef]);

  const exit = useCallback(() => {
    setTheater(false);
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      // Older engines may throw or return undefined rather than a promise.
      try {
        const p = document.exitFullscreen() as Promise<void> | undefined;
        p?.catch?.(() => {});
      } catch {
        /* ignore */
      }
    }
  }, []);

  const toggle = useCallback(() => {
    if (theater) exit(); else enter();
  }, [theater, enter, exit]);

  useEffect(() => {
    if (!theater) return;
    document.body.classList.add('is-theater');
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') exit(); };
    const onFs = () => { if (!document.fullscreenElement) setTheater(false); };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.body.classList.remove('is-theater');
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, [theater, exit]);

  return { theater, enter, exit, toggle };
}
