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
  { label, value, sub, tone }: {
    label: string;
    value: string | number;
    sub?: string;
    tone?: 'rating' | 'win' | 'loss';
  },
) {
  return (
    <div class="figure">
      <p class="figure__label eyebrow">{label}</p>
      <p class={`figure__value num${tone ? ` figure__value--${tone}` : ''}`}>{value}</p>
      {sub && <p class="figure__sub">{sub}</p>}
    </div>
  );
}
