import { slotColor, slotLabel } from './draw';
import { SPEEDS, type usePlayback } from './playback';
import type { TimelineEntry } from './timeline';

/** Round time as m:ss. The scrub bar is in milliseconds because that is what
 *  the frames carry; nobody wants to read that. Exported because the
 *  timeline rail needs the same formatting for its own timestamps. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface ReplayControlsProps {
  playback: ReturnType<typeof usePlayback>;
  endMs: number;
  live: boolean;
  followSlot: number | null;
  setFollowSlot: (slot: number | null) => void;
  slots: string[];
  names: Record<string, string>;
  timeline?: TimelineEntry[];
}

/** The toolbar, scrub bar, speed and follow rows. Purely presentational:
 *  every value it reads is passed in, and every interaction it triggers is
 *  one of the callback props. */
export function ReplayControls(
  {
    playback, endMs, live, followSlot, setFollowSlot, slots, names, timeline,
  }: ReplayControlsProps,
) {
  return (
    <>
      <div class="replay__controls">
        <button class="chip" onClick={playback.toggle}>
          {playback.playing ? 'Pause' : 'Play'}
        </button>
        <div class="scrub">
          <input
            class="scrub__range"
            type="range"
            min={0}
            max={Math.max(endMs, 1)}
            value={playback.tMs}
            aria-label="Round position"
            onInput={(e) => playback.seek(Number((e.target as HTMLInputElement).value))}
          />
          {timeline && endMs > 0 && (
            <div class="scrub__ticks" aria-hidden="true">
              {timeline.map((e) => (
                <span
                  key={e.seq}
                  class={`scrub__tick scrub__tick--${e.kind}`}
                  style={{ left: `${Math.min(100, Math.max(0, (e.tMs / endMs) * 100))}%` }}
                />
              ))}
            </div>
          )}
        </div>
        <span class="replay__time">{formatTime(playback.tMs)} / {formatTime(endMs)}</span>
        {SPEEDS.map((s) => (
          <button
            key={s}
            class={`chip ${playback.speed === s ? 'is-on' : ''}`}
            onClick={() => playback.setSpeed(s)}
          >{s}x</button>
        ))}
        {live && (
          <button
            class={`chip ${playback.following ? 'is-on' : ''}`}
            onClick={playback.follow}
          >Live</button>
        )}
      </div>

      <div class="replay__toolbar">
        <button
          class={`chip ${followSlot === null ? 'is-on' : ''}`}
          onClick={() => setFollowSlot(null)}
        >Free</button>
        {/* One button per slot, in the slot's own colour. This is the only
            legend the map's eight colours have: without it nothing on the
            page ties a colour to a person, and a viewer has to guess which
            blue dot is which. The colour rides on the button's `color`, so
            `is-on`'s `outline: 1px solid currentColor` picks it up and the
            swatch inherits it; the label itself is pinned back to --text,
            because the darkest slot only reaches 3.5:1 on this surface and
            that is a fine contrast for a dot or a rule and a poor one for
            text.

            Every slot gets a button, including one with no roster entry.
            The old `id === ''` skip meant the whole follow row was empty on
            the by-filename route, which is the same root cause as Finding
            12 and the same route it mattered on. */}
        {slots.map((id, i) => (
          <button
            key={i}
            class={`chip chip--slot ${followSlot === i ? 'is-on' : ''}`}
            style={{ color: slotColor(i) }}
            onClick={() => setFollowSlot(i)}
          >
            <span class="replay__swatch" />
            <span class="replay__slot-name">{names[id] ?? slotLabel(i)}</span>
          </button>
        ))}
      </div>
    </>
  );
}
