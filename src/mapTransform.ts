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

export function fitView(
  box: ViewBox, canvasW: number, canvasH: number, padFraction = 0.03,
): View {
  // A degenerate box would divide by zero. One pixel is arbitrary and
  // harmless: there is nothing to see either way, and the alternative is
  // Infinity propagating into every drawn position.
  const w = Math.max(box.x1 - box.x0, 1);
  const h = Math.max(box.y1 - box.y0, 1);
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
