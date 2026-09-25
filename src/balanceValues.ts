import type { DB } from './db.js';
import { placeholders, type Catalogue, type CatalogueValue } from './balanceCatalogue.js';
import { patchNumber } from './balanceControl.js';
import { resolvePatch } from './balanceFold.js';

/**
 * The Game values page: every catalogue value as the servers ran it in the
 * newest round on a settled (balance) config, its vanilla value, when it last
 * changed, and the rules that apply now. See
 * docs/superpowers/specs/2026-09-24-balance-catalogue-values-design.md.
 */

type Inventory = Record<string, string>;

export interface ValueView {
  id: string; label: string; unit: string | null; note: string | null;
  /** What the servers run, or null when not reported (or hidden, see status). */
  value: string | null;
  vanilla: string | null;
  differsFromVanilla: boolean;
  status: 'reported' | 'not_reported' | 'hidden';
  /** The most recent change; null when it has not changed since tracking began.
   *  `patch` is null when the patch is not public (public view). */
  lastChange: { at: string; patch: { id: number; number: number; name: string } | null } | null;
}
export interface RuleView {
  id: string; text: string; active: boolean; draft: boolean;
  /** Placeholders the servers do not report yet (shown as "?"). */
  missing: string[];
}
export interface GroupView { id: string; label: string; values: ValueView[]; rules: RuleView[] }
export interface GameValues {
  /** The settled patch the values come from (admin view only). */
  asOf?: { patchId: number; number: number } | null;
  /** The newest queue round ran a config still waiting for triage: the values
   *  shown are the last settled ones. */
  reviewing: boolean;
  groups: GroupView[];
}

const keyOf = (v: CatalogueValue) => (v.source === 'weapon' ? `w:${v.id}` : `c:${v.id}`);
const same = (a: string, b: string) => {
  const x = Number(a), y = Number(b);
  return a.trim() !== '' && b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y) ? x === y : a === b;
};

interface PatchRow { id: number; inputs_json: string | null; name: string | null; published_at: string | null; triage: string }
/** A run of consecutive queue rounds on one sighted patch that counts for a
 *  balance patch. */
interface Run { at: string; patchId: number; inv: Inventory }

/** The settled config history, from the queue rounds in time order: each
 *  round's sighted patch (its own reported values, so a value a folded patch
 *  started watching shows) counted for the balance patch it resolves to.
 *  Rounds on a pending patch are left out. Walking rounds rather than patches
 *  dates a return to an earlier config (A, B, A reuses A's row) at the return. */
function settledRuns(db: DB): { runs: Run[]; reviewing: boolean } {
  const rounds = db.prepare(`SELECT r.started_at AS at, COALESCE(r.sighted_patch_id, r.patch_id) AS sighted
    FROM match_rounds r JOIN matches m ON m.id = r.match_id
    WHERE m.origin = 'queue' AND r.started_at IS NOT NULL AND COALESCE(r.sighted_patch_id, r.patch_id) IS NOT NULL
    ORDER BY r.started_at, r.match_id, r.ordinal, r.half`).all() as { at: string; sighted: number }[];
  const getPatch = db.prepare("SELECT id, inputs_json, name, published_at, COALESCE(triage, 'balance') AS triage FROM balance_patches WHERE id = ?");
  const info = new Map<number, { settled: false; pending: boolean } | { settled: true; patchId: number; inv: Inventory }>();
  const infoOf = (sighted: number) => {
    let i = info.get(sighted);
    if (i) return i;
    const own = getPatch.get(sighted) as PatchRow | undefined;
    const target = resolvePatch(db, sighted);
    const eff = target === sighted ? own : (getPatch.get(target) as PatchRow | undefined);
    let inv: Inventory | null = null;
    try { inv = own?.inputs_json ? (JSON.parse(own.inputs_json) as Inventory) : null; } catch { inv = null; }
    i = eff?.triage === 'balance' && inv ? { settled: true, patchId: target, inv } : { settled: false, pending: eff?.triage === 'pending' };
    info.set(sighted, i);
    return i;
  };
  const runs: Run[] = [];
  let lastSighted: number | null = null;
  let reviewing = false;
  for (const r of rounds) {
    const i = infoOf(r.sighted);
    if (!i.settled) { reviewing = i.pending; continue; }
    reviewing = false;
    if (r.sighted !== lastSighted) runs.push({ at: r.at, patchId: i.patchId, inv: i.inv });
    lastSighted = r.sighted;
  }
  return { runs, reviewing };
}

export function gameValues(db: DB, cat: Catalogue, opts: { admin: boolean }): GameValues {
  const { runs, reviewing } = settledRuns(db);
  const current = runs.length ? runs[runs.length - 1] : null;
  const inv: Inventory = current?.inv ?? {};
  const patchView = (id: number) => {
    const p = db.prepare('SELECT id, name, published_at FROM balance_patches WHERE id = ?').get(id) as
      { id: number; name: string | null; published_at: string | null } | undefined;
    if (!p) return null;
    const number = patchNumber(db, p.id);
    if (!opts.admin && p.published_at === null) return null;
    return { id: p.id, number, name: p.name?.trim() ? p.name : `Patch ${number}` };
  };

  // A weapon key the weapons file leaves alone reports "default": the vanilla value.
  const readValue = (v: CatalogueValue, i: Inventory): string | undefined => {
    const raw = i[keyOf(v)];
    return raw !== undefined && v.source === 'weapon' && raw === 'default' ? v.vanilla ?? 'game default' : raw;
  };

  const valueView = (v: CatalogueValue): ValueView => {
    let changed: { at: string; id: number } | null = null;
    let prev: string | undefined;
    for (const r of runs) {
      const val = readValue(v, r.inv);
      if (val === undefined) continue;
      if (prev !== undefined && !same(prev, val)) changed = { at: r.at, id: r.patchId };
      prev = val;
    }
    // Resolved once, for the last change only.
    const lastChange: ValueView['lastChange'] = changed ? { at: changed.at, patch: patchView(changed.id) } : null;
    const raw = readValue(v, inv);
    const status: ValueView['status'] = v.hideLive ? 'hidden' : raw === undefined ? 'not_reported' : 'reported';
    const value = status === 'reported' ? raw! : null;
    return {
      id: v.id, label: v.label, unit: v.unit ?? null, note: v.note ?? null, value, vanilla: v.vanilla ?? null,
      differsFromVanilla: value !== null && v.vanilla !== undefined && !same(value, v.vanilla),
      status, lastChange,
    };
  };

  const ruleActive = (w: Catalogue['rules'][number]['when']) => {
    // Loaded from a subfolder (plugins/optional/...) it reports as "optional/<file>".
    if ('plugin' in w) return Object.keys(inv).some((k) => k === `p:${w.plugin}` || (k.startsWith('p:') && k.endsWith(`/${w.plugin}`)));
    const v = inv[`c:${w.cvar}`];
    if (v === undefined) return false;
    return 'equals' in w ? same(v, w.equals) : !same(v, w.notEquals);
  };
  const byValueId = new Map(cat.values.map((v) => [v.id, v]));
  /** Fill {id} placeholders from the reported values; the ids it could not fill. */
  const render = (text: string): { text: string; missing: string[] } => {
    const missing: string[] = [];
    const out = text.replace(/\{([^{}]+)\}/g, (_m, id: string) => {
      const v = byValueId.get(id);
      const raw = v ? inv[keyOf(v)] : undefined;
      if (raw === undefined || raw === 'default') { missing.push(id); return '?'; }
      return raw;
    });
    return { text: out, missing };
  };

  const groups = cat.groups.map((g): GroupView => ({
    id: g.id, label: g.label,
    values: cat.values.filter((v) => v.group === g.id).map(valueView),
    rules: cat.rules.filter((r) => r.group === g.id)
      .map((r) => { const t = render(r.text); return { id: r.id, text: t.text, active: ruleActive(r.when), draft: !r.reviewed, missing: t.missing }; })
      // Publicly, a rule shows only once every number in it is reported.
      .filter((r) => opts.admin || (r.active && !r.draft && r.missing.length === 0)),
  })).filter((g) => g.values.length > 0 || g.rules.length > 0);

  const asOf = current ? { patchId: current.patchId, number: patchNumber(db, current.patchId) } : null;
  return opts.admin ? { asOf, reviewing, groups } : { reviewing, groups };
}
