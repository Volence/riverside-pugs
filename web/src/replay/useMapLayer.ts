import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  autoFitTransform, boundsOf, fitView, pickLayer, transformOfLayer,
  type MapLayer, type MapTransform, type View,
} from '../../../src/mapTransform';
import { overviewFor } from '../../../src/mapOverviews';
import { STATE, type Frame, type PlayerSample, type ReplayHeader } from '../../../src/replayFormat';
import { isSurvivor } from './draw';

// Every captured layer image is exactly 2048x1271. The view is sized to that
// same aspect (scaled by 0.625) rather than a square, so drawScene's `s`
// factor (canvas width over image width) stays uniform across the whole
// image instead of squashing it into a square canvas.
export const VIEW_W = 1280;
export const VIEW_H = 794;

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
    return bounds ? autoFitTransform(bounds, VIEW_W, VIEW_H) : null;
    // Deliberately keyed on the map and the frame count rather than on
    // `frames`, so a live round refits occasionally as it extends rather than
    // on every single poll.
  }, [overview, header?.map, Math.floor(frames.length / 100)]);

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

  const transform: MapTransform | null = layer ? transformOfLayer(layer) : fitted;

  /** The map's content box, fitted to the canvas. Both branches go through
   *  `fitView` so there is one code path: a map with an overview crops to
   *  its `contentBox`, and the auto-fit fallback (no image, `transform` is
   *  already sized to the canvas) passes the full canvas rect with no
   *  padding, which fits at scale 1 with no offset, i.e. the identity. */
  const view = useMemo<View>(() => {
    const box = overview
      ? overview.contentBox
      : { x0: 0, y0: 0, x1: VIEW_W, y1: VIEW_H };
    return fitView(box, VIEW_W, VIEW_H, overview ? undefined : 0);
  }, [overview]);

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
