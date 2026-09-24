import type { RepoFile } from './deployRepo.js';
import type { FileSig } from './fleetCompare.js';
import { isManaged, SIZE_CAP } from './fleetTree.js';

/** Staging a release: pure functions from a repo tree and the fleet readings.
 *  docs/superpowers/specs/2026-09-24-release-deploy-design.md */

export function deploySlug(name: string): string {
  return name.trim().toLowerCase().replace(/#/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export interface WantedFile { path: string; size: number; sha256: string; blob: string; layer: 'shared' | 'box' }

/** Repo path to game-dir path and layer, or null for anything else in the repo. */
function mapPath(repoPath: string): { path: string; layer: 'shared' } | { path: string; layer: 'box'; slug: string } | null {
  if (repoPath.startsWith('overrides/')) return { path: repoPath.slice('overrides/'.length), layer: 'shared' };
  const m = /^boxes\/([^/]+)\/(.+)$/.exec(repoPath);
  return m ? { path: m[2], layer: 'box', slug: m[1] } : null;
}

export function wantedFor(files: RepoFile[], slug: string): Map<string, WantedFile> {
  const out = new Map<string, WantedFile>();
  for (const layer of ['shared', 'box'] as const) {
    for (const f of files) {
      const m = mapPath(f.path);
      if (!m || m.layer !== layer || (m.layer === 'box' && m.slug !== slug)) continue;
      out.set(m.path, { path: m.path, size: f.size, sha256: f.sha256, blob: f.blob, layer });
    }
  }
  return out;
}

export function validateTree(files: RepoFile[]): string[] {
  const reasons: string[] = [];
  for (const f of files) {
    const m = mapPath(f.path);
    if (!m) continue;
    const base = m.path.split('/').pop();
    if (base === 'secrets.cfg') reasons.push(`secrets.cfg is never deployed: ${m.path}`);
    else if (f.mode === '120000') reasons.push(`symlink: ${f.path}`);
    else if (!isManaged(m.path)) reasons.push(`outside the managed folders: ${m.path}`);
    else if (f.size > SIZE_CAP) reasons.push(`over 20 MB: ${m.path}`);
  }
  return reasons;
}

export type Op =
  | { path: string; op: 'write'; kind: 'add' | 'update'; size: number; sha256: string; blob?: string; backupFrom?: { releaseId: number; serverId: number } }
  | { path: string; op: 'remove' };

const same = (a: FileSig, sha: string, size: number) => (a.sha256 !== null ? a.sha256 === sha : a.size === size);

/** Adds first, then updates, then deletions; each group in path order. A
 *  deletion is only ever of a file the repo shipped to this box before. */
export function planBox(wanted: Map<string, WantedFile>, onBox: Map<string, FileSig>, shipped: Map<string, { sha256: string; blob: string }>): Op[] {
  const adds: Op[] = [], updates: Op[] = [], deletes: Op[] = [];
  for (const w of [...wanted.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const have = onBox.get(w.path);
    if (!have) adds.push({ path: w.path, op: 'write', kind: 'add', size: w.size, sha256: w.sha256, blob: w.blob });
    else if (!same(have, w.sha256, w.size)) updates.push({ path: w.path, op: 'write', kind: 'update', size: w.size, sha256: w.sha256, blob: w.blob });
  }
  for (const p of [...shipped.keys()].sort()) if (!wanted.has(p) && onBox.has(p)) deletes.push({ path: p, op: 'remove' });
  return [...adds, ...updates, ...deletes];
}

const PLUGIN_DIR = 'left4dead/addons/sourcemod/plugins/';

export function describeOps(ops: Op[]): string[] {
  return ops.map((o) => {
    const rel = o.path.replace(/^left4dead\//, '');
    const what = o.op === 'remove' ? 'removed' : o.kind === 'add' ? 'added' : 'updated';
    if (o.path.startsWith(PLUGIN_DIR) && o.path.endsWith('.smx')) {
      const name = o.path.slice(PLUGIN_DIR.length).replace(/\.smx$/, '');
      return `plugin ${what}: ${name}`;
    }
    if (o.path.endsWith('.cfg')) return o.op === 'remove' ? `cfg removed: ${rel}` : o.kind === 'add' ? `cfg added: ${rel}` : `cfg changed: ${rel}`;
    return `file ${what}: ${rel}`;
  });
}

const NOT_CVARS = new Set(['exec', 'echo', 'alias', 'say', 'sm', 'writeid', 'writeip', 'log', 'bind', 'wait']);
function cvarsOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const m = /^(?:sm_cvar\s+)?([A-Za-z_][\w]*)\s+"?([^"\s]*)"?/.exec(line);
    if (m && !NOT_CVARS.has(m[1]) && m[2] !== '') out.set(m[1], m[2]);
  }
  return out;
}

export function cvarDiff(oldText: string, newText: string): string[] {
  const a = cvarsOf(oldText), b = cvarsOf(newText);
  const out: string[] = [];
  for (const [k, v] of b) {
    if (!a.has(k)) continue;
    if (a.get(k) !== v) out.push(`${k} ${a.get(k)} → ${v}`);
  }
  for (const [k, v] of b) if (!a.has(k)) out.push(`${k} set to ${v}`);
  for (const k of a.keys()) if (!b.has(k)) out.push(`${k} no longer set`);
  return out;
}

export function suggestBalance(ops: Op[][], changedCvars: string[], knobs: {
  cvars: { cvar: string }[]; files: { path: string }[]; dirs: { path: string }[]; versionless: string[]; ignored?: string[];
} | null): 'not_balance' | 'possibly_balance' {
  if (!knobs) return 'possibly_balance';
  const watched = new Set(knobs.cvars.map((c) => c.cvar));
  if (changedCvars.some((c) => watched.has(c))) return 'possibly_balance';
  const quiet = new Set([...knobs.versionless, ...(knobs.ignored ?? [])]);
  for (const o of ops.flat()) {
    const rel = o.path.replace(/^left4dead\//, '');
    if (knobs.files.some((f) => f.path === rel) || knobs.dirs.some((d) => rel.startsWith(`${d.path}/`))) return 'possibly_balance';
    if (o.path.startsWith(PLUGIN_DIR) && o.path.endsWith('.smx') && !quiet.has(o.path.slice(PLUGIN_DIR.length))) return 'possibly_balance';
  }
  return 'not_balance';
}
