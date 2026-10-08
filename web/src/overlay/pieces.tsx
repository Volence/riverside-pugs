import type { StudioState } from '../../../src/cast/types';

/**
 * Pieces every overlay scene file shares (moved unchanged out of Scenes.tsx
 * for the draft scenes, drafts plan D2b2 Ruling 13).
 */

/** The full-frame backdrop: page black, grain, the campaign's tint and a
 *  survivor or infected still, darkened. */
export function Backdrop({ art = 'survivor-hilltop' }: { art?: string }) {
  return (
    <div class="ov-bg" aria-hidden="true">
      <div class="ov-bg__art" style={{ backgroundImage: `url(/hud-backdrops/${art}.jpg)` }} />
      <div class="ov-bg__tint" />
      <div class="ov-bg__grain" />
    </div>
  );
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function Countdown({ to, now, label }: { to: string | null; now: number; label: string }) {
  if (!to) return <p class="ov-count ov-count--idle">{label}</p>;
  const left = Date.parse(to) - now;
  return (
    <div class="ov-count">
      <span class="ov-count__label">{left > 0 ? label : 'Any moment now'}</span>
      {left > 0 && <span class="ov-count__clock">{fmtClock(left)}</span>}
    </div>
  );
}

export function Title({ studio, fallback }: { studio: StudioState; fallback: string }) {
  return (
    <header class="ov-title">
      <p class="ov-title__eyebrow">{studio.title || 'Riverside PUGs'}</p>
      <h1 class="ov-title__main">{fallback}</h1>
      {studio.subtitle && <p class="ov-title__sub">{studio.subtitle}</p>}
    </header>
  );
}
