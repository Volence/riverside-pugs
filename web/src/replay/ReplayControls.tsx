import { slotColor, slotLabel } from './draw';
import { SPEEDS, type usePlayback } from './playback';
import type { Toggles } from './useToggles';

const TOGGLE_LABELS: Record<string, string> = {
  hp: 'HP', names: 'Names', guns: 'Guns', events: 'Evts', chat: 'Chat', ci: 'CI', entities: 'Ents',
};

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
  toggles: Toggles;
  toggle: (k: keyof Toggles) => void;
  endMs: number;
  live: boolean;
  followSlot: number | null;
  setFollowSlot: (slot: number | null) => void;
  slots: string[];
  names: Record<string, string>;
}

/** The toolbar, scrub bar, speed, toggle and follow rows. Purely
 *  presentational: every value it reads is passed in, and every interaction
 *  it triggers is one of the callback props. */
export function ReplayControls(
  {
    playback, toggles, toggle, endMs, live, followSlot, setFollowSlot, slots, names,
  }: ReplayControlsProps,
) {
  return (
    <>
      <div class="replay__controls">
        <button class="replay__btn" onClick={playback.toggle}>
          {playback.playing ? 'Pause' : 'Play'}
        </button>
        <input
          class="replay__scrub"
          type="range"
          min={0}
          max={Math.max(endMs, 1)}
          value={playback.tMs}
          onInput={(e) => playback.seek(Number((e.target as HTMLInputElement).value))}
        />
        <span class="replay__time">{formatTime(playback.tMs)} / {formatTime(endMs)}</span>
        {SPEEDS.map((s) => (
          <button
            key={s}
            class={`replay__btn ${playback.speed === s ? 'is-on' : ''}`}
            onClick={() => playback.setSpeed(s)}
          >{s}x</button>
        ))}
        {live && (
          <button
            class={`replay__btn ${playback.following ? 'is-on' : ''}`}
            onClick={playback.follow}
          >Live</button>
        )}
      </div>

      <div class="replay__toolbar">
        {(['hp', 'names', 'guns', 'events', 'chat', 'ci', 'entities'] as (keyof Toggles)[]).map((k) => (
          <button
            key={k}
            class={`replay__btn ${toggles[k] ? 'is-on' : ''}`}
            onClick={() => toggle(k)}
          >{TOGGLE_LABELS[k]}</button>
        ))}
      </div>

      <div class="replay__toolbar">
        <button
          class={`replay__btn ${followSlot === null ? 'is-on' : ''}`}
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
            class={`replay__btn replay__btn--slot ${followSlot === i ? 'is-on' : ''}`}
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
