import { rmSync } from 'node:fs';
import type { DB } from '../db.js';
import type { CommunityStore, FileKind } from './store.js';

/** How long a removed or deleted entry keeps its payload and files, as
 *  evidence for a report about it. */
export const KEEP_TOMBSTONE_MS = 30 * 86_400_000;

/** A file younger than this with no row may belong to a share that is still
 *  between its write and its insert, so the sweep leaves it for next time. */
export const ORPHAN_GRACE_MS = 3_600_000;

export interface SweepResult { purged: number; files: number }

/**
 * Purge tombstones older than 30 days, then delete every file no unpurged row
 * references.
 *
 * "Referenced" counts tombstones still inside their 30 days as well as live
 * entries. The spec only requires keeping a blob a live entry uses, but an
 * identical preview or a shared import may also be evidence for another
 * entry's open report, so the sweep keeps anything any unpurged row names.
 *
 * A purged row stays, with payload '' and purged_at set, so a ticket that
 * links to it still resolves.
 */
export function sweepCommunity(db: DB, store: CommunityStore, now: Date): SweepResult {
  const cutoff = new Date(now.getTime() - KEEP_TOMBSTONE_MS).toISOString();
  const purged = db.prepare(
    `UPDATE community_entries SET payload = '', purged_at = ?
      WHERE deleted_at IS NOT NULL AND deleted_at < ? AND purged_at IS NULL`,
  ).run(now.toISOString(), cutoff).changes;

  const inUse = (column: 'preview' | 'import_id'): Set<string> => new Set(
    (db.prepare(`SELECT DISTINCT ${column} AS v FROM community_entries WHERE purged_at IS NULL AND ${column} IS NOT NULL`)
      .all() as { v: string }[]).map((r) => r.v),
  );
  const refs: Record<FileKind, Set<string>> = { preview: inUse('preview'), import: inUse('import_id') };

  // Files of a just-purged row go at once whatever their age. Everything else
  // unreferenced (a crash between write and insert, a stray temp file) waits
  // out the grace period first.
  const justPurged: Record<FileKind, Set<string>> = { preview: new Set(), import: new Set() };
  if (purged > 0) {
    for (const r of db.prepare('SELECT preview, import_id FROM community_entries WHERE purged_at = ?')
      .all(now.toISOString()) as { preview: string | null; import_id: string | null }[]) {
      if (r.preview) justPurged.preview.add(r.preview);
      if (r.import_id) justPurged.import.add(r.import_id);
    }
  }

  const graceCutoff = now.getTime() - ORPHAN_GRACE_MS;
  let files = 0;
  for (const kind of ['preview', 'import'] as FileKind[]) {
    for (const f of store.list(kind)) {
      if (f.name && refs[kind].has(f.name)) continue;
      const old = f.mtimeMs < graceCutoff;
      if (!old && !(f.name && justPurged[kind].has(f.name))) continue;
      try {
        rmSync(f.file, { force: true });
        files++;
      } catch (err) {
        console.error('[community] sweep could not remove', f.file, err);
      }
    }
  }
  return { purged, files };
}
