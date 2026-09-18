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
