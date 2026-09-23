/**
 * The crosshair the Crosshair page saved in this browser, and its texture
 * pixels.
 *
 * The Crosshair page keeps its state in localStorage `xhair` (its own
 * loadState), and on its image shape the imported image, already drawn as
 * the texture it exports, in `xhairImage`. The HUD editor copies it into a
 * brand new design, or into the design it is opened on from that page's
 * Open in the HUD editor button, and from then on the design carries its
 * own crosshair. Anything that could not be drawn exactly as that page
 * would export it counts as no crosshair at all: a missing or unreadable
 * entry, a field of the wrong type, or the image shape with no image.
 */
import { PX_AT_1080, TEX, drawCrosshair, type CrosshairState } from './draw';
import { readArt, readState, type CrosshairArt } from './art';

export const CROSSHAIR_KEY = 'xhair';
export const CROSSHAIR_IMAGE_KEY = 'xhairImage';

/** Per-viewer convenience only, so every access is guarded: a private window or blocked site data makes it throw. */
function readJson(key: string): unknown {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/** The page's drawn crosshair, over its defaults, or null (the image shape included). */
export function savedCrosshair(): CrosshairState | null {
  return readState(readJson(CROSSHAIR_KEY));
}

/** Whatever the page would export: its drawn crosshair, or on its image shape the saved image. */
export function savedArt(): CrosshairArt | null {
  const raw = readJson(CROSSHAIR_KEY);
  if (typeof raw === 'object' && raw !== null && (raw as { shape?: unknown }).shape === 'image') {
    const img = readJson(CROSSHAIR_IMAGE_KEY);
    return typeof img === 'object' && img !== null ? readArt({ ...img, kind: 'image' }) : null;
  }
  const state = readState(raw);
  return state ? { kind: 'built', state } : null;
}

/** Keep the page's imported image, as its texture PNG, for savedArt. */
export function saveImage(img: { png: string; w: number; h: number }): void {
  try { localStorage.setItem(CROSSHAIR_IMAGE_KEY, JSON.stringify(img)); } catch { /* a convenience, not worth surfacing */ }
}

/**
 * The exported texture's pixels: the crosshair drawn centred in a TEX x TEX
 * canvas at the scale the Crosshair page exports at. Both downloads take
 * their texture from here, so the bundled crosshair is that page's own.
 * Null when the browser gives no 2D context.
 */
export function crosshairPixels(s: CrosshairState, image: CanvasImageSource | null): Uint8ClampedArray | null {
  const c = document.createElement('canvas');
  c.width = TEX; c.height = TEX;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  drawCrosshair(ctx, TEX / 2, TEX / 2, TEX / PX_AT_1080, s, image);
  return ctx.getImageData(0, 0, TEX, TEX).data;
}
