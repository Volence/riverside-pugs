import type { DB } from './db.js';

/**
 * How many maps a campaign plays, when an admin has said.
 *
 * Absent is the default and the default is what the site has always done:
 * every chapter except the last. So a fresh install, and every campaign nobody
 * has configured, behaves exactly as before.
 *
 * Stock and custom campaigns share one table. A stock finale is excluded for
 * the same reason a custom one is, and giving stock campaigns their own
 * mechanism is how the pool ended up with two switches nobody could tell apart.
 */

export function getMapsToPlay(db: DB, slug: string): number | null {
  const row = db
    .prepare('SELECT maps_to_play FROM campaign_play_rules WHERE slug = ?')
    .get(slug) as { maps_to_play: number } | undefined;
  return row?.maps_to_play ?? null;
}

export function setMapsToPlay(db: DB, slug: string, maps: number): void {
  db.prepare(
    `INSERT INTO campaign_play_rules (slug, maps_to_play) VALUES (?, ?)
     ON CONFLICT(slug) DO UPDATE SET maps_to_play = excluded.maps_to_play`,
  ).run(slug, maps);
}

export function clearMapsToPlay(db: DB, slug: string): void {
  db.prepare('DELETE FROM campaign_play_rules WHERE slug = ?').run(slug);
}

export function allMapsToPlay(db: DB): Map<string, number> {
  const rows = db
    .prepare('SELECT slug, maps_to_play FROM campaign_play_rules')
    .all() as { slug: string; maps_to_play: number }[];
  return new Map(rows.map((r) => [r.slug, r.maps_to_play]));
}
