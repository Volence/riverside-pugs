import type { MapLayer } from '../../../src/mapTransform';

/**
 * Warming the browser's cache with the rest of a map's overview layers.
 *
 * A layer is 2 to 10 MB on the wire, so the first switch to one stalls the
 * viewer: `useMapLayer` holds the previous image on screen until the new one
 * arrives, which reads as a stutter every time the team changes floor. The
 * bytes are immutable and cached for a year, so fetching them once up front
 * turns every later switch into a disk read.
 *
 * Deliberately warms the HTTP cache rather than keeping the images: decoded,
 * one 8192x5084 layer is about 167 MB of bitmap, and a tall map has fifteen.
 * Holding those is how you turn a stutter into an out-of-memory tab, so the
 * images here are dropped as soon as they load and the browser is left to
 * decide what stays decoded.
 */

/** What `navigator.connection` offers that is worth reading. Typed here
 *  because it is still not in the DOM lib, and absent entirely on Safari. */
export interface ConnectionInfo {
  saveData?: boolean;
  effectiveType?: string;
}

/** Connections where tens of megabytes of prefetch would be rude. */
const SLOW = new Set(['slow-2g', '2g']);

export function shouldPreload(connection: ConnectionInfo | undefined): boolean {
  if (!connection) return true;         // says nothing: assume it can take it
  if (connection.saveData) return false;
  return !SLOW.has(connection.effectiveType ?? '');
}

/**
 * The other layers' URLs, nearest cut height first.
 *
 * Nearest first because a team leaves a floor for the one above or below it,
 * never for the roof: the next layer needed is almost always a neighbour, and
 * ordering this way means the useful bytes land before the far ones.
 */
export function preloadOrder(layers: readonly MapLayer[], currentImage: string): string[] {
  const current = layers.find((l) => l.image === currentImage);
  const from = current ? current.cutHeight : 0;
  return layers
    .filter((l) => l.image !== currentImage)
    .slice()
    .sort((a, b) => Math.abs(a.cutHeight - from) - Math.abs(b.cutHeight - from))
    .map((l) => l.image);
}

/**
 * Fetch each URL in turn, one at a time, until cancelled.
 *
 * Sequential on purpose: the point is to be invisible, and a parallel burst of
 * eight multi-megabyte images competes with the layer the viewer is actually
 * waiting on. `fetchPriority` says the same thing to the browser's scheduler.
 * A failure is not worth reporting: the layer simply loads normally later.
 */
export function preloadSequentially(urls: readonly string[]): () => void {
  let cancelled = false;
  void (async () => {
    for (const url of urls) {
      if (cancelled) return;
      await new Promise<void>((done) => {
        const img = new Image();
        img.fetchPriority = 'low';
        img.onload = () => done();
        img.onerror = () => done();
        img.src = url;
      });
    }
  })();
  return () => { cancelled = true; };
}
