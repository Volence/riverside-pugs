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
