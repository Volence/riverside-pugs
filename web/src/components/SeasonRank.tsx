import type { Placing, RankView } from '../api';

/** A Bronze..Master badge. The tier sets the colour; the division rides
 *  along in the text ("Gold II"). `compact` drops to a single letter + numeral
 *  for a table cell on a phone. */
export function RankBadge({ rank, name, compact = false }: { rank?: RankView | null; name?: string | null; compact?: boolean }) {
  const label = rank?.name ?? name;
  if (!label) return null;
  const tier = (rank?.tier ?? label.split(' ')[0]).toLowerCase();
  return (
    <span class={`rankbadge rankbadge--${tier}`} title={label}>
      <span class="rankbadge__gem" aria-hidden="true" />
      {compact ? label.replace(/^(\w)\w*/, '$1') : label}
    </span>
  );
}

/** "Placing 2/5": shown wherever an SR would be while it is still hidden. */
export function PlacingTag({ placing }: { placing: Placing }) {
  return <span class="placingtag" title={`SR and rank show after ${placing.of} games this season`}>{`Placing ${placing.played}/${placing.of}`}</span>;
}

export function Top10Tag() {
  return <span class="top10tag" title="Top 10 this season">Top 10</span>;
}
