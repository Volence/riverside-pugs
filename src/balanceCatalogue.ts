import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BalanceKnobs } from './balanceKnobs.js';

/**
 * The balance catalogue: the values and rules the public Game values page
 * shows, and the extra values the plugin watches. See
 * docs/superpowers/specs/2026-09-24-balance-catalogue-values-design.md.
 */

export interface CatalogueValue {
  id: string; group: string; label: string; source: 'cvar' | 'weapon';
  unit?: string; vanilla?: string; note?: string;
  /** The live value misreports (a plugin applies it itself): show the note. */
  hideLive?: boolean;
  /** Shown publicly only while this holds (e.g. hunting rifle stats only while
   *  the rifle can be picked up). Same shape as a rule's `when`. */
  when?: CatalogueRule['when'];
}
export interface CatalogueRule {
  id: string; group: string; text: string;
  when: { plugin: string } | { cvar: string; equals: string } | { cvar: string; notEquals: string };
  /** `{id}` placeholders name catalogue values and are filled in with what
   *  the servers report, so the text follows the numbers. */
  /** Only reviewed rules are public; drafts show on the admin preview. */
  reviewed: boolean;
}
export interface Catalogue {
  groups: { id: string; label: string }[];
  values: CatalogueValue[];
  rules: CatalogueRule[];
}

/** The `{id}` placeholders in a rule's text. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
}

export const CATALOGUE_PATH = fileURLToPath(new URL('../balance/catalogue.json', import.meta.url));
const CVAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const WEAPON_RE = /^(weapon_[a-z0-9_]{1,40})\.([A-Za-z][A-Za-z0-9_]{0,40})$/;
const PLUGIN_RE = /^[A-Za-z0-9_. -]{1,64}\.smx$/;

function validWhen(when: unknown): boolean {
  const w = (when ?? {}) as Record<string, unknown>;
  return (typeof w.plugin === 'string' && PLUGIN_RE.test(w.plugin))
    || (typeof w.cvar === 'string' && CVAR_RE.test(w.cvar) && (typeof w.equals === 'string' || typeof w.notEquals === 'string'));
}

/** Load and validate. `raw` lets tests validate an object without the disk. */
export function loadCatalogue(path: string = CATALOGUE_PATH, raw?: unknown): Catalogue {
  const c = (raw ?? JSON.parse(readFileSync(path, 'utf8'))) as Catalogue;
  if (!Array.isArray(c.groups) || !Array.isArray(c.values) || !Array.isArray(c.rules)) throw new Error('catalogue: groups, values and rules must be arrays');
  const groups = new Set(c.groups.map((g) => g.id));
  if (groups.size !== c.groups.length) throw new Error('catalogue: duplicate group');
  const ids = new Set<string>();
  const cvarsLower = new Set<string>();
  for (const v of c.values) {
    if (!groups.has(v.group)) throw new Error(`catalogue: ${v.id} is in unknown group ${v.group}`);
    if (ids.has(v.id)) throw new Error(`catalogue: duplicate value ${v.id}`);
    ids.add(v.id);
    // FindConVar ignores case, so two spellings would watch one cvar twice.
    if (v.source === 'cvar') {
      if (cvarsLower.has(v.id.toLowerCase())) throw new Error(`catalogue: duplicate value ${v.id} (cvars ignore case)`);
      cvarsLower.add(v.id.toLowerCase());
    }
    if (v.source === 'cvar' && !CVAR_RE.test(v.id)) throw new Error(`catalogue: bad cvar ${v.id}`);
    else if (v.source === 'weapon' && !WEAPON_RE.test(v.id)) throw new Error(`catalogue: bad weapon key ${v.id}`);
    else if (v.source !== 'cvar' && v.source !== 'weapon') throw new Error(`catalogue: ${v.id} has unknown source`);
    if (typeof v.label !== 'string' || !v.label.trim()) throw new Error(`catalogue: ${v.id} needs a label`);
    if (v.when !== undefined && !validWhen(v.when)) throw new Error(`catalogue: ${v.id} has a bad when: needs plugin, or cvar with equals or notEquals`);
  }
  const ruleIds = new Set<string>();
  for (const r of c.rules) {
    if (!groups.has(r.group)) throw new Error(`catalogue: rule ${r.id} is in unknown group ${r.group}`);
    if (ruleIds.has(r.id)) throw new Error(`catalogue: duplicate rule ${r.id}`);
    ruleIds.add(r.id);
    if (!validWhen(r.when)) throw new Error(`catalogue: rule ${r.id} needs when.plugin, or when.cvar with equals or notEquals`);
    for (const t of placeholders(r.text)) {
      if (!ids.has(t)) throw new Error(`catalogue: rule ${r.id} uses {${t}}, which is not a catalogue value`);
    }
    if (typeof r.reviewed !== 'boolean') throw new Error(`catalogue: rule ${r.id} needs reviewed true or false`);
  }
  return c;
}

/** The watch list the plugin reads: knobs.json's lists plus the catalogue's
 *  cvars (deduplicated, knobs order first) and weapon keys. */
export function watchKnobs(knobs: BalanceKnobs, cat: Catalogue | null): BalanceKnobs {
  if (!cat) return knobs;
  // Cvars compare ignoring case, as FindConVar does.
  const have = new Set(knobs.cvars.map((c) => c.cvar.toLowerCase()));
  const extra = cat.values.filter((v) => v.source === 'cvar' && !have.has(v.id.toLowerCase())).map((v) => ({ cvar: v.id, label: v.label, group: v.group }));
  const weapons = [...(knobs.weapons ?? [])];
  const haveW = new Set(weapons.map((w) => `${w.weapon}.${w.key}`));
  for (const v of cat.values) {
    if (v.source !== 'weapon' || haveW.has(v.id)) continue;
    haveW.add(v.id);
    const [weapon, key] = v.id.split('.');
    weapons.push({ weapon, key, label: v.label });
  }
  return { ...knobs, cvars: [...knobs.cvars, ...extra], weapons };
}

/** `w:<weapon>.<key>` -> label, from knobs.json's weapons and the catalogue's
 *  weapon values (knobs first), for wording triage changes. */
export function weaponLabels(knobs: BalanceKnobs | null, cat: Catalogue | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of cat?.values ?? []) if (v.source === 'weapon') out[`w:${v.id}`] = v.label;
  for (const w of knobs?.weapons ?? []) out[`w:${w.weapon}.${w.key}`] = w.label;
  return out;
}
