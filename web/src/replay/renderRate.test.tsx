import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/preact';
import { act } from 'preact/test-utils';
import { useMemo } from 'preact/hooks';
import { drawScene } from './draw';
import { ReplayCanvas } from './ReplayCanvas';
import { FREE } from './camera';
import { usePlayback, PUBLISH_INTERVAL_MS } from './playback';
import { bracket, interpolatePlayers } from './interpolate';
import { fitView, type MapTransform } from '../../../src/mapTransform';
import { STATE, type Frame } from '../../../src/replayFormat';

/* Render pressure, which is the one thing about this viewer nothing measured.
 *
 * The viewer used to publish its clock to Preact state on every animation
 * frame, so every frame re-rendered the whole subtree: the canvas, the scrub
 * bar, the timeline rail and eight HUD panels, each with a portrait, a name,
 * a health number, status flags and a two-part bar. The match page mounts two
 * viewers at once, so a page sat at roughly a thousand component renders a
 * second on the main thread and the browser visibly struggled.
 *
 * None of that DOM can show anything new more than ten times a second,
 * because the recording is 10Hz. Only the canvas has a reason to run at the
 * display's rate, because interpolation is what makes movement smooth.
 *
 * Measured on this harness before the split: 60 renders and 60 draws per
 * simulated second. The assertions below are ratios rather than exact counts
 * so the test survives a different publish interval or a different frame
 * rate, but would still fail the moment the clock went back to driving the
 * DOM at frame rate. */

const TRANSFORM: MapTransform = {
  originX: 0, originY: 0, unitsPerPixel: 1, image: null, width: 2048, height: 1271,
};
const VIEW = fitView({ x0: 0, y0: 0, x1: 2048, y1: 1271 }, 800, 496, 0);
const SIZE = { cssW: 800, cssH: 496, pixelW: 800, pixelH: 496, ratio: 1 };
const SLOTS = ['', '', '', '', '', '', '', ''];
const SHOW = { ci: true, entities: true, names: true };
/* Stable identities, as the real Viewer has: `trail` and `view` are memos,
 * `names` and `slots` come from props and header state. The canvas repaints
 * when a prop changes, so handing it a fresh array here would measure the
 * harness rather than the component. */
const TRAIL: { x: number; y: number }[] = [];
const NAMES: Record<string, string> = {};
const PORTRAITS: Record<string, HTMLImageElement> = {};
const SHIFT = { current: { x: 0, y: 0 } };

const FPS = 60;
const FRAME_MS = 1000 / FPS;

vi.mock('./draw', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./draw')>();
  return { ...actual, drawScene: vi.fn() };
});

const drawSceneMock = drawScene as unknown as ReturnType<typeof vi.fn>;

/** A 20 second round at the recording's real 10Hz, with everyone moving, so
 *  interpolation between frames actually has something to interpolate. */
function makeFrames(): Frame[] {
  const out: Frame[] = [];
  for (let i = 0; i < 200; i++) {
    out.push({
      tMs: i * 100,
      offset: 0,
      players: Array.from({ length: 8 }, (_, slot) => ({
        slot, x: i * 10, y: i * 5, z: 0, yaw: 0, pitch: 0,
        state: STATE.PRESENT | STATE.ALIVE,
        health: 100, temp: 0, cls: 0, weapon: 0, clip: 0, reserve: 0,
      })),
      entities: [],
    });
  }
  return out;
}

/** happy-dom has no 2D context. `drawScene` is mocked out, so all the real
 *  component asks of the context is the handful of transform calls around it. */
function stubCanvas() {
  const ctx = {
    save() {}, restore() {}, setTransform() {}, clearRect() {}, translate() {},
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
}

function driveRaf() {
  let cbs: FrameRequestCallback[] = [];
  let now = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cbs.push(cb);
    return cbs.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => { cbs = []; });
  vi.stubGlobal('performance', { now: () => now });
  return {
    /** Fire one animation frame `ms` after the previous one.
     *
     *  Each frame gets its own `act`, which is what a browser does: a frame
     *  callback is its own task and any state it sets is flushed before the
     *  next frame runs. Wrapping the whole second in one `act` would let
     *  Preact batch sixty updates into a single render and the measurement
     *  would flatter whatever the code does. */
    frame() {
      act(() => {
        now += FRAME_MS;
        const due = cbs;
        cbs = [];
        for (const cb of due) cb(now);
      });
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** The viewer subtree in miniature: the hook, one memo derived from the
 *  published clock the way the HUD and status counts are, and the canvas. */
function mountViewer(frames: Frame[]) {
  const seen = { renders: 0 };
  let controls!: ReturnType<typeof usePlayback>;
  const endMs = frames[frames.length - 1].tMs;

  function Host() {
    const pb = usePlayback(endMs);
    controls = pb;
    seen.renders++;
    // Stands in for everything the real Viewer derives from `tMs`: the HUD
    // panels, the status counts and the map layer. Listed so a future change
    // that put the canvas back on this path would be caught here.
    useMemo(() => {
      const pair = bracket(frames, pb.tMs);
      return pair ? interpolatePlayers(pair.a, pair.b, pair.f) : [];
    }, [frames, pb.tMs]);
    return (
      <ReplayCanvas
        transform={TRANSFORM}
        view={VIEW}
        size={SIZE}
        backdrop={null}
        trail={TRAIL}
        frames={frames}
        timeRef={pb.tRef}
        show={SHOW}
        follow={FREE}
        shiftRef={SHIFT}
        names={NAMES}
        slots={SLOTS}
        portraits={PORTRAITS}
        version={1}
      />
    );
  }

  render(<Host />);
  return { seen, get controls() { return controls; } };
}

describe('viewer render pressure', () => {
  it('re-renders the DOM at the recording rate while drawing every frame', () => {
    stubCanvas();
    const raf = driveRaf();
    const frames = makeFrames();
    const host = mountViewer(frames);

    const mountRenders = host.seen.renders;
    drawSceneMock.mockClear();

    for (let i = 0; i < FPS; i++) raf.frame();

    const renders = host.seen.renders - mountRenders;
    const draws = drawSceneMock.mock.calls.length;

    // The canvas is the reason the ref exists: it must still be painting a
    // freshly interpolated scene on essentially every animation frame.
    expect(draws).toBeGreaterThanOrEqual(FPS - 2);

    // The DOM tracks the data, not the display. Allowing a little slack
    // either side of 1000 / PUBLISH_INTERVAL_MS keeps this about the order of
    // magnitude rather than an exact schedule.
    const expected = 1000 / PUBLISH_INTERVAL_MS;
    expect(renders).toBeGreaterThanOrEqual(expected - 2);
    expect(renders).toBeLessThanOrEqual(expected + 2);

    // And the headline, stated as the ratio it really is: the old code drew
    // and rendered the same number of times.
    expect(draws / renders).toBeGreaterThanOrEqual(4);
  });

  it('costs nothing but the two loops while paused', () => {
    stubCanvas();
    const raf = driveRaf();
    const host = mountViewer(makeFrames());

    // Let it run long enough to publish, then stop.
    for (let i = 0; i < FPS; i++) raf.frame();
    act(() => host.controls.pause());
    // Pausing does not stop the world mid-frame: the canvas loop may still
    // owe a draw for the last clock value it has not seen, and the playback
    // loop still owes the readout the moment it stopped on. A quarter second
    // is more than one publish interval, so both have settled by here.
    for (let i = 0; i < FPS / 4; i++) raf.frame();

    const rendersAtPause = host.seen.renders;
    drawSceneMock.mockClear();

    for (let i = 0; i < FPS; i++) raf.frame();

    // A paused viewer shows one unchanging moment. Redrawing it sixty times
    // a second, or re-rendering it ten times a second, is pure waste.
    expect(drawSceneMock.mock.calls.length).toBe(0);
    expect(host.seen.renders).toBe(rendersAtPause);
  });

  it('moves the canvas on the next frame after a seek, not at the next publish', () => {
    stubCanvas();
    const raf = driveRaf();
    const host = mountViewer(makeFrames());

    for (let i = 0; i < FPS; i++) raf.frame();
    act(() => host.controls.pause());
    for (let i = 0; i < FPS; i++) raf.frame();

    drawSceneMock.mockClear();
    act(() => host.controls.seek(12_345));
    // Still paused, so nothing but the seek can have moved the clock.
    expect(host.controls.tRef.current).toBe(12_345);

    raf.frame();
    expect(drawSceneMock.mock.calls.length).toBe(1);
    // The readout agrees with what was drawn straight away, rather than
    // trailing it until the next publish boundary.
    expect(host.controls.tMs).toBe(12_345);
  });
});
