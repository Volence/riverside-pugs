import { formatTime } from './ReplayControls';
import { liveStatusText } from './ReplayHud';
import type { LivePhase } from '../api';

/** "fit" at 1, otherwise one decimal with a trailing .0 dropped: 2x, 2.4x. */
export function zoomLabel(zoom: number): string {
  if (Math.abs(zoom - 1) < 0.01) return 'fit';
  return `${Number(zoom.toFixed(1))}x`;
}

/**
 * The line across the bottom of the theater (spec 7.1, Status line): time
 * of end, alive, common, specials, zoom. Replaces the top-left readout of
 * ReplayHud while in theater. Purely presentational.
 */
export function TheaterStatus(
  { tMs, endMs, counts, zoom, live, closed, phase = null, names = {}, behindSinceMs = null }: {
    tMs: number;
    endMs: number;
    counts: { survivors: number; commons: number; specials: number };
    zoom: number;
    live: boolean;
    closed: boolean;
    phase?: LivePhase | null;
    names?: Record<string, string>;
    behindSinceMs?: number | null;
  },
) {
  return (
    <div class="tstat">
      <span class="tstat__time num">{formatTime(tMs)}</span>
      <span class="tstat__item">of {formatTime(endMs)}</span>
      <span class="tstat__item tstat__item--win">{counts.survivors} alive</span>
      <span class="tstat__item">{counts.commons} common</span>
      <span class="tstat__item">{counts.specials} specials</span>
      <span class="tstat__item">{zoomLabel(zoom)}</span>
      {liveStatusText(live, closed, tMs, endMs, phase, Date.now(), names, behindSinceMs) && (
        <span class="tstat__item tstat__item--live">
          {liveStatusText(live, closed, tMs, endMs, phase, Date.now(), names, behindSinceMs)}
        </span>
      )}
    </div>
  );
}
