import type { DB } from './db.js';
import { placeholders, type Catalogue, type CatalogueValue } from './balanceCatalogue.js';
import { baseInventory, patchNumber } from './balanceControl.js';
import { resolvePatch } from './balanceFold.js';

/**
 * The Game values page: every catalogue value as the servers report it, its
 * vanilla value, when it last changed, and the rules that apply now. See
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
export interface GameValues { asOf: { patchId: number; number: number } | null; groups: GroupView[] }

const keyOf = (v: CatalogueValue) => (v.source === 'weapon' ? `w:${v.id}` : `c:${v.id}`);
const same = (a: string, b: string) => {
  const x = Number(a), y = Number(b);
  return a.trim() !== '' && b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y) ? x === y : a === b;
};

interface PatchRow { id: number; first_seen_at: string; inputs_json: string; name: string | null; published_at: string | null }

export function gameValues(db: DB, cat: Catalogue, opts: { admin: boolean }): GameValues {
  const base = baseInventory(db);
  const inv: Inventory = base?.inventory ?? {};
  // History: balance and folded patches with inputs, in time order. A folded
  // patch's change is credited to the patch it counts for.
  const patches = db.prepare(`SELECT id, first_seen_at, inputs_json, name, published_at FROM balance_patches
    WHERE inputs_json IS NOT NULL AND COALESCE(triage, 'balance') IN ('balance','folded')
    ORDER BY first_seen_at, id`).all() as PatchRow[];
  const parsed = patches.map((p) => { try { return { ...p, inv: JSON.parse(p.inputs_json) as Inventory }; } catch { return { ...p, inv: {} as Inventory }; } });
  const byId = new Map(patches.map((p) => [p.id, p]));
  const patchView = (id: number) => {
    const target = resolvePatch(db, id);
    const p = byId.get(target) ?? (db.prepare('SELECT id, first_seen_at, inputs_json, name, published_at FROM balance_patches WHERE id = ?').get(target) as PatchRow | undefined);
    if (!p) return null;
    const number = patchNumber(db, p.id);
    if (!opts.admin && p.published_at === null) return null;
    return { id: p.id, number, name: p.name?.trim() ? p.name : `Patch ${number}` };
  };

  const valueView = (v: CatalogueValue): ValueView => {
    const key = keyOf(v);
    let changed: { at: string; id: number } | null = null;
    let prev: string | undefined;
    for (const p of parsed) {
      const val = p.inv[key];
      if (val === undefined) continue;
      if (prev !== undefined && !same(prev, val)) changed = { at: p.first_seen_at, id: p.id };
      prev = val;
    }
    // Resolved once, for the last change only.
    const lastChange: ValueView['lastChange'] = changed ? { at: changed.at, patch: patchView(changed.id) } : null;
    let raw = inv[key];
    if (raw !== undefined && v.source === 'weapon' && raw === 'default') raw = v.vanilla ?? 'game default';
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

  return { asOf: base ? { patchId: base.patchId, number: patchNumber(db, base.patchId) } : null, groups };
}
