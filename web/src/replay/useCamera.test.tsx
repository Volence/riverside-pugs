import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { useCamera, type CameraControls } from './useCamera';
import { FREE, TEAM, zoomedView } from './camera';
import { fitView } from '../../../src/mapTransform';

afterEach(cleanup);

// Same shape as the canvas: overflows both axes from zoom 2 up, so a pan is
// never clamped to zero in the drag tests below. See camera.test.ts.
const BOX = { x0: 0, y0: 0, x1: 1600, y1: 1000 };
const SIZE = { cssW: 800, cssH: 500, pixelW: 800, pixelH: 500, ratio: 1 };
const FIT = fitView(BOX, SIZE.cssW, SIZE.cssH);

function mount() {
  const shiftRef = { current: { x: 0, y: 0 } };
  let ctl!: CameraControls;
  function Host() {
    ctl = useCamera(FIT, SIZE, shiftRef);
    return <div data-testid="stage" onWheel={ctl.onWheel} onPointerDown={ctl.onPointerDown} />;
  }
  const r = render(<Host />);
  const stage = r.getByTestId('stage') as HTMLElement;
  // happy-dom lays nothing out; the hook measures the stage's rect, so give it one.
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return { get ctl() { return ctl; }, stage, shiftRef };
}

function wheel(stage: HTMLElement, deltaY: number, clientX: number, clientY: number) {
  act(() => {
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY, clientX, clientY, bubbles: true, cancelable: true }));
  });
}

function drag(stage: HTMLElement, from: [number, number], to: [number, number]) {
  act(() => {
    stage.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: from[0], clientY: from[1], bubbles: true }));
  });
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: to[0], clientY: to[1], bubbles: true }));
  });
  act(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: to[0], clientY: to[1], bubbles: true }));
  });
}

describe('useCamera', () => {
  it('starts at fit and free, and its view is the fit', () => {
    const h = mount();
    expect(h.ctl.cam).toEqual({ zoom: 1, panX: 0, panY: 0 });
    expect(h.ctl.follow).toEqual(FREE);
    expect(h.ctl.view.scale).toBeCloseTo(FIT.scale, 9);
    expect(h.ctl.view.offsetX).toBeCloseTo(FIT.offsetX, 9);
    expect(h.ctl.view.offsetY).toBeCloseTo(FIT.offsetY, 9);
  });

  it('zooms a notch in on wheel up about the cursor, out on wheel down', () => {
    const h = mount();
    wheel(h.stage, -100, 400, 250);
    expect(h.ctl.cam.zoom).toBeCloseTo(1.25, 9);
    wheel(h.stage, 100, 400, 250);
    expect(h.ctl.cam.zoom).toBeCloseTo(1, 9);
  });

  it('sets a chip zoom about the centre and reports the zoomed view', () => {
    const h = mount();
    act(() => h.ctl.setZoom(4));
    expect(h.ctl.cam.zoom).toBe(4);
    expect(h.ctl.view).toEqual(zoomedView(FIT, h.ctl.cam, SIZE.cssW, SIZE.cssH));
  });

  it('pans by the drag distance when zoomed in and free', () => {
    const h = mount();
    act(() => h.ctl.setZoom(4));
    drag(h.stage, [400, 250], [430, 240]);
    expect(h.ctl.cam.panX).toBeCloseTo(30, 9);
    expect(h.ctl.cam.panY).toBeCloseTo(-10, 9);
    expect(h.ctl.dragging).toBe(false);
  });

  it('ignores a movement under the drag threshold, so a click is a click', () => {
    const h = mount();
    act(() => h.ctl.setZoom(4));
    act(() => h.ctl.setFollow(TEAM));
    drag(h.stage, [400, 250], [401, 251]);
    expect(h.ctl.follow).toEqual(TEAM);
    expect(h.ctl.cam.panX).toBe(0);
  });

  it('a drag turns follow off and seeds the pan from the follow shift so nothing jumps', () => {
    const h = mount();
    act(() => h.ctl.setZoom(4));
    act(() => h.ctl.setFollow(TEAM));
    // What the canvas last translated by to keep the centroid centred.
    h.shiftRef.current = { x: -120, y: 45 };
    drag(h.stage, [400, 250], [410, 250]);
    expect(h.ctl.follow).toEqual(FREE);
    expect(h.ctl.cam.panX).toBeCloseTo(-110, 9);
    expect(h.ctl.cam.panY).toBeCloseTo(45, 9);
  });

  it('following again clears the pan', () => {
    const h = mount();
    act(() => h.ctl.setZoom(4));
    drag(h.stage, [400, 250], [450, 250]);
    expect(h.ctl.cam.panX).not.toBe(0);
    act(() => h.ctl.setFollow({ kind: 'slot', slot: 2 }));
    expect(h.ctl.cam.panX).toBe(0);
    expect(h.ctl.cam.panY).toBe(0);
    expect(h.ctl.cam.zoom).toBe(4);
  });

  it('snapshots and restores', () => {
    const h = mount();
    act(() => h.ctl.setZoom(2));
    const s = h.ctl.snapshot();
    act(() => { h.ctl.setZoom(6); h.ctl.setFollow(TEAM); });
    act(() => h.ctl.restore(s));
    expect(h.ctl.cam.zoom).toBe(2);
    expect(h.ctl.follow).toEqual(FREE);
  });

  it('does not start a drag from a button inside the stage', () => {
    const h = mount();
    act(() => h.ctl.setZoom(4));
    const btn = document.createElement('button');
    h.stage.appendChild(btn);
    act(() => {
      btn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 400, clientY: 250, bubbles: true }));
    });
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { clientX: 450, clientY: 250 })); });
    act(() => { window.dispatchEvent(new PointerEvent('pointerup', { clientX: 450, clientY: 250 })); });
    expect(h.ctl.cam.panX).toBe(0);
  });
});
