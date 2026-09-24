import type { DB } from './db.js';
import { foldInto, resolvePatch } from './balanceFold.js';

/** A box written by a release reports its first match: confirm the box, and
 *  apply the release's balance decision to the new fingerprint, if any. */
export function linkReleaseSighting(db: DB, s: { serverId: number; patchId: number; previousPatchId: number | null }): void {
  const row = db.prepare(`SELECT rb.release_id, r.balance_decision, r.balance_name, r.balance_notes
    FROM release_boxes rb JOIN releases r ON r.id = rb.release_id
    WHERE rb.server_id = ? AND r.kind = 'deploy' AND rb.state IN ('written','restarted')
    ORDER BY rb.release_id DESC LIMIT 1`).get(s.serverId) as
    { release_id: number; balance_decision: string | null; balance_name: string | null; balance_notes: string | null } | undefined;
  if (!row) return;
  db.transaction(() => {
    db.prepare("UPDATE release_boxes SET state = 'confirmed' WHERE release_id = ? AND server_id = ?").run(row.release_id, s.serverId);
    if (s.previousPatchId === s.patchId) return;
    const p = db.prepare('SELECT triage, release_id FROM balance_patches WHERE id = ?').get(s.patchId) as { triage: string | null; release_id: number | null } | undefined;
    if (!p) return;
    if (p.release_id === null) db.prepare('UPDATE balance_patches SET release_id = ? WHERE id = ?').run(row.release_id, s.patchId);
    if (p.triage !== 'pending') return;
    if (row.balance_decision === 'balance') {
      db.prepare("UPDATE balance_patches SET triage = 'balance', name = ?, notes = ?, reviewed = 1 WHERE id = ?")
        .run(row.balance_name, row.balance_notes ?? '', s.patchId);
    } else if (row.balance_decision === 'not_balance' && s.previousPatchId !== null) {
      const target = resolvePatch(db, s.previousPatchId);
      if (target !== s.patchId) foldInto(db, s.patchId, target);
    }
  })();
}
