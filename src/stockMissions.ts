import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { missionsFromLargeVpk, parseMission, type Mission } from './vpk.js';
import { campaignForMap, CRASH_CENTER_FIRST_MAP } from './campaigns.js';

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
 *
 * The `dirs` parameter is a list of directories walked in order. Slugs cannot
 * collide across them, so the reader folds them rather than making the caller
 * merge two maps and decide precedence.
 *
 * A directory can also be an addons folder holding the L4D2 pack as addon VPKs
 * (`zz_l4d2maps_c01_deadcenter.vpk` and so on, since 2026-09-26): each campaign
 * VPK carries its mission file, read without loading the whole VPK. Only those
 * names are opened, so custom campaigns in the same folder are left to their own
 * registry.
 */

const PACK_VPK = /^zz_l4d2maps_c\d+_[a-z0-9]+\.vpk$/i;

export interface StockChapter { map: string; display: string | null }

export function readStockMissions(dirs: string[]): Map<string, StockChapter[]> {
  const out = new Map<string, StockChapter[]>();
  for (const dir of dirs) {
    if (!dir) continue;
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.txt') || PACK_VPK.test(n));
    } catch {
      // A directory that is not there is how a feature is turned off, not an
      // error, and one bad path must not cost us the campaigns in the others.
      continue;
    }
    for (const name of names) {
      let missions: Mission[];
      try {
        if (PACK_VPK.test(name)) {
          missions = missionsFromLargeVpk(join(dir, name));
        } else {
          const one = parseMission(readFileSync(join(dir, name), 'utf8'));
          missions = one ? [one] : [];
        }
      } catch {
        continue;
      }
      for (const mission of missions) {
        if (mission.chapters.length === 0) continue;
        const slug = slugOf(mission);
        if (slug) out.set(slug, mission.chapters);
      }
    }
  }
  return out;
}

/**
 * The site's slug for a mission. Keyed by the SITE's slug, not the mission's
 * own Name: a mission calls itself "airport" where this site says "dead_air",
 * and campaignForMap already knows that mapping from the campaign word embedded
 * in every stock map name. Deriving it from the first chapter avoids a second
 * lookup table that would have to be kept in step with the first.
 *
 * One exception. Crash Center (Hotel, Streets, Mall, Alleys, Atrium) lives in
 * Crash Course's own garage.txt, because L4D1 resolves a map to the first
 * mission that lists it and garage.txt loads before the pack's deadcenter.txt
 * (deploy/deadcenter/missions/). Its first chapter is Dead Center's, so the
 * first-chapter rule would file it under dead_center and overwrite Dead
 * Center's own list. It is told apart by its Name. The base game's stock
 * garage.txt (Alleys, Lots) carries the same Name and is not a site campaign,
 * so it is only Crash Center when it starts where Crash Center starts.
 */
function slugOf(mission: Mission): string | null {
  const first = mission.chapters[0].map;
  if (mission.name.toLowerCase() === 'garage') {
    return first.toLowerCase() === CRASH_CENTER_FIRST_MAP ? 'crash_center' : null;
  }
  return campaignForMap(first);
}
