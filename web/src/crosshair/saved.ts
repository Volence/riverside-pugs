/**
 * The crosshair the Crosshair page saved in this browser, and its texture
 * pixels, for the HUD editor to bundle into a HUD download.
 *
 * The Crosshair page keeps its state in localStorage `xhair` (its own
 * loadState). The HUD page only offers to bundle a crosshair it can draw
 * exactly as that page would export it, so anything it cannot is treated as
 * no crosshair at all: a missing or unreadable entry, a field of the wrong
 * type, or the imported-image shape, whose image is never saved.
 */
import { DEFAULT_STATE, PX_AT_1080, TEX, drawCrosshair, type CrosshairState, type Shape } from './draw';

export const CROSSHAIR_KEY = 'xhair';

const DRAWN: readonly Shape[] = ['cross', 'crossdot', 't', 'dot', 'circle', 'circledot'];
const NUMBERS = ['len', 'thick', 'gap', 'dot', 'radius', 'alpha', 'outline', 'oalpha'] as const;

/** Per-viewer convenience only, so the read is guarded: a private window or blocked site data makes it throw. */
export function savedCrosshair(): CrosshairState | null {
  let raw: unknown;
  try {
    const s = localStorage.getItem(CROSSHAIR_KEY);
    if (!s) return null;
    raw = JSON.parse(s);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const s: CrosshairState = { ...DEFAULT_STATE, ...(raw as Partial<CrosshairState>) };
  if (!DRAWN.includes(s.shape)) return null;
  if (!NUMBERS.every((k) => typeof s[k] === 'number' && Number.isFinite(s[k]))) return null;
  if (typeof s.round !== 'boolean' || typeof s.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.color)) return null;
  const out = { ...DEFAULT_STATE };
  for (const k of Object.keys(DEFAULT_STATE) as (keyof CrosshairState)[]) (out as Record<string, unknown>)[k] = s[k];
  return out;
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
