import { cvarAdapter } from './timeline/cvar.js';
import { conductAdapter } from './timeline/conduct.js';
import type { DB } from '../db.js';
import { aliasesOf, resolveAlias } from '../aliases.js';
import { inputAdapter } from './timeline/input.js';
import { lilacAdapter } from './timeline/lilac.js';
import { analyzerAdapter } from './timeline/analyzer.js';
import { dropsAdapter } from './timeline/drops.js';
import { steamAdapter } from './timeline/steam.js';
import { ticketsAdapter } from './timeline/tickets.js';
import { penaltiesAdapter } from './timeline/penalties.js';
import { bansAdapter } from './timeline/bans.js';
import { notesAdapter } from './timeline/notes.js';
import { discordLinksAdapter } from './timeline/discordLinks.js';
import type { TimelineAdapter, TimelineItem } from './timeline/types.js';

/** Every source, in no particular order: the result is sorted by time. A new
 *  source is one adapter file and one entry here. */
export const ADAPTERS: TimelineAdapter[] = [
  inputAdapter,
  lilacAdapter,
  cvarAdapter,
  conductAdapter,
  analyzerAdapter,
  dropsAdapter,
  steamAdapter,
  ticketsAdapter,
  penaltiesAdapter,
  bansAdapter,
  notesAdapter,
  discordLinksAdapter,
];

/** Items on one file. Well above what a page shows, and a bound all the same. */
export const TIMELINE_LIMIT = 500;

/**
 * One chronological list of everything about a player, newest first.
 *
 * The alias is resolved first, so a merged alt's history is the main's, and
 * every adapter is handed the canonical id together with every alias: the
 * evidence tables have no foreign key on players and keep rows under the id
 * that produced them.
 *
 * An adapter that throws yields nothing and is logged. The spec asks for
 * that explicitly: one broken source must not take the file with it.
 */
export function playerTimeline(
  db: DB, steamid: string, viewer: string, adapters: TimelineAdapter[] = ADAPTERS,
): TimelineItem[] {
  const canonical = resolveAlias(db, steamid);
  const ids = [canonical, ...aliasesOf(db, canonical).map((a) => a.steamid)];
  const ctx = { db, steamid: canonical, ids, viewer };
  const out: TimelineItem[] = [];
  for (const adapter of adapters) {
    try {
      out.push(...adapter.items(ctx));
    } catch (err) {
      console.error(`[timeline] the ${adapter.source} source failed for ${canonical}:`, err);
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, TIMELINE_LIMIT);
}
