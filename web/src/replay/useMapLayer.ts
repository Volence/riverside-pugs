import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  autoFitTransform, boundsOf, canvasAspect, fitView, pickLayer, transformOfLayer,
  type MapLayer, type MapTransform, type View,
} from '../../../src/mapTransform';
import { overviewFor } from '../../../src/mapOverviews';
import { STATE, type Frame, type PlayerSample, type ReplayHeader } from '../../../src/replayFormat';
import { isSurvivor } from './draw';
import type { CanvasSize } from './canvasSize';

/** The canvas shape a map with no art gets. It is the captures' own shape,
 *  2048x1271, which is what every map got when the canvas was fixed. There is
 *  no image to take a shape from on this path, and the round's own extent is
 *  not known yet at the point the element has to be sized. */
export const DEFAULT_ASPECT = 2048 / 1271;

/**
 * The canvas shape a map wants, resolved on its own.
 *
 * Separate from the hook below because of the order things have to happen in:
 * the element is sized from this, the element is then measured, and only then
 * is there a canvas size to fit the map into. Resolving the overview twice
 * costs one record lookup per map change.
 */
export function mapAspect(header: ReplayHeader | null): number {
  const overview = header ? overviewFor(header.map) : null;
  return overview ? canvasAspect(overview.contentBox) : DEFAULT_ASPECT;
}

export interface MapLayerResult {
  transform: MapTransform | null;
  view: View;
  backdrop: HTMLImageElement | null;
}

/**
 * Resolve the map art layer and its backdrop image for the current moment in
 * the replay.
 *
 * Bundled into one hook because the two are one decision: which layer is on
 * screen determines which image needs to be loaded, and the loaded image
 * lags the layer pick by however long decoding takes.
 */
export function useMapLayer(
  header: ReplayHeader | null,
  frames: Frame[],
  livePlayers: PlayerSample[],
  size: CanvasSize,
): MapLayerResult {
  const [backdrop, setBackdrop] = useState<HTMLImageElement | null>(null);

  /** The map's layer stack, or null when there is no art for it. Resolved once
   *  per replay: the stack never changes mid-round. */
  const overview = useMemo(
    () => (header ? overviewFor(header.map) : null),
    [header?.map],
  );

  /** Auto-fit is now the fallback rather than the main path: every shipped map
   *  has real art. It still earns its place for a custom map, or for an asset
   *  that failed to load. Fitted to the whole round rather than the visible
   *  frame so the view does not reframe itself as the team moves. */
  const fitted = useMemo(() => {
    if (overview || !header) return null;
    const points: { x: number; y: number }[] = [];
    for (const f of frames) {
      for (const p of f.players) {
        if ((p.state & STATE.PRESENT) !== 0) points.push({ x: p.x, y: p.y });
      }
    }
    const bounds = boundsOf(points);
    return bounds ? autoFitTransform(bounds, size.cssW, size.cssH) : null;
    // Deliberately keyed on the map and the frame count rather than on
    // `frames`, so a live round refits occasionally as it extends rather than
    // on every single poll.
  }, [overview, header?.map, Math.floor(frames.length / 100), size.cssW, size.cssH]);

  /** The layer currently on screen, kept in a ref so `pickLayer` still gets
   *  its hysteresis argument even though selection is now derived rather than
   *  stateful. */
  const layerRef = useRef<MapLayer | null>(null);

  /** Layer selection follows the survivors' median height, with hysteresis, so a
   *  team going down into a basement takes the view with them. Median rather
   *  than mean so one player in a hole does not drag it.
   *
   *  Derived with `useMemo` rather than `useState` set inside an effect: state
   *  set in an effect only lands on the render after next, so the very first
   *  render had no layer at all and the canvas skipped a draw. A memo has a
   *  value on the first render. */
  const layer = useMemo(() => {
    if (!overview) { layerRef.current = null; return null; }
    const survivorZ = livePlayers
      .filter((p) => isSurvivor(p) && (p.state & STATE.ALIVE) !== 0)
      .map((p) => p.z)
      .sort((a, b) => a - b);
    // Survivors spawn at ground level on every L4D1 map. Before anyone is
    // alive, zero is a far better proxy for that than the bottom of the
    // stack: several maps' lowest layers are basements or tunnels that are
    // otherwise empty by design, and `-Infinity` would pick exactly those.
    const z = survivorZ.length ? survivorZ[Math.floor(survivorZ.length / 2)] : 0;
    const picked = pickLayer(overview.layers, z, layerRef.current);
    layerRef.current = picked;
    return picked;
  }, [overview, livePlayers]);

  /** Memoised for its IDENTITY, not for the arithmetic, which is six field
   *  copies. The canvas now draws from its own animation loop and repaints
   *  whenever a prop changes, so a fresh object on every render would repaint
   *  a paused viewer ten times a second for a scene that had not moved.
   *  `layer` and `fitted` are both stable while the view holds still, so this
   *  is too. */
  const transform = useMemo<MapTransform | null>(
    () => (layer ? transformOfLayer(layer) : fitted),
    [layer, fitted],
  );

  /** The map's content box, fitted to the canvas. Both branches go through
   *  `fitView` so there is one code path: a map with an overview crops to
   *  its `contentBox`, and the auto-fit fallback (no image, `transform` is
   *  already sized to the canvas) passes the full canvas rect with no
   *  padding, which fits at scale 1 with no offset, i.e. the identity.
   *
   *  The canvas is in CSS pixels, not backing-store pixels: the draw code
   *  works in CSS pixels and the draw effect scales the context once for the
   *  device ratio. */
  const view = useMemo<View>(() => {
    const box = overview
      ? overview.contentBox
      : { x0: 0, y0: 0, x1: size.cssW, y1: size.cssH };
    return fitView(box, size.cssW, size.cssH, overview ? undefined : 0);
  }, [overview, size.cssW, size.cssH]);

  /** Cache of decoded images by URL. A team moving up and down stairs
   *  otherwise refetches the same images repeatedly; the browser cache makes
   *  the refetch cheap but decoding is not free. */
  const imageCache = useRef(new Map<string, HTMLImageElement>());

  useEffect(() => {
    if (!transform?.image) { setBackdrop(null); return; }
    const src = transform.image;
    const cached = imageCache.current.get(src);
    if (cached) { setBackdrop(cached); return; }
    // Cancellation guard: a team can move between layers fast enough that a
    // second load starts before the first one's `onload` fires. Without this
    // flag, the FIRST image's `onload` would still land after the second
    // effect run has already set the correct, newer backdrop, silently
    // overwriting it with a stale one that then sticks until the next layer
    // change. The cleanup below sets `cancelled` when this effect is
    // superseded, so a late callback from an abandoned load is a no-op.
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      imageCache.current.set(src, img);
      if (cancelled) return;
      // Keep the previous image on screen until this one is ready, so a
      // layer change never flashes black between them.
      setBackdrop(img);
    };
    // A missing overview is not an error. Falling back to the grid is exactly
    // what a map with no art does anyway.
    img.onerror = () => { if (!cancelled) setBackdrop(null); };
    img.src = src;
    return () => { cancelled = true; };
  }, [transform?.image]);

  return { transform, view, backdrop };
}
