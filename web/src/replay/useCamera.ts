import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { View } from '../../../src/mapTransform';
import type { CanvasSize } from './canvasSize';
import {
  FIT_CAMERA, FREE, WHEEL_STEP, clampPan, clampZoom, zoomAbout, zoomedView,
  type Camera, type Follow,
} from './camera';

/** Pointer travel before a press becomes a drag. Under this a press is a
 *  click on whatever is under it and follow is left alone. */
export const DRAG_THRESHOLD_PX = 3;

export interface CameraState { cam: Camera; follow: Follow }

export interface CameraControls {
  cam: Camera;
  /** The fitted view with the camera applied and the pan clamped. Hand this
   *  to the canvas in place of the fit. */
  view: View;
  follow: Follow;
  /** Following anything clears the pan: the follow translate is the shift
   *  then, and a leftover pan would add to it. */
  setFollow(f: Follow): void;
  /** A chip. Zooms about the canvas centre, which is also the followed point
   *  while following. */
  setZoom(z: number): void;
  dragging: boolean;
  onWheel(e: WheelEvent): void;
  onPointerDown(e: PointerEvent): void;
  snapshot(): CameraState;
  restore(s: CameraState): void;
}

interface Drag {
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  moved: boolean;
}

/**
 * Camera and follow state for one viewer, with the wheel and drag behaviour
 * of spec 7.1.
 *
 * Pan is stored raw and clamped when the view is derived, so a resize that
 * makes a stored pan too large is corrected on the next render rather than
 * left showing void. Drag listens on the window once a press starts, rather
 * than capturing the pointer on the stage: pointer capture would redirect
 * the click that ends a press on a chip inside the stage.
 */
export function useCamera(
  fit: View, size: CanvasSize, shiftRef: { current: { x: number; y: number } },
): CameraControls {
  const [cam, setCam] = useState<Camera>(FIT_CAMERA);
  const [follow, setFollowState] = useState<Follow>(FREE);
  const [dragging, setDragging] = useState(false);
  const { cssW, cssH } = size;

  const view = useMemo(
    () => zoomedView(fit, clampPan(fit, cam, cssW, cssH), cssW, cssH),
    [fit, cam, cssW, cssH],
  );

  // Handlers read the newest values through refs so the window listeners a
  // drag installs never close over a stale render.
  const latest = useRef({ fit, cam, follow, cssW, cssH });
  latest.current = { fit, cam, follow, cssW, cssH };
  const drag = useRef<Drag | null>(null);

  const setFollow = useCallback((f: Follow) => {
    setFollowState(f);
    if (f.kind !== 'free') setCam((c) => ({ zoom: c.zoom, panX: 0, panY: 0 }));
  }, []);

  const zoomAt = useCallback((zoom: number, px: number, py: number) => {
    const l = latest.current;
    setCam((c) => (
      l.follow.kind === 'free'
        ? zoomAbout(l.fit, c, zoom, px, py, l.cssW, l.cssH)
        : { zoom: clampZoom(zoom), panX: 0, panY: 0 }
    ));
  }, []);

  const setZoom = useCallback((z: number) => {
    const l = latest.current;
    zoomAt(z, l.cssW / 2, l.cssH / 2);
  }, [zoomAt]);

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const factor = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
    zoomAt(latest.current.cam.zoom * factor, e.clientX - rect.left, e.clientY - rect.top);
  }, [zoomAt]);

  const onPointerDown = useCallback((e: PointerEvent) => {
    if (e.button !== 0) return;
    // A press on a chip inside the stage is a click, never a drag.
    if ((e.target as HTMLElement | null)?.closest('button')) return;
    const l = latest.current;
    drag.current = {
      startX: e.clientX, startY: e.clientY,
      baseX: l.cam.panX, baseY: l.cam.panY, moved: false,
    };
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        d.moved = true;
        setDragging(true);
        if (latest.current.follow.kind !== 'free') {
          // Take over from the follow camera where it is: while following the
          // pan is zero and the canvas translate is the whole shift, so that
          // shift IS the equivalent free pan (spec 7.1: any drag turns follow
          // off).
          d.baseX = shiftRef.current.x;
          d.baseY = shiftRef.current.y;
          setFollowState(FREE);
        }
      }
      setCam((c) => ({ zoom: c.zoom, panX: d.baseX + dx, panY: d.baseY + dy }));
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      setDragging(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [shiftRef]);

  const snapshot = useCallback((): CameraState => {
    const l = latest.current;
    return { cam: l.cam, follow: l.follow };
  }, []);
  const restore = useCallback((s: CameraState) => {
    setCam(s.cam);
    setFollowState(s.follow);
  }, []);

  return { cam, view, follow, setFollow, setZoom, dragging, onWheel, onPointerDown, snapshot, restore };
}
