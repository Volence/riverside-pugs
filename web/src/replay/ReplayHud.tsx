import { formatTime } from './ReplayControls';
import type { Toggles } from './useToggles';

const TOGGLE_LABELS: [keyof Toggles, string][] = [
  ['hp', 'HP'], ['names', 'Names'], ['guns', 'Guns'], ['events', 'Events'],
  ['chat', 'Chat'], ['ci', 'CI'], ['entities', 'Ents'],
];

/**
 * The overlay drawn over the stage: the clock and the alive counts top left,
 * the toggle chips top right, the live flag beneath the clock. What used to
 * be a status line under the canvas and a toggle row above the follow row.
 * Purely presentational, like ReplayControls.
 */
export function ReplayHud(
  { tMs, endMs, counts, live, closed, toggles, toggle }: {
    tMs: number;
    endMs: number;
    counts: { survivors: number; commons: number; specials: number };
    live: boolean;
    closed: boolean;
    toggles: Toggles;
    toggle: (k: keyof Toggles) => void;
  },
) {
  return (
    <div class="rhud">
      <div class="rhud__left">
        <span class="rhud__time num">{formatTime(tMs)}</span>
        <span class="rhud__of eyebrow">of {formatTime(endMs)}</span>
        <span class="rhud__counts eyebrow">
          {counts.survivors} alive · {counts.commons} common · {counts.specials} special
        </span>
        {live && !closed && <span class="rhud__live eyebrow">Live, 10s delayed</span>}
      </div>
      <div class="rhud__right">
        {TOGGLE_LABELS.map(([k, label]) => (
          <button key={k} type="button" class={`chip${toggles[k] ? ' is-on' : ''}`} onClick={() => toggle(k)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
