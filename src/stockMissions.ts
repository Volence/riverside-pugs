import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMission } from './vpk.js';
import { campaignForMap } from './campaigns.js';

/**
 * The stock campaigns' chapter lists, read off disk.
 *
 * The registry carries `maps: []` for the stock four because the orchestrator
 * only ever needed each one's first map. Choosing where a campaign stops needs
 * the whole list, and it is already sitting in `left4dead/missions/` as plain
 * text on every install.
 *
 * Read rather than hardcoded on purpose: a hardcoded list is a second source of
 * truth that drifts from whatever the server is actually running, and the
 * consequence of that drift is a match ending on the wrong map.
 *
 * Every failure here is silent and empty. A missing directory, an unreadable
 * file or a file that is not a mission must not stop the site booting; the
 * campaign simply has no known chapters and keeps today's behaviour.
 */

export interface StockChapter { map: string; display: string | null }

export function readStockMissions(dir: string): Map<string, StockChapter[]> {
  const out = new Map<string, StockChapter[]>();
  if (!dir) return out;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.txt'));
  } catch {
    return out;
  }
  for (const name of names) {
    let mission;
    try {
      mission = parseMission(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!mission || mission.chapters.length === 0) continue;
    // Keyed by the SITE's slug, not the mission's own Name. A mission calls
    // itself "airport" where this site says "dead_air", and campaignForMap
    // already knows that mapping from the campaign word embedded in every
    // stock map name. Deriving it from the first chapter avoids a second
    // lookup table that would have to be kept in step with the first.
    const slug = campaignForMap(mission.chapters[0].map);
    if (slug) out.set(slug, mission.chapters);
  }
  return out;
}
