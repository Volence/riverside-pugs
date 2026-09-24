/**
 * The close-up beside the canvas: which part of the canvas to show so the
 * selection fills most of a small view. Pure, in canvas pixels.
 */
import type { Box } from './design';

/** How much larger than the selection the view's region is, so its surroundings show. */
export const CLOSEUP_PAD = 1.6;
/** The most the view enlarges: past this a tiny piece becomes a few smeared pixels. */
export const CLOSEUP_MAX_ZOOM = 8;

/**
 * The region of a canvas `cw` x `ch` that a view `vw` x `vh` shows for the
 * selection `box`: centred on it, with the view's own shape, about
 * CLOSEUP_PAD times its size, never enlarged past CLOSEUP_MAX_ZOOM nor
 * shrunk past the whole canvas, and moved back inside the canvas where it
 * can be (centred when the region is wider than the canvas).
 * `zoom` is how much the view enlarges it.
 */
export function closeUpRegion(box: Box, cw: number, ch: number, vw: number, vh: number): Box & { zoom: number } {
  const fit = Math.min(vw / Math.max(1, box.w * CLOSEUP_PAD), vh / Math.max(1, box.h * CLOSEUP_PAD));
  // Never below the zoom that fits the whole canvas in the view, so a big selection shows the screen, not less.
  const whole = Math.min(vw / cw, vh / ch);
  const zoom = Math.max(whole, Math.min(CLOSEUP_MAX_ZOOM, fit));
  const w = vw / zoom, h = vh / zoom;
  const clamp = (v: number, size: number, max: number) => (size >= max ? (max - size) / 2 : Math.min(Math.max(0, v), max - size));
  const x = clamp(box.x + box.w / 2 - w / 2, w, cw);
  const y = clamp(box.y + box.h / 2 - h / 2, h, ch);
  return { x, y, w, h, zoom };
}
