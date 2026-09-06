import type { ComponentChildren } from 'preact';
import type { MatchResult } from '../api';
import { deltaClass, fmtDelta, RESULT_LABEL, sparklinePoints } from '../format';

export function PlayerLink({ steamid, name }: { steamid: string; name: string }) {
  return <a href={`/player/${encodeURIComponent(steamid)}`}>{name}</a>;
}

export function SrDelta({ value }: { value: number }) {
  return <span class={deltaClass(value)}>{fmtDelta(value)}</span>;
}

/** The W/L/D glyph. `title` carries the long form for screen readers, since the
 *  letter alone is terse and the color carries no information on its own. */
export function ResultChip({ result }: { result: MatchResult }) {
  return (
    <span class={`result result--${result}`} title={result}>
      {RESULT_LABEL[result]}
    </span>
  );
}

export function Panel({ children, class: cls = '' }: { children: ComponentChildren; class?: string }) {
  return <section class={`panel ${cls}`}>{children}</section>;
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>;
}

/** SR over time. Rendered from a pure point-math helper so the geometry is
 *  unit-tested without a DOM (see format.test.ts). */
export function Sparkline({ values }: { values: number[] }) {
  const w = 800;
  const h = 120;
  const points = sparklinePoints(values, w, h);
  if (!points) return <Empty>Not enough matches for a graph yet.</Empty>;
  return (
    <svg class="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img"
         aria-label="Rating over time">
      <polyline points={points} />
    </svg>
  );
}
