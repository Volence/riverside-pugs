import { useEffect, useState } from 'preact/hooks';
import { api, SEASON_THEMES, type CurrentSeasonLook, type SeasonThemeId, type SiteInfo } from './api';

/** The current season's look, from /api/site (src/seasonThemes.ts).
 *
 * The theme is an attribute on <html> that only swaps tokens (tokens.css), so
 * it is applied as early as possible: index.html's inline script sets it from
 * the value cached here on the last visit, before the first paint, and
 * syncSeasonTheme corrects it once /api/site answers. A season that changes
 * theme therefore shows the old look for one load at most.
 *
 * `?theme=wrong-way` previews a look before its season starts (kept for this
 * browser's later loads), `?theme=standard` shows the standard look during a
 * themed season, and `?theme=off` ends either preview. */
const CACHE = 'season-theme';
const PREVIEW = 'season-theme-preview';

const known = (v: string | null): v is SeasonThemeId => SEASON_THEMES.some((t) => t.id === v);

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, v: string | null) {
  try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, v); } catch { /* private mode */ }
}

type Preview = SeasonThemeId | 'standard';
const previewable = (v: string | null): v is Preview => v === 'standard' || known(v);

/** A preview asked for in the URL, else one kept from earlier, else none. */
export function previewTheme(search = location.search): Preview | null {
  const asked = new URLSearchParams(search).get('theme');
  if (asked === 'off') { write(PREVIEW, null); return null; }
  if (previewable(asked)) { write(PREVIEW, asked); return asked; }
  const kept = read(PREVIEW);
  return previewable(kept) ? kept : null;
}

export function applySeasonTheme(theme: SeasonThemeId | null) {
  const root = document.documentElement;
  if (theme) root.dataset.season = theme; else delete root.dataset.season;
}

/** Called with the season /api/site reported. */
export function syncSeasonTheme(season: CurrentSeasonLook | null) {
  const theme = season?.theme ?? null;
  write(CACHE, theme);
  const preview = previewTheme();
  applySeasonTheme(preview === 'standard' ? null : preview ?? theme);
}

let pending: Promise<SiteInfo | undefined> | null = null;
/** One /api/site request for the whole app, shared by everything that asks.
 *  undefined = the request failed. */
function loadSite(): Promise<SiteInfo | undefined> {
  pending ??= api.site().catch(() => { pending = null; return undefined; });
  return pending;
}

/** undefined = the request failed (keep whatever look is showing), null = no
 *  current season. */
export function loadSeasonLook(): Promise<CurrentSeasonLook | null | undefined> {
  return loadSite().then((s) => (s === undefined ? undefined : s.season ?? null));
}

export function useSeasonLook(): CurrentSeasonLook | null {
  const [season, setSeason] = useState<CurrentSeasonLook | null>(null);
  useEffect(() => { let live = true; void loadSeasonLook().then((s) => { if (live) setSeason(s ?? null); }); return () => { live = false; }; }, []);
  return season;
}

/** Whether the duo queue is on (Season 1 live, staff switch not off), from
 *  the same /api/site request. False until it answers and from an older
 *  server, so no duo surface shows by mistake. */
export function useDuoQueueOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => { let live = true; void loadSite().then((s) => { if (live) setOn(s?.duoQueue === true); }); return () => { live = false; }; }, []);
  return on;
}

/** Banner facts: which week of the season this is, and days left when an end
 *  date is set. Weeks count from the start day, the first week being 1. */
export function seasonProgress(season: Pick<CurrentSeasonLook, 'startedAt' | 'endsAt'>, now = new Date()) {
  const start = Date.parse(season.startedAt.includes('T') ? season.startedAt : `${season.startedAt.replace(' ', 'T')}Z`);
  const day = 86_400_000;
  const week = Math.max(1, Math.floor((now.getTime() - start) / (7 * day)) + 1);
  if (!season.endsAt) return { week, weeks: null, daysLeft: null };
  // The end date is the season's last day, so it ends at the close of it.
  const end = Date.parse(`${season.endsAt}T00:00:00Z`) + day;
  return {
    week,
    weeks: Math.max(week, Math.ceil((end - start) / (7 * day))),
    daysLeft: Math.max(0, Math.ceil((end - now.getTime()) / day)),
  };
}
