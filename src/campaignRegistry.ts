import type { DB } from './db.js';
import { CAMPAIGNS, campaignForMap } from './campaigns.js';
import { chaptersOf, listCampaigns } from './customCampaigns.js';
import { isInstalledEverywhere } from './campaignInstall.js';
import { enabledServerIds } from './serverPool.js';

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

/**
 * Campaigns an admin may put in map_pool: the stock four (no VPK, always
 * eligible), plus published custom campaigns that are `enabled` and
 * installed on every enabled server. "In the pool" is meant to gate both the
 * public download and the vote; this is the vote half, kept as its own
 * lookup rather than filtered on the client so a direct PUT to the setting
 * (validateSetting) enforces exactly the same rule the panel displays.
 *
 * `alsoAllow` keeps an admin from being locked out of their own settings
 * page: a campaign already sitting in map_pool that later loses its install
 * (a server re-imaged, an admin flipping it back to disabled) should not
 * make the pool unsavable or vanish from the list out from under whatever
 * else is being edited. It stays offered until someone deliberately removes
 * it from the pool.
 */
export function poolableCampaigns(
  db: DB, opts: { alsoAllow?: Iterable<string> } = {},
): CampaignEntry[] {
  const serverIds = enabledServerIds(db);
  const enabledCustomSlugs = new Set(
    listCampaigns(db, { state: 'published', enabledOnly: true }).map((c) => c.slug),
  );
  const already = new Set(opts.alsoAllow ?? []);
  return [...campaignRegistry(db).values()].filter((c) => (
    !c.custom
    || already.has(c.slug)
    || (enabledCustomSlugs.has(c.slug) && isInstalledEverywhere(db, c.slug, serverIds))
  ));
}
