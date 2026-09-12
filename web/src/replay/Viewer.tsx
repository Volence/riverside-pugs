import { useMemo, useState } from 'preact/hooks';
import { STATE } from '../../../src/replayFormat';
import { bracket, interpolateEntities, interpolatePlayers } from './interpolate';
import { usePlayback } from './playback';
import { useReplaySource, type ReplaySpec } from './source';
import { isSurvivor, sceneCounts, type ShowFlags } from './draw';
import { useToggles } from './useToggles';
import { useMapLayer } from './useMapLayer';
import { ReplayCanvas } from './ReplayCanvas';
import { ReplayControls } from './ReplayControls';
import { HudStrip } from './HudStrip';
import { TimelineRail } from './TimelineRail';
import type { TimelineEntry } from './timeline';

export function Viewer(
  { spec, live = false, names = {}, timeline }:
  { spec: ReplaySpec; live?: boolean; names?: Record<string, string>; timeline?: TimelineEntry[] },
) {
  const { header, frames, closed, tooNew, error } = useReplaySource(spec);
  const endMs = frames.length ? frames[frames.length - 1].tMs : 0;
  const playback = usePlayback(endMs, { live });
  const [toggles, toggle] = useToggles();
  const show: ShowFlags = { ci: toggles.ci, entities: toggles.entities };
  const [followSlot, setFollowSlot] = useState<number | null>(null);

  /**
   * One interpolated frame per tick, shared by everything that reads it.
   *
   * The canvas, the status counts and the health panels must agree. Letting
   * each call `bracket` itself would drift them a frame apart, which shows up
   * as a health number sitting next to an avatar that has already moved.
   */
  const { livePlayers, liveEntities, counts } = useMemo(() => {
    const pair = bracket(frames, playback.tMs);
    if (!pair) {
      return { livePlayers: [], liveEntities: [], counts: { survivors: 0, commons: 0, specials: 0 } };
    }
    const players = interpolatePlayers(pair.a, pair.b, pair.f);
    const entities = interpolateEntities(pair.a, pair.b, pair.f);
    return { livePlayers: players, liveEntities: entities, counts: sceneCounts(players, entities) };
  }, [frames, playback.tMs]);

  const { transform, view, backdrop } = useMapLayer(header, frames, livePlayers);

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
      <ReplayCanvas
        transform={transform}
        view={view}
        backdrop={backdrop}
        trail={trail}
        livePlayers={livePlayers}
        liveEntities={liveEntities}
        show={show}
        followSlot={followSlot}
      />

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
