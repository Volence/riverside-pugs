import { useMemo, useState } from 'preact/hooks';
import { canvasForAspect } from '../../../src/mapTransform';
import { STATE } from '../../../src/replayFormat';
import { bracket, interpolateEntities, interpolatePlayers } from './interpolate';
import { usePlayback } from './playback';
import { useReplaySource, type ReplaySpec } from './source';
import { isSurvivor, sceneCounts, type ShowFlags } from './draw';
import { useToggles } from './useToggles';
import { mapAspect, useMapLayer } from './useMapLayer';
import { useCanvasSize } from './canvasSize';
import { ReplayCanvas } from './ReplayCanvas';
import { ReplayControls } from './ReplayControls';
import { HudStrip } from './HudStrip';
import { TimelineRail } from './TimelineRail';
import type { TimelineEntry } from './timeline';

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

/** The default roster lookup, as one shared object rather than a fresh `{}`
 *  per render. The canvas repaints when its props change, and a route that
 *  passes no names (the by-filename replay page) would otherwise hand it a
 *  new object every render and make a paused viewer repaint for nothing. */
const NO_NAMES: Record<string, string> = {};

export function Viewer(
  { spec, live = false, names = NO_NAMES, timeline }:
  { spec: ReplaySpec; live?: boolean; names?: Record<string, string>; timeline?: TimelineEntry[] },
) {
  const { header, frames, closed, tooNew, error } = useReplaySource(spec);
  const endMs = frames.length ? frames[frames.length - 1].tMs : 0;
  const playback = usePlayback(endMs, { live });
  const [toggles, toggle] = useToggles();
  const show: ShowFlags = { ci: toggles.ci, entities: toggles.entities, names: toggles.names };
  const [followSlot, setFollowSlot] = useState<number | null>(null);

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
   * its backing store follows the element's real width.
   *
   * The captures and the old fixed canvas were both 1.61 landscape, so
   * cropping a map's horizontal void only moved that void into the canvas as
   * black bars and left the height governing the fit: eighteen of the
   * twenty-two maps came out SMALLER than before the crop existed. The shape
   * has to follow the content box for the crop to buy anything at all.
   */
  const aspect = useMemo(() => mapAspect(header), [header?.map]);
  const { size, ref: stageRef } = useCanvasSize(aspect);
  const stageStyle = useMemo(() => ({
    // A single number, not a `w / h` pair, so the layout box and the backing
    // store are computed from the identical value and the browser has nothing
    // left to letterbox.
    aspectRatio: String(aspect),
    maxWidth: `min(${canvasForAspect(aspect).width}px, calc(${STAGE_MAX_VH}vh * ${aspect}))`,
  }), [aspect]);

  const { transform, view, backdrop } = useMapLayer(header, frames, livePlayers, size);

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

  if (tooNew) {
    return (
      <div class="replay replay--empty">
        This replay was recorded in a newer format than this page can read.
      </div>
    );
  }
  if (error && !header) return <div class="replay replay--empty">Couldn't load that replay.</div>;
  if (!header) return <div class="replay replay--empty">Loading replay...</div>;

  return (
    <div class="replay">
      <div class="replay__stage" ref={stageRef} style={stageStyle}>
        <ReplayCanvas
          transform={transform}
          view={view}
          size={size}
          backdrop={backdrop}
          trail={trail}
          frames={frames}
          timeRef={playback.tRef}
          show={show}
          followSlot={followSlot}
          names={names}
          slots={header.slots}
        />
      </div>

      {timeline && (toggles.events || toggles.chat) && (
        <TimelineRail
          timeline={timeline}
          tMs={playback.tMs}
          toggles={toggles}
          seek={playback.seek}
          names={names}
        />
      )}

      <ReplayControls
        playback={playback}
        toggles={toggles}
        toggle={toggle}
        endMs={endMs}
        live={live}
        followSlot={followSlot}
        setFollowSlot={setFollowSlot}
        slots={header.slots}
        names={names}
      />

      <HudStrip
        players={livePlayers}
        header={header}
        names={names}
        showHp={toggles.hp}
        showGuns={toggles.guns}
      />

      <div class="replay__status">
        <span>{header.map}</span>
        <span>{counts.survivors} alive</span>
        <span>{counts.commons} common</span>
        <span>{counts.specials} special</span>
        {!closed && <span class="replay__live">LIVE, 10s delayed</span>}
      </div>
    </div>
  );
}
