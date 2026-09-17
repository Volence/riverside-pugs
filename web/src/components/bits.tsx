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

/**
 * One horizontal comparison bar.
 *
 * Two channels carrying two different facts, which is what makes this more
 * readable than a column of numbers: the bar's LENGTH is volume (how much of
 * this thing happened, relative to the biggest row) and its COLOUR is quality
 * (whether that was good). A long red bar and a short green one are instantly
 * distinguishable in a way that "12" and "3" are not.
 *
 * `fraction` is expected in 0..1 and is clamped, so a caller that divides by a
 * stale maximum cannot produce a bar that overflows its track.
 */
export function BarRow(
  { name, value, detail, fraction, tone = 'neutral', href }: {
    name: string;
    value: string;
    detail?: string;
    fraction: number;
    tone?: 'good' | 'bad' | 'neutral';
    href?: string;
  },
) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100;
  return (
    <div class="bar">
      <div class="bar__head">
        <span class="bar__name">{href ? <a href={href}>{name}</a> : name}</span>
        <span class={`bar__value bar__value--${tone}`}>
          {value}
          {detail && <span class="bar__detail"> {detail}</span>}
        </span>
      </div>
      <div class="bar__track">
        <div class={`bar__fill bar__fill--${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** A labelled group of bars. */
export function Bars({ label, children }: { label?: string; children: ComponentChildren }) {
  return (
    <div class="bars">
      {label && <p class="bars__label">{label}</p>}
      {children}
    </div>
  );
}

/**
 * Simple tab strip. State lives in the caller so a tab choice can be lifted or
 * persisted later without rewriting every use site.
 */
export function Tabs(
  { tabs, active, onSelect }: {
    tabs: { key: string; label: string; count?: number }[];
    active: string;
    onSelect: (key: string) => void;
  },
) {
  return (
    <div class="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          type="button"
          role="tab"
          aria-selected={t.key === active}
          class={`tabs__tab${t.key === active ? ' is-active' : ''}`}
          key={t.key}
          onClick={() => onSelect(t.key)}
        >
          {t.label}
          {t.count !== undefined && <span class="tabs__count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** The page-shaped placeholder shown while a route's first fetch is in flight.
 *
 *  Four routes used to return an empty `<div class="page">` here. On a cold
 *  load of /match/:id that is a blank dark screen for about three seconds,
 *  which reads as a broken page rather than a loading one, and it is the link
 *  handed round in Discord after every match.
 *
 *  Deliberately not a spinner. The shapes match what is about to arrive (a
 *  header block, then panels), so the layout does not jump when it does, and a
 *  slow connection sees the structure of the page immediately.
 *
 *  `aria-busy` plus a polite live region, because to a screen reader the old
 *  empty div and the loaded page were indistinguishable. */
export function PageSkeleton(
  { variant = 'list', panels = 2 }: { variant?: 'list' | 'match' | 'profile'; panels?: number },
) {
  return (
    <div class={`page page--${variant}`} aria-busy="true">
      <p class="sr-only" role="status">Loading</p>
      <div class="skel skel--head">
        <div class="skel__bar skel__bar--eyebrow" />
        <div class="skel__bar skel__bar--title" />
        <div class="skel__figures">
          {[0, 1, 2, 3].map((i) => <div class="skel__bar skel__bar--figure" key={i} />)}
        </div>
      </div>
      <div class="stack">
        {Array.from({ length: panels }, (_, i) => (
          <div class="panel skel__panel" key={i}>
            <div class="skel__bar skel__bar--h3" />
            <div class="skel__bar skel__bar--row" />
            <div class="skel__bar skel__bar--row" />
            <div class="skel__bar skel__bar--row" />
          </div>
        ))}
      </div>
    </div>
  );
}
