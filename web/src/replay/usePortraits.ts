import { useEffect, useState } from 'preact/hooks';
import { SURVIVOR_CHARACTERS } from '../../../src/replayFormat';

/** Every portrait the map can ask for. `portraitFor` in hud.ts builds the
 *  same URLs; this list exists so they load once, up front, rather than on
 *  the first frame that needs each. */
export const PORTRAIT_URLS: readonly string[] = [
  ...SURVIVOR_CHARACTERS.map((n) => `/portraits/${n}.png`),
  '/portraits/unknown.png',
];

/**
 * Decoded portraits by URL, filled in as each finishes loading.
 *
 * A fresh object on every load rather than a mutated one, because the canvas
 * repaints on prop identity: the paused viewer that first drew discs with no
 * faces has to be told to draw again once the faces exist.
 */
export function usePortraits(): Record<string, HTMLImageElement> {
  const [loaded, setLoaded] = useState<Record<string, HTMLImageElement>>({});
  useEffect(() => {
    let cancelled = false;
    for (const url of PORTRAIT_URLS) {
      const img = new Image();
      img.onload = () => { if (!cancelled) setLoaded((m) => ({ ...m, [url]: img })); };
      img.src = url;
    }
    return () => { cancelled = true; };
  }, []);
  return loaded;
}
