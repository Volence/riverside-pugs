import type { DB } from './db.js';
import { CAMPAIGNS, campaignForMap } from './campaigns.js';
import { chaptersOf, listCampaigns } from './customCampaigns.js';

/**
 * Every campaign the site can run: the stock four, plus published custom ones.
 *
 * `src/campaigns.ts` stays a pure const with no database dependency, because
 * the Discord command module reads it at import time and a test asserts its
 * exact keys. Everything that needs to know about custom campaigns comes here
 * instead.
 *
 * Cached, because resolveCampaignForMap is called once per round by the log
 * listener and the answer only changes when an admin publishes, edits or
 * deletes a campaign. Every one of those paths calls invalidateCampaignCache.
 */

export interface CampaignEntry {
  slug: string;
  name: string;
  /** The map a match changelevels into. */
  firstMap: string;
  /** Every map in the campaign, in play order. */
  maps: string[];
  custom: boolean;
}

/** These MUST be the l4d_vs_ BSPs. The plain l4d_ names are the coop maps,
 *  which load a coop mission and cannot be played versus. */
const STOCK_FIRST: Record<string, string> = {
  no_mercy: 'l4d_vs_hospital01_apartment',
  death_toll: 'l4d_vs_smalltown01_caves',
  dead_air: 'l4d_vs_airport01_greenhouse',
  blood_harvest: 'l4d_vs_farm01_hilltop',
};

let cache: { registry: Map<string, CampaignEntry>; byMap: Map<string, string> } | null = null;

export function invalidateCampaignCache(): void {
  cache = null;
}

function build(db: DB): NonNullable<typeof cache> {
  const registry = new Map<string, CampaignEntry>();
  for (const [slug, c] of Object.entries(CAMPAIGNS)) {
    registry.set(slug, {
      slug, name: c.name, firstMap: STOCK_FIRST[slug], maps: [], custom: false,
    });
  }

  const byMap = new Map<string, string>();
  for (const row of listCampaigns(db, { state: 'published' })) {
    const chapters = chaptersOf(db, row.slug);
    // Only included chapters are playable. Plan 2 lets an admin change which
    // those are; until then every chapter is included, so this is the whole
    // list and the ordering is the file's own.
    const played = chapters
      .filter((c) => c.included === 1)
      .sort((a, b) => (a.play_order ?? a.ordinal) - (b.play_order ?? b.ordinal));
    if (played.length === 0) continue;

    registry.set(row.slug, {
      slug: row.slug, name: row.name, firstMap: played[0].map,
      maps: played.map((c) => c.map), custom: true,
    });
    // Every chapter claims its map, included or not: a match standing on an
    // excluded chapter is still that campaign for attribution purposes.
    for (const c of chapters) byMap.set(c.map.toLowerCase(), row.slug);
  }

  return { registry, byMap };
}

function warm(db: DB): NonNullable<typeof cache> {
  if (!cache) cache = build(db);
  return cache;
}

export function campaignRegistry(db: DB): Map<string, CampaignEntry> {
  return warm(db).registry;
}

/** The campaign a map belongs to: stock by name prefix, custom by lookup.
 *  Null rather than a default for anything unrecognised. */
export function resolveCampaignForMap(db: DB, map: string): string | null {
  const stock = campaignForMap(map);
  if (stock) return stock;
  return warm(db).byMap.get(map.toLowerCase()) ?? null;
}

/** First playable map of a campaign, which is what a match changelevels into. */
export function firstMapOf(db: DB, campaign: string): string {
  const entry = campaignRegistry(db).get(campaign);
  return entry?.firstMap ?? STOCK_FIRST.no_mercy;
}
