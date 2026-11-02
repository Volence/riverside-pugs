import { useState } from 'preact/hooks';
import type { TimelineItem, TimelineSource } from '../../../api';
import { Empty } from '../../../components/bits';
import { fmtTime } from '../useAction';
import { SOURCE_LABEL, SourceBadge } from './GlanceRow';

/** The replay viewer at the moment a row is about. The same query shape the
 *  integrity board and the ticket page already use, which MatchDetail reads
 *  to pick the round and seek once its frames arrive. */
const replayHref = (item: TimelineItem): string | null =>
  item.matchId === null || item.replay === null
    ? null
    : `/match/${item.matchId}?ordinal=${item.replay.ordinal}&half=${item.replay.half}&t=${item.replay.tMs}`;

/**
 * One chronological list of everything, rather than a box per source.
 *
 * A person reading a file wants the order things happened in: a flag the
 * week after a ticket about the same thing reads differently from a flag on
 * its own. The chips narrow it without reordering it, and every badge has
 * the same weight, because the list is context and not an accusation.
 */
/** Rows shown before "Show all": enough for a month of an active player,
 *  short enough that the sections under it are still a scroll away. */
const FIRST = 15;

export function Timeline({ items }: { items: TimelineItem[] }) {
  const [only, setOnly] = useState<TimelineSource | null>(null);
  const [all, setAll] = useState(false);
  const counts = new Map<TimelineSource, number>();
  for (const item of items) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  const matching = only === null ? items : items.filter((i) => i.source === only);
  const shown = all ? matching : matching.slice(0, FIRST);

  if (items.length === 0) return <Empty>Nothing has been recorded about this player.</Empty>;

  return (
    <>
      <div class="timeline__chips" role="group" aria-label="Show only">
        {/* .chip's active state is is-on (see MatchDetail's half/round chips),
            not is-active, which belongs to a different set of components. */}
        <button type="button" class={`chip${only === null ? ' is-on' : ''}`} onClick={() => { setOnly(null); setAll(false); }}>
          Everything <span class="timeline__n">{items.length}</span>
        </button>
        {[...counts].map(([source, count]) => (
          <button key={source} type="button" class={`chip${only === source ? ' is-on' : ''}`}
            onClick={() => { setOnly(source); setAll(false); }}>
            {SOURCE_LABEL[source]} <span class="timeline__n">{count}</span>
          </button>
        ))}
      </div>
      <ul class="timeline">
        {shown.map((item, i) => (
          <li key={`${item.source}-${item.ref?.id ?? i}-${item.at}`} class="timeline__row">
            <span class="timeline__when">{fmtTime(item.at)}</span>
            <span class="timeline__src"><SourceBadge source={item.source} /></span>
            <span class="timeline__text">{item.summary}</span>
            <span class="timeline__links">
              {replayHref(item) !== null && <a href={replayHref(item)!}>replay moment</a>}
              {item.matchId !== null && <a href={`/match/${item.matchId}`}>#{item.matchId}</a>}
            </span>
          </li>
        ))}
      </ul>
      {matching.length > shown.length && (
        <div class="file-foot">
          <button type="button" class="chip" onClick={() => setAll(true)}>Show all {matching.length}</button>
        </div>
      )}
    </>
  );
}
