import type { DB } from './db.js';
import { currentSeasonId, ensureRating } from './players.js';
import { settingNumber } from './settings.js';

/**
 * How much stronger than their two ratings a duo counts, in mu, for balancing
 * and for rating (spec section 5). Slides from duo_bonus_min_sr for the
 * lowest-rated pairs to duo_bonus_max_sr for the highest, by the share of
 * this season's rated players below the pair's average mu. Hidden mu, not
 * display SR: SR is hidden through placement and the soft reset keeps the
 * order, so mu ranks a pair properly from Season 1's first day.
 */
export function duoBonusMu(db: DB, a: string, b: string): number {
  const season = currentSeasonId(db);
  const avg = (ensureRating(db, a, season).mu + ensureRating(db, b, season).mu) / 2;
  const row = db.prepare(
    'SELECT COUNT(*) AS n, SUM(CASE WHEN mu < ? THEN 1 ELSE 0 END) AS below FROM player_ratings WHERE season_id = ?',
  ).get(avg, season) as { n: number; below: number | null };
  const pct = row.n > 0 ? (row.below ?? 0) / row.n : 0.5;
  const min = settingNumber(db, 'duo_bonus_min_sr', 50, { min: 0, max: 1000, integer: true });
  const max = Math.max(min, settingNumber(db, 'duo_bonus_max_sr', 200, { min: 0, max: 1000, integer: true }));
  return (min + (max - min) * pct) / 100;
}
