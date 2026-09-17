import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.js';
import { getSetting } from './settings.js';

/** SourceTV's own per-map recordings of ordinary play: auto-<date>-<map>.dem.
 *  Nothing links to these; they are kept only as a short window for a "what
 *  happened there" look back. */
const AUTO_RE = /^auto-\d{8}-\d{4}-.+\.dem$/;
/** Match demos, named by the plugin. These are linked from match pages. */
const PUG_RE = /^pug_[0-9a-f]{32}_\d+_.+\.dem$/;

export interface DemoPruneResult { deleted: number; bytes: number }

function days(db: DB, key: string, fallback: number): number {
  const n = Number(getSetting(db, key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Delete demos past their retention.
 *
 * Two kinds, two ages: an auto-recording of casual play is disposable within
 * days, while a match demo is linked from its match page and kept as long as
 * replays are. Rows in match_demos for files that go are removed too, so the
 * match page stops offering a download that would 404.
 */
export function pruneDemos(db: DB, dir: string, now = Date.now()): DemoPruneResult {
  const out: DemoPruneResult = { deleted: 0, bytes: 0 };
  if (!dir) return out;
  const autoMs = days(db, 'demo_autorecord_days', 7) * 86_400_000;
  const pugMs = days(db, 'demo_retention_days', 90) * 86_400_000;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const isAuto = AUTO_RE.test(name);
    const isPug = PUG_RE.test(name);
    if (!isAuto && !isPug) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (now - st.mtimeMs < (isAuto ? autoMs : pugMs)) continue;
      unlinkSync(path);
      out.deleted += 1;
      out.bytes += st.size;
      if (isPug) db.prepare('DELETE FROM match_demos WHERE filename = ?').run(name);
    } catch (err) {
      console.error(`[demo] could not prune ${name}:`, err);
    }
  }
  if (out.deleted > 0) {
    console.log(`[demo] pruned ${out.deleted} demos, ${(out.bytes / 1e9).toFixed(2)} GB`);
  }
  return out;
}
