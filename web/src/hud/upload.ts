/**
 * Import a HUD: a player's .vpk addon, or a .zip of a HUD folder, read into
 * the HUD's own files.
 *
 * The HUD root is what the game mounts: a .vpk's root, or in a zip the
 * folder that holds scripts/hudlayout.res, however deep (the shallowest
 * wins). Paths are lower case with forward slashes, as the game looks them
 * up and as readVPK already gives them. gameinfo.txt is never a HUD file
 * and shipping one in an addon could break the game, so it is dropped
 * wherever it is, along with everything outside the root; `dropped` names
 * them so the page can say so.
 *
 * Every file the editor parses is parsed here once, so a HUD whose files
 * KeyValues cannot read is refused with the file's name rather than failing
 * later inside the canvas draw.
 */
import { readVPK } from '../vpk/read';
import { readZip, ZipTooBig } from '../vpk/unzip';
import { parseKv } from './kv';
import { BASE_PATHS } from './base';
import { decodeText } from './text';
import { safeName } from './design';

export const MAX_HUD_BYTES = 50 * 1024 * 1024;
export const IMPORT_ERRORS = {
  notHud: 'This file has no scripts/hudlayout.res, so it is not a HUD',
  tooBig: 'This HUD is over 50 MB',
  unreadable: 'Could not read this file as a VPK or zip',
} as const;

export interface HudUpload { name: string; files: Map<string, Uint8Array>; dropped: string[] }

const LAYOUT = 'scripts/hudlayout.res';
const isVpk = (b: Uint8Array) => b.length >= 4 && b[0] === 0x34 && b[1] === 0x12 && b[2] === 0xaa && b[3] === 0x55;
const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b;
const fail = (why: string): never => { throw new Error(why); };
const total = (m: Map<string, Uint8Array>) => [...m.values()].reduce((n, d) => n + d.length, 0);

/** A single-file VPK's files, or the unreadable sentence: a split addon's _dir.vpk is missing most of its data. */
function vpkFiles(bytes: Uint8Array): Map<string, Uint8Array> {
  const split = new Set<string>();
  let files: Map<string, Uint8Array>;
  try { files = readVPK(bytes, split); } catch { return fail(IMPORT_ERRORS.unreadable); }
  if (split.size) fail(IMPORT_ERRORS.unreadable);
  if (total(files) > MAX_HUD_BYTES) fail(IMPORT_ERRORS.tooBig);
  return files;
}

/** The HUD root among lower-cased paths: '' for the top, 'a/b/' for a folder, null when none holds the layout. */
function hudRoot(paths: string[]): string | null {
  const roots = paths.filter((p) => p === LAYOUT || p.endsWith(`/${LAYOUT}`))
    .map((p) => p.slice(0, p.length - LAYOUT.length))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  return roots[0] ?? null;
}

const nameOf = (fileName: string, root: string) => {
  const folder = root.replace(/\/$/, '').split('/').pop();
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.(vpk|zip)$/i, '').replace(/_dir$/i, '');
  return safeName(folder || base);
};

/** Refuse a HUD whose files the editor parses cannot be read, naming the file. */
function checkParses(files: Map<string, Uint8Array>) {
  for (const path of BASE_PATHS) {
    const data = files.get(path);
    if (!data || path === 'scripts/hudanimations.txt') continue;           // hudanimations.txt is not KeyValues
    try { parseKv(decodeText(data).text); }
    catch (e) { fail(`This HUD's ${path} could not be read (${(e as Error).message})`); }
  }
}

export async function readHudUpload(fileName: string, bytes: Uint8Array): Promise<HudUpload> {
  if (bytes.length > MAX_HUD_BYTES) fail(IMPORT_ERRORS.tooBig);
  let entries: Map<string, Uint8Array>;
  const original = new Map<string, string>();                  // lower-cased path -> the name as the zip spells it
  if (isVpk(bytes)) entries = vpkFiles(bytes);
  else if (isZip(bytes)) {
    let raw: Map<string, Uint8Array>;
    try { raw = await readZip(bytes, MAX_HUD_BYTES); }
    catch (e) { return fail(e instanceof ZipTooBig ? IMPORT_ERRORS.tooBig : IMPORT_ERRORS.unreadable); }
    entries = new Map();
    for (const [name, data] of raw) { const p = name.toLowerCase(); entries.set(p, data); original.set(p, name); }
  } else return fail(IMPORT_ERRORS.unreadable);

  const root = hudRoot([...entries.keys()]);
  if (root === null && original.size) {
    // No loose HUD in the zip: a VPK inside it that holds one, shallowest
    // first. That is a gameinfo-mounted folder's pak01_dir.vpk (the editor's
    // own Advanced download), whose root is the archive root, so the name
    // comes from the upload's file name.
    const vpks = [...entries.keys()].filter((p) => p.endsWith('.vpk')).sort((a, b) => a.split('/').length - b.split('/').length);
    for (const p of vpks) {
      let inner: Map<string, Uint8Array>;
      try { inner = vpkFiles(entries.get(p)!); } catch { continue; }
      if (!inner.has(LAYOUT)) continue;
      const dropped = [...original].filter(([q]) => q !== p).map(([, name]) => name);
      return finish(nameOf(fileName, ''), inner, dropped);
    }
  }
  if (root === null) return fail(IMPORT_ERRORS.notHud);
  const files = new Map<string, Uint8Array>();
  const dropped: string[] = [];
  for (const [p, data] of entries) {
    const inRoot = p.startsWith(root);
    const rel = inRoot ? p.slice(root.length) : p;
    if (!inRoot || rel === 'gameinfo.txt' || rel.endsWith('/gameinfo.txt')) { dropped.push(original.get(p) ?? p); continue; }
    files.set(rel, data);
  }
  return finish(nameOf(fileName, root), files, dropped.sort());
}

function finish(name: string, files: Map<string, Uint8Array>, dropped: string[]): HudUpload {
  for (const p of [...files.keys()]) if (p === 'gameinfo.txt' || p.endsWith('/gameinfo.txt')) { files.delete(p); dropped.push(p); }
  checkParses(files);
  return { name, files, dropped: dropped.sort() };
}

/**
 * The HUD's identity: SHA-256 of its canonical file list, every path in
 * sorted order followed by its length and its bytes. The same HUD imported
 * twice, from a .vpk or a zip, is one id, so it is one stored entry, and a
 * design that names an id can never open against different files.
 */
export async function hudId(files: ReadonlyMap<string, Uint8Array>): Promise<string> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const path of [...files.keys()].sort()) {
    const data = files.get(path)!;
    parts.push(enc.encode(`${path}\0${data.length}\0`), data);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
