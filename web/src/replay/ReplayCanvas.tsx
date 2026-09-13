import { useEffect, useRef } from 'preact/hooks';
import { projectView, type MapTransform, type View } from '../../../src/mapTransform';
import type { Frame } from '../../../src/replayFormat';
import { bracket, interpolateEntities, interpolatePlayers } from './interpolate';
import { drawScene, type ShowFlags } from './draw';
import { followPoint, followSlotOf, type Follow } from './camera';
import type { CanvasSize } from './canvasSize';

export interface ReplayCanvasProps {
  transform: MapTransform | null;
  view: View;
  size: CanvasSize;
  backdrop: HTMLImageElement | null;
  trail: { x: number; y: number }[];
  /** The recording itself. The canvas brackets and interpolates it for
   *  itself, once per animation frame, rather than being handed an already
   *  interpolated pair of arrays: those could only be recomputed by a render,
   *  and a render per frame is the cost this component exists to avoid. */
  frames: Frame[];
  /** The playback clock, read every animation frame. See `usePlayback`. */
  timeRef: { current: number };
  show: ShowFlags;
  follow: Follow;
  /** The translate the last paint applied to centre the followed point, in
   *  CSS pixels, or zero when free. A drag that starts while following reads
   *  this to seed the pan so the map does not jump under the cursor. */
  shiftRef: { current: { x: number; y: number } };
  names: Record<string, string>;
  slots: string[];
  /** Decoded portrait images by URL. See `usePortraits`. */
  portraits: Record<string, HTMLImageElement>;
  /** Replay format version, threaded to `portraitFor` via `drawScene`. */
  version: number;
  /** A witch_aggro has happened with no witch_killed after it, threaded to
   *  `drawScene` so her rim turns the alert red. */
  witchStartled: boolean;
}

/**
 * Paint one moment of the replay into the canvas.
 *
 * A plain function of its arguments, with the clock read exactly once at the
 * top so every part of the scene is drawn from the same instant.
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
function paint(canvas: HTMLCanvasElement | null, p: ReplayCanvasProps): void {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx || !p.transform) return;

  const {
    transform, view, size, backdrop, trail, show, follow, names, slots, portraits, version, witchStartled,
  } = p;
  const pair = bracket(p.frames, p.timeRef.current);
  const players = pair ? interpolatePlayers(pair.a, pair.b, pair.f) : [];
  const entities = pair ? interpolateEntities(pair.a, pair.b, pair.f) : [];

  // Reset in device space before anything else. Without this, a follow
  // camera's translate below would shift drawScene's own internal clear by
  // the same offset, leaving a sliver of the previous frame uncleared at
  // the canvas edge every time the translate is non-zero, which is nearly
  // always while following a moving target.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size.pixelW, size.pixelH);
  ctx.restore();

  const pt = followPoint(players, follow);
  ctx.save();
  // Everything below this line is in CSS pixels. One scale here is what
  // lets an avatar radius or a line width in the draw code mean the same
  // thing on a phone at 3x and a desktop at 1x, instead of meaning a
  // backing pixel that the browser then resamples to whatever is left.
  ctx.setTransform(size.ratio, 0, 0, size.ratio, 0, 0);
  let shift = { x: 0, y: 0 };
  if (pt) {
    // Keep the followed point centred by moving the world under it.
    // `projectView` is the same helper drawScene uses to turn a world
    // position into a canvas position, through the view's crop and scale;
    // a raw `worldToImage` result is in image space and would centre the
    // camera off by that same scale factor.
    const c = projectView(transform, view, pt.x, pt.y);
    shift = { x: size.cssW / 2 - c.px, y: size.cssH / 2 - c.py };
    ctx.translate(shift.x, shift.y);
  }
  p.shiftRef.current = shift;
  drawScene(ctx, {
    transform, view, backdrop, trail,
    players,
    entities,
    entitiesPrev: pair ? pair.a.entities : [],
    show,
    width: size.cssW,
    height: size.cssH,
    names,
    slots,
    followSlot: followSlotOf(follow),
    portraits,
    version,
    witchStartled,
  });
  ctx.restore();
}

/**
 * The canvas itself, plus the animation loop that draws into it.
 *
 * This component renders its element once and then stops caring about
 * renders. The clock it draws from is a ref, so playback costs zero Preact
 * work: no state changes sixty times a second, nothing above it re-renders,
 * and interpolation still happens at the display's rate rather than the
 * recording's 10Hz. Everything else the scene depends on does arrive by
 * prop, so there are two ways in: the loop repaints when the clock moves,
 * and one effect repaints when anything else does.
 */
export function ReplayCanvas(props: ReplayCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { size } = props;

  /** The loop is started once and never restarted, so it cannot close over
   *  this render's props. Assigned during render rather than in an effect so
   *  the newest props are in place before anything can read them. */
  const propsRef = useRef(props);
  propsRef.current = props;

  /** Repaint when something OTHER than the clock changed what a frame should
   *  look like: a toggle, a resize, a newly decoded backdrop, the frames
   *  arriving. Drawn here and not merely flagged for the loop because
   *  requestAnimationFrame does not fire in a hidden tab, and a viewer opened
   *  in a background tab would otherwise sit on a blank canvas until it was
   *  looked at. The loop owns the clock and this owns everything else, and
   *  they do not fight: the loop skips any frame whose time it has already
   *  drawn, so a paused viewer repaints exactly once per change. */
  useEffect(() => {
    paint(canvasRef.current, propsRef.current);
    // `show` is a fresh object every render, so its flags are listed
    // individually rather than the object itself, and `size` is listed by
    // field for the same reason. `frames` belongs here because a live round
    // appends to it and a finished one arrives after the first render.
  }, [
    props.frames, props.transform, props.view, props.backdrop, props.trail,
    props.show.ci, props.show.entities, props.show.names,
    props.follow, props.names, props.slots, props.portraits, props.version,
    props.witchStartled,
    size.cssW, size.cssH, size.pixelW, size.pixelH, size.ratio,
  ]);

  useEffect(() => {
    let raf = 0;
    // NaN so the first frame always draws: no real clock value equals it.
    let drawnAt = Number.NaN;

    const frame = (): void => {
      const p = propsRef.current;
      const t = p.timeRef.current;
      // A paused viewer sits on one moment with nothing else changing, so it
      // costs one comparison per frame and no drawing at all. Skipping the
      // draw rather than the rAF is deliberate: cancelling the loop would
      // mean something has to know to restart it, and there is no state
      // change to hang that on.
      if (t !== drawnAt) {
        drawnAt = t;
        paint(canvasRef.current, p);
      }
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={size.pixelW}
      height={size.pixelH}
      class="replay__canvas"
    />
  );
}
