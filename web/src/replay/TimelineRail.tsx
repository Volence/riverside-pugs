import { activeEntries, entryText, type TimelineEntry } from './timeline';
import { formatTime } from './ReplayControls';
import type { Toggles } from './useToggles';

export interface TimelineRailProps {
  timeline: TimelineEntry[];
  tMs: number;
  toggles: Toggles;
  seek: (t: number) => void;
  names: Record<string, string>;
}

/**
 * The scrubbable rail of events and chat beside the canvas.
 *
 * Purely presentational, same discipline as ReplayControls: everything it
 * shows and does is a prop or a callback. `activeEntries` is what keeps it
 * from ever showing something in the future, on both a saved and a live
 * replay.
 */
export function TimelineRail({ timeline, tMs, toggles, seek, names }: TimelineRailProps) {
  const nameOf = (id: string) => names[id] ?? id;
  return (
    <div class="replay__rail">
      {activeEntries(timeline, tMs)
        .filter((e) => (e.kind === 'chat' ? toggles.chat : toggles.events))
        .map((e) => (
          <button
            key={e.seq}
            class={`replay__entry replay__entry--${e.kind}`}
            onClick={() => seek(e.tMs)}
          >
            <span class="replay__entry-t">{formatTime(e.tMs)}</span>
            <span class="replay__entry-who">{nameOf(e.actor)}</span>
            <span class="replay__entry-text">{entryText(e, nameOf)}</span>
          </button>
        ))}
    </div>
  );
}
