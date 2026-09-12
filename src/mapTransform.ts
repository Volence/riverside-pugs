/**
 * Where a world position lands on a map image.
 *
 * This is a data table on purpose. Adding No Mercy later is a row and a PNG,
 * not a code change, and no replay ever needs re-recording because positions
 * are stored as raw world units rather than pixels.
 *
 * It also replaces the manual calibration panel suprep's viewer carries.
 * `cl_leveloverview` prints the origin and the scale on the console, and
 * Valve's own mapinfo.res stores exactly those numbers, so there is nothing
 * to eyeball.
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

/** Valve's shipped overviews. `x` and `y` are the upper-left world corner and
 *  `scale` is world units per pixel at the 1024 pixel height their BMPs use.
 *  Straight out of `left4dead/resource/overviews/mapinfo.res`. */
const VALVE: Record<string, { x: number; y: number; scale: number }> = {
  l4d_farm01_hilltop: { x: -13730, y: -6299, scale: 9.0 },
  l4d_farm02_traintunnel: { x: -9279, y: -4779, scale: 8.5 },
  l4d_farm03_bridge: { x: -353, y: -8921, scale: 10.0 },
  l4d_farm04_barn: { x: 6693, y: -241, scale: 11.0 },
  l4d_farm05_cornfield: { x: 5769, y: 4893, scale: 6.0 },
  l4d_smalltown01_caves: { x: -17459, y: -3809, scale: 12.0 },
  l4d_smalltown02_drainage: { x: -11784, y: -3090, scale: 6.0 },
  l4d_smalltown03_ranchhouse: { x: -12920, y: 2506, scale: 10.5 },
  l4d_smalltown04_mainstreet: { x: -5900, y: 1620, scale: 10.0 },
  l4d_smalltown05_houseboat: { x: -3400, y: 4820, scale: 10.0 },
};

/** The pixel height Valve's `scale` assumes. Their BMPs are 1024x1024, so for
 *  those the correction below is a no-op. It is written out anyway because a
 *  `cl_leveloverview` capture at any other height is the expected way new maps
 *  arrive, and at that point units per pixel is `1024 * scale / height` on
 *  both axes. Pixels stay square either way: a non-square capture is a wider
 *  field of view, not a distorted one. */
const VALVE_SCALE_HEIGHT = 1024;
const VALVE_IMAGE_SIZE = 1024;

/**
 * A versus map and its coop twin share one overview.
 *
 * The engine reports `l4d_vs_farm01_hilltop` in a versus match and mapinfo.res
 * is keyed on `l4d_farm01_hilltop`. Without this every ranked replay would
 * fall through to auto-fit despite the art being right there.
 */
export function normalizeMapName(map: string): string {
  return map.toLowerCase().replace(/^l4d_vs_/, 'l4d_');
}

export function transformFor(map: string): MapTransform | null {
  const key = normalizeMapName(map);
  const v = VALVE[key];
  if (!v) return null;
  return {
    originX: v.x,
    originY: v.y,
    unitsPerPixel: (VALVE_SCALE_HEIGHT * v.scale) / VALVE_IMAGE_SIZE,
    image: `/overviews/${key}.png`,
    width: VALVE_IMAGE_SIZE,
    height: VALVE_IMAGE_SIZE,
  };
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
 * This is what makes the viewer usable on the twelve maps with no overview:
 * the replay knows where people went, so the view can be derived from the
 * replay itself. One scale governs both axes so pixels stay square, and the
 * short axis is centred.
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

export function worldToImage(
  t: MapTransform, x: number, y: number,
): { px: number; py: number } {
  return {
    px: (x - t.originX) / t.unitsPerPixel,
    py: (t.originY - y) / t.unitsPerPixel,
  };
}
