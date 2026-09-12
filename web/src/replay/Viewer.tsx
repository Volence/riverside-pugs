import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  autoFitTransform, boundsOf, pickLayer, transformOfLayer,
  type MapLayer, type MapTransform,
} from '../../../src/mapTransform';
import { overviewFor } from '../../../src/mapOverviews';
import { STATE } from '../../../src/replayFormat';
import { bracket, interpolateEntities, interpolatePlayers } from './interpolate';
import { usePlayback } from './playback';
import { useReplaySource, type ReplaySpec } from './source';
import { drawScene, isSurvivor, type ShowFlags } from './draw';

const SIZE = 720;

export function Viewer(
  { spec, live = false }:
  { spec: ReplaySpec; live?: boolean },
) {
  const { header, frames, closed, error } = useReplaySource(spec);
  const endMs = frames.length ? frames[frames.length - 1].tMs : 0;
  const playback = usePlayback(endMs, { live });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [backdrop, setBackdrop] = useState<HTMLImageElement | null>(null);
  const show: ShowFlags = { ci: true, entities: true };

  /**
   * One interpolated frame per tick, shared by everything that reads it.
   *
   * The canvas, the status counts and the health panels must agree. Letting
   * each call `bracket` itself would drift them a frame apart, which shows up
   * as a health number sitting next to an avatar that has already moved.
   */
  const { livePlayers, liveEntities } = useMemo(() => {
    const pair = bracket(frames, playback.tMs);
    if (!pair) return { livePlayers: [], liveEntities: [] };
    return {
      livePlayers: interpolatePlayers(pair.a, pair.b, pair.f),
      liveEntities: interpolateEntities(pair.a, pair.b, pair.f),
    };
  }, [frames, playback.tMs]);

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
    return bounds ? autoFitTransform(bounds, SIZE, SIZE) : null;
    // Deliberately keyed on the map and the frame count rather than on
    // `frames`, so a live round refits occasionally as it extends rather than
    // on every single poll.
  }, [overview, header?.map, Math.floor(frames.length / 100)]);

  const [layer, setLayer] = useState<MapLayer | null>(null);

  /** Layer selection follows the survivors' median height, with hysteresis, so a
   *  team going down into a basement takes the view with them. Median rather
   *  than mean so one player in a hole does not drag it. */
  useEffect(() => {
    if (!overview) { setLayer(null); return; }
    const survivorZ = livePlayers
      .filter((p) => isSurvivor(p) && (p.state & STATE.ALIVE) !== 0)
      .map((p) => p.z)
      .sort((a, b) => a - b);
    // Before anyone is alive, show the ground floor rather than nothing.
    const z = survivorZ.length ? survivorZ[Math.floor(survivorZ.length / 2)] : -Infinity;
    setLayer((cur) => pickLayer(overview.layers, z, cur));
  }, [overview, livePlayers]);

  const transform: MapTransform | null = layer ? transformOfLayer(layer) : fitted;

  /** Cache of decoded images by URL. A team moving up and down stairs
   *  otherwise refetches the same images repeatedly; the browser cache makes
   *  the refetch cheap but decoding is not free. */
  const imageCache = useRef(new Map<string, HTMLImageElement>());

  useEffect(() => {
    if (!transform?.image) { setBackdrop(null); return; }
    const src = transform.image;
    const cached = imageCache.current.get(src);
    if (cached) { setBackdrop(cached); return; }
    const img = new Image();
    img.onload = () => {
      imageCache.current.set(src, img);
      // Keep the previous image on screen until this one is ready, so a
      // layer change never flashes black between them.
      setBackdrop(img);
    };
    // A missing overview is not an error. Falling back to the grid is exactly
    // what a map with no art does anyway.
    img.onerror = () => setBackdrop(null);
    img.src = src;
  }, [transform?.image]);

  const trail = useMemo(() => {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < frames.length; i += 10) {
      const alive = frames[i].players.filter((p) => isSurvivor(p) && (p.state & STATE.ALIVE) !== 0);
      if (alive.length === 0) continue;
      out.push({
        x: alive.reduce((n, p) => n + p.x, 0) / alive.length,
        y: alive.reduce((n, p) => n + p.y, 0) / alive.length,
      });
    }
    return out;
  }, [frames.length]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !transform) return;
    drawScene(ctx, {
      transform, backdrop, trail,
      players: livePlayers,
      entities: liveEntities,
      show,
      width: SIZE,
      height: SIZE,
    });
  }, [livePlayers, liveEntities, transform, backdrop, trail]);

  if (error && !header) return <div class="replay replay--empty">Couldn't load that replay.</div>;
  if (!header) return <div class="replay replay--empty">Loading replay...</div>;

  return (
    <div class="replay">
      <canvas ref={canvasRef} width={SIZE} height={SIZE} class="replay__canvas" />
      <div class="replay__status">
        {header.map}
        {!closed && <span class="replay__live"> LIVE, 10s delayed</span>}
      </div>
    </div>
  );
}
