import type { DB } from './db.js';
import { diffInventories, onPluginList, pluginFile, refingerprintPatches, watchedOneSided, withoutIgnored } from './balancePatches.js';
import { chainOf, foldInto, resolvePatch, unfoldPatch } from './balanceFold.js';
import { addIgnored, effectiveIgnored, PLUGIN_FILE_RE } from './balanceIgnore.js';
import { activeRollout } from './balanceRollouts.js';
import { patchNumber } from './balanceControl.js';

/**
 * Patch triage: is a new config a balance patch? See
 * docs/superpowers/specs/2026-09-24-balance-catalogue-and-triage-design.md.
 * Callers (the admin routes) audit every decision.
 */

type Inventory = Record<string, string>;
export type Lists = {
  versionless: string[]; ignored: string[];
  /** Words for weapon keys, `w:<weapon>.<key>` -> label (see weaponLabels). */
  labels?: Record<string, string>;
};
export type TriageResult = { ok: true; target?: number } | { ok: false; status: 400 | 404 | 409; error: string };

const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const base = (path: string) => path.split('/').pop() ?? path;

/** a to b in plain words, one line per difference. A versionless plugin whose
 *  build alone changed is not a difference (the fingerprint ignores it too).
 *  Neither is a watched value present on one side only: the watch list grew
 *  or shrank, not the game (the rule watchListOnly uses), so those are one
 *  summary line each way and never stop a plugin-only change from reading as
 *  one. `labels` words weapon keys (`w:...`) by their catalogue label. */
export function describeChanges(a: Inventory, b: Inventory, versionless: string[], labels: Record<string, string> = {}): { lines: string[]; plugins: string[]; onlyPlugins: boolean } {
  const skip = onPluginList(versionless);
  const d = diffInventories(a, b);
  const watched = watchedOneSided(a, b);
  const lines: string[] = [];
  const plugins: string[] = [];
  let other = 0;
  const word = (key: string, what: 'added' | 'removed' | 'changed', from?: string, to?: string) => {
    const kind = key.slice(0, 2), name = key.slice(2);
    if (kind === 'p:') {
      // The ignore list holds file names (see onPluginList).
      if (!plugins.includes(pluginFile(key))) plugins.push(pluginFile(key));
      lines.push(`plugin ${what === 'changed' ? 'updated' : what}: ${pluginFile(key).replace(/\.smx$/, '')}`);
      return;
    }
    other++;
    if (kind === 'c:') {
      // A vanished or appeared cvar is worded once, on its c: key; the x: key
      // on the other side is skipped below.
      const gone = what === 'removed' && `x:${name}` in b, came = what === 'added' && `x:${name}` in a;
      if (gone) lines.push(`${name} no longer exists (was ${a[key]})`);
      else if (came) lines.push(`${name} now exists (${to})`);
      else lines.push(what === 'changed' ? `${name} ${from} -> ${to}` : `${name} ${what === 'added' ? `now reported (${to})` : 'no longer reported'}`);
    } else if (kind === 'x:' && what !== 'changed' && (`c:${name}` in a || `c:${name}` in b)) other--;
    else if (kind === 'w:') lines.push(what === 'changed' ? `${labels[key] ?? name} ${from} -> ${to}` : `${labels[key] ?? name} ${what}`);
    else if (kind === 'f:') lines.push(`file ${what}: ${base(name)}`);
    else if (kind === 'd:') lines.push(`files changed in: ${base(name)}`);
    else lines.push(what === 'changed' ? `${key}: ${from} -> ${to}` : `${key} ${what}`);
  };
  for (const k of d.added) if (!watched.has(k)) word(k, 'added', undefined, b[k]);
  for (const k of d.removed) if (!watched.has(k)) word(k, 'removed');
  for (const c of d.changed) if (!skip(c.key)) word(c.key, 'changed', c.from, c.to);
  const values = (n: number) => `${n} value${n === 1 ? '' : 's'}`;
  const grew = d.added.filter((k) => watched.has(k)).length, shrank = d.removed.filter((k) => watched.has(k)).length;
  if (grew > 0) lines.push(`${values(grew)} newly watched`);
  if (shrank > 0) lines.push(`${values(shrank)} no longer watched`);
  // Plugins first, then everything else, each in key order.
  const order = (l: string) => (l.startsWith('plugin ') ? 0 : 1);
  lines.sort((x, y) => order(x) - order(y));
  return { lines, plugins: plugins.sort(), onlyPlugins: plugins.length > 0 && other === 0 };
}

const row = (db: DB, id: number) => db.prepare(
  'SELECT id, name, source, triage, folded_into, came_from_patch_id, inputs_json, first_seen_at FROM balance_patches WHERE id = ?',
).get(id) as { id: number; name: string | null; source: string; triage: string | null; folded_into: number | null;
  came_from_patch_id: number | null; inputs_json: string | null; first_seen_at: string } | undefined;

const inputsOf = (db: DB, id: number, ignored: string[]): Inventory | null => {
  const r = row(db, id);
  if (!r?.inputs_json) return null;
  try { return withoutIgnored(JSON.parse(r.inputs_json) as Inventory, ignored); } catch { return null; }
};

/** The patch a pending patch is judged against (and folded into by default):
 *  where its first server came from, when that is a balance patch, else the
 *  newest earlier balance patch with inputs. Always a balance patch, since
 *  only one can be folded into. For a folded patch, the patch it is folded
 *  into. */
function triageBaseId(db: DB, id: number): number | null {
  const r = row(db, id);
  if (!r) return null;
  if (r.triage === 'folded' && r.folded_into !== null) return resolvePatch(db, r.folded_into);
  if (r.came_from_patch_id !== null) {
    const b = resolvePatch(db, r.came_from_patch_id);
    if (b !== id && (row(db, b)?.triage ?? 'balance') === 'balance') return b;
  }
  const prev = db.prepare(`SELECT id FROM balance_patches WHERE inputs_json IS NOT NULL AND COALESCE(triage, 'balance') = 'balance'
    AND id != ? AND (first_seen_at < ? OR (first_seen_at = ? AND id < ?)) ORDER BY first_seen_at DESC, id DESC LIMIT 1`)
    .get(id, r.first_seen_at, r.first_seen_at, id) as { id: number } | undefined;
  return prev?.id ?? null;
}

/** With no balance patch to judge against (the first fingerprinted configs
 *  on a site that only had historical patches), the newest earlier patch that
 *  has inputs, whatever its triage, so the card still shows what changed. It
 *  is shown as needing triage and is never a fold target. */
function comparisonOnlyId(db: DB, id: number): number | null {
  const r = row(db, id);
  if (!r) return null;
  const prev = db.prepare(`SELECT id FROM balance_patches WHERE inputs_json IS NOT NULL AND COALESCE(triage, 'balance') != 'folded'
    AND id != ? AND (first_seen_at < ? OR (first_seen_at = ? AND id < ?)) ORDER BY first_seen_at DESC, id DESC LIMIT 1`)
    .get(id, r.first_seen_at, r.first_seen_at, id) as { id: number } | undefined;
  return prev?.id ?? null;
}

export function triageInfo(db: DB, id: number, lists: Lists) {
  const foldBase = triageBaseId(db, id);
  const baseId = foldBase ?? comparisonOnlyId(db, id);
  const b = baseId === null ? undefined : row(db, baseId);
  const mine = inputsOf(db, id, lists.ignored);
  const theirs = baseId === null ? null : inputsOf(db, baseId, lists.ignored);
  const d = mine && theirs ? describeChanges(theirs, mine, lists.versionless, lists.labels) : { lines: [], plugins: [], onlyPlugins: false };
  return {
    base: b ? { id: b.id, number: patchNumber(db, b.id), name: b.name, ...(foldBase === null ? { needsTriage: true } : {}) } : null,
    changes: d.lines, plugins: d.plugins, onlyPluginsChanged: d.onlyPlugins,
  };
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function triageBalance(db: DB, id: number, p: { name: unknown; notes: unknown }): TriageResult {
  const r = row(db, id);
  if (!r) return { ok: false, status: 404, error: 'no such patch' };
  if (r.triage !== 'pending') return { ok: false, status: 409, error: 'only a pending patch can be triaged' };
  const name = text(p.name), notes = typeof p.notes === 'string' ? p.notes.trim() : '';
  if (!name) return { ok: false, status: 400, error: 'a balance patch needs a name' };
  if (name.length > 60) return { ok: false, status: 400, error: 'a patch name is up to 60 characters' };
  if (notes.length > 2000) return { ok: false, status: 400, error: 'notes are up to 2000 characters' };
  db.prepare("UPDATE balance_patches SET triage = 'balance', name = ?, notes = ?, reviewed = 1 WHERE id = ?").run(name, notes, id);
  return { ok: true };
}

/** Checks shared by fold and ignore. Returns the resolved target id. */
function checkFold(db: DB, id: number, into: unknown, states: string[]): { ok: true; into: number } | Extract<TriageResult, { ok: false }> {
  const r = row(db, id);
  if (!r) return { ok: false, status: 404, error: 'no such patch' };
  if (r.source !== 'detected') return { ok: false, status: 400, error: 'only a detected patch can be folded' };
  if (!states.includes(r.triage ?? 'balance')) return { ok: false, status: 409, error: `a ${r.triage} patch cannot be folded here` };
  const ro = activeRollout(db);
  if (ro && ro.patch_id === id) return { ok: false, status: 409, error: 'this patch is the knob panel\'s active rollout; it cannot be folded' };
  if (typeof into !== 'number' || !Number.isInteger(into) || !row(db, into)) return { ok: false, status: 400, error: 'pick a patch to fold into' };
  let target: number;
  try { target = resolvePatch(db, into); } catch { return { ok: false, status: 409, error: 'the target is in a fold loop' }; }
  if (chainOf(db, into).includes(id)) return { ok: false, status: 400, error: 'that fold would make a loop' };
  if ((row(db, target)!.triage ?? 'balance') !== 'balance') return { ok: false, status: 400, error: 'fold into a balance patch' };
  return { ok: true, into: target };
}

export function triageFold(db: DB, id: number, into: unknown): TriageResult {
  return db.transaction((): TriageResult => {
    const c = checkFold(db, id, into, ['pending', 'balance']);
    if (!c.ok) return c;
    const f = foldInto(db, id, c.into);
    return f.ok ? { ok: true, target: f.target } : { ok: false, status: 400, error: f.error };
  })();
}

export function triageIgnore(db: DB, id: number, p: {
  into: unknown; plugins: unknown; versionless: string[]; knobsIgnored: string[]; adminId: string; now?: string;
}): TriageResult {
  return db.transaction((): TriageResult => {
    const c = checkFold(db, id, p.into, ['pending']);
    if (!c.ok) return c;
    const ignored = effectiveIgnored(db, p.knobsIgnored);
    const mine = inputsOf(db, id, ignored), theirs = inputsOf(db, c.into, ignored);
    if (!mine || !theirs) return { ok: false, status: 400, error: 'both patches need recorded inputs' };
    const d = describeChanges(theirs, mine, p.versionless);
    if (!d.onlyPlugins) return { ok: false, status: 400, error: 'ignoring plugins is only offered when every difference is a plugin' };
    const asked = Array.isArray(p.plugins) ? p.plugins : null;
    if (!asked || asked.some((f) => typeof f !== 'string' || !PLUGIN_FILE_RE.test(f))
      || [...new Set(asked as string[])].sort().join('|') !== d.plugins.join('|')) {
      return { ok: false, status: 400, error: `the plugins to ignore must be exactly the ones that differ: ${d.plugins.join(', ')}` };
    }
    addIgnored(db, d.plugins, { reason: `triage of patch #${patchNumber(db, id)}`, by: p.adminId, now: p.now ?? nowSql() });
    // Other patches that differ only by these plugins merge too: admins hear
    // about it the same way as a boot merge.
    refingerprintPatches(db, p.versionless, effectiveIgnored(db, p.knobsIgnored));
    // The refingerprint may have merged this patch into another one that now
    // holds the shared fingerprint (or that one into this). New sightings land
    // on that holder, so it is the chain end that joins the target: folding
    // this patch alone would leave the holder pending and every later
    // sighting counting for it. A holder that is a balance patch already
    // counts as balance and is left alone.
    const end = resolvePatch(db, id);
    if (end !== resolvePatch(db, c.into) && (row(db, end)?.triage ?? 'balance') === 'pending') {
      const f = foldInto(db, end, c.into);
      if (!f.ok) return { ok: false, status: 400, error: f.error };
    }
    return { ok: true, target: resolvePatch(db, id) };
  })();
}

export function triageUnfold(db: DB, id: number): TriageResult {
  const r = row(db, id);
  if (!r) return { ok: false, status: 404, error: 'no such patch' };
  if (r.triage !== 'folded') return { ok: false, status: 409, error: 'this patch is not folded' };
  // Merged by the refingerprint (or an ignore): it hashes the same as the
  // patch it is folded into, and no sighting can reach it again, so unfolded
  // it would be a pending patch nothing could ever resolve.
  const fp = db.prepare('SELECT fingerprint FROM balance_patches WHERE id = ?').get(id) as { fingerprint: string | null };
  if (r.source === 'detected' && fp.fingerprint === null) {
    return { ok: false, status: 409, error: 'this patch was merged: it has the same config as the patch it is folded into once ignored and versionless plugins are left out, so it cannot be unfolded' };
  }
  const ro = activeRollout(db);
  if (ro && ro.patch_id === id) return { ok: false, status: 409, error: 'this patch is the knob panel\'s active rollout; it cannot be unfolded' };
  unfoldPatch(db, id);
  return { ok: true };
}
