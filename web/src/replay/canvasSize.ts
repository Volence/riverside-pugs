import { useEffect, useState } from 'preact/hooks';
import { CANVAS_PIXEL_BUDGET, canvasForAspect } from '../../../src/mapTransform';

/**
 * How big the replay canvas is, in both of the sizes a canvas has.
 *
 * The element used to carry a fixed 1280x794 backing store inside a page at
 * most 1120px wide, so on a desktop it was resampled to about 0.8 and on a
 * 375px phone to about 0.22. Everything the draw code calls a "screen unit",
 * an avatar radius or a line width, was therefore a fifth of the size it
 * claimed by the time anyone saw it. Deriving the backing store from the
 * element's own width instead makes a screen unit a CSS pixel again.
 */
export interface CanvasSize {
  /** CSS pixels the element occupies. The draw code works in these. */
  cssW: number;
  cssH: number;
  /** The canvas element's width and height attributes. */
  pixelW: number;
  pixelH: number;
  /** Backing pixels per CSS pixel. The draw effect scales the context by this
   *  once, so nothing downstream has to know about it. */
  ratio: number;
}

/**
 * The backing store for an element of `width` CSS pixels at a given aspect.
 *
 * The height comes from the aspect rather than from a second measurement, so
 * the backing store can never end up a different shape from the layout box
 * and get letterboxed a second time by the browser.
 */
export function canvasSize(
  width: number, aspect: number, dpr: number, budget = CANVAS_PIXEL_BUDGET,
): CanvasSize {
  const cssW = Math.max(width, 1);
  const cssH = cssW / aspect;
  // Below 1:1 the map softens for no reason, so a display reporting a ratio
  // under one (or nothing at all) still gets a pixel per CSS pixel.
  const want = Math.max(dpr, 1);
  // And above the budget the canvas costs more memory and fill than the fixed
  // one it replaced, which is the one thing the shape change may not do.
  const cap = Math.sqrt(budget / (cssW * cssH));
  const ratio = Math.min(want, cap);
  return {
    cssW,
    cssH,
    ratio,
    pixelW: Math.round(cssW * ratio),
    pixelH: Math.round(cssH * ratio),
  };
}

function pixelRatio(): number {
  return typeof devicePixelRatio === 'number' && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
}

/**
 * Track an element's laid-out width and turn it into a canvas size.
 *
 * The element is handed over as a CALLBACK ref rather than a ref object, and
 * that is load-bearing: the stage does not exist on the first render at all,
 * because the viewer shows a loading line until the replay header arrives. An
 * effect keyed on a ref object would run once against `null` and never look
 * again, leaving the canvas stuck at its fallback size forever. A callback
 * ref lands in state, so attaching and detaching the element each re-run the
 * observer.
 *
 * A `ResizeObserver` rather than a window resize listener: the element is a
 * flex child of a column whose width changes when the timeline rail appears,
 * which a window listener would miss entirely.
 */
export function useCanvasSize(
  aspect: number,
): { size: CanvasSize; ref: (el: HTMLElement | null) => void } {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!el) return;
    const read = () => {
      const w = el.clientWidth;
      // A zero width is a hidden element or an environment with no layout at
      // all, not a real measurement. Keeping the last good one leaves the
      // budget-sized fallback below in place rather than collapsing to 1px.
      if (w > 0) setWidth(w);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);

  // Before the first measurement, the budget canvas for this shape is the
  // honest stand-in: it is exactly what the element takes on a page wide
  // enough to give it one.
  const fallback = canvasForAspect(aspect).width;
  return {
    size: canvasSize(width > 0 ? width : fallback, aspect, pixelRatio()),
    // `setEl` is stable across renders, so preact does not detach and
    // reattach the observer on every frame of playback.
    ref: setEl,
  };
}
