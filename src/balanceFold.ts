import type { DB } from './db.js';

/**
 * Folding: a patch that is not a balance change counts as another patch.
 * Leaf module (imports nothing from the balance code) so the sighting, the
 * boot refingerprint, the triage decisions and the compare cache can all use
 * it without an import cycle. See
 * docs/superpowers/specs/2026-09-24-balance-catalogue-and-triage-design.md.
 */

let generation = 0;
/** Bumped on every retag, so the compare cache drops results computed before
 *  rounds moved between patches (a fold changes no count or timestamp the
 *  cache stamp otherwise reads). */
export function triageGeneration(): number { return generation; }

/** `id`, then each patch it is folded into, ending at the effective patch.
 *  Throws on a loop, which foldInto never creates. */
export function chainOf(db: DB, id: number): number[] {
  const step = db.prepare('SELECT triage, folded_into FROM balance_patches WHERE id = ?');
  const chain = [id];
  for (;;) {
    const r = step.get(chain[chain.length - 1]) as { triage: string | null; folded_into: number | null } | undefined;
    if (!r || r.triage !== 'folded' || r.folded_into === null) return chain;
    if (chain.includes(r.folded_into)) throw new Error(`balance patch fold loop: ${[...chain, r.folded_into].join(' -> ')}`);
    chain.push(r.folded_into);
  }
}

export function resolvePatch(db: DB, id: number): number {
  const c = chainOf(db, id);
  return c[c.length - 1];
}

/** Every round (and its metric context row) gets the patch its sighted patch
 *  resolves to. Returns how many rounds moved. */
export function retagRounds(db: DB): number {
  return db.transaction(() => {
    const ids = db.prepare('SELECT DISTINCT sighted_patch_id AS id FROM match_rounds WHERE sighted_patch_id IS NOT NULL').all() as { id: number }[];
    const setRounds = db.prepare('UPDATE match_rounds SET patch_id = ? WHERE sighted_patch_id = ? AND patch_id IS NOT ?');
    const setCtx = db.prepare(`UPDATE round_metric_context SET patch_id = ?
      WHERE patch_id IS NOT ? AND EXISTS (SELECT 1 FROM match_rounds r WHERE r.match_id = round_metric_context.match_id
        AND r.ordinal = round_metric_context.ordinal AND r.half = round_metric_context.half AND r.sighted_patch_id = ?)`);
    let moved = 0;
    for (const { id } of ids) {
      const eff = resolvePatch(db, id);
      moved += setRounds.run(eff, id, eff).changes;
      setCtx.run(eff, eff, id);
    }
    generation++;
    return moved;
  })();
}

/** Fold `id` into the end of `into`'s chain, unpublish it and retag. No
 *  checks on source or state: the triage decisions and the refingerprint
 *  make those. */
export function foldInto(db: DB, id: number, into: number): { ok: true; target: number } | { ok: false; error: string } {
  if (id === into) return { ok: false, error: 'a patch cannot be folded into itself' };
  const chain = chainOf(db, into);
  if (chain.includes(id)) return { ok: false, error: 'that fold would make a loop: the target is already folded into this patch' };
  const target = chain[chain.length - 1];
  db.transaction(() => {
    db.prepare("UPDATE balance_patches SET triage = 'folded', folded_into = ?, published_at = NULL WHERE id = ?").run(target, id);
    retagRounds(db);
  })();
  return { ok: true, target };
}

export function unfoldPatch(db: DB, id: number): void {
  db.transaction(() => {
    db.prepare("UPDATE balance_patches SET triage = 'pending', folded_into = NULL WHERE id = ?").run(id);
    retagRounds(db);
  })();
}
