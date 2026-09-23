/**
 * A crosshair as a design carries it, and the one routine that draws it.
 *
 * A crosshair is either built (the Crosshair Maker's parameters, drawn by
 * drawCrosshair) or an image (an uploaded picture, or the texture out of a
 * crosshair addon's .vpk, kept as a PNG data URL). Both arrive from
 * untrusted places (a share link, a .json file, this browser's storage), so
 * readArt rebuilds them field by field like validateDesign does, and a
 * crosshair it returns is always one the texture can be made from.
 *
 * drawArt draws either kind into a square of any size exactly as the game
 * draws the texture into the 26-unit xHair element: the canvas preview, the
 * side panel's zoom and the exported texture all go through it, so none of
 * them can disagree with the others.
 */
import { DEFAULT_STATE, PX_AT_1080, drawCrosshair, type CrosshairState, type Shape, type Backdrop, type Res } from './draw';
import { MAX_IMAGE_B64, MAX_IMAGE_SIDE } from '../hud/limits';

export type CrosshairArt =
  | { kind: 'built'; state: CrosshairState }
  | { kind: 'image'; png: string; w: number; h: number };

/** The shapes the builder draws; 'image' is not one, an image is its own kind of art. */
export const DRAWN: readonly Shape[] = ['cross', 'crossdot', 't', 'dot', 'circle', 'circledot'];

type NumKey = 'len' | 'thick' | 'gap' | 'dot' | 'radius' | 'alpha' | 'outline' | 'oalpha';
/** Each number's slider: min, max and step, in 1080p screen pixels or percent. The builder and readState share it. */
export const LIMITS: Record<NumKey, readonly [number, number, number]> = {
  len: [0, 30, 0.5], thick: [0.5, 10, 0.5], gap: [0, 30, 0.5], dot: [0.5, 16, 0.5],
  radius: [1, 40, 0.5], alpha: [10, 100, 1], outline: [0, 4, 0.5], oalpha: [0, 100, 1],
};

const BACKDROPS: readonly Backdrop[] = ['scene', 'dark', 'bright', 'grey', 'shot'];
const RESES: readonly Res[] = ['768', '1080', '1440', '2160'];
export const PNG_PREFIX = 'data:image/png;base64,';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A builder state, over the defaults, or null when the builder could not
 * have made it: a shape it does not draw, a number that is not one, a
 * colour that is not #rrggbb. Numbers are clamped to the sliders' ranges.
 * The backdrop and resolution only change the Crosshair page's preview, so
 * a bad one falls back rather than losing the crosshair.
 */
export function readState(raw: unknown): CrosshairState | null {
  if (!isObj(raw)) return null;
  const s = { ...DEFAULT_STATE, ...raw } as Record<string, unknown>;
  if (!DRAWN.includes(s.shape as Shape)) return null;
  if (typeof s.round !== 'boolean' || typeof s.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.color)) return null;
  const out: CrosshairState = {
    ...DEFAULT_STATE,
    shape: s.shape as Shape, round: s.round, color: s.color,
    backdrop: BACKDROPS.includes(s.backdrop as Backdrop) ? s.backdrop as Backdrop : DEFAULT_STATE.backdrop,
    res: RESES.includes(s.res as Res) ? s.res as Res : DEFAULT_STATE.res,
  };
  for (const [k, [lo, hi]] of Object.entries(LIMITS) as [NumKey, readonly [number, number, number]][]) {
    const v = s[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[k] = Math.min(hi, Math.max(lo, v));
  }
  return out;
}

/**
 * A crosshair a design can carry, or null. An image is a PNG data URL
 * within the caps uploaded style images have, 1 to 512 pixels a side.
 */
export function readArt(raw: unknown): CrosshairArt | null {
  if (!isObj(raw)) return null;
  if (raw.kind === 'built') {
    const state = readState(raw.state);
    return state ? { kind: 'built', state } : null;
  }
  if (raw.kind === 'image') {
    const { png, w, h } = raw;
    if (typeof png !== 'string' || !png.startsWith(PNG_PREFIX)) return null;
    const b64 = png.slice(PNG_PREFIX.length);
    if (b64.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]*$/.test(b64)) return null;
    const side = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_IMAGE_SIDE;
    return side(w) && side(h) ? { kind: 'image', png, w, h } : null;
  }
  return null;
}

/** Where a w x h image lands inside a square of `side`: scaled to fit, aspect kept, centred. */
export function fitSquare(w: number, h: number, side: number): { x: number; y: number; w: number; h: number } {
  const k = side / Math.max(w, h);
  const fw = w * k, fh = h * k;
  return { x: (side - fw) / 2, y: (side - fh) / 2, w: fw, h: fh };
}

/**
 * Draw the crosshair into the `size` x `size` square centred on (cx, cy),
 * as the game draws the texture into the xHair element. A built crosshair
 * scales as the Crosshair page's export does: the square is PX_AT_1080
 * screen pixels at 1080p. An image is fitted into the square; `img` is its
 * decoded picture, and while it is still loading (null) nothing is drawn.
 */
export function drawArt(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number,
  art: CrosshairArt, img: CanvasImageSource | null,
): void {
  if (art.kind === 'built') {
    drawCrosshair(ctx, cx, cy, size / PX_AT_1080, art.state, null);
    return;
  }
  if (!img) return;
  const f = fitSquare(art.w, art.h, size);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, cx - size / 2 + f.x, cy - size / 2 + f.y, f.w, f.h);
}
