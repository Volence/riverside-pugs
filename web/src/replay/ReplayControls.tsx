import { SPEEDS, type usePlayback } from './playback';
import type { Toggles } from './useToggles';

const TOGGLE_LABELS: Record<string, string> = {
  hp: 'HP', guns: 'Guns', events: 'Evts', chat: 'Chat', ci: 'CI', entities: 'Ents',
};

/** Round time as m:ss. The scrub bar is in milliseconds because that is what
 *  the frames carry; nobody wants to read that. */
function formatTime(ms: number): string {
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
        {(['hp', 'guns', 'events', 'chat', 'ci', 'entities'] as (keyof Toggles)[]).map((k) => (
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
        {slots.map((id, i) => (id === '' ? null : (
          <button
            key={i}
            class={`replay__btn ${followSlot === i ? 'is-on' : ''}`}
            onClick={() => setFollowSlot(i)}
          >{names[id] ?? `Slot ${i}`}</button>
        )))}
      </div>
    </>
  );
}
