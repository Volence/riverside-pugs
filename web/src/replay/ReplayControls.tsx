import { useState } from 'preact/hooks';
import { slotColor, slotLabel } from './draw';
import { SPEEDS, type usePlayback } from './playback';
import { tickEntries } from './bookmarks';
import { bookmarkSeekMs, entryText, type TimelineEntry } from './timeline';
import { eventSentence } from './eventText';
import {
  FREE, TEAM, ZOOM_LEVELS, followSlotOf, type Follow,
} from './camera';

/** Round time as m:ss. The scrub bar is in milliseconds because that is what
 *  the frames carry; nobody wants to read that. Exported because the
 *  timeline rail needs the same formatting for its own timestamps. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** What a scrub tick says when hovered: the moment, then the same sentence
 *  the map tag tooltip uses for an event, or speaker and message for chat.
 *  The aria-label carries the phrase form; this is the readable one. */
export function tickText(e: TimelineEntry, nameOf: (id: string) => string): string {
  const what = e.kind === 'chat' ? `${nameOf(e.actor)}: ${e.text}` : eventSentence(e, nameOf);
  return `${formatTime(e.tMs)} · ${what}`;
}

/** Which way the tick tip grows so it stays inside the bar: centred on the
 *  tick, or from its left/right edge near the ends. */
export function tipAnchor(fraction: number): 'start' | 'mid' | 'end' {
  if (fraction < 0.12) return 'start';
  if (fraction > 0.88) return 'end';
  return 'mid';
}

export interface ReplayControlsProps {
  playback: ReturnType<typeof usePlayback>;
  endMs: number;
  live: boolean;
  follow: Follow;
  setFollow: (f: Follow) => void;
  zoom: number;
  setZoom: (z: number) => void;
  slots: string[];
  names: Record<string, string>;
  timeline?: TimelineEntry[];
}

/** The toolbar, scrub bar, speed and follow rows. Purely presentational:
 *  every value it reads is passed in, and every interaction it triggers is
 *  one of the callback props. */
export function ReplayControls(
  {
    playback, endMs, live, follow, setFollow, zoom, setZoom, slots, names, timeline,
  }: ReplayControlsProps,
) {
  const nameOf = (id: string) => names[id] ?? id;
  // The follow row is the bookmark selector (spec 7.2). An unrostered slot is
  // '' in the header and selects nothing rather than everything.
  const followSlot = followSlotOf(follow);
  const selected = followSlot === null ? null : (slots[followSlot] ?? '');
  const ticks = timeline ? tickEntries(timeline, selected) : [];
  const pct = (t: number) => `${Math.min(100, Math.max(0, (t / endMs) * 100))}%`;
  // The hovered or focused tick's seq. Plain state: it drives one tooltip
  // and nothing the canvas reads.
  const [hoverTick, setHoverTick] = useState<number | null>(null);
  const tipEntry = hoverTick === null ? null : ticks.find((t) => t.entry.seq === hoverTick)?.entry ?? null;

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
            aria-valuetext={formatTime(playback.tMs)}
            onInput={(e) => playback.seek(Number((e.target as HTMLInputElement).value))}
          />
          <div
            class="scrub__progress"
            aria-hidden="true"
            style={{ width: `${endMs > 0 ? Math.min(100, (playback.tMs / endMs) * 100) : 0}%` }}
          />
          {timeline && endMs > 0 && (
            <div class="scrub__ticks">
              {ticks.map(({ entry: e, role }) => (
                <button
                  key={e.seq}
                  type="button"
                  class={`scrub__tick scrub__tick--${role ?? e.kind}`}
                  style={{ left: pct(e.tMs) }}
                  aria-label={`${formatTime(e.tMs)} ${nameOf(e.actor)} ${entryText(e, nameOf)}`}
                  onClick={() => playback.seek(bookmarkSeekMs(e.tMs))}
                  onPointerEnter={() => setHoverTick(e.seq)}
                  onPointerLeave={() => setHoverTick((h) => (h === e.seq ? null : h))}
                  onFocus={() => setHoverTick(e.seq)}
                  onBlur={() => setHoverTick((h) => (h === e.seq ? null : h))}
                />
              ))}
            </div>
          )}
          {tipEntry && endMs > 0 && (
            <div
              class={`replay__tip scrub__tip scrub__tip--${tipAnchor(tipEntry.tMs / endMs)}`}
              role="tooltip"
              style={{ left: pct(tipEntry.tMs) }}
            >{tickText(tipEntry, nameOf)}</div>
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
        <span class="replay__sep" aria-hidden="true" />
        {/* Spec 7.1: fit, 2x, 4x, 6x. Wheel zoom lands between chips, and
            then none is lit, which is honest. */}
        {ZOOM_LEVELS.map((z) => (
          <button
            key={z}
            class={`chip ${Math.abs(zoom - z) < 0.01 ? 'is-on' : ''}`}
            onClick={() => setZoom(z)}
            aria-label={z === 1 ? 'Zoom to fit' : `Zoom ${z}x`}
          >{z === 1 ? 'Fit' : `${z}x`}</button>
        ))}
      </div>

      <div class="replay__toolbar">
        <button
          class={`chip ${follow.kind === 'free' ? 'is-on' : ''}`}
          onClick={() => setFollow(FREE)}
        >Free</button>
        {/* The survivor centroid (spec 7.1). Following the team rather than
            one player is what theater defaults to; here it is one chip. */}
        <button
          class={`chip ${follow.kind === 'team' ? 'is-on' : ''}`}
          onClick={() => setFollow(TEAM)}
        >Survivors</button>
        {/* One button per slot, in the slot's own colour. This is the only
            legend the map's eight colours have: without it nothing on the
            page ties a colour to a person, and a viewer has to guess which
            blue dot is which. The colour rides on the button's `color`, so
            `.chip--slot.is-on`'s `border-color: currentColor` picks it up
            and the swatch inherits it; the label itself is pinned back to
            --text, because the darkest slot only reaches 3.5:1 on this
            surface and that is a fine contrast for a dot or a rule and a
            poor one for text.

            Every slot gets a button, including one with no roster entry.
            The old `id === ''` skip meant the whole follow row was empty on
            the by-filename route, which is the same root cause as Finding
            12 and the same route it mattered on. */}
        {slots.map((id, i) => (
          <button
            key={i}
            class={`chip chip--slot ${followSlot === i ? 'is-on' : ''}`}
            style={{ color: slotColor(i) }}
            onClick={() => setFollow({ kind: 'slot', slot: i })}
          >
            <span class="replay__swatch" />
            <span class="replay__slot-name">{names[id] ?? slotLabel(i)}</span>
          </button>
        ))}
      </div>
    </>
  );
}
