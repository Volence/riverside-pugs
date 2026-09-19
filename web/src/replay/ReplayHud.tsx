import { formatTime } from './ReplayControls';
import type { BoolToggle, Toggles } from './useToggles';
import type { LivePhase } from '../api';

const TOGGLE_LABELS: [BoolToggle, string][] = [
  ['hp', 'HP'], ['names', 'Names'], ['guns', 'Guns'], ['events', 'Events'],
  ['chat', 'Chat'], ['ci', 'CI'], ['entities', 'Ents'], ['stats', 'Stats'], ['key', 'Key'],
];

export interface TheaterChip { on: boolean; toggle(): void }

/** The toggle chips, plus the Theater chip when the viewer offers one. In
 *  normal mode they sit top right inside the stage; in theater they move to
 *  the top bar, which is why they are their own component. */
export function ToggleChips(
  { toggles, toggle, theater }:
  { toggles: Toggles; toggle: (k: BoolToggle) => void; theater?: TheaterChip },
) {
  return (
    <>
      {TOGGLE_LABELS.map(([k, label]) => (
        <button key={k} type="button" class={`chip${toggles[k] ? ' is-on' : ''}`} onClick={() => toggle(k)}>
          {label}
        </button>
      ))}
      {theater && (
        <button type="button" class={`chip${theater.on ? ' is-on' : ''}`} onClick={theater.toggle}>
          Theater
        </button>
      )}
    </>
  );
}

/**
 * What the live flag under the clock should say, or null for a saved replay.
 *
 * A live source that has closed its current file is between rounds: the
 * server will name the next file once that round goes live and is ten
 * seconds old. Until then the page sits on the last frame, and without a
 * word about it that read as frozen (2026-09-19). While the clock is still
 * short of the end the last ten seconds are playing out, and that is said
 * too, so a viewer who sees action under a "round over" flag knows why.
 */
export function liveStatusText(
  live: boolean, closed: boolean, tMs: number, endMs: number,
  phase: LivePhase | null = null, nowMs: number = Date.now(),
): string | null {
  if (!live) return null;
  // The plugin's word wins when it names a state with nothing to draw. A
  // 'live' or 'roundover' phase, or no phase at all (an older plugin), falls
  // through to what the file itself says.
  if (phase?.state === 'paused') {
    if (phase.leave) return 'Paused, waiting for a player to reconnect';
    if (!phase.team) return 'Paused';
    const who = `Paused by Team ${phase.team.toUpperCase()}`;
    if (phase.limit <= 0) return who;
    const left = Math.max(0, phase.limit * 1000 - (nowMs - phase.sinceMs));
    return `${who}, ${formatTime(left)} left`;
  }
  if (phase?.state === 'readyup') return 'Readying up';
  if (phase?.state === 'loading') return 'Loading the next map';
  if (!closed) return 'Live, 10s delayed';
  return tMs < endMs ? 'Round over, catching up' : 'Round over, waiting for the next round';
}

/**
 * The overlay drawn over the stage: the clock and the alive counts top left,
 * the toggle chips top right, the live flag beneath the clock. What used to
 * be a status line under the canvas and a toggle row above the follow row.
 * Purely presentational, like ReplayControls.
 */
export function ReplayHud(
  { tMs, endMs, counts, live, closed, phase = null, toggles, toggle, theater }: {
    tMs: number;
    endMs: number;
    counts: { survivors: number; commons: number; specials: number };
    live: boolean;
    closed: boolean;
    phase?: LivePhase | null;
    toggles: Toggles;
    toggle: (k: BoolToggle) => void;
    theater?: TheaterChip;
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
        {liveStatusText(live, closed, tMs, endMs, phase) && (
          <span class="rhud__live eyebrow">{liveStatusText(live, closed, tMs, endMs, phase)}</span>
        )}
      </div>
      <div class="rhud__right">
        <ToggleChips toggles={toggles} toggle={toggle} theater={theater} />
      </div>
    </div>
  );
}
