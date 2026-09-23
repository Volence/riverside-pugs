import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/preact';
import { Viewer, isDefaultCamera, edgeTop, EDGE_TOP_MIN, isPortraitAspect, portraitVars, PORTRAIT_ASPECT } from './Viewer';
import { OVERVIEWS } from '../../../src/mapOverviews';
import { mapAspect } from './useMapLayer';
import { FREE, TEAM } from './camera';
import { STATE, type Frame, type ReplayHeader } from '../../../src/replayFormat';
import type { HitItem } from './hitTest';
import { bookmarkSeekMs, type TimelineEntry } from './timeline';

const HEADER: ReplayHeader = {
  version: 2, token: '', ordinal: 0, half: 1, playerHz: 10, entityHz: 2, map: 'not_a_real_map',
  startedUnix: 0, indexOffset: 0, indexCount: 0, frameCount: 0,
  slots: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  infectedMask: 0,
  sidesKnown: false,
};
// Swapped per test by the portrait layout tests; every other test runs on a
// map with no overview, which gets the landscape DEFAULT_ASPECT.
let headerMap = HEADER.map;
const NAMES = { A: 'bill', B: 'zoey', C: 'francis', D: 'louis', E: 'smk', F: 'boom', G: 'hunt', H: 'tank' };
let sourceOverride: Record<string, unknown> = {};

// 8000/10000 give the hover/click tests below an endMs far past
// BOOKMARK_LEAD_MS (3000), so a seek's lead-in is never clamped to the round
// start by coincidence the way it would be with only the original 0/100/200.
function frames(): Frame[] {
  return [0, 100, 200, 8000, 10000].map((tMs) => ({
    tMs, offset: 0,
    players: Array.from({ length: 8 }, (_, slot) => ({
      slot, x: slot * 10, y: 0, z: 0, yaw: 0, pitch: 0,
      state: STATE.PRESENT | STATE.ALIVE,
      health: 100, temp: 0, cls: slot < 4 ? slot : 1, weapon: 0, clip: 0, reserve: 0,
    })),
    entities: [],
  }));
}

vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return {
    ...actual,
    useReplaySource: () => ({
      header: { ...HEADER, map: headerMap }, frames: frames(), closed: true, tooNew: false, error: null, phase: null, behindSinceMs: null,
      ...sourceOverride,
    }),
  };
});

/**
 * `hitsRef`/`shiftRef` are written by the canvas's own paint, which never
 * runs in happy-dom (no 2D context). Hover/click tests set these before
 * mounting instead, and this stub writes them into the refs Viewer hands
 * down, standing in for a real paint. `tooltipRenders` counts invocations of
 * the mocked ReplayTooltip, which Preact calls exactly when Viewer's own
 * render runs (a plain function component with no memoization): that makes
 * it a direct probe for "did Viewer re-render", used by the render-storm
 * test below.
 */
let mockHits: HitItem[] = [];
let mockShift = { x: 0, y: 0 };
let tooltipRenders = 0;

vi.mock('./ReplayCanvas', () => ({
  ReplayCanvas: (props: { hitsRef: { current: HitItem[] }; shiftRef: { current: { x: number; y: number } } }) => {
    props.hitsRef.current = mockHits;
    props.shiftRef.current = mockShift;
    return <canvas class="replay__canvas" />;
  },
}));

vi.mock('./ReplayTooltip', () => ({
  ReplayTooltip: (props: { text: string | null }) => {
    tooltipRenders += 1;
    return props.text ? <div class="replay__tip" role="tooltip">{props.text}</div> : null;
  },
}));

const DEFAULT_TIMELINE: TimelineEntry[] = [
  { seq: 1, tMs: 100, kind: 'event', event: 'boom', actor: 'F', target: 'A', value: 0 },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.classList.remove('is-theater');
  // useToggles persists to localStorage; the second test turns two toggles off.
  localStorage.clear();
  mockHits = [];
  mockShift = { x: 0, y: 0 };
  tooltipRenders = 0;
  headerMap = HEADER.map;
  sourceOverride = {};
});

function mount(timeline: TimelineEntry[] = DEFAULT_TIMELINE, seekMs?: number) {
  const r = render(
    <Viewer spec={{ kind: 'file', name: 'x' }} names={NAMES} timeline={timeline} seekMs={seekMs} />,
  );
  const stage = r.container.querySelector('.replay__stage') as HTMLElement;
  // happy-dom lays nothing out; give the stage a rect so clientX/Y map to
  // stage-relative coordinates the same way the brief's math assumes.
  stage.getBoundingClientRect = () => (
    { left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, x: 0, y: 0, toJSON() {} } as DOMRect
  );
  return { ...r, stage };
}

describe('Viewer theater', () => {
  it('enters theater from the chip, lays the roster down the edges in order, and leaves on Escape', () => {
    const { container } = mount();
    expect(container.querySelector('.replay--theater')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Theater' }));
    expect(container.querySelector('.replay--theater')).not.toBeNull();
    expect(container.querySelector('.hud-strip')).toBeNull();
    expect(container.querySelector('.tstat')).not.toBeNull();

    const left = [...container.querySelectorAll('.hud-edge--l .hudp__name')].map((n) => n.textContent);
    const right = [...container.querySelectorAll('.hud-edge--r .hudp__name')].map((n) => n.textContent);
    expect(left).toEqual(['bill', 'zoey', 'francis', 'louis']);
    expect(right).toEqual(['smk', 'boom', 'hunt', 'tank']);

    // Spec 7.1: follow is on by default in theater, on the survivor centroid.
    expect(screen.getByRole('button', { name: 'Survivors' }).classList.contains('is-on')).toBe(true);

    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(container.querySelector('.replay--theater')).toBeNull();
    expect(container.querySelector('.hud-strip')).not.toBeNull();
    // And the camera is back where it was: free at fit.
    expect(screen.getByRole('button', { name: 'Free' }).classList.contains('is-on')).toBe(true);
    expect(screen.getByRole('button', { name: 'Zoom to fit' }).classList.contains('is-on')).toBe(true);
  });

  it('gives the rail its column and pushes the infected cards inward', () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Theater' }));
    const root = container.querySelector('.replay--theater') as HTMLElement;
    // Events and chat are on by default, so the rail is shown.
    expect(container.querySelector('.theater__rail')).not.toBeNull();
    expect(root.style.getPropertyValue('--rail-w')).toBe('320px');
    fireEvent.click(screen.getByRole('button', { name: 'Events' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(container.querySelector('.theater__rail')).toBeNull();
    expect(root.style.getPropertyValue('--rail-w')).toBe('0px');
  });

  it('renders the marker filters inside theater__top, where the pointer-events re-enabling rule reaches them', () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Theater' }));
    const top = container.querySelector('.theater__top');
    expect(top).not.toBeNull();
    const filters = top!.querySelector('.replay__filters');
    expect(filters).not.toBeNull();
  });

  it('leaves no interactive element inside the edge HUD plates for the stage to fight over pointer events', () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Theater' }));
    const edges = container.querySelectorAll('.hud-edge');
    expect(edges.length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.hud-edge .hudp').length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.querySelector('button, a, input')).toBeNull();
    }
  });
});

describe('Viewer hover and click-to-seek', () => {
  it('renders once for a new hover and not again for a second pointermove over the same hit', () => {
    mockHits = [{ kind: 'player', px: 40, py: 30, r: 17, slot: 0 }];
    mockShift = { x: 0, y: 0 };
    const { stage } = mount();

    const before = tooltipRenders;
    fireEvent.pointerMove(stage, { clientX: 40, clientY: 30 });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    const afterFirst = tooltipRenders;
    expect(afterFirst).toBeGreaterThan(before);

    // Same hit, same coordinates: sameHit says nothing changed, so setHover's
    // updater hands back the identical object and Preact bails out of the
    // render entirely. A regression back to `setHover({...})` unconditionally
    // would make this assertion fail.
    fireEvent.pointerMove(stage, { clientX: 40, clientY: 30 });
    expect(tooltipRenders).toBe(afterFirst);
  });

  it('shows a tooltip naming the hovered player, at the hit position plus the follow shift', () => {
    mockHits = [{ kind: 'player', px: 50, py: 60, r: 17, slot: 0 }];
    mockShift = { x: 20, y: 15 };
    const { stage } = mount();

    // The scene was drawn shifted by (20, 15), so the on-screen point for a
    // hit recorded at (50, 60) is (70, 75); stageHit must subtract the same
    // shift back out to find it.
    fireEvent.pointerMove(stage, { clientX: 70, clientY: 75 });
    expect(screen.getByRole('tooltip').textContent).toContain('bill');
  });

  it('shows nothing off a miss, even with hits recorded', () => {
    mockHits = [{ kind: 'player', px: 50, py: 60, r: 17, slot: 0 }];
    mockShift = { x: 0, y: 0 };
    const { stage } = mount();
    fireEvent.pointerMove(stage, { clientX: 500, clientY: 400 });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('seeks to BOOKMARK_LEAD_MS before the event when a marker tag is clicked, with no preceding hover', () => {
    mockHits = [{ kind: 'marker', px: 50, py: 60, r: 8, seq: 9 }];
    mockShift = { x: 0, y: 0 };
    const tl: TimelineEntry[] = [
      { seq: 9, tMs: 8000, kind: 'event', event: 'boom', actor: 'F', target: 'A', value: 0 },
    ];
    const { stage, container } = mount(tl);

    // No pointermove before this click: on touch, `pointerleave` fires after
    // `pointerup` and before `click`, clearing hover before the click ever
    // sees it. The seek has to come from the click event's own coordinates,
    // not from hover state, or a tap would never seek.
    fireEvent.click(stage, { clientX: 50, clientY: 60 });

    const scrub = container.querySelector('.scrub__range') as HTMLInputElement;
    expect(scrub.value).toBe(String(bookmarkSeekMs(8000)));
    expect(scrub.value).not.toBe('8000');
  });

  it('clears the tooltip during a drag and does not seek on the click that ends it', () => {
    mockHits = [{ kind: 'marker', px: 50, py: 60, r: 8, seq: 9 }];
    mockShift = { x: 0, y: 0 };
    const tl: TimelineEntry[] = [
      { seq: 9, tMs: 8000, kind: 'event', event: 'boom', actor: 'F', target: 'A', value: 0 },
    ];
    const { stage, container } = mount(tl);

    fireEvent.pointerMove(stage, { clientX: 50, clientY: 60 });
    expect(screen.getByRole('tooltip')).toBeTruthy();

    // A drag: press on the stage, then a big enough window pointermove for
    // useCamera's own listener to cross DRAG_THRESHOLD_PX and flip `dragging`.
    fireEvent.pointerDown(stage, { clientX: 50, clientY: 60, button: 0 });
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 65, clientY: 75, bubbles: true }));
    });

    // The pointer is back over the same marker, but camera.dragging is true:
    // stageHit must refuse the hit outright rather than merely leaving the
    // stale hover in place.
    fireEvent.pointerMove(stage, { clientX: 50, clientY: 60 });
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.click(stage);
    const scrub = container.querySelector('.scrub__range') as HTMLInputElement;
    expect(scrub.value).toBe('0');

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 65, clientY: 75, bubbles: true }));
    });
  });
});

describe('Viewer stats panel', () => {
  it('opens the running box score from the Stats chip, at the playhead, and closes it from the panel', () => {
    const { container } = mount();
    expect(container.querySelector('.box')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Stats' }));
    const box = container.querySelector('.box');
    expect(box).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Stats' }).classList.contains('is-on')).toBe(true);
    // DEFAULT_TIMELINE's one boom at 0.1s is behind a playhead at 0 only once
    // it plays; the column exists from the start because the round has it.
    expect([...box!.querySelectorAll('th')].map((h) => h.textContent)).toContain('Booms');

    fireEvent.click(screen.getByRole('button', { name: 'Close stats' }));
    expect(container.querySelector('.box')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stats' }).classList.contains('is-on')).toBe(false);
  });
});

describe('Viewer key panel', () => {
  it('opens the key panel from the Key chip and closes it from the panel button', () => {
    const { container } = mount();
    expect(container.querySelector('.key')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Key' }));
    expect(container.querySelector('.key')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Key' }).classList.contains('is-on')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Close key' }));
    expect(container.querySelector('.key')).toBeNull();
  });

  it('does not let a press inside the panel (on a non-button element) start the stage drag', () => {
    const { container, stage } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Key' }));
    const heading = container.querySelector('.key h5') as HTMLElement;
    expect(heading).not.toBeNull();

    fireEvent.pointerDown(heading, { clientX: 50, clientY: 60, button: 0 });
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 65, clientY: 75, bubbles: true }));
    });

    // useCamera's onPointerDown never saw the press (stopped on the panel
    // root), so the window pointermove above never crosses into a drag: the
    // stage never picks up its dragging class.
    expect(stage.classList.contains('is-dragging')).toBe(false);

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 65, clientY: 75, bubbles: true }));
    });
  });
});

describe('Viewer deep link seek', () => {
  it('seeks once to seekMs when the frames arrive, and not again on later renders', () => {
    // frames() carries an exact 8000 tMs entry, so a correct seek lands the
    // playhead precisely there on mount, before anything else has driven it.
    const { container, rerender } = mount(DEFAULT_TIMELINE, 8000);
    const scrub = container.querySelector('.scrub__range') as HTMLInputElement;
    expect(scrub.value).toBe('8000');

    // The viewer is scrubbed elsewhere. A deep link only sets the opening
    // position, so a later render with the identical seekMs prop must not
    // yank the viewer back to it.
    fireEvent.input(scrub, { target: { value: '100' } });
    expect(scrub.value).toBe('100');

    rerender(
      <Viewer spec={{ kind: 'file', name: 'x' }} names={NAMES} timeline={DEFAULT_TIMELINE} seekMs={8000} />,
    );
    expect(scrub.value).toBe('100');
  });

  it('does not seek at all when seekMs is absent, leaving the round at its own start', () => {
    const { container } = mount(DEFAULT_TIMELINE, undefined);
    const scrub = container.querySelector('.scrub__range') as HTMLInputElement;
    expect(scrub.value).toBe('0');
  });

  it('writes its clock into momentRef, so a control outside it can ask what moment is on screen', () => {
    const momentRef = { current: -1 };
    const { container } = render(<Viewer spec={{ kind: 'file', name: 'x' }} names={NAMES} timeline={[]} seekMs={8000} momentRef={momentRef} />);
    expect((container.querySelector('.scrub__range') as HTMLInputElement).value).toBe('8000');
    expect(momentRef.current).toBe(8000);
  });
});

describe('isDefaultCamera', () => {
  it('is true within tolerance of fit and free, even after a zoom-in/zoom-out round trip', () => {
    expect(isDefaultCamera({ cam: { zoom: 1.0000000000000002, panX: 0, panY: 0 }, follow: FREE })).toBe(true);
  });

  it('is false when zoomed', () => {
    expect(isDefaultCamera({ cam: { zoom: 2, panX: 0, panY: 0 }, follow: FREE })).toBe(false);
  });

  it('is false when following, even at fit zoom', () => {
    expect(isDefaultCamera({ cam: { zoom: 1, panX: 0, panY: 0 }, follow: TEAM })).toBe(false);
  });
});

describe('edgeTop', () => {
  // The bug: .hud-edge and .theater__rail started at a hardcoded top: 150px,
  // chosen to clear the theater chrome. But that chrome wraps. Narrow the
  // window enough that the toggle chips take two rows and it grows past
  // 150px, so the top survivor card renders UNDER the HP/NAMES/GUNS buttons.
  it('keeps the established offset for chrome that fits on one row', () => {
    expect(edgeTop(0)).toBe(EDGE_TOP_MIN);
    expect(edgeTop(120)).toBe(EDGE_TOP_MIN);
  });

  // A zero measurement is jsdom or a hidden element, not a real reading, so
  // the floor has to hold rather than collapsing the columns to the top.
  it('falls back to the floor when there is no measurement', () => {
    expect(edgeTop(0)).toBe(EDGE_TOP_MIN);
  });

  it('pushes the columns clear when the chrome has wrapped', () => {
    expect(edgeTop(190)).toBeGreaterThan(190);
    expect(edgeTop(260)).toBeGreaterThan(260);
  });
});

describe('Viewer portrait layout', () => {
  const PORTRAIT = 'l4d_vs_airport03_garage';

  it('splits the shipped maps at PORTRAIT_ASPECT with a gap either side of it', () => {
    // The threshold sits in the empty band between the tallest portrait map
    // (hospital03, 0.92) and the squarest landscape one (hospital01, 1.05),
    // so no shipped map is within a rounding error of changing layout.
    const aspects = Object.keys(OVERVIEWS).map((m) => mapAspect({ ...HEADER, map: m }));
    const portrait = aspects.filter(isPortraitAspect);
    expect(portrait.length).toBe(4);
    expect(Math.max(...portrait)).toBeLessThan(PORTRAIT_ASPECT - 0.05);
    expect(Math.min(...aspects.filter((a) => !isPortraitAspect(a)))).toBeGreaterThan(PORTRAIT_ASPECT + 0.03);
    expect(isPortraitAspect(mapAspect({ ...HEADER, map: PORTRAIT }))).toBe(true);
  });

  it('puts the controls, filters, rail and panels in a column beside a portrait map', () => {
    headerMap = PORTRAIT;
    const { container } = mount();
    const root = container.querySelector('.replay') as HTMLElement;
    expect(root.classList.contains('replay--portrait')).toBe(true);
    const main = container.querySelector('.replay__main') as HTMLElement;
    // The frame and the column are the two tracks of the side layout.
    expect([...main.children].map((c) => c.className)).toEqual(['replay__frame', 'replay__side']);
    const side = container.querySelector('.replay__side') as HTMLElement;
    expect([...side.children].map((c) => c.className)).toEqual([
      'replay__slot replay__slot--controls',
      'replay__slot replay__slot--filters',
      'replay__slot replay__slot--rail',
      'replay__slot replay__slot--hud',
    ]);
    expect(side.querySelector('.hud-strip')).not.toBeNull();
    // The width cap moved to the stylesheet, which picks side or stacked by
    // viewport width from the variables on the main element.
    const stage = container.querySelector('.replay__stage') as HTMLElement;
    expect(stage.style.maxWidth).toBe('');
    expect(stage.style.aspectRatio).not.toBe('');
    expect(main.style.getPropertyValue('--side-max-w')).toContain('100vh');
    expect(main.style.getPropertyValue('--stacked-max-w')).toContain('78vh');
  });

  it('leaves a landscape map exactly as it was', () => {
    const { container } = mount();
    expect(container.querySelector('.replay--portrait')).toBeNull();
    expect(container.querySelector('.replay__main')).toBeNull();
    const stage = container.querySelector('.replay__stage') as HTMLElement;
    expect(stage.style.maxWidth).toContain('78vh');
    // Filters, frame, rail, controls, panels, in that order, as direct children.
    const root = container.querySelector('.replay') as HTMLElement;
    expect([...root.children].map((c) => c.className.split(' ')[0])).toEqual([
      'replay__filters', 'replay__frame', 'replay__rail', 'replay__controls', 'replay__toolbar', 'hud-strip',
    ]);
  });

  it('gives the side stage nearly the whole viewport height, the stacked one the old cap', () => {
    const v = portraitVars(0.75);
    expect(v['--side-max-w']).toBe('calc((100vh - 32px) * 0.75)');
    expect(v['--side-frame-w']).toBe('calc(calc((100vh - 32px) * 0.75) + 54px)');
    expect(v['--stacked-max-w']).toMatch(/^min\(\d+px, calc\(78vh \* 0\.75\)\)$/);
  });

  it('still enters theater from a portrait map', () => {
    headerMap = PORTRAIT;
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Theater' }));
    expect(container.querySelector('.replay--theater')).not.toBeNull();
    expect(container.querySelector('.replay__main')).toBeNull();
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(container.querySelector('.replay--portrait .replay__side')).not.toBeNull();
  });
});

describe('Viewer live with nothing to draw yet', () => {
  it('says the live view is catching up instead of loading for ever', () => {
    sourceOverride = { header: null, frames: [], closed: false, behindSinceMs: Date.now() - 5_000 };
    render(<Viewer spec={{ kind: 'live-match', matchId: 1 }} live names={NAMES} />);
    expect(screen.getByText('Live view is catching up')).toBeTruthy();
  });

  it('still says loading for a saved replay with no header yet', () => {
    sourceOverride = { header: null, frames: [] };
    render(<Viewer spec={{ kind: 'file', name: 'x' }} names={NAMES} />);
    expect(screen.getByText('Loading replay...')).toBeTruthy();
  });
});
