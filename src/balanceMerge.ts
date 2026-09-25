import type { DB } from './db.js';
import { foldInto, resolvePatch } from './balanceFold.js';
import { activeRollout } from './balanceRollouts.js';

/**
 * Merge duplicate detected balance patches by folding them into one (the CLI
 * is scripts/merge-balance-patches.ts). A fold, never a delete: rounds keep
 * their sighted patch (match_rounds.sighted_patch_id references it, so a
 * DELETE fails), their effective patch becomes the kept one, and per-server
 * sightings and server states stay as they are, so the next sighting of an
 * unchanged box follows the fold without a "config changed" alert. Undo with
 * an unfold on the Patches tab.
 */

export type MergeResult =
  | { ok: true; applied: boolean; target: number; roundsMoved: number }
  | { ok: false; error: string };

const DRY = 'dry run, rolled back';

export function mergeBalancePatches(db: DB, keep: number, drop: number[], opts: { apply: boolean }): MergeResult {
  if (drop.length === 0) return { ok: false, error: 'nothing to drop' };
  if (drop.includes(keep)) return { ok: false, error: 'the kept patch cannot also be dropped' };
  const exists = db.prepare('SELECT 1 FROM balance_patches WHERE id = ?');
  for (const id of [keep, ...drop]) if (!exists.get(id)) return { ok: false, error: `patch ${id} does not exist` };
  const end = resolvePatch(db, keep);
  if (end !== keep) return { ok: false, error: `patch ${keep} is folded into patch ${end}; keep ${end} instead` };
  if (opts.apply) {
    // A live match can tag rounds mid-merge.
    const live = (db.prepare("SELECT COUNT(*) AS n FROM matches WHERE state IN ('live', 'configuring')").get() as { n: number }).n;
    if (live > 0) return { ok: false, error: `${live} match(es) live or configuring; run again when none are` };
  }
  const ro = activeRollout(db);
  if (ro && drop.includes(ro.patch_id)) return { ok: false, error: `patch ${ro.patch_id} is the knob panel's active rollout; it cannot be folded` };

  const effective = () => new Map((db.prepare('SELECT rowid AS id, patch_id FROM match_rounds').all() as { id: number; patch_id: number | null }[])
    .map((r) => [r.id, r.patch_id]));
  let result: MergeResult = { ok: false, error: 'not run' };
  try {
    db.transaction(() => {
      const before = effective();
      let target = keep;
      for (const id of drop) {
        if (resolvePatch(db, id) === target) continue; // already counts for it
        const f = foldInto(db, id, keep);
        if (!f.ok) throw new Error(`patch ${id}: ${f.error}`);
        target = f.target;
      }
      const after = effective();
      const roundsMoved = [...after].filter(([id, p]) => before.get(id) !== p).length;
      result = { ok: true, applied: opts.apply, target, roundsMoved };
      if (!opts.apply) throw new Error(DRY);
    })();
  } catch (err) {
    const msg = (err as Error).message;
    if (msg !== DRY) return { ok: false, error: msg };
  }
  return result;
}
