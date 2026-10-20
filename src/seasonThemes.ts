import type { DB } from './db.js';

/** Site looks a season can wear. Each id matches a `[data-season='<id>']`
 *  block in web/src/styles/tokens.css; anything else is refused, so a typo
 *  cannot leave the site half-themed. */
export const SEASON_THEMES = ['wrong-way'] as const;
export type SeasonTheme = typeof SEASON_THEMES[number];

export function isSeasonTheme(v: unknown): v is SeasonTheme {
  return typeof v === 'string' && (SEASON_THEMES as readonly string[]).includes(v);
}

/** What the site shell needs about the current season: its name for the
 *  banner, its theme, and how far through it is. */
export interface CurrentSeasonLook {
  id: number;
  name: string;
  theme: SeasonTheme | null;
  startedAt: string;
  endsAt: string | null;
  /** The season plays by the Season 1 rules. Also the switch for everything
   *  that launches with Season 1 (seasonOneLive). */
  ranks: boolean;
}

/**
 * Whether the features that launch with Season 1 are on: News and the
 * hand-written patch notes, !rq, the end-of-match SR line, the rank-up
 * moment. Owner ruling 2026-10-20: none of it is live before Season 1
 * actually starts, so the code can ship early and turns on at the flip. The
 * switch is the current season playing by the ranked rules, which is exactly
 * what starting Season 1 changes.
 */
export function seasonOneLive(db: DB): boolean {
  const row = db.prepare('SELECT ranks FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as { ranks: number } | undefined;
  return !!row?.ranks;
}

export function currentSeasonLook(db: DB): CurrentSeasonLook | null {
  const row = db.prepare(
    'SELECT id, name, theme, started_at, ends_at, ranks FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1',
  ).get() as { id: number; name: string; theme: string | null; started_at: string; ends_at: string | null; ranks: number } | undefined;
  if (!row) return null;
  return { id: row.id, name: row.name, theme: isSeasonTheme(row.theme) ? row.theme : null, startedAt: row.started_at, endsAt: row.ends_at, ranks: !!row.ranks };
}

/** A plain YYYY-MM-DD date, or null to clear it. */
export function parseEndsAt(v: unknown): string | null | undefined {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return undefined;
  return v;
}

export function setSeasonLook(db: DB, id: number, look: { theme: SeasonTheme | null; endsAt: string | null }): boolean {
  return db.prepare('UPDATE seasons SET theme = ?, ends_at = ? WHERE id = ?').run(look.theme, look.endsAt, id).changes > 0;
}
