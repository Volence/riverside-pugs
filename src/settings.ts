import type { DB } from './db.js';

export function getSetting(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/**
 * A numeric setting, or the fallback when the row cannot be read as one.
 *
 * THE reader for every numeric setting, and the emptiness check is not belt
 * and braces. These rows are meant to be hand-edited in sqlite, and Number('')
 * is 0, not NaN, so a blank value sails past an isFinite or an isInteger
 * guard: a blank noshow_minutes made `age_min >= 0` true for every live match
 * and the next 60 second tick aborted all of them, and a blank
 * clock_hold_max_minutes pushed `sm_pug_leave_hold_max 0` to a game server,
 * which clamps it to ten seconds and quietly releases every admin hold on
 * that match.
 *
 * Out of range is the fallback too, not a clamp: a value the caller says it
 * cannot use is as unusable as a blank one, and 0-by-accident must never come
 * out of here under any option.
 */
export function settingNumber(
  db: DB,
  key: string,
  fallback: number,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const value = getSetting(db, key);
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (opts.integer && !Number.isInteger(n)) return fallback;
  if (opts.min !== undefined && n < opts.min) return fallback;
  if (opts.max !== undefined && n > opts.max) return fallback;
  return n;
}

export function getJsonSetting<T>(db: DB, key: string): T {
  const raw = getSetting(db, key);
  if (raw === undefined) throw new Error(`missing setting: ${key}`);
  return JSON.parse(raw) as T;
}

/**
 * The campaign vote pool, as a list of slugs.
 *
 * Defensive on purpose. `map_pool` is seeded by DEFAULT_SETTINGS and is only
 * ever written through validateSetting, so a malformed value should be
 * impossible. But settingsSchema.ts's own header records that these used to be
 * hand-edited in sqlite, and that a blank noshow_minutes read as 0 and aborted
 * every live match. An empty pool is a recoverable state; a JSON.parse throwing
 * out of a route is not, and two callers here sit on paths that must not fail.
 */
export function getCampaignPool(db: DB): string[] {
  try {
    const parsed = JSON.parse(getSetting(db, 'map_pool') ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
