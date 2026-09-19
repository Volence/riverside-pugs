import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.js';
import { listCampaigns } from './customCampaigns.js';
import { consistencyCollisions } from './consistencyList.js';
import { listVpkPaths } from './vpk.js';

export interface VpkCheck {
  filename: string;
  /** The custom campaign this VPK belongs to, or null for a VPK that was put
   *  in the addons directory by hand (a map pack, a mission override). Those
   *  are mounted by the game server all the same, so they are checked too. */
  slug: string | null;
  state: 'draft' | 'published' | null;
  result: 'ok' | 'collides' | 'unreadable';
  collisions: string[];
}

/**
 * Check every VPK in the addons directory against the enforced file list, plus
 * every campaign row whose VPK is not there at all.
 *
 * The upload route refuses new collisions; this is for what was installed
 * before that check existed. Read-only.
 */
export function checkAddonsDir(db: DB, addonsDir: string, forced: string[]): VpkCheck[] {
  const campaigns = new Map(listCampaigns(db).map((c) => [c.vpk_filename.toLowerCase(), c]));
  const onDisk = readdirSync(addonsDir)
    // pak01_000.vpk style files are the data half of a split archive and have
    // no directory of their own; their _dir.vpk is what lists the paths.
    .filter((f) => f.toLowerCase().endsWith('.vpk') && !/_\d{3}\.vpk$/i.test(f))
    .sort();

  const out: VpkCheck[] = [];
  const seen = new Set<string>();
  for (const filename of onDisk) {
    seen.add(filename.toLowerCase());
    const c = campaigns.get(filename.toLowerCase());
    const base = { filename, slug: c?.slug ?? null, state: c?.state ?? null };
    let paths: string[];
    try {
      paths = listVpkPaths(join(addonsDir, filename));
    } catch {
      out.push({ ...base, result: 'unreadable', collisions: [] });
      continue;
    }
    if (paths.length === 0) {
      out.push({ ...base, result: 'unreadable', collisions: [] });
      continue;
    }
    const collisions = consistencyCollisions(paths, forced);
    out.push({ ...base, result: collisions.length > 0 ? 'collides' : 'ok', collisions });
  }
  for (const [key, c] of campaigns) {
    if (!seen.has(key)) out.push({ filename: c.vpk_filename, slug: c.slug, state: c.state, result: 'unreadable', collisions: [] });
  }
  return out;
}
