import { useEffect, useRef } from 'preact/hooks';
import type { MapTransform } from '../../../src/mapTransform';
import type { EntitySample, PlayerSample } from '../../../src/replayFormat';
import { drawScene, project, scaleFor, type ShowFlags } from './draw';
import { VIEW_W, VIEW_H } from './useMapLayer';

export interface ReplayCanvasProps {
  transform: MapTransform | null;
  backdrop: HTMLImageElement | null;
  trail: { x: number; y: number }[];
  livePlayers: PlayerSample[];
  liveEntities: EntitySample[];
  show: ShowFlags;
  followSlot: number | null;
}

/**
 * The canvas itself, plus the one effect that draws into it.
 *
 * Two things here fixed real bugs earlier in this feature and must not
 * regress on a future edit:
 *
 * - The untransformed `clearRect` happens BEFORE `ctx.translate`. Clearing
 *   inside the translated space would leave a sliver of the previous frame
 *   at the canvas edge on every panning frame.
 * - The follow camera centres a SCALED canvas position (`project`, the same
 *   helper `drawScene` uses), not a raw `worldToImage` image-space pixel. An
 *   unscaled translate drifts worse the further the followed player is from
 *   the origin.
 */
export function ReplayCanvas(
  { transform, backdrop, trail, livePlayers, liveEntities, show, followSlot }: ReplayCanvasProps,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !transform) return;

    // Reset in device space before anything else. Without this, a follow
    // camera's translate below would shift drawScene's own internal clear by
    // the same offset, leaving a sliver of the previous frame uncleared at
    // the canvas edge every time the translate is non-zero, which is nearly
    // always while following a moving target.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    ctx.restore();

    const target = followSlot === null ? null : (livePlayers[followSlot] ?? null);
    ctx.save();
    if (target) {
      // Keep the followed player centred by moving the world under them.
      // `project` is the same helper drawScene uses to turn a world position
      // into a canvas position, scaled by canvas width over image width; a
      // raw `worldToImage` result is in image space and would centre the
      // camera off by that same scale factor.
      const s = scaleFor(transform, VIEW_W);
      const p = project(transform, s, target.x, target.y);
      ctx.translate(VIEW_W / 2 - p.px, VIEW_H / 2 - p.py);
    }
    drawScene(ctx, {
      transform, backdrop, trail,
      players: livePlayers,
      entities: liveEntities,
      show,
      width: VIEW_W,
      height: VIEW_H,
    });
    ctx.restore();
    // `show` is a fresh object every render, so its two flags are listed
    // individually rather than the object itself: Task 14 wires real toggles
    // to them, and without this the draw effect would not rerun when they
    // change.
  }, [livePlayers, liveEntities, transform, backdrop, trail, show.ci, show.entities, followSlot]);

  return <canvas ref={canvasRef} width={VIEW_W} height={VIEW_H} class="replay__canvas" />;
}
