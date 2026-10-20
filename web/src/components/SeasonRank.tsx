import type { Placing, RankView } from '../api';

/** The emblem for "Gold II" (web/public/ranks, built by
 *  scripts/rank-emblems.py), or null for a name that is not a rank. `badge`
 *  is the tight, pip-less tier image for inline sizes, where the division is
 *  written beside it anyway. */
export function emblemUrl(name: string, badge = false): string | null {
  const m = name.match(/^(Bronze|Silver|Gold|Platinum|Diamond|Master) (III|II|I)$/);
  if (!m) return null;
  return badge ? `/ranks/${m[1].toLowerCase()}-badge.webp` : `/ranks/${m[1].toLowerCase()}-${m[2].toLowerCase()}.webp`;
}

/** A Bronze..Master badge: the emblem, then the name ("Gold II") in the
 *  tier's colour. `compact` drops to a single letter + numeral for a table
 *  cell on a phone. */
export function RankBadge({ rank, name, compact = false }: { rank?: RankView | null; name?: string | null; compact?: boolean }) {
  const label = rank?.name ?? name;
  if (!label) return null;
  const tier = (rank?.tier ?? label.split(' ')[0]).toLowerCase();
  const emblem = emblemUrl(label, true);
  return (
    <span class={`rankbadge rankbadge--${tier}`} title={label}>
      {emblem ? <img class="rankbadge__emblem" src={emblem} alt="" aria-hidden="true" /> : <span class="rankbadge__gem" aria-hidden="true" />}
      {compact ? label.replace(/^(\w)\w*/, '$1') : label}
    </span>
  );
}

/** The profile's season card: a large emblem beside the rank, SR and the
 *  way to the next division. */
export function RankCard({ rank, sr, top10 }: { rank: RankView; sr: number; top10?: boolean }) {
  const emblem = emblemUrl(rank.name);
  const span = rank.next === null ? 1 : rank.next - rank.floor;
  const pct = rank.next === null ? 100 : Math.max(0, Math.min(100, ((sr - rank.floor) / span) * 100));
  return (
    <div class={`rankcard rankbadge--${rank.tier.toLowerCase()}`}>
      {emblem && <img class="rankcard__emblem" src={emblem} alt="" aria-hidden="true" />}
      <div class="rankcard__body">
        <p class="rankcard__name">{rank.name}{top10 && <> <Top10Tag /></>}</p>
        <p class="rankcard__sr">{`${sr} SR`}</p>
        <div class="rankcard__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
             aria-label={rank.next === null ? 'Top division' : `Progress to the next division`}>
          <div class="rankcard__fill" style={{ width: `${pct}%` }} />
        </div>
        <p class="rankcard__next muted">
          {rank.next === null ? 'Top division' : `${Math.max(0, rank.next - sr)} SR to ${nextName(rank)}`}
        </p>
      </div>
    </div>
  );
}

const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master'];
const DIVS = ['III', 'II', 'I'];
function nextName(rank: RankView): string {
  const i = rank.index + 1;
  return `${TIERS[Math.floor(i / 3)]} ${DIVS[i % 3]}`;
}

/** "Placing 2/5": shown wherever an SR would be while it is still hidden. */
export function PlacingTag({ placing }: { placing: Placing }) {
  return <span class="placingtag" title={`SR and rank show after ${placing.of} games this season`}>{`Placing ${placing.played}/${placing.of}`}</span>;
}

export function Top10Tag() {
  return <span class="top10tag" title="Top 10 this season">Top 10</span>;
}

/** A season-end trophy: the highest rank someone held in a finished season,
 *  kept on their profile for good, with a Top 10 ribbon for a final place in
 *  the Top 10. A season without ranks (Season 0) only has the Top 10 one. */
export function Trophy({ season, peakRank, place }: { season: string; peakRank: string | null; place: number | null }) {
  const tier = peakRank ? peakRank.split(' ')[0].toLowerCase() : 'top10';
  const emblem = peakRank ? emblemUrl(peakRank) : null;
  return (
    <figure class={`trophy rankbadge--${tier}`} title={peakRank ? `${season}: peak ${peakRank}` : `${season}: Top 10`}>
      <div class="trophy__art">
        {emblem ? <img src={emblem} alt="" aria-hidden="true" /> : <span class="trophy__medal" aria-hidden="true">{`#${place}`}</span>}
        {emblem && place !== null && place <= 10 && <span class="trophy__ribbon">{`#${place}`}</span>}
      </div>
      <figcaption>
        <span class="trophy__season">{season}</span>
        <span class="trophy__what">{peakRank ? `Peak ${peakRank}` : 'Top 10'}</span>
      </figcaption>
    </figure>
  );
}
