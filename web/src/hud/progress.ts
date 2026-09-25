/**
 * The use/heal bar's Bar (progressbar.res, a CTerrorProgressBar-style Panel
 * with border_thickness, gap and shadow_thickness keys): where the game draws
 * each of its parts, and the rule that keeps its border and gap from eating
 * it. A leaf: it imports nothing, so the editor's controls (slice 2.6) and
 * validateDesign can use the rule without pulling in the preview.
 *
 * Measured in probe-phase2/b1v2/shots/b1/b1-d.png (Bar 200 x 20, border 3,
 * gap 3, shadow 1, at 2.25 px a unit): the bar's rect is x 767 to 1217,
 * y 595 to 640 px. The border ring is that rect less the shadow on its right
 * and bottom (x 767 to 1215, y 595 to 638), 6 px thick; then a 6 px gap
 * (nothing drawn); then the fill from the left in fill_color and the rest in
 * empty_color (y 607 to 626). The shadow is two strips, the ring's right and
 * bottom edges pushed out by the shadow thickness: x 1215 to 1217 from
 * y 597, and y 638 to 640 from x 769. The stock bar
 * (probe-phase2/b13/b13-stock/heal/mid-heal.png, 8 tall, 1 1 1) is the same
 * shape at 2 px each. In B1 (b1/shots/crops/bar-d.png, 8 tall, border 3,
 * gap 3) only the border drew: nothing was left inside it (probe Q22).
 */

export interface BarKeys { border: number; gap: number; shadow: number }
export interface BarRect { x: number; y: number; w: number; h: number }
export interface BarParts {
  /** The border ring's outer edge; the ring is `borderWidth` thick inside it. */
  border: BarRect | null;
  borderWidth: number;
  fill: BarRect | null;
  empty: BarRect | null;
  /** The right and bottom strips of the drop shadow, or none. */
  shadow: BarRect[];
}

/**
 * The largest border and gap that still leave one unit of fill inside the
 * ring: 2 * (border + gap) + shadow < tall (probe Q22; the plan's
 * 2 * (border + gap) < tall with the shadow the game also takes out of the
 * tall). The gap gives way first, then the border. Units in, units out.
 */
export function clampBarKeys(keys: BarKeys, tall: number): BarKeys {
  const room = Math.max(0, tall - keys.shadow - 1);          // what border and gap may take, both sides together
  const border = Math.max(0, Math.min(keys.border, Math.floor(room / 2)));
  const gap = Math.max(0, Math.min(keys.gap, Math.floor(room / 2) - border));
  return { border, gap, shadow: keys.shadow };
}

/**
 * The parts the game draws for a bar of rect `r` at fraction `f` (0 to 1)
 * of fill. Unit-free: the painter passes pixels, with each thickness already
 * cut to whole pixels as the game cuts it. A part with no room is null.
 */
export function barGeometry(r: BarRect, keys: BarKeys, f: number): BarParts {
  const s = Math.max(0, keys.shadow), b = Math.max(0, keys.border), g = Math.max(0, keys.gap);
  const ring = { x: r.x, y: r.y, w: r.w - s, h: r.h - s };
  const shadow = s > 0 && ring.w > 0 && ring.h > 0
    ? [{ x: r.x + ring.w, y: r.y + s, w: s, h: ring.h }, { x: r.x + s, y: r.y + ring.h, w: ring.w, h: s }]
    : [];
  const inset = b + g;
  const inner = { x: ring.x + inset, y: ring.y + inset, w: ring.w - 2 * inset, h: ring.h - 2 * inset };
  const has = inner.w > 0 && inner.h > 0;
  const fw = has ? inner.w * Math.min(1, Math.max(0, f)) : 0;
  return {
    border: b > 0 && ring.w > 0 && ring.h > 0 ? ring : null,
    borderWidth: b,
    fill: has && fw > 0 ? { ...inner, w: fw } : null,
    empty: has && fw < inner.w ? { x: inner.x + fw, y: inner.y, w: inner.w - fw, h: inner.h } : null,
    shadow,
  };
}
