import type { Standing } from '../api';
import { STANDING_TOP } from '../format';
import type { ComponentChildren } from 'preact';

/**
 * The poster page header: an eyebrow, an Anton title, an optional right-hand
 * aside, then a row of figures, all above one red rule.
 *
 * Replaces the stat-card row (Tile/Tiles). The summary numbers a page used to
 * put in cards sit here as figures, so the header carries the page's
 * headline facts and the panels below carry the detail.
 */
export function PageHeader(
  { eyebrow, title, aside, children }: {
    eyebrow?: string;
    title: ComponentChildren;
    aside?: ComponentChildren;
    children?: ComponentChildren;
  },
) {
  return (
    <header class="page-head">
      <div class="page-head__row">
        <div>
          {eyebrow && <p class="page-head__eyebrow eyebrow">{eyebrow}</p>}
          <h2 class="page-head__title">{title}</h2>
        </div>
        {aside && <div class="page-head__aside">{aside}</div>}
      </div>
      {children}
    </header>
  );
}

export function Figures({ children }: { children: ComponentChildren }) {
  return <div class="figures">{children}</div>;
}

/** One eyebrowed number. `tone` colors the number by role: gold for a
 *  rating, teal or red for a result. Untoned figures are bright bone. */
export function Figure(
  { label, value, sub, tone, standing }: {
    label: string;
    value: string | number;
    sub?: string;
    tone?: 'rating' | 'win' | 'loss';
    /** Where this figure places this season. A top-five place is a badge
     *  beside the label; anything else becomes a percentile under the number,
     *  because a figure with nothing beside it tells a reader only what they
     *  scored and never whether that is any good. */
    standing?: Standing;
  },
) {
  const place = standing ? placeText(standing) : null;
  return (
    <div class="figure">
      <p class="figure__label eyebrow">
        {label}
        {standing && standing.rank <= STANDING_TOP && <RankBadge standing={standing} />}
      </p>
      <p class={`figure__value num${tone ? ` figure__value--${tone}` : ''}`}>{value}</p>
      {sub && <p class="figure__sub">{sub}</p>}
      {place && <p class="figure__place">{place}</p>}
    </div>
  );
}

/** Top five earns a badge and needs no second label. `of` 1 gets nothing: a
 *  percentile against a field of one is not a comparison, and "#1 of 1" beside
 *  it would be worse. */
function placeText(s: Standing): string | null {
  if (s.rank <= STANDING_TOP || s.of < 2) return null;
  return `${s.pct}th percentile, #${s.rank} of ${s.of}`;
}

/** "#2" in a small medal. #1 is gold, the rest of the top five a quieter
 *  bone, so the one that is actually first reads as first at a glance. */
export function RankBadge({ standing, what }: { standing: Standing; what?: string }) {
  const { rank, of } = standing;
  return (
    <span
      class={`rankbadge${rank === 1 ? ' rankbadge--first' : ''}`}
      title={`#${rank} of ${of} ranked players this season${what ? ` in ${what}` : ''}`}
    >
      #{rank}
    </span>
  );
}
