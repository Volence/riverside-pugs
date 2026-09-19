import type { DB } from './db.js';
import { campaignRegistry } from './campaignRegistry.js';
import { getMapsToPlay } from './campaignRules.js';

/**
 * The map a match on this campaign should stop after.
 *
 * Null means "we do not know", and the backend then sends the plugin nothing,
 * leaving it on NextMapIsFinale() exactly as before. That is the honest answer
 * for a campaign whose chapter list we cannot see, and it is what keeps this
 * change inert until a missions directory is configured.
 *
 * The default with no rule is the second from last map, which is what the
 * plugin already does on its own. Matching it here rather than special casing
 * means the backend and the plugin cannot disagree about an unconfigured
 * campaign.
 */
export function stopAfterMap(db: DB, slug: string): string | null {
  const maps = campaignRegistry(db).get(slug)?.maps ?? [];
  if (maps.length === 0) return null;

  const rule = getMapsToPlay(db, slug);
  // A rule of zero or less would mean a match with no maps. Treat it as
  // unconfigured rather than obeying it.
  const wanted = rule !== null && rule > 0 ? rule : Math.max(maps.length - 1, 1);
  return maps[Math.min(wanted, maps.length) - 1];
}
