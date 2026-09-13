import { groupTicks, tickEntries } from './bookmarks';
import {
  activeEntries, bookmarkSeekMs, entryText, type TimelineEntry,
} from './timeline';
import { markerEntries } from './markers';
import { formatTime } from './ReplayControls';
import { enrichEvents, enrichmentText, fromTimeline, type Enrichment } from '../eventEnrich';
import type { Toggles } from './useToggles';

export interface TimelineRailProps {
  timeline: TimelineEntry[];
  tMs: number;
  toggles: Toggles;
  seek: (t: number) => void;
  names: Record<string, string>;
  /** SteamID64 of the followed player, or null. Selecting one turns the rail
   *  from a rolling window into that player's whole round (spec 7.2). */
  selected: string | null;
}

function Entry(
  { e, tMs, seek, nameOf, n, en }:
  { e: TimelineEntry; tMs: number; seek: (t: number) => void; nameOf: (id: string) => string; n?: number; en?: Enrichment },
) {
  const extra = e.kind === 'event' ? enrichmentText(e.event, en, nameOf, e.target ? nameOf(e.target) : null) : '';
  return (
    <button
      class={`replay__entry replay__entry--${e.kind}${e.tMs > tMs ? ' replay__entry--ahead' : ''}`}
      onClick={() => seek(bookmarkSeekMs(e.tMs))}
    >
      {n !== undefined && <span class="replay__entry-n">{n}</span>}
      <span class="replay__entry-t">{formatTime(e.tMs)}</span>
      <span class="replay__entry-who">{nameOf(e.actor)}</span>
      <span class="replay__entry-text">{entryText(e, nameOf)}{extra ? <span class="muted"> {extra}</span> : null}</span>
    </button>
  );
}

/**
 * The rail of events and chat under the stage.
 *
 * Purely presentational, same discipline as ReplayControls: everything it
 * shows and does is a prop or a callback. Unselected, `activeEntries` keeps
 * it to the last twenty seconds. Selected, it is a bookmark list for one
 * player: every event they were part of, grouped by what happened and which
 * side of it they were on, with entries ahead of the playhead dimmed rather
 * than hidden so the whole round is jumpable.
 */
export function TimelineRail({ timeline, tMs, toggles, seek, names, selected }: TimelineRailProps) {
  const nameOf = (id: string) => names[id] ?? id;
  const visible = (e: TimelineEntry) => (e.kind === 'chat' ? toggles.chat : toggles.events);
  const enriched = enrichEvents(fromTimeline(timeline));

  if (selected !== null) {
    const ticks = tickEntries(timeline, selected).filter((t) => visible(t.entry));
    const groups = groupTicks(ticks);
    const chat = ticks.filter((t) => t.entry.kind === 'chat');
    // The rail's bookmark numbers, matching the map tags' numbering: the
    // selected player's marker-kind events, in round order, at "Show all"
    // regardless of what the Show select is actually narrowed to (spec 7.2's
    // task 10: a narrowed Show renumbers the tags only). Chat and non-marker
    // kinds (ff, revive) get no entry here and so render with no number.
    const numbered = new Map(markerEntries(timeline, 'all', selected).map((e, i) => [e.seq, i + 1]));
    if (groups.length === 0 && chat.length === 0) {
      return (
        <div class="replay__rail replay__rail--player">
          <span class="replay__rail-empty">Nothing recorded for {nameOf(selected)} this round.</span>
        </div>
      );
    }
    return (
      <div class="replay__rail replay__rail--player">
        {groups.map((g) => (
          <section key={g.key} class="rail-group">
            <div class={`rail-group__head rail-group__head--${g.role}`}>
              {g.label} <span class="num">×{g.items.length}</span>
            </div>
            {g.items.map((i) => (
              <Entry key={i.entry.seq} e={i.entry} tMs={tMs} seek={seek} nameOf={nameOf} n={numbered.get(i.entry.seq)} en={enriched.get(i.entry.seq)} />
            ))}
          </section>
        ))}
        {chat.length > 0 && (
          <section class="rail-group">
            <div class="rail-group__head">Chat <span class="num">×{chat.length}</span></div>
            {chat.map((t) => <Entry key={t.entry.seq} e={t.entry} tMs={tMs} seek={seek} nameOf={nameOf} />)}
          </section>
        )}
      </div>
    );
  }

  return (
    <div class="replay__rail">
      {activeEntries(timeline, tMs).filter(visible).map((e) => (
        <Entry key={e.seq} e={e} tMs={tMs} seek={seek} nameOf={nameOf} en={enriched.get(e.seq)} />
      ))}
    </div>
  );
}
