import type { DB } from './db.js';
import { CAMPAIGNS, campaignForMap, DLC4_CAMPAIGNS } from './campaigns.js';
import { chaptersOf, listCampaigns } from './customCampaigns.js';
import { isInstalledEverywhere } from './campaignInstall.js';
import { enabledServerIds, allServersHaveDlc4 } from './serverPool.js';
import { readStockMissions, type StockChapter } from './stockMissions.js';

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
  /** Lives in left4dead_dlc4, so a server without the mappack cannot load it.
   *  Gated separately from `custom`, which means "has its own VPK to install". */
  requiresDlc4: boolean;
}

/** The map a match changelevels into, per campaign.
 *
 *  For the base game these MUST be the `l4d_vs_` BSPs. The plain `l4d_` names
 *  are the coop maps, which load a coop mission and cannot be played versus.
 *
 *  The dlc4 ports are the exception and take their plain names: those campaigns
 *  ship ONE bsp per chapter serving both modes, and the mission file's versus
 *  block names the same maps its coop block does. There is no `c1m1_vs_hotel`
 *  to reach for. Verified against the real mission files 2026-09-20. */
const STOCK_FIRST: Record<string, string> = {
  no_mercy: 'l4d_vs_hospital01_apartment',
  death_toll: 'l4d_vs_smalltown01_caves',
  dead_air: 'l4d_vs_airport01_greenhouse',
  blood_harvest: 'l4d_vs_farm01_hilltop',
  dead_center: 'c1m1_hotel',
  dark_carnival: 'c2m1_highway',
  swamp_fever: 'c3m1_plankcountry',
  hard_rain: 'c4m1_milltown_a',
  the_parish: 'c5m1_waterfront',
  the_passing: 'c6m1_riverbank',
  cold_stream: 'c13m1_alpinecreek',
  the_last_stand: 'c14m1_junkyard',
};

let cache: {
  registry: Map<string, CampaignEntry>;
  byMap: Map<string, string>;
  // Kept alongside `registry` rather than folded into CampaignEntry.maps:
  // stopAfterMap and the orchestrator only ever need the bare map names in
  // play order, and reshaping that shared field to carry display names too
  // would ripple into every one of their readers. Chapter display is admin-UI
  // presentation only, so it gets its own lookup.
  stockChapters: Map<string, StockChapter[]>;
} | null = null;

export function invalidateCampaignCache(): void {
  cache = null;
}

let missionsDirs: string[] = [];

/** Where campaign chapter lists live: the base game's `missions/` and dlc4's.
 *  Set once at startup from config. Module state rather than a parameter
 *  because campaignRegistry(db) is called from a dozen places that have no
 *  business knowing about the game directory. */
export function setMissionsDirs(dirs: string[]): void {
  missionsDirs = dirs.filter(Boolean);
  cache = null;
}

function build(db: DB): NonNullable<typeof cache> {
  const registry = new Map<string, CampaignEntry>();
  const stockMissions = readStockMissions(missionsDirs);
  for (const [slug, c] of Object.entries(CAMPAIGNS)) {
    registry.set(slug, {
      slug, name: c.name, firstMap: STOCK_FIRST[slug],
      maps: (stockMissions.get(slug) ?? []).map((ch) => ch.map), custom: false,
      requiresDlc4: DLC4_CAMPAIGNS.has(slug),
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
      requiresDlc4: false,
    });
    // Every chapter claims its map, included or not: a match standing on an
    // excluded chapter is still that campaign for attribution purposes.
    for (const c of chapters) byMap.set(c.map.toLowerCase(), row.slug);
  }

  return { registry, byMap, stockChapters: stockMissions };
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

/** A stock campaign's chapters with their display names, for the admin panel.
 *  Empty for a custom campaign (its chapters come from chaptersOf instead) or
 *  when MISSIONS_DIR is unset, same as CampaignEntry.maps in that case. */
export function stockChaptersOf(db: DB, slug: string): StockChapter[] {
  return warm(db).stockChapters.get(slug) ?? [];
}

/**
 * Campaigns an admin may put in map_pool: the base four (no VPK, always
 * eligible), plus published custom campaigns that are `enabled` and
 * installed on every enabled server, plus the eight dlc4 campaigns once
 * every enabled server carries the mappack. That install check (custom) and
 * the dlc4 check (stock) are the whole gate: there used to be a second
 * `enabled` flag an admin had to tick first for custom campaigns, but once
 * downloads stopped depending on it its only remaining job was permitting
 * another switch, which cost a click and confused people without adding any
 * safety this does not already provide. Kept as its own lookup rather than
 * filtered on the client so a direct PUT to the setting (validateSetting)
 * enforces exactly the same rule the panel displays.
 *
 * `alsoAllow` keeps an admin from being locked out of their own settings
 * page and wins over BOTH gates below: a campaign already sitting in
 * map_pool that later loses its install (a server re-imaged, an admin
 * flipping it back to disabled) or loses dlc4 coverage (a server added
 * without the pack) should not make the pool unsavable or vanish from the
 * list out from under whatever else is being edited. It stays offered until
 * someone deliberately removes it from the pool.
 */
export function poolableCampaigns(
  db: DB, opts: { alsoAllow?: Iterable<string> } = {},
): CampaignEntry[] {
  const serverIds = enabledServerIds(db);
  const already = new Set(opts.alsoAllow ?? []);
  // Read once rather than per campaign: eight of the twelve stock campaigns
  // ask the same question and the answer cannot change inside one call.
  const dlc4Everywhere = allServersHaveDlc4(db);
  return [...campaignRegistry(db).values()].filter((c) => {
    if (already.has(c.slug)) return true;
    // A dlc4 campaign on a server without the mappack is a match that dies
    // on the first changelevel, so this gate is the same kind of thing as
    // the install check below and not a nicety.
    if (c.requiresDlc4 && !dlc4Everywhere) return false;
    return !c.custom || isInstalledEverywhere(db, c.slug, serverIds);
  });
}

/** A campaign's display name, falling back to the slug.
 *
 *  The one place this is answered for anything a person reads. Callers used to
 *  write `CAMPAIGNS[slug]?.name ?? slug` inline, which silently printed the raw
 *  slug for every custom campaign: a Discord message announcing a live match
 *  read "city17_v2_8" rather than "City 17 v2.8".
 */
export function campaignDisplayName(db: DB, slug: string): string {
  return campaignRegistry(db).get(slug)?.name ?? slug;
}
