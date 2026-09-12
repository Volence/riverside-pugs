import { useEffect, useRef } from 'preact/hooks';
import { projectView, type MapTransform, type View } from '../../../src/mapTransform';
import type { EntitySample, PlayerSample } from '../../../src/replayFormat';
import { drawScene, followTarget, type ShowFlags } from './draw';
import type { CanvasSize } from './canvasSize';

export interface ReplayCanvasProps {
  transform: MapTransform | null;
  view: View;
  size: CanvasSize;
  backdrop: HTMLImageElement | null;
  trail: { x: number; y: number }[];
  livePlayers: PlayerSample[];
  liveEntities: EntitySample[];
  show: ShowFlags;
  followSlot: number | null;
  names: Record<string, string>;
  slots: string[];
}

/**
 * The canvas itself, plus the one effect that draws into it.
 *
 * Three things here fixed real bugs earlier in this feature and must not
 * regress on a future edit:
 *
 * - The untransformed `clearRect` happens BEFORE `ctx.translate`. Clearing
 *   inside the translated space would leave a sliver of the previous frame
 *   at the canvas edge on every panning frame. It clears the BACKING store,
 *   in backing pixels, which is why it runs under the identity transform
 *   rather than the device-ratio one set just below it.
 * - The follow camera centres a SCALED canvas position (`projectView`, the
 *   same helper `drawScene` uses), not a raw `worldToImage` image-space
 *   pixel. An unscaled translate drifts worse the further the followed
 *   player is from the origin.
 * - Every dimension comes from `size`, which follows the element's real
 *   layout. There is no fixed canvas size to read: the canvas is as wide as
 *   the page gives it and as tall as the map's own shape asks for, so a
 *   hardcoded 1280 here would put the follow camera's centre and the drawn
 *   scene's extent somewhere other than the middle and edges of the canvas.
 */
export function ReplayCanvas(
  {
    transform, view, size, backdrop, trail, livePlayers, liveEntities, show, followSlot,
    names, slots,
  }: ReplayCanvasProps,
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
    ctx.clearRect(0, 0, size.pixelW, size.pixelH);
    ctx.restore();

    const target = followTarget(livePlayers, followSlot);
    ctx.save();
    // Everything below this line is in CSS pixels. One scale here is what
    // lets an avatar radius or a line width in the draw code mean the same
    // thing on a phone at 3x and a desktop at 1x, instead of meaning a
    // backing pixel that the browser then resamples to whatever is left.
    ctx.setTransform(size.ratio, 0, 0, size.ratio, 0, 0);
    if (target) {
      // Keep the followed player centred by moving the world under them.
      // `projectView` is the same helper drawScene uses to turn a world
      // position into a canvas position, through the view's crop and scale;
      // a raw `worldToImage` result is in image space and would centre the
      // camera off by that same scale factor.
      const p = projectView(transform, view, target.x, target.y);
      ctx.translate(size.cssW / 2 - p.px, size.cssH / 2 - p.py);
    }
    drawScene(ctx, {
      transform, view, backdrop, trail,
      players: livePlayers,
      entities: liveEntities,
      show,
      width: size.cssW,
      height: size.cssH,
      names,
      slots,
      followSlot,
    });
    ctx.restore();
    // `show` is a fresh object every render, so its flags are listed
    // individually rather than the object itself: Task 14 wires real toggles
    // to them, and without this the draw effect would not rerun when they
    // change. `size` is listed by field for the same reason.
  }, [
    livePlayers, liveEntities, transform, view, backdrop, trail,
    show.ci, show.entities, show.names, followSlot, names, slots,
    size.cssW, size.cssH, size.pixelW, size.pixelH, size.ratio,
  ]);

  return (
    <canvas
      ref={canvasRef}
      width={size.pixelW}
      height={size.pixelH}
      class="replay__canvas"
    />
  );
}
