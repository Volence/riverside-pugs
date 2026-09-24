import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { canvasForAspect } from '../../../src/mapTransform';
import { STATE } from '../../../src/replayFormat';
import { bracket, interpolateEntities, interpolatePlayers } from './interpolate';
import { usePlayback } from './playback';
import { useReplaySource, type ReplaySpec } from './source';
import { isSurvivor, sceneCounts, type ShowFlags, type MarkerItem } from './draw';
import { useToggles } from './useToggles';
import { usePortraits } from './usePortraits';
import { mapAspect, useMapLayer } from './useMapLayer';
import { useCanvasSize } from './canvasSize';
import { ReplayCanvas } from './ReplayCanvas';
import { ReplayControls } from './ReplayControls';
import { ReplayHud, ToggleChips, liveStatusText } from './ReplayHud';
import { KeyPanel } from './KeyPanel';
import { HudStrip } from './HudStrip';
import { TimelineRail } from './TimelineRail';
import { TheaterStatus } from './TheaterStatus';
import { MarkerFilters } from './MarkerFilters';
import { FREE, TEAM, followSlotOf } from './camera';
import { useCamera, type CameraState } from './useCamera';
import { useTheater } from './useTheater';
import { useIdle } from './useIdle';
import { eventPosition, markerEntries, markerKind, witchStartledAt } from './markers';
import { sameHit, stageHit, type HitItem } from './hitTest';
import { tooltipText } from './tooltipText';
import { ReplayTooltip } from './ReplayTooltip';
import { StatsPanel } from './StatsPanel';
import { bookmarkSeekMs, type TimelineEntry } from './timeline';

/**
 * How much of the viewport height the map may take.
 *
 * The canvas now follows the map's shape, and a portrait map at the pixel
 * budget is over 1300px tall, which would push the scrub bar and the health
 * panels off the bottom of every screen. Capping the WIDTH by the height the
 * viewport can spare keeps the aspect exact, where a `max-height` would clamp
 * one axis only and stretch the bitmap.
 */
const STAGE_MAX_VH = 78;

/**
 * Below this aspect the map is laid out with the controls BESIDE it.
 *
 * Stacked, a map's width is capped at STAGE_MAX_VH of the viewport height
 * times its aspect, so a portrait map on a 1080p screen (about 955px of
 * viewport) came out a narrow column with the page's sides empty: caves 440px
 * wide in a 1018px frame, airport03 and farm04 about 553. Beside the column
 * the stage is capped by nearly the whole viewport height instead, and the
 * layout widens past the page into the side margins to fit it (see
 * `.replay__main` in app.css), so a portrait map always gets bigger.
 *
 * Why 1.0: this is the owner's call for portrait maps, and 1.0 is where the
 * shipped maps split with room to spare. The 22 overviews have nothing
 * between hospital03 at 0.92 and hospital01 at 1.05, so no map sits near the
 * line and rounding in a future capture cannot flip one. The four below it
 * (caves 0.59, airport03 0.74, farm04 0.74, hospital03 0.92) are the maps
 * that were leaving most of the page empty; a square or wider map already
 * fills most of the 1018px frame stacked, and keeps that layout exactly.
 */
export const PORTRAIT_ASPECT = 1.0;

/** The events/controls column beside a portrait map. */
const SIDE_COL_W = 320;
/** Viewport height the side-layout stage leaves free, top and bottom. */
const SIDE_STAGE_GUTTER = 32;
/** The two sprocket bands and their seams, which share the frame's width. */
const SPROCKETS_W = 54;

export function isPortraitAspect(aspect: number): boolean {
  return aspect < PORTRAIT_ASPECT;
}

/**
 * The CSS custom properties a portrait map's layout reads (see
 * `.replay--portrait` in app.css). Both widths are handed over and the
 * stylesheet picks one, because which layout applies is a media query: a
 * window too narrow for the side column falls back to the stacked layout,
 * and the stacked stage is capped exactly as a landscape map's is.
 */
export function portraitVars(aspect: number): Record<string, string> {
  const side = `calc((100vh - ${SIDE_STAGE_GUTTER}px) * ${aspect})`;
  return {
    '--stacked-max-w': `min(${canvasForAspect(aspect).width}px, calc(${STAGE_MAX_VH}vh * ${aspect}))`,
    '--side-max-w': side,
    '--side-frame-w': `calc(${side} + ${SPROCKETS_W}px)`,
    '--side-col-w': `${SIDE_COL_W}px`,
  };
}

/** The camera theater opens with when the viewer was sitting at fit and
 *  free (spec 7.1: a close camera, follow on by default). A camera the
 *  viewer had already set up is kept as it is. */
const THEATER_CAMERA: CameraState = { cam: { zoom: 2, panX: 0, panY: 0 }, follow: TEAM };

/** The events-and-chat column's width in theater (spec 7.1, Hidden chrome). */
const RAIL_W = 320;

/** Whether a camera is still sitting at the "fit and free" default theater
 *  should open over. Every other consumer of a zoomed camera compares zoom
 *  with a tolerance (ReplayControls, `zoomLabel`) because repeated
 *  zoom-in/zoom-out round trips through `zoomAbout`/`clampZoom` land on
 *  values like `1.0000000000000002`, not exactly `1`; an exact `===` here
 *  would silently keep the close theater camera from ever opening. */
export function isDefaultCamera(s: CameraState): boolean {
  return Math.abs(s.cam.zoom - 1) < 0.01 && s.follow.kind === FREE.kind;
}

/** The default roster lookup, as one shared object rather than a fresh `{}`
 *  per render. The canvas repaints when its props change, and a route that
 *  passes no names (the by-filename replay page) would otherwise hand it a
 *  new object every render and make a paused viewer repaint for nothing. */
const NO_NAMES: Record<string, string> = {};

/** The default timeline, as one shared object rather than a fresh `[]` per
 *  render. Passed to the canvas when there is no timeline, or events are
 *  toggled off, so its prop identity stays stable across renders (see
 *  NO_NAMES above, and renderRate.test.tsx). */
const NO_TIMELINE: TimelineEntry[] = [];

/**
 * Where the theater's edge columns start, given the measured chrome height.
 *
 * They used to start at a hardcoded 150px, picked to clear the top chrome. But
 * that chrome WRAPS: narrow the window until the toggle chips need two rows and
 * it grows past 150, and the top survivor card renders underneath the
 * HP/NAMES/GUNS buttons.
 *
 * A floor rather than a pure measurement, for two reasons. A zero reading is
 * jsdom or a hidden element rather than a real measurement, and collapsing the
 * columns to the top on that would be worse than the bug. And short chrome
 * should keep the layout everyone is used to instead of creeping upward.
 */
export const EDGE_TOP_MIN = 150;
const EDGE_TOP_GAP = 8;

export function edgeTop(chromeHeight: number): number {
  return Math.max(EDGE_TOP_MIN, Math.round(chromeHeight) + EDGE_TOP_GAP);
}

export function Viewer(
  { spec, live = false, names = NO_NAMES, timeline, seekMs, momentRef }:
  {
    spec: ReplaySpec; live?: boolean; names?: Record<string, string>; timeline?: TimelineEntry[];
    seekMs?: number;
    /** Written on every render with the clock the viewer is showing, in
     *  milliseconds into the round, so a control OUTSIDE the viewer (the
     *  match page's "Report this moment") can ask without the viewer knowing
     *  what it is for. A ref, not a callback: it must never cause a render. */
    momentRef?: { current: number };
  },
) {
  const { header, frames, closed, phase, behindSinceMs = null, tooNew, error } = useReplaySource(spec);
  const endMs = frames.length ? frames[frames.length - 1].tMs : 0;
  const playback = usePlayback(endMs, { live, closed });
  if (momentRef) momentRef.current = playback.tMs;

  /** A deep link lands on a moment, not the start of the round. Fires once,
   *  when the frames first arrive: a viewer the user has since scrubbed must
   *  not be yanked back to the link's timestamp on a later render. Depends on
   *  `playback.seek` rather than the whole `playback` object (a fresh object
   *  every render, see usePlayback) so an unrelated re-render, e.g. a hover
   *  change, does not re-invoke this at all once past the guard. */
  const seeked = useRef(false);
  useEffect(() => {
    if (seeked.current || seekMs == null || frames.length === 0) return;
    seeked.current = true;
    playback.seek(seekMs);
  }, [seekMs, frames.length, playback.seek]);
  const [toggles, toggle, setToggle] = useToggles();
  const show: ShowFlags = { ci: toggles.ci, entities: toggles.entities, names: toggles.names };
  const portraits = usePortraits();

  // Theater is a layout state of this component (spec 7.1), never a route.
  const rootRef = useRef<HTMLDivElement>(null);
  const { theater, toggle: toggleTheater } = useTheater(rootRef);
  // Measured, not assumed: see edgeTop. Same shape as useCanvasSize, including
  // the ResizeObserver guard, because jsdom has neither the observer nor any
  // layout to read.
  const chromeRef = useRef<HTMLDivElement>(null);
  const [chromeH, setChromeH] = useState(0);
  useEffect(() => {
    const el = chromeRef.current;
    if (!el) return undefined;
    const read = () => {
      const h = el.offsetHeight;
      setChromeH((prev) => (prev === h ? prev : h));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [theater]);
  const { idle, wake } = useIdle(theater);

  /**
   * One interpolated frame per DOM tick, shared by everything made of DOM.
   *
   * The status counts, the health panels and the map layer must agree, so
   * they all read this one memo rather than bracketing for themselves. It
   * runs at `playback.tMs`, which publishes about ten times a second, because
   * that is the rate the recording changes at: nothing below can show a value
   * the frames did not have.
   *
   * The canvas is deliberately NOT on this. It interpolates from
   * `playback.tRef` inside its own animation loop, because it is the one
   * thing on the page whose output changes between two recorded frames.
   * Worst case it is drawing a moment up to one publish ahead of these
   * numbers, which is the same tenth of a second the recording rounds away
   * anyway.
   */
  const { livePlayers, counts } = useMemo(() => {
    const pair = bracket(frames, playback.tMs);
    if (!pair) {
      return { livePlayers: [], counts: { survivors: 0, commons: 0, specials: 0 } };
    }
    const players = interpolatePlayers(pair.a, pair.b, pair.f);
    const entities = interpolateEntities(pair.a, pair.b, pair.f);
    return { livePlayers: players, counts: sceneCounts(players, entities) };
  }, [frames, playback.tMs]);

  /**
   * The canvas takes the map's own shape instead of one fixed rectangle, and
   * its backing store follows the element's real width. In theater the stage
   * is the viewport, so the element's own shape wins and the fit letterboxes
   * the map inside it.
   *
   * The captures and the old fixed canvas were both 1.61 landscape, so
   * cropping a map's horizontal void only moved that void into the canvas as
   * black bars and left the height governing the fit: eighteen of the
   * twenty-two maps came out SMALLER than before the crop existed. The shape
   * has to follow the content box for the crop to buy anything at all.
   */
  const aspect = useMemo(() => mapAspect(header), [header?.map]);
  const { size, ref: stageRef } = useCanvasSize(aspect, theater);
  const portrait = isPortraitAspect(aspect);
  const stageStyle = useMemo(() => (portrait
    // The width cap comes from the stylesheet here, which picks the side or
    // the stacked one by viewport width; see portraitVars.
    ? { aspectRatio: String(aspect) }
    : {
      // A single number, not a `w / h` pair, so the layout box and the backing
      // store are computed from the identical value and the browser has nothing
      // left to letterbox.
      aspectRatio: String(aspect),
      maxWidth: `min(${canvasForAspect(aspect).width}px, calc(${STAGE_MAX_VH}vh * ${aspect}))`,
    }), [aspect, portrait]);
  const mainStyle = useMemo(() => (portrait ? portraitVars(aspect) : undefined), [aspect, portrait]);

  const { transform, view, backdrop } = useMapLayer(header, frames, livePlayers, size);

  /** Written by the canvas on every paint. See ReplayCanvasProps.shiftRef. */
  const shiftRef = useRef({ x: 0, y: 0 });
  // The fit from useMapLayer is the camera's base; the canvas draws the
  // camera's view. Follow lives here too because following clears the pan.
  const camera = useCamera(view, size, shiftRef);
  const { follow, setFollow } = camera;
  const followSlot = followSlotOf(follow);
  // The follow row is the bookmark selector (spec 7.2). '' is an unrostered
  // slot and selects nothing; see tickEntries.
  const selected = followSlot === null || !header ? null : (header.slots[followSlot] ?? '');

  /** Entering theater opens a close camera on the team if the viewer was
   *  still at its defaults; leaving puts back whatever was there before,
   *  so a viewer the user had already zoomed is not reset on them. */
  const before = useRef<CameraState | null>(null);
  useEffect(() => {
    if (theater) {
      const s = camera.snapshot();
      before.current = s;
      if (isDefaultCamera(s)) camera.restore(THEATER_CAMERA);
    } else if (before.current) {
      camera.restore(before.current);
      before.current = null;
    }
    // camera.snapshot and camera.restore are stable callbacks; only the
    // theater flag should drive this.
  }, [theater]);

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

  // A stable empty array when there is no timeline at all, so a route with
  // none (the by-filename replay page) does not hand the canvas a fresh
  // array every render. See NO_NAMES.
  const tl = timeline ?? NO_TIMELINE;

  /** The tags to leave on the map: the timeline filtered by Show/for and
   *  positioned at each event's moment, in round order. Empty with events
   *  off, so toggling them off clears the map along with the rail. */
  const markers = useMemo<MarkerItem[]>(() => {
    if (!header || tl.length === 0 || !toggles.events) return [];
    const list = markerEntries(tl, toggles.showKind, selected);
    const out: MarkerItem[] = [];
    list.forEach((entry, i) => {
      const pos = eventPosition(frames, header.slots, entry);
      const kind = markerKind(entry.event);
      if (pos && kind) out.push({ entry, kind, pos, index: selected ? i + 1 : null });
    });
    return out;
  }, [tl, toggles.showKind, toggles.events, selected, frames.length, header?.slots]);

  const witchStartled = useMemo(() => witchStartledAt(tl, playback.tMs), [tl, playback.tMs]);

  /** Written by the canvas on every paint, read by the pointer handlers
   *  below to hit-test the map. See ReplayCanvasProps.hitsRef. */
  const hitsRef = useRef<HitItem[]>([]);

  /** What the pointer is over right now, or null when nothing is hit or the
   *  pointer has left. Plain state: it drives only the tooltip, a sibling
   *  DOM node the canvas never reads, so a hover changing never touches
   *  ReplayCanvas's props and never triggers its repaint effect.
   *
   *  Holds only the hit item, not the pointer position: the tooltip's screen
   *  position is derived from the hit's own recorded `px,py` plus the
   *  current follow shift (see the stage div below), so two pointermoves
   *  that land on the SAME hit never need a new object here. `setHover`
   *  below only ever commits a value when `sameHit` says the identity
   *  actually changed, so moving the pointer around inside one medallion
   *  costs comparisons, not renders: without that guard every pixel of
   *  pointer travel re-rendered the whole Viewer subtree. */
  const [hover, setHover] = useState<HitItem | null>(null);

  if (tooNew) {
    return (
      <div class="replay replay--empty">
        This replay was recorded in a newer format than this page can read.
      </div>
    );
  }
  if (error && !header) return <div class="replay replay--empty">Couldn't load that replay.</div>;
  if (!header) {
    // A live round with no bytes yet says why, rather than "Loading" for ever.
    const waiting = live && behindSinceMs !== null
      ? liveStatusText(live, false, 0, 0, phase, Date.now(), names, behindSinceMs)
      : null;
    return <div class="replay replay--empty">{waiting ?? 'Loading replay...'}</div>;
  }

  const railOn = Boolean(timeline) && (toggles.events || toggles.chat);
  const theaterChip = { on: theater, toggle: toggleTheater };
  const rootClass = `replay${theater ? ' replay--theater' : ''}${theater && idle ? ' is-idle' : ''}`;

  const canvas = (
    <div
      key="stage"
      class={`replay__stage${camera.dragging ? ' is-dragging' : ''}`}
      ref={stageRef}
      style={theater ? undefined : stageStyle}
      onWheel={camera.onWheel}
      onPointerDown={camera.onPointerDown}
      onPointerMove={(e) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left; const y = e.clientY - rect.top;
        const hit = stageHit(hitsRef.current, x, y, shiftRef.current, camera.dragging);
        // Committing only on a real identity change is the whole point: see
        // the doc comment on `hover` above.
        setHover((prev) => (sameHit(prev, hit) ? prev : hit));
      }}
      onPointerLeave={() => setHover((prev) => (prev === null ? prev : null))}
      onClick={(e) => {
        // Computed fresh from the click's own coordinates rather than read
        // off `hover`: on touch, `pointerleave` fires after `pointerup` and
        // before `click`, clearing hover before the click ever sees it, so a
        // tap on a marker would never seek. `hover` still drives the tooltip
        // and nothing else.
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const hit = stageHit(hitsRef.current, e.clientX - rect.left, e.clientY - rect.top, shiftRef.current, camera.dragging);
        if (!hit || hit.kind !== 'marker') return;
        const entry = tl.find((t) => t.kind === 'event' && t.seq === hit.seq);
        // Owner feedback: landing exactly on the tag's own moment shows the
        // aftermath rather than the setup, e.g. a death already on the
        // ground instead of the pounce that put them there.
        if (entry) playback.seek(bookmarkSeekMs(entry.tMs));
      }}
    >
      <ReplayCanvas
        transform={transform}
        view={camera.view}
        size={size}
        backdrop={backdrop}
        trail={trail}
        frames={frames}
        timeRef={playback.tRef}
        show={show}
        follow={follow}
        shiftRef={shiftRef}
        names={names}
        slots={header.slots}
        portraits={portraits}
        version={header.version}
        witchStartled={witchStartled}
        markers={markers}
        timeline={toggles.events ? tl : NO_TIMELINE}
        hitsRef={hitsRef}
      />
      <div class="replay__vignette" aria-hidden="true" />
      <ReplayTooltip
        text={hover ? tooltipText(hover, {
          players: livePlayers, slots: header.slots, names, version: header.version, timeline: tl, witchStartled,
        }) : null}
        // `hover.px/py` were recorded before the follow camera's translate
        // (see ReplayCanvasProps.hitsRef); `shiftRef.current` is that same
        // translate, so adding it back is the inverse of the subtraction
        // `stageHit` does on the way in, and lands the tooltip on the hit's
        // actual on-screen position rather than wherever the pointer was.
        x={hover ? hover.px + shiftRef.current.x : 0}
        y={hover ? hover.py + shiftRef.current.y : 0}
        stageW={size.cssW}
        stageH={size.cssH}
      />
      {!theater && (
        <ReplayHud
          tMs={playback.tMs}
          endMs={endMs}
          counts={counts}
          live={live}
          closed={closed}
          phase={phase}
          names={names}
          behindSinceMs={behindSinceMs}
          toggles={toggles}
          toggle={toggle}
          theater={theaterChip}
        />
      )}
      {toggles.key && <KeyPanel onClose={() => setToggle('key', false)} />}
      {toggles.stats && timeline && (
        <StatsPanel
          timeline={tl}
          tMs={playback.tMs}
          players={livePlayers}
          slots={header.slots}
          names={names}
          onClose={() => setToggle('stats', false)}
        />
      )}
    </div>
  );

  const controls = (
    <ReplayControls
      playback={playback}
      endMs={endMs}
      live={live}
      follow={follow}
      setFollow={setFollow}
      slots={header.slots}
      names={names}
      timeline={timeline}
      zoom={camera.cam.zoom}
      setZoom={camera.setZoom}
    />
  );

  const rail = timeline && railOn && (
    <TimelineRail
      timeline={timeline}
      tMs={playback.tMs}
      toggles={toggles}
      seek={playback.seek}
      names={names}
      selected={selected}
    />
  );

  const filters = timeline && (
    <MarkerFilters
      timeline={tl}
      showKind={toggles.showKind}
      setShowKind={(k) => setToggle('showKind', k)}
      slots={header.slots}
      names={names}
      follow={follow}
      setFollow={setFollow}
    />
  );

  if (theater) {
    return (
      <div
        class={rootClass}
        ref={rootRef}
        style={{
          '--rail-w': `${railOn ? RAIL_W : 0}px`,
          '--edge-top': `${edgeTop(chromeH)}px`,
        } as Record<string, string>}
        onPointerMove={wake}
        onFocusIn={wake}
      >
        <div class="replay__frame">{canvas}</div>
        {/* Spec 7.1, Hidden chrome: the toolbar along the top fades when idle.
            Toggles join it because the in-stage HUD is not drawn here. */}
        <div class="theater__top" ref={chromeRef}>
          {controls}
          {filters}
          <div class="theater__toggles">
            <ToggleChips toggles={toggles} toggle={toggle} theater={theaterChip} />
          </div>
        </div>
        <HudStrip
          players={livePlayers}
          header={header}
          names={names}
          showHp={toggles.hp}
          showGuns={toggles.guns}
          layout="edges"
        />
        {rail && <div class="theater__rail">{rail}</div>}
        <TheaterStatus
          tMs={playback.tMs}
          endMs={endMs}
          counts={counts}
          zoom={camera.cam.zoom}
          live={live}
          closed={closed}
          phase={phase}
          names={names}
          behindSinceMs={behindSinceMs}
        />
      </div>
    );
  }

  const frame = (
    <div class="replay__frame">
      <div key="l" class="replay__sprocket replay__sprocket--l" aria-hidden="true" />
      {canvas}
      <div key="r" class="replay__sprocket replay__sprocket--r" aria-hidden="true" />
    </div>
  );

  const hud = (
    <HudStrip
      players={livePlayers}
      header={header}
      names={names}
      showHp={toggles.hp}
      showGuns={toggles.guns}
    />
  );

  if (portrait) {
    // A portrait map: the controls, events and panels go in a column beside
    // the stage, in the side space a portrait map leaves empty. On a window
    // too narrow for that the column dissolves (display: contents) and each
    // slot's `order` puts the pieces back in the stacked layout's order.
    return (
      <div class={`${rootClass} replay--portrait`} ref={rootRef}>
        <div class="replay__main" style={mainStyle}>
          {frame}
          <div class="replay__side">
            <div class="replay__slot replay__slot--controls">{controls}</div>
            {filters && <div class="replay__slot replay__slot--filters">{filters}</div>}
            {rail && <div class="replay__slot replay__slot--rail">{rail}</div>}
            <div class="replay__slot replay__slot--hud">{hud}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class={rootClass} ref={rootRef}>
      {filters}
      {frame}

      {rail}

      {controls}

      {hud}
    </div>
  );
}
