/**
 * Box geometry the editor's gestures share, and snapping. While a section,
 * a card or a piece moves, its edges and centre lines snap to the targets'
 * edges and centre lines within SNAP_UNITS HUD units, and a guide line is
 * returned for every alignment the snapped box then makes, so the page can
 * draw a pink line for each. Resizing snaps only the edges the dragged
 * handle moves. Pure: the caller picks the targets (from the generator's
 * rects) and decides whether Alt turned snapping off.
 */
import type { Box } from './design';

/** A handle on a selection's box: a side or a corner, named by compass point. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const CORNERS: Handle[] = ['nw', 'ne', 'se', 'sw'];
/** Corners first, so a tiny box whose corners and sides overlap still offers its corners. */
export const ALL_HANDLES: Handle[] = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'];

export const SNAP_UNITS = 4;

export interface Guide { axis: 'x' | 'y'; at: number; from: number; to: number }
export interface Snap { dx: number; dy: number; guides: Guide[] }

/** The box around every box given, or null for none. */
export function unionBox(rects: Box[]): Box | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  const r = Math.max(...rects.map((b) => b.x + b.w)), b = Math.max(...rects.map((q) => q.y + q.h));
  return { x, y, w: r - x, h: b - y };
}

/** A box's two edges and its centre line along one axis. */
const lines = (lo: number, size: number) => [lo, lo + size / 2, lo + size];

/** The smallest correction that puts one of `mine` on one of `theirs`, within `threshold` (inclusive), or null. */
function nearest(mine: number[], theirs: number[], threshold: number): number | null {
  let best: number | null = null;
  for (const m of mine) {
    for (const t of theirs) {
      const d = t - m;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  return best;
}

/**
 * One guide per target line that one of `at` now sits on, spanning the
 * moving box and that target across the other axis, so the line runs
 * between the two things it aligns.
 */
function guidesOn(axis: 'x' | 'y', at: number[], moving: Box, targets: Box[]): Guide[] {
  const out = new Map<string, Guide>();
  for (const t of targets) {
    const tl = axis === 'x' ? lines(t.x, t.w) : lines(t.y, t.h);
    const from = axis === 'x' ? Math.min(moving.y, t.y) : Math.min(moving.x, t.x);
    const to = axis === 'x' ? Math.max(moving.y + moving.h, t.y + t.h) : Math.max(moving.x + moving.w, t.x + t.w);
    for (const a of at) if (tl.some((l) => Math.abs(l - a) < 0.01)) out.set(`${a}:${from}:${to}`, { axis, at: a, from, to });
  }
  return [...out.values()];
}

/**
 * Snap a moving box (already at the pointer's position) to the targets:
 * each axis independently, the nearest line pair within `threshold`.
 */
export function snapMove(moving: Box, targets: Box[], threshold = SNAP_UNITS): Snap {
  const sx = nearest(lines(moving.x, moving.w), targets.flatMap((t) => lines(t.x, t.w)), threshold);
  const sy = nearest(lines(moving.y, moving.h), targets.flatMap((t) => lines(t.y, t.h)), threshold);
  const at = { ...moving, x: moving.x + (sx ?? 0), y: moving.y + (sy ?? 0) };
  const guides = [
    ...(sx === null ? [] : guidesOn('x', lines(at.x, at.w), at, targets)),
    ...(sy === null ? [] : guidesOn('y', lines(at.y, at.h), at, targets)),
  ];
  return { dx: sx ?? 0, dy: sy ?? 0, guides };
}

/**
 * Snap a box being resized by `handle` (already at the pointer's size): only
 * the edges that handle moves are candidates. The corrections add to the
 * pointer delta the same way for every handle, since a left or top edge
 * moves with the delta just as a right or bottom one does.
 */
export function snapEdges(box: Box, handle: Handle, targets: Box[], threshold = SNAP_UNITS): Snap {
  const mx = handle.includes('e') ? [box.x + box.w] : handle.includes('w') ? [box.x] : [];
  const my = handle.includes('s') ? [box.y + box.h] : handle.includes('n') ? [box.y] : [];
  const sx = nearest(mx, targets.flatMap((t) => lines(t.x, t.w)), threshold);
  const sy = nearest(my, targets.flatMap((t) => lines(t.y, t.h)), threshold);
  const guides = [
    ...(sx === null ? [] : guidesOn('x', [mx[0] + sx], box, targets)),
    ...(sy === null ? [] : guidesOn('y', [my[0] + sy], box, targets)),
  ];
  return { dx: sx ?? 0, dy: sy ?? 0, guides };
}
