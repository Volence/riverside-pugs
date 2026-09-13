import { boxSpan, type View } from '../../../src/mapTransform';
import { STATE, type PlayerSample } from '../../../src/replayFormat';
import { followTarget, isSurvivor } from './draw';

/**
 * The camera, as a magnification of the fitted view plus a shift.
 *
 * It composes onto the `View` that `fitView` produced rather than replacing
 * it (spec 7.1): a zoomed view is just another View, so `projectView`, the
 * follow translate in ReplayCanvas and `drawScene` all keep working with no
 * knowledge of zoom.
 */
export interface Camera {
  /** Multiplier over the fitted view. 1 is fit. */
  zoom: number;
  /** Shift of the magnified view, in CSS pixels. Zero while following: the
   *  follow translate in ReplayCanvas is the shift then. */
  panX: number;
  panY: number;
}

export const FIT_CAMERA: Camera = { zoom: 1, panX: 0, panY: 0 };
/** The chip group. */
export const ZOOM_LEVELS = [1, 2, 4, 6] as const;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** One wheel notch. Three notches are 1.95x, close enough to a chip step. */
export const WHEEL_STEP = 1.25;

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** The fitted view magnified about the canvas centre, then shifted by the pan. */
export function zoomedView(fit: View, cam: Camera, cssW: number, cssH: number): View {
  const cx = cssW / 2;
  const cy = cssH / 2;
  return {
    box: fit.box,
    scale: fit.scale * cam.zoom,
    offsetX: cx + (fit.offsetX - cx) * cam.zoom + cam.panX,
    offsetY: cy + (fit.offsetY - cy) * cam.zoom + cam.panY,
  };
}

function clampAxis(pan: number, offset: number, drawn: number, canvas: number): number {
  // Smaller than the canvas: the fit already centred it, and a pan would
  // only move the map off centre for no reason.
  if (drawn <= canvas) return 0;
  // Bigger: the map's edges may reach the canvas edges but never pass them.
  const min = canvas - drawn - offset;
  const max = -offset;
  return Math.min(max, Math.max(min, pan));
}

/** Keep the map on the canvas (spec 7.1: pan clamps to the content box). */
export function clampPan(fit: View, cam: Camera, cssW: number, cssH: number): Camera {
  const unpanned = zoomedView(fit, { zoom: cam.zoom, panX: 0, panY: 0 }, cssW, cssH);
  const { w, h } = boxSpan(fit.box);
  return {
    zoom: cam.zoom,
    panX: clampAxis(cam.panX, unpanned.offsetX, w * unpanned.scale, cssW),
    panY: clampAxis(cam.panY, unpanned.offsetY, h * unpanned.scale, cssH),
  };
}

/** Change the zoom keeping the map point under canvas pixel (px, py) still. */
export function zoomAbout(
  fit: View, cam: Camera, zoom: number, px: number, py: number, cssW: number, cssH: number,
): Camera {
  const z = clampZoom(zoom);
  const before = zoomedView(fit, cam, cssW, cssH);
  // The image-space point under the cursor, box-relative.
  const ix = (px - before.offsetX) / before.scale;
  const iy = (py - before.offsetY) / before.scale;
  const unpanned = zoomedView(fit, { zoom: z, panX: 0, panY: 0 }, cssW, cssH);
  return clampPan(fit, {
    zoom: z,
    panX: px - (ix * unpanned.scale + unpanned.offsetX),
    panY: py - (iy * unpanned.scale + unpanned.offsetY),
  }, cssW, cssH);
}

/** What the camera centres on. `team` is the survivor centroid (spec 7.1). */
export type Follow =
  | { kind: 'free' }
  | { kind: 'team' }
  | { kind: 'slot'; slot: number };

export const FREE: Follow = { kind: 'free' };
export const TEAM: Follow = { kind: 'team' };

/** The slot to draw the follow ring around, or null. */
export function followSlotOf(f: Follow): number | null {
  return f.kind === 'slot' ? f.slot : null;
}

/** The world point to centre on, or null to leave the camera where it is. */
export function followPoint(
  players: PlayerSample[], f: Follow,
): { x: number; y: number } | null {
  if (f.kind === 'free') return null;
  if (f.kind === 'slot') {
    const p = followTarget(players, f.slot);
    return p ? { x: p.x, y: p.y } : null;
  }
  const present = players.filter((p) => isSurvivor(p) && (p.state & STATE.PRESENT) !== 0);
  const alive = present.filter((p) => (p.state & STATE.ALIVE) !== 0);
  // A wiped team still has bodies somewhere; centring on them beats jumping
  // to nowhere in the last seconds of a round.
  const pool = alive.length ? alive : present;
  if (pool.length === 0) return null;
  return {
    x: pool.reduce((n, p) => n + p.x, 0) / pool.length,
    y: pool.reduce((n, p) => n + p.y, 0) / pool.length,
  };
}
