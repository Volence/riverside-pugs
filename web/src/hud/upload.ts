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
 * them so the page can say so. So is any path that is unsafe or junk (see
 * unwanted), before the root is looked for, so junk can never be the root.
 *
 * Every file the editor parses is parsed here once, so a HUD whose files
 * KeyValues cannot read, or read into a shape the editor cannot walk, is
 * refused with the file's name rather than failing later inside the canvas
 * draw (checkFiles).
 */
import { vpkPathProblem } from '../vpk';
import { readVPK, isVpk } from '../vpk/read';
import { readZip, ZipTooBig, UNREADABLE } from '../vpk/unzip';
import { parseKv, kvFind, type KvNode } from './kv';
import { BASE_PATHS } from './base';
import { decodeText } from './text';
import { safeName } from './design';
import { ELEMENTS } from './elements';
import { TEAM_PANEL } from './children';

export const MAX_HUD_BYTES = 50 * 1024 * 1024;
export const IMPORT_ERRORS = {
  notHud: 'This file has no scripts/hudlayout.res, so it is not a HUD',
  tooBig: 'This HUD is over 50 MB',
  unreadable: UNREADABLE,
} as const;

export interface HudUpload { name: string; files: Map<string, Uint8Array>; dropped: string[] }

const LAYOUT = 'scripts/hudlayout.res';
const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b;
const fail = (why: string): never => { throw new Error(why); };
/** A gameinfo.txt at any depth: never a HUD file (see the header). */
const isGameinfo = (p: string) => p === 'gameinfo.txt' || p.endsWith('/gameinfo.txt');
const total = (m: Map<string, Uint8Array>) => [...m.values()].reduce((n, d) => n + d.length, 0);

/** Files a Mac, Windows or git leaves in a folder it zips, by lower-cased file name. */
const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/**
 * Whether a lower-cased path is dropped rather than imported. Unsafe: an
 * absolute path, a drive letter, or anything encodeVPK refuses (a ".." or
 * "." or empty folder, a control character, a name or extension it cannot
 * store). A path the game would never look up is harmless in the editor,
 * but the download passes every file through, and a tool that extracts it
 * would write "../" paths outside the addon. Junk: a Mac's __MACOSX folder
 * and "._" resource forks, .DS_Store, Thumbs.db, desktop.ini, and dotfiles
 * such as .gitignore, which no game reads and which a VPK cannot name.
 */
function unwanted(p: string): boolean {
  const segments = p.split('/');
  const base = segments[segments.length - 1];
  if (segments.includes('__macosx') || JUNK_NAMES.has(base) || base.startsWith('._')) return true;
  if (base.startsWith('.') && base.indexOf('.', 1) < 0) return true;
  if (p.startsWith('/') || /^[a-z]:/.test(p)) return true;
  return vpkPathProblem(p) !== null;
}

/** Move every unwanted entry out of `entries` into `dropped`, by the name the upload spells it with. */
function dropUnwanted(entries: Map<string, Uint8Array>, dropped: string[], original?: Map<string, string>) {
  for (const p of [...entries.keys()]) {
    if (unwanted(p)) { entries.delete(p); dropped.push(original?.get(p) ?? p); }
  }
}

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

/**
 * The blocks the editor looks up by name, by file: a HUD may lack any of
 * them (the editor then offers no control for it, as the spec's "Degrading"
 * says), but one written as a plain value where a block belongs is not a
 * HUD the game can read either, and every reader would trip on it.
 * `required` names blocks the editor cannot work without when the upload
 * ships that file at all: the chat window's size comes from basechat.res's
 * HudChat, and every weapon and item icon from mod_textures.txt's
 * TextureData.
 */
const SHAPES: { path: string; blocks: string[]; required?: string[] }[] = [
  { path: LAYOUT, blocks: [...ELEMENTS.map((e) => e.key), 'HudCrosshair'] },
  { path: 'resource/ui/hud/teamdisplayhud.res', blocks: ['TeamPlayer1', 'TeamPlayer2', 'TeamPlayer3', 'TeamPlayer4'] },
  { path: TEAM_PANEL.file, blocks: TEAM_PANEL.children.map((c) => c.name) },
  { path: 'resource/ui/basechat.res', blocks: ['HudChat', 'HudChatHistory'], required: ['HudChat'] },
  { path: 'scripts/mod_textures.txt', blocks: ['TextureData'], required: ['TextureData'] },
  { path: 'resource/clientscheme.res', blocks: ['Colors', 'Fonts', 'CustomFontFiles'] },
];

/**
 * Refuse a HUD whose files the editor parses cannot be read, or can be read
 * but not in the shape the editor walks, naming the file. Every file must
 * parse and have one root block (an empty or comment-only file, or a root
 * that is a plain value, has none), and the blocks SHAPES lists must be
 * blocks. This is the first of two checks: the page then draws and builds
 * the new HUD once, off screen (importCheck.ts), which catches whatever a
 * list like this one misses.
 */
function checkFiles(files: ReadonlyMap<string, Uint8Array>) {
  const roots = new Map<string, KvNode[]>();
  for (const path of BASE_PATHS) {
    const data = files.get(path);
    if (!data || path === 'scripts/hudanimations.txt') continue;           // hudanimations.txt is not KeyValues
    let tree: KvNode[];
    try { tree = parseKv(decodeText(data).text); }
    catch (e) { return fail(`This HUD's ${path} could not be read (${(e as Error).message})`); }
    const root = tree[0];
    if (!root || typeof root.value === 'string') fail(`This HUD's ${path} has no root block, so the editor cannot read it`);
    roots.set(path, root.value as KvNode[]);
  }
  for (const { path, blocks, required = [] } of SHAPES) {
    const root = roots.get(path);
    if (!root) continue;
    for (const name of blocks) {
      const n = kvFind(root, [name]);
      if (n ? typeof n.value === 'string' : required.includes(name)) {
        fail(`This HUD's ${path} has no ${name} block, so the editor cannot read it`);
      }
    }
  }
}

/** checkFiles's refusal as a value: null for files the editor can walk, else the one-line reason naming the file. */
export function fileProblem(files: ReadonlyMap<string, Uint8Array>): string | null {
  try { checkFiles(files); return null; } catch (e) { return (e as Error).message; }
}

export async function readHudUpload(fileName: string, bytes: Uint8Array): Promise<HudUpload> {
  if (bytes.length > MAX_HUD_BYTES) fail(IMPORT_ERRORS.tooBig);
  let entries: Map<string, Uint8Array>;
  const original = new Map<string, string>();                  // lower-cased path -> the name as the zip spells it
  const twins: string[] = [];
  if (isVpk(bytes)) entries = vpkFiles(bytes);
  else if (isZip(bytes)) {
    let raw: Map<string, Uint8Array>;
    try { raw = await readZip(bytes, MAX_HUD_BYTES); }
    catch (e) { return fail(e instanceof ZipTooBig ? IMPORT_ERRORS.tooBig : IMPORT_ERRORS.unreadable); }
    entries = new Map();
    // The game looks paths up without regard to case, so two entries whose
    // names differ only by case are one file to it: the first is kept and
    // the other is listed as left out, rather than one silently winning.
    for (const [name, data] of raw) {
      const p = name.toLowerCase();
      if (entries.has(p)) { twins.push(name); continue; }
      entries.set(p, data); original.set(p, name);
    }
  } else return fail(IMPORT_ERRORS.unreadable);
  const dropped: string[] = [...twins];
  dropUnwanted(entries, dropped, original);

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
      // Everything but this VPK is dropped, junk included, which is in `dropped` already.
      const others = [...entries.keys()].filter((q) => q !== p).map((q) => original.get(q)!);
      return finish(nameOf(fileName, ''), inner, [...dropped, ...others]);
    }
  }
  if (root === null) return fail(IMPORT_ERRORS.notHud);
  const files = new Map<string, Uint8Array>();
  for (const [p, data] of entries) {
    const inRoot = p.startsWith(root);
    const rel = inRoot ? p.slice(root.length) : p;
    if (!inRoot || isGameinfo(rel)) { dropped.push(original.get(p) ?? p); continue; }
    files.set(rel, data);
  }
  return finish(nameOf(fileName, root), files, dropped);
}

function finish(name: string, files: Map<string, Uint8Array>, dropped: string[]): HudUpload {
  dropUnwanted(files, dropped);                                  // again, for a VPK found inside a zip
  for (const p of [...files.keys()]) if (isGameinfo(p)) { files.delete(p); dropped.push(p); }
  checkFiles(files);
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
