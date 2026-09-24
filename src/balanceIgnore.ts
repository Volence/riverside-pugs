import type { DB } from './db.js';

/**
 * The effective ignored plugin list: knobs.json `ignored` plus the plugins an
 * admin marked "ignore from now on" in patch triage. Every reader of the
 * ignored list goes through here, so the site list takes effect with no
 * deploy. See docs/superpowers/specs/2026-09-24-balance-catalogue-and-triage-design.md.
 */

export const PLUGIN_FILE_RE = /^[A-Za-z0-9_.-]{1,64}\.smx$/;

export function siteIgnored(db: DB): string[] {
  return (db.prepare('SELECT file FROM balance_ignored_plugins ORDER BY file').all() as { file: string }[]).map((r) => r.file);
}

export function effectiveIgnored(db: DB, knobsIgnored: string[] = []): string[] {
  return [...new Set([...knobsIgnored, ...siteIgnored(db)])].sort();
}

export function withEffectiveIgnored<T extends { ignored?: string[] }>(db: DB, knobs: T): T {
  return { ...knobs, ignored: effectiveIgnored(db, knobs.ignored) };
}

export interface IgnoredPlugin { file: string; reason: string; addedBy: string | null; addedAt: string | null; source: 'site' | 'knobs' }

/** Site entries first-class; a knobs.json entry also on the site list shows
 *  once, as the site entry (removing it there still leaves knobs.json). */
export function listIgnored(db: DB, knobsIgnored: string[] = []): IgnoredPlugin[] {
  const site = (db.prepare('SELECT file, reason, added_by, added_at FROM balance_ignored_plugins').all() as
    { file: string; reason: string; added_by: string; added_at: string }[])
    .map((r): IgnoredPlugin => ({ file: r.file, reason: r.reason, addedBy: r.added_by, addedAt: r.added_at, source: 'site' }));
  const have = new Set(site.map((s) => s.file));
  const fromKnobs = knobsIgnored.filter((f) => !have.has(f))
    .map((file): IgnoredPlugin => ({ file, reason: '', addedBy: null, addedAt: null, source: 'knobs' }));
  return [...site, ...fromKnobs].sort((a, b) => a.file.localeCompare(b.file));
}

export function addIgnored(db: DB, files: string[], p: { reason: string; by: string; now: string }): string[] {
  const ins = db.prepare('INSERT OR IGNORE INTO balance_ignored_plugins (file, reason, added_by, added_at) VALUES (?, ?, ?, ?)');
  return files.filter((f) => ins.run(f, p.reason, p.by, p.now).changes > 0);
}

export function removeIgnored(db: DB, file: string): boolean {
  return db.prepare('DELETE FROM balance_ignored_plugins WHERE file = ?').run(file).changes > 0;
}
