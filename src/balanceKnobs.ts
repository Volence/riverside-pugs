import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface KnobCvar {
  cvar: string; label: string; group: string;
  /** Present together (with min, max, step, baseline) on an adjustable knob. */
  type?: 'int' | 'float';
  min?: number; max?: number; step?: number;
  /** The exact string the PUG config chain sets today. */
  baseline?: string;
  unit?: string; note?: string;
  /** A cvar that must stay greater than or equal to this one. */
  pairMax?: string;
}

export interface AdjustableKnob {
  cvar: string; label: string; group: string; type: 'int' | 'float';
  min: number; max: number; step: number; baseline: string;
  unit?: string; note?: string; pairMax?: string;
}

export interface BalanceKnobs {
  cvars: KnobCvar[];
  files: { path: string; label: string }[];
  dirs: { path: string; ext: string; label: string }[];
  versionless: string[];
  /** Plugins that are not balance at all and get loaded and unloaded around a
   *  match, so their presence is noise. Dropped from the inventory entirely. */
  ignored?: string[];
}

export const BALANCE_KNOBS_PATH = fileURLToPath(new URL('../balance/knobs.json', import.meta.url));

const CVAR_RE = /^[a-z0-9_]{1,63}$/;
// Relative, forward slashes, no spaces, no parent traversal.
const PATH_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_\-./]{1,200}$/;

const ADJ_FIELDS = ['type', 'min', 'max', 'step', 'baseline'] as const;

export function isAdjustable(c: KnobCvar): c is KnobCvar & AdjustableKnob {
  return ADJ_FIELDS.every((f) => c[f] !== undefined);
}

export function adjustableKnobs(k: BalanceKnobs): AdjustableKnob[] {
  return k.cvars.filter(isAdjustable);
}

/** Decimals a value of this step is written with: 0.05 -> 2, 250 -> 0. */
export function stepDecimals(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** The exact string written to the cfg file and read back by the plugin.
 *  Source keeps the string a cvar was set with, so "0.1" and "0.10" are two
 *  different fingerprints: floats always carry the decimals of their step. */
export function formatKnobValue(k: Pick<AdjustableKnob, 'type' | 'step'>, n: number): string {
  return k.type === 'int' ? String(Math.round(n)) : n.toFixed(stepDecimals(k.step));
}

const onGrid = (k: Pick<AdjustableKnob, 'min' | 'step'>, n: number): boolean => {
  const q = (n - k.min) / k.step;
  return Math.abs(q - Math.round(q)) < 1e-9;
};

/** A draft value as the exact string to write, or why it cannot be written.
 *  Only plain decimal numbers pass, so nothing but a number ever reaches the
 *  cfg file. */
export function normalizeKnobValue(k: AdjustableKnob, raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const s = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, error: `${k.label}: not a number` };
  const n = Number(s);
  if (k.type === 'int' && !Number.isInteger(n)) return { ok: false, error: `${k.label}: must be a whole number` };
  if (n < k.min - 1e-9 || n > k.max + 1e-9) {
    return { ok: false, error: `${k.label}: ${s} is outside ${formatKnobValue(k, k.min)} to ${formatKnobValue(k, k.max)}` };
  }
  if (!onGrid(k, n)) return { ok: false, error: `${k.label}: must be in steps of ${formatKnobValue(k, k.step)}` };
  return { ok: true, value: formatKnobValue(k, n) };
}

function validateAdjustable(k: BalanceKnobs): void {
  for (const c of k.cvars) {
    const present = ADJ_FIELDS.filter((f) => c[f] !== undefined);
    if (present.length === 0) continue;
    if (present.length !== ADJ_FIELDS.length) throw new Error(`knob ${c.cvar}: type, min, max, step and baseline go together`);
    if (c.type !== 'int' && c.type !== 'float') throw new Error(`knob ${c.cvar}: type must be int or float`);
    for (const f of ['min', 'max', 'step'] as const) {
      if (typeof c[f] !== 'number' || !Number.isFinite(c[f])) throw new Error(`knob ${c.cvar}: ${f} must be a number`);
    }
    const a = c as AdjustableKnob;
    if (!(a.step > 0)) throw new Error(`knob ${c.cvar}: step must be above 0`);
    if (a.min > a.max) throw new Error(`knob ${c.cvar}: min is above max`);
    if (a.type === 'int' && ![a.min, a.max, a.step].every(Number.isInteger)) {
      throw new Error(`knob ${c.cvar}: an int knob needs whole min, max and step`);
    }
    if (!onGrid(a, a.max)) throw new Error(`knob ${c.cvar}: max is not on the step grid`);
    if (typeof a.baseline !== 'string') throw new Error(`knob ${c.cvar}: baseline must be a string`);
    const norm = normalizeKnobValue(a, a.baseline);
    if (!norm.ok) throw new Error(`knob ${c.cvar}: baseline ${norm.error}`);
    if (norm.value !== a.baseline) throw new Error(`knob ${c.cvar}: baseline must be written as ${norm.value}`);
  }
  const adj = new Map(adjustableKnobs(k).map((a) => [a.cvar, a]));
  for (const c of k.cvars) {
    if (c.pairMax === undefined) continue;
    const self = adj.get(c.cvar);
    const other = adj.get(c.pairMax);
    if (!self || !other) throw new Error(`knob ${c.cvar}: pair ${c.pairMax} must be two adjustable knobs`);
    if (Number(self.baseline) > Number(other.baseline)) throw new Error(`knob ${c.cvar}: pair is invalid at baseline`);
  }
}

/** Load and validate the watched list. `raw` lets tests validate an object
 *  without touching the disk. Throws on anything the plugin could not use. */
export function loadBalanceKnobs(path: string = BALANCE_KNOBS_PATH, raw?: unknown): BalanceKnobs {
  const k = (raw ?? JSON.parse(readFileSync(path, 'utf8'))) as BalanceKnobs;
  if (!Array.isArray(k.cvars)) throw new Error('balance knobs: cvars must be an array');
  if (!Array.isArray(k.files)) throw new Error('balance knobs: files must be an array');
  if (!Array.isArray(k.dirs)) throw new Error('balance knobs: dirs must be an array');
  if (!Array.isArray(k.versionless)) throw new Error('balance knobs: versionless must be an array');
  if (k.ignored !== undefined && !Array.isArray(k.ignored)) throw new Error('balance knobs: ignored must be an array');
  for (const c of k.cvars) if (!CVAR_RE.test(c.cvar)) throw new Error(`bad cvar name: ${c.cvar}`);
  for (const f of k.files) if (!PATH_RE.test(f.path)) throw new Error(`bad file path: ${f.path}`);
  for (const d of k.dirs) {
    if (!PATH_RE.test(d.path)) throw new Error(`bad dir path: ${d.path}`);
    if (!/^\.[a-z0-9]{1,8}$/.test(d.ext)) throw new Error(`bad dir ext: ${d.ext}`);
  }
  if (new Set(k.cvars.map((c) => c.cvar)).size !== k.cvars.length) throw new Error('duplicate cvar');
  validateAdjustable(k);
  return k;
}

/** The plugin include. Deterministic, so the parity test can compare bytes. */
export function renderBalanceListInc(k: BalanceKnobs): string {
  // Not `static`: SourcePawn's compiler scopes a file-static global to the
  // physical file that declares it, even when that file is spliced in by
  // #include, so pug-balance.inc (a different physical file) could not see
  // these arrays at all ("undefined symbol") with `static` here. Not `const`
  // either: `const char name[][] = {...}` at global scope fails to parse on
  // this compiler ("expected token: '=', but found '['"); a plain global
  // array declaration compiles and is just as read-only in practice, since
  // nothing ever writes to it.
  const arr = (name: string, items: string[]) =>
    `char ${name}[][] = {\n${items.map((s) => `\t"${s}"`).join(',\n')}\n};\n`;
  return [
    '// GENERATED by scripts/gen-balance-list.ts from balance/knobs.json. Do not edit.',
    '// tests/balanceKnobs.test.ts fails when this file and knobs.json disagree.',
    '',
    arr('g_sBalCvars', k.cvars.map((c) => c.cvar)),
    arr('g_sBalFiles', k.files.map((f) => f.path)),
    arr('g_sBalDirs', k.dirs.map((d) => d.path)),
    arr('g_sBalDirExt', k.dirs.map((d) => d.ext)),
  ].join('\n');
}
