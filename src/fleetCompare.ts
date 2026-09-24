import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isManaged } from './fleetTree.js';

/** The fleet view's comparison: pure, from two reference manifests and the
 *  stored readings. Rules in docs/superpowers/specs/2026-09-24-fleet-view-design.md. */

export interface FileSig { size: number; sha256: string | null }
export interface Manifest { kind: 'repo' | 'base'; label: string; at: string; files: Record<string, FileSig> }

export function loadManifest(dir: string, kind: 'repo' | 'base'): Manifest | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, `${kind}.json`), 'utf8')) as Manifest;
    if (m.kind !== kind || typeof m.label !== 'string' || typeof m.files !== 'object' || m.files === null) return null;
    return m;
  } catch {
    return null;
  }
}

export type Area = 'plugins' | 'configs' | 'data' | 'gamedata' | 'extensions' | 'stripper' | 'other';
const AREA_ORDER: Area[] = ['plugins', 'configs', 'data', 'gamedata', 'extensions', 'stripper', 'other'];

export function areaOf(path: string): Area {
  const sm = 'left4dead/addons/sourcemod/';
  if (path.startsWith(`${sm}plugins/`)) return 'plugins';
  if (path.startsWith('left4dead/cfg/') || path.startsWith(`${sm}configs/`)) return 'configs';
  if (path.startsWith(`${sm}data/`)) return 'data';
  if (path.startsWith(`${sm}gamedata/`)) return 'gamedata';
  if (path.startsWith(`${sm}extensions/`)) return 'extensions';
  if (path.startsWith('left4dead/addons/stripper/')) return 'stripper';
  return 'other';
}

export type CellLabel = 'repo' | 'base' | 'neither' | 'missing' | 'unread';
export interface FleetCell { sig: FileSig | null; label: CellLabel; highlight: boolean; sizeOnly: boolean }
export interface FleetRow {
  path: string; area: Area; repo: FileSig | null; base: FileSig | null;
  cells: Record<number, FleetCell>;
  /** Differs from the base (no repo entry) the same way on every read box: a
   *  post-install patch such as the local.cfg hooks, not drift. */
  patchedEverywhere: boolean;
  differs: boolean;
}

/** Same file: by hash when both sides have one, else by size. */
const same = (a: FileSig, b: FileSig) => (a.sha256 !== null && b.sha256 !== null ? a.sha256 === b.sha256 : a.size === b.size);
const key = (s: FileSig | null) => (s === null ? 'missing' : `${s.size}:${s.sha256 ?? ''}`);

export function compareFleet(repo: Manifest | null, base: Manifest | null,
  boxes: { serverId: number; files: Map<string, FileSig> | null }[]): FleetRow[] {
  const paths = new Set<string>();
  for (const m of [repo, base]) if (m) for (const p of Object.keys(m.files)) paths.add(p);
  for (const b of boxes) if (b.files) for (const p of b.files.keys()) paths.add(p);

  const rows: FleetRow[] = [];
  for (const path of paths) {
    if (!isManaged(path)) continue;
    const r = repo?.files[path] ?? null;
    const bs = base?.files[path] ?? null;
    const ref = r ?? bs;
    const read = boxes.filter((b) => b.files !== null);
    const sigOf = (b: { files: Map<string, FileSig> | null }) => b.files!.get(path) ?? null;
    const labelOf = (s: FileSig | null): CellLabel =>
      s === null ? 'missing' : r && same(s, r) ? 'repo' : bs && same(s, bs) ? 'base' : 'neither';

    // Majority among read boxes, for rows with no reference.
    const counts = new Map<string, number>();
    for (const b of read) counts.set(key(sigOf(b)), (counts.get(key(sigOf(b))) ?? 0) + 1);
    const top = Math.max(0, ...counts.values());
    const leaders = [...counts].filter(([, n]) => n === top).map(([k]) => k);
    const allAgree = counts.size === 1;
    const patchedEverywhere = !r && bs !== null && read.length > 0 && allAgree && sigOf(read[0]) !== null && !same(sigOf(read[0])!, bs);

    const cells: Record<number, FleetCell> = {};
    for (const b of boxes) {
      if (b.files === null) { cells[b.serverId] = { sig: null, label: 'unread', highlight: false, sizeOnly: false }; continue; }
      const s = sigOf(b);
      let highlight: boolean;
      if (ref) highlight = patchedEverywhere ? false : s === null || !same(s, ref);
      else highlight = !allAgree && (leaders.length > 1 || key(s) !== leaders[0]);
      const sizeOnly = s !== null && (s.sha256 === null || (ref !== null && ref.sha256 === null));
      cells[b.serverId] = { sig: s, label: labelOf(s), highlight, sizeOnly };
    }
    rows.push({ path, area: areaOf(path), repo: r, base: bs, cells, patchedEverywhere,
      differs: Object.values(cells).some((c) => c.highlight) });
  }
  return rows.sort((a, b) => AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area) || a.path.localeCompare(b.path));
}
