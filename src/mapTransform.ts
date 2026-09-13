/**
 * Where a world position lands on a map image.
 *
 * Positions are stored as raw world units rather than pixels, so no replay
 * ever needs re-recording when the art backing a map changes.
 *
 * This module has no imports, deliberately. It is loaded by the browser as
 * well as the server, and a relative `.js` specifier would break the bundler.
 */

export interface MapTransform {
  /** World x of the image's left edge. */
  originX: number;
  /** World y of the image's TOP edge. World y grows north, image y grows
   *  down, which is why projection subtracts in the other direction. */
  originY: number;
  unitsPerPixel: number;
  /** Web path to the backdrop, or null when there is no art and the viewer
   *  should draw a grid and a trail instead. */
  image: string | null;
  width: number;
  height: number;
}

export interface WorldBounds {
  minX: number; maxX: number; minY: number; maxY: number;
}

export function boundsOf(points: { x: number; y: number }[]): WorldBounds | null {
  if (points.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Fit a world extent into a canvas with no art at all.
 *
 * A fallback for a map with no entry in the overview manifest, such as a custom
 * map, or when an overview image failed to load. The replay knows where people
 * went, so the view can be derived from the replay itself. One scale governs both
 * axes so pixels stay square, and the short axis is centred.
 */
export function autoFitTransform(
  bounds: WorldBounds, width: number, height: number, padFraction = 0.05,
): MapTransform {
  // A round where nobody moved, or a single frame, would otherwise divide by
  // zero. One unit per pixel is arbitrary and harmless: there is nothing to
  // see either way, and the alternative is Infinity propagating into every
  // drawn position.
  const spanX = Math.max(bounds.maxX - bounds.minX, 1);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1);
  const pad = 1 + padFraction * 2;
  const unitsPerPixel = Math.max(spanX / width, spanY / height) * pad;

  // Centre: half the leftover canvas in world units, on each axis.
  const marginX = (width * unitsPerPixel - spanX) / 2;
  const marginY = (height * unitsPerPixel - spanY) / 2;

  return {
    originX: bounds.minX - marginX,
    originY: bounds.maxY + marginY,
    unitsPerPixel,
    image: null,
    width,
    height,
  };
}

export interface ViewBox { x0: number; y0: number; x1: number; y1: number }

/** How a region of the layer image is placed on the canvas.
 *
 *  The captures frame each map inside a 2048x1271 image and the map itself
 *  is often a tall narrow ribbon covering a small part of it, so drawing the
 *  whole image wastes most of the canvas. This maps a chosen region of the
 *  image onto the canvas instead, preserving aspect. */
export interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
  box: ViewBox;
}

/**
 * The span of a view box, with a degenerate box widened to one pixel.
 *
 * A degenerate box would divide by zero in `fitView`. One pixel is arbitrary
 * and harmless: there is nothing to see either way, and the alternative is
 * Infinity propagating into every drawn position.
 *
 * Exported because the draw code needs exactly the numbers `fitView` scaled,
 * not its own reading of the same box: a zero-width source rect makes
 * `drawImage` throw IndexSizeError, where `fitView` would quietly have used
 * the clamped one. The generator falls back to the full frame rather than
 * emitting a degenerate box, so the two disagreeing is latent rather than
 * live, which is exactly the kind of disagreement that surfaces years later
 * on a new map.
 */
export function boxSpan(box: ViewBox): { w: number; h: number } {
  return {
    w: Math.max(box.x1 - box.x0, 1),
    h: Math.max(box.y1 - box.y0, 1),
  };
}

/**
 * Backing-store pixels one replay canvas may spend, whatever shape it takes.
 *
 * 1280 x 794 is the single fixed canvas every map used to get, so holding the
 * product constant leaves memory and fill cost exactly where they were while
 * the shape is free to follow the map.
 */
export const CANVAS_PIXEL_BUDGET = 1280 * 794;

/** The widest and the tallest canvas the page can lay out. A box outside this
 *  range letterboxes inside the clamped canvas, which is what every map does
 *  today, so the clamp is a fallback rather than a new failure mode. */
export const MIN_CANVAS_ASPECT = 0.55;
export const MAX_CANVAS_ASPECT = 2.2;

/** The canvas shape a box wants, clamped to what the page can lay out. */
export function canvasAspect(box: ViewBox): number {
  const { w, h } = boxSpan(box);
  return Math.min(MAX_CANVAS_ASPECT, Math.max(MIN_CANVAS_ASPECT, w / h));
}

/**
 * The canvas a given aspect gets at a fixed pixel budget.
 *
 * Solving `width * height = budget` and `width / height = aspect` at once, so
 * a portrait map and a landscape map cost the same to draw.
 */
export function canvasForAspect(
  aspect: number, budget = CANVAS_PIXEL_BUDGET,
): { width: number; height: number } {
  const height = Math.round(Math.sqrt(budget / aspect));
  return { width: Math.round(height * aspect), height };
}

/**
 * The canvas a cropped map wants.
 *
 * The captures are 2048x1271 and the canvas used to be 1280x794: the same
 * shape. Cropping horizontal void out of a same-shape landscape frame cannot
 * draw a map any bigger, because the height still governs the fit; it only
 * moves the void out of the image and into the canvas as black bars. Letting
 * the canvas take the box's own shape is what turns the crop into pixels.
 */
export function canvasForBox(
  box: ViewBox, budget = CANVAS_PIXEL_BUDGET,
): { width: number; height: number } {
  return canvasForAspect(canvasAspect(box), budget);
}

export function fitView(
  box: ViewBox, canvasW: number, canvasH: number, padFraction = 0.03,
): View {
  const { w, h } = boxSpan(box);
  const pad = 1 - padFraction * 2;
  const scale = Math.min(canvasW / w, canvasH / h) * pad;
  return {
    scale,
    offsetX: (canvasW - w * scale) / 2,
    offsetY: (canvasH - h * scale) / 2,
    box,
  };
}

export function worldToImage(
  t: MapTransform, x: number, y: number,
): { px: number; py: number } {
  return {
    px: (x - t.originX) / t.unitsPerPixel,
    py: (t.originY - y) / t.unitsPerPixel,
  };
}

/** World position to canvas pixel, through the layer image and the view. */
export function projectView(
  t: MapTransform, v: View, x: number, y: number,
): { px: number; py: number } {
  const img = worldToImage(t, x, y);
  return {
    px: (img.px - v.box.x0) * v.scale + v.offsetX,
    py: (img.py - v.box.y0) * v.scale + v.offsetY,
  };
}

/** Canvas pixel back to world position: the inverse of `projectView`. What a
 *  drag needs to know which map point is under the cursor. */
export function unprojectView(
  t: MapTransform, v: View, px: number, py: number,
): { x: number; y: number } {
  const ipx = (px - v.offsetX) / v.scale + v.box.x0;
  const ipy = (py - v.offsetY) / v.scale + v.box.y0;
  return {
    x: t.originX + ipx * t.unitsPerPixel,
    y: t.originY - ipy * t.unitsPerPixel,
  };
}

/** One horizontal slice of a map, matching the generated entries in
 *  src/mapOverviews.ts structurally. Declared here rather than imported from
 *  there because both modules are loaded by the browser and neither may carry a
 *  relative import: a `.js` specifier breaks Vite's resolution and omitting the
 *  extension breaks NodeNext. Structural typing makes them compatible anyway. */
export interface MapLayer {
  image: string;
  /** Camera eye height this slice was cut at. The slice shows everything below
   *  it and nothing above. */
  cutHeight: number;
  unitsPerPixel: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export interface MapOverview {
  map: string;
  layers: MapLayer[];
}

/** How far a player must move past a boundary before the layer changes.
 *
 *  Without this, someone standing on a cut height flips the entire map back and
 *  forth several times a second, which is unwatchable. Sixty units is a little
 *  under half a player's height. */
export const LAYER_BIAS = 60;

/**
 * Which slice to draw for a team at height `z`.
 *
 * A layer shows everything below its cut, so the right one is the lowest whose
 * cut is still above the players. Pass the layer currently being shown as
 * `current` to get hysteresis; pass null when there is none yet.
 *
 * Callers should use the MEDIAN survivor height rather than the mean, so one
 * player who fell in a hole or climbed a roof does not drag the view away from
 * the other three.
 */
export function pickLayer(
  layers: MapLayer[], z: number, current: MapLayer | null,
): MapLayer | null {
  if (layers.length === 0) return null;
  const found = layers.find(
    (l) => l.cutHeight > z + (l === current ? -LAYER_BIAS : LAYER_BIAS),
  );
  // Above every cut there is no slice that contains the player at all. The top
  // one is the least wrong answer.
  return found ?? layers[layers.length - 1];
}

export function transformOfLayer(layer: MapLayer): MapTransform {
  return {
    originX: layer.originX,
    originY: layer.originY,
    unitsPerPixel: layer.unitsPerPixel,
    image: layer.image,
    width: layer.width,
    height: layer.height,
  };
}
