import type { DB } from './db.js';
import { adjustableKnobs, normalizeKnobValue, type BalanceKnobs } from './balanceKnobs.js';
import { diffInventories, fingerprintOf, formatDiff, withoutIgnored } from './balancePatches.js';

/**
 * The control panel's pure half: what the servers should run and what their
 * fingerprint will be. Nothing here writes. See
 * docs/superpowers/specs/2026-09-24-balance-control-panel-design.md.
 */

export type Inventory = Record<string, string>;

/** The inventory the prediction starts from: the patch on the most recent
 *  round of a queue match, as sighted (the config the servers actually ran,
 *  not the patch it was folded into, so the predicted fingerprint matches
 *  what they will report). Queue matches always run the pinned PUG config;
 *  balance_server_state may hold a 2v2 or auto-tracked casual inventory. */
export function baseInventory(db: DB): { patchId: number; inventory: Inventory } | null {
  const row = db.prepare(`
    SELECT p.id, p.inputs_json FROM match_rounds r
    JOIN matches m ON m.id = r.match_id
    JOIN balance_patches p ON p.id = COALESCE(r.sighted_patch_id, r.patch_id)
    WHERE m.origin = 'queue' AND p.inputs_json IS NOT NULL
    ORDER BY r.started_at DESC, r.match_id DESC, r.ordinal DESC, r.half DESC
    LIMIT 1`).get() as { id: number; inputs_json: string } | undefined;
  if (!row) return null;
  try {
    return { patchId: row.id, inventory: JSON.parse(row.inputs_json) as Inventory };
  } catch {
    return null;
  }
}

export function patchNumber(db: DB, patchId: number): number {
  const r = db.prepare(`SELECT number FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY first_seen_at, id) AS number FROM balance_patches
    ) WHERE id = ?`).get(patchId) as { number: number } | undefined;
  return r?.number ?? 0;
}

/** What the servers are meant to run now: the latest rollout's values over
 *  the baselines (a rollout always holds the full snapshot, the merge only
 *  covers a knob added to knobs.json since). */
export function currentValues(db: DB, knobs: BalanceKnobs): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(adjustableKnobs(knobs).map((k) => [k.cvar, k.baseline]));
  const row = db.prepare('SELECT values_json FROM balance_rollouts ORDER BY id DESC LIMIT 1').get() as { values_json: string } | undefined;
  if (row) {
    const v = JSON.parse(row.values_json) as Record<string, string>;
    for (const k of Object.keys(out)) if (typeof v[k] === 'string') out[k] = v[k];
  }
  return out;
}

export function predictInventory(base: Inventory, knobs: BalanceKnobs, values: Record<string, string>): Inventory {
  const inv = withoutIgnored(base, knobs.ignored ?? []);
  for (const k of adjustableKnobs(knobs)) inv[`c:${k.cvar}`] = values[k.cvar];
  return inv;
}

export function missingKnobs(base: Inventory, knobs: BalanceKnobs): string[] {
  return adjustableKnobs(knobs).filter((k) => !(`c:${k.cvar}` in base)).map((k) => k.cvar);
}

/** An inventory with ignored plugins and adjustable knob values dropped:
 *  what a rollout cannot change. */
function withoutKnobs(inv: Inventory, knobs: BalanceKnobs): Inventory {
  const out = withoutIgnored(inv, knobs.ignored ?? []);
  for (const k of adjustableKnobs(knobs)) delete out[`c:${k.cvar}`];
  return out;
}

/** formatDiff of a to b, leaving out a versionless plugin whose build alone
 *  changed (its presence still counts, as in the fingerprint). */
export function diffIgnoringVersionless(a: Inventory, b: Inventory, versionless: string[]): string {
  const skip = new Set(versionless.map((f) => `p:${f}`));
  const d = diffInventories(a, b);
  return formatDiff({ ...d, changed: d.changed.filter((c) => !skip.has(c.key)) });
}

/** Enabled servers whose last inventory differs from the base in something a
 *  rollout does not set. Compared by fingerprint, so a versionless plugin
 *  build or a pending knob value never blocks. A server never sighted does
 *  not block. */
export function blockingServers(db: DB, base: Inventory, knobs: BalanceKnobs): { serverId: number; name: string; diff: string }[] {
  const want = withoutKnobs(base, knobs);
  const wantFp = fingerprintOf(want, knobs.versionless);
  const rows = db.prepare(`SELECT st.server_id, s.name, st.inventory_json FROM balance_server_state st
    JOIN servers s ON s.id = st.server_id WHERE s.enabled = 1 ORDER BY s.id`).all() as
    { server_id: number; name: string; inventory_json: string }[];
  const out: { serverId: number; name: string; diff: string }[] = [];
  for (const r of rows) {
    const have = withoutKnobs(JSON.parse(r.inventory_json) as Inventory, knobs);
    if (fingerprintOf(have, knobs.versionless) === wantFp) continue;
    out.push({ serverId: r.server_id, name: r.name, diff: diffIgnoringVersionless(want, have, knobs.versionless) });
  }
  return out;
}

export function validateDraft(knobs: BalanceKnobs, raw: unknown, current: Record<string, string>): { values: Record<string, string>; errors: string[] } {
  const values = { ...current };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { values, errors: ['values must be an object'] };
  const adj = new Map(adjustableKnobs(knobs).map((k) => [k.cvar, k]));
  const errors: string[] = [];
  // A value the draft does not set is carried over from current; it goes to
  // the servers all the same, so it has to be inside the safe range too.
  for (const [cvar, k] of adj) {
    if (Object.hasOwn(raw, cvar)) continue;
    if (!normalizeKnobValue(k, current[cvar]).ok) {
      errors.push(`${k.label}: current value ${current[cvar]} is outside the safe range; set it in this draft`);
    }
  }
  for (const [cvar, v] of Object.entries(raw as Record<string, unknown>)) {
    const k = adj.get(cvar);
    if (!k) { errors.push(`${cvar} is not an adjustable knob`); continue; }
    const n = normalizeKnobValue(k, v);
    if (n.ok) values[cvar] = n.value;
    else errors.push(n.error);
  }
  for (const k of adj.values()) {
    if (!k.pairMax) continue;
    const other = adj.get(k.pairMax)!;
    if (Number(values[k.cvar]) > Number(values[other.cvar])) errors.push(`${k.label} must not be above ${other.label}`);
  }
  return { values, errors };
}

export function renderBalanceCfg(knobs: BalanceKnobs, values: Record<string, string>, patch: { number: number; name: string | null }): string {
  // The name is free text from the panel and lands in a file srcds execs:
  // keep it to plain punctuation so nothing in it can end the comment line.
  const name = (patch.name ?? '').replace(/[^A-Za-z0-9 _.,:()#+-]/g, ' ').replace(/ {2,}/g, ' ').trim() || 'unnamed';
  return [
    '// Generated by riversidepug.com (Admin > Balance > Knobs). Do not edit: the site rewrites this file.',
    `// Values here override the deploy repo. Patch #${patch.number} ${name}.`,
    ...adjustableKnobs(knobs).map((k) => `sm_cvar ${k.cvar} "${values[k.cvar]}"`),
    '',
  ].join('\n');
}

export interface KnobDiffRow { cvar: string; label: string; group: string; from: string; to: string }
export interface KnobPreview {
  values: Record<string, string>;
  errors: string[];
  diff: KnobDiffRow[];
  groupsChanged: string[];
  base: { patchId: number; number: number } | null;
  missing: string[];
  blocking: { serverId: number; name: string; diff: string }[];
  fingerprint: string | null;
  existingPatch: { id: number; number: number; name: string | null; notes: string; source: string; triage: 'pending' | 'balance' | 'folded' } | null;
  /** Things that do not block an apply but make its first sightings harder
   *  to read. */
  warnings: string[];
}

/** A release still on its way to the boxes changes their inventory in the
 *  same between-match gap as this apply. The rollout still confirms (by its
 *  knob values), but the first sightings carry both changes. */
export function applyWarnings(db: DB): string[] {
  const rows = db.prepare("SELECT id FROM releases WHERE state IN ('deploying', 'canary_wait') ORDER BY id").all() as { id: number }[];
  return rows.map((r) => `Release ${r.id} is still rolling out: the first matches after this apply will show both changes at once, so the patch they report may differ from the one predicted here.`);
}

export function previewKnobs(db: DB, knobs: BalanceKnobs, raw: unknown): KnobPreview {
  const current = currentValues(db, knobs);
  const { values, errors } = validateDraft(knobs, raw, current);
  const diff = adjustableKnobs(knobs).filter((k) => values[k.cvar] !== current[k.cvar])
    .map((k) => ({ cvar: k.cvar, label: k.label, group: k.group, from: current[k.cvar], to: values[k.cvar] }));
  const groupsChanged = [...new Set(diff.map((d) => d.group))];
  const base = baseInventory(db);
  const missing = base ? missingKnobs(base.inventory, knobs) : [];
  const blocking = base ? blockingServers(db, base.inventory, knobs) : [];
  let fingerprint: string | null = null;
  let existingPatch: KnobPreview['existingPatch'] = null;
  if (base && errors.length === 0 && missing.length === 0) {
    fingerprint = fingerprintOf(predictInventory(base.inventory, knobs, values), knobs.versionless);
    const p = db.prepare("SELECT id, name, notes, source, COALESCE(triage, 'balance') AS triage FROM balance_patches WHERE fingerprint = ?").get(fingerprint) as
      { id: number; name: string | null; notes: string; source: string; triage: 'pending' | 'balance' | 'folded' } | undefined;
    if (p) existingPatch = { ...p, number: patchNumber(db, p.id) };
  }
  return {
    values, errors, diff, groupsChanged, missing, blocking, fingerprint, existingPatch, warnings: applyWarnings(db),
    base: base ? { patchId: base.patchId, number: patchNumber(db, base.patchId) } : null,
  };
}

export function restoreValues(db: DB, knobs: BalanceKnobs, patchId: number):
  { ok: true; values: Record<string, string>; notes: string[] } | { ok: false; error: string } {
  const row = db.prepare('SELECT inputs_json FROM balance_patches WHERE id = ?').get(patchId) as { inputs_json: string | null } | undefined;
  if (!row) return { ok: false, error: 'No such patch.' };
  if (!row.inputs_json) return { ok: false, error: 'This patch has no recorded values (historical patches cannot be restored).' };
  const inv = JSON.parse(row.inputs_json) as Inventory;
  const values = currentValues(db, knobs);
  const notes: string[] = [];
  const adj = adjustableKnobs(knobs);
  const absent: string[] = [];
  for (const k of adj) {
    const v = inv[`c:${k.cvar}`];
    if (v === undefined) { absent.push(k.label); continue; }
    const n = normalizeKnobValue(k, v);
    if (!n.ok || n.value !== v) return { ok: false, error: `${k.label} was ${v} in that patch, which the panel cannot write (outside the safe range or not in its steps).` };
    values[k.cvar] = v;
  }
  if (absent.length) notes.push(`Not recorded in that patch, kept as now: ${absent.join(', ')}.`);
  const adjSet = new Set(adj.map((k) => `c:${k.cvar}`));
  const other = Object.keys(inv).filter((key) => key.startsWith('c:') && !adjSet.has(key)).length;
  if (other > 0) notes.push(`Knobs that are not adjustable (${other}) are left as they are.`);
  return { ok: true, values, notes };
}
