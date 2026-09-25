/**
 * Pictures an imported HUD points at that nobody provides.
 *
 * A HUD file names a material (a .vmt, which names its texture, a .vtf). When
 * neither the HUD nor the game has that file, the game draws Source's missing
 * texture, a purple and black checkerboard, in its place. The download passes
 * every imported file through, so a picture the import includes is fine, and
 * so is one the game ships (stockVgui.ts, exported from the game's files). What
 * is left is a picture the player has somewhere else, such as a loose folder the
 * HUD came from, and a server with sv_pure 2 (every Riverside server) refuses a
 * loose picture: research/2026-09-25-hud-missing-textures.md.
 *
 * Only pictures under vgui/ are checked, as that is what the stock list covers.
 * A bare `image` name with no folder is left alone: some panels take a texture
 * entry's name there (`tip_boomer`), not a file. So is `vgui/hud/altcrosshair`:
 * a HUD that draws "whichever crosshair addon you have" names it on purpose and
 * leaves it to that addon.
 */
import { parseKv, type KvNode } from './kv';
import { decodeText } from './text';
import { STOCK_VGUI } from './stockVgui';

export interface MissingPicture {
  /** Relative to materials/, lower case, no extension: `vgui/hud/sigh`. */
  material: string;
  /** The HUD file that names it. */
  file: string;
}

let stock: Set<string> | null = null;
/** Every file the game ships under materials/vgui/, relative to materials/, lower case. */
export function stockVgui(): ReadonlySet<string> {
  return stock ??= new Set(STOCK_VGUI.split('\n').filter(Boolean));
}

/** Named on purpose and provided by another addon (see the header). */
const FROM_ANOTHER_ADDON = new Set(['vgui/hud/altcrosshair']);

/** Keys whose value is relative to materials/vgui/ (ImagePanel, CircularProgressBar). */
const VGUI_RELATIVE = new Set(['image', 'fg_image', 'bg_image']);
/** Keys whose value is relative to materials/ (panel corners, icons, texture entries). */
const MATERIALS_RELATIVE = new Set(['texture1', 'texture2', 'texture3', 'texture4', 'icon_texture', 'yes_texture', 'no_texture', 'file']);

/** Lower case, forward slashes, `..` and `.` resolved, no leading slash or .vmt/.vtf. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.toLowerCase().replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/').replace(/\.(vmt|vtf)$/, '');
}

function* pairs(nodes: KvNode[]): Generator<[string, string]> {
  for (const n of nodes) {
    if (typeof n.value === 'string') yield [n.key.toLowerCase(), n.value];
    else yield* pairs(n.value);
  }
}

function read(bytes: Uint8Array): KvNode[] | null {
  try { return parseKv(decodeText(bytes).text); } catch { return null; }
}

/** The pictures `files` (an import's files by lower-case path) names but nobody provides, each once, in file order. */
export function missingPictures(files: ReadonlyMap<string, Uint8Array>): MissingPicture[] {
  const game = stockVgui();
  const out: MissingPicture[] = [];
  const seen = new Set<string>();
  const has = (m: string, ext: 'vmt' | 'vtf') => files.has(`materials/${m}.${ext}`) || game.has(`${m}.${ext}`);
  const report = (material: string, file: string) => {
    if (seen.has(material) || FROM_ANOTHER_ADDON.has(material)) return;
    seen.add(material);
    out.push({ material, file });
  };

  for (const [path, bytes] of files) {
    const isLayout = /^(resource|scripts)\/.*\.(res|txt)$/.test(path);
    const isMaterial = /^materials\/vgui\/.*\.vmt$/.test(path);
    if (!isLayout && !isMaterial) continue;
    const nodes = read(bytes);
    if (!nodes) continue;
    for (const [key, value] of pairs(nodes)) {
      if (!value.trim()) continue;
      if (isMaterial) {
        if (key !== '$basetexture') continue;
        const t = normalize(value);
        if (t.startsWith('vgui/') && !has(t, 'vtf')) report(t, path);
        continue;
      }
      let m: string;
      if (VGUI_RELATIVE.has(key)) {
        if (!/[\\/]/.test(value)) continue;              // a texture entry's name, or a vgui/ root file
        m = normalize(`vgui/${value}`);
      } else if (MATERIALS_RELATIVE.has(key)) {
        m = normalize(value);
      } else continue;
      if (m.startsWith('vgui/') && !has(m, 'vmt')) report(m, path);
    }
  }
  return out;
}
