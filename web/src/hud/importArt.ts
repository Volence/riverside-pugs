/**
 * An imported HUD's own textures, for the preview (spec, "Textures").
 *
 * A panel names a material; the game reads materials/<name>.vmt, follows
 * its $baseTexture to a .vtf and draws that. The preview does the same
 * against the upload: the .vmt, its $baseTexture, the .vtf decoded by
 * decodeVTF (DXT included, mip 0), put into a canvas once and cached by
 * base key and material, so two imports never share one. $additive 1 is
 * reported so the caller can add it onto the scene the way the game does.
 *
 * null: the upload has no such material, so the stock art is right. `stock`:
 * the upload's .vmt points at a texture it does not carry, which the game
 * then takes from pak01, so the caller draws that stock texture.
 * Preview only: build.ts never imports this.
 */
import { importedFiles, type BaseKey } from './base';
import { parseKv, kvGet } from './kv';
import { decodeText } from './text';
import { decodeVTF } from '../vpk/read';

export interface ImportedArt { src: CanvasImageSource; w: number; h: number; additive: boolean }
export type ImportedMaterial = ImportedArt | { stock: string; additive: boolean } | null;

const CACHE = new Map<string, ImportedMaterial>();
const tex = (m: string) => m.trim().replace(/\\/g, '/').toLowerCase().replace(/^materials\//, '').replace(/\.(vtf|vmt)$/, '');

export function importedMaterial(key: BaseKey, material: string, canvas: (w: number, h: number) => HTMLCanvasElement | null): ImportedMaterial {
  const files = importedFiles(key);
  if (!files) return null;
  const id = `${key}|${material}`;
  if (CACHE.has(id)) return CACHE.get(id)!;
  const out = read(files, tex(material), canvas);
  CACHE.set(id, out);
  return out;
}

function read(files: ReadonlyMap<string, Uint8Array>, material: string, canvas: (w: number, h: number) => HTMLCanvasElement | null): ImportedMaterial {
  const vmt = files.get(`materials/${material}.vmt`);
  if (!vmt) return null;
  let base = material;
  let additive = false;
  try {
    const root = parseKv(decodeText(vmt).text)[0];
    if (root && typeof root.value !== 'string') {
      base = tex(kvGet(root, '$baseTexture') ?? material);
      additive = (kvGet(root, '$additive') ?? '0').trim() === '1';
    }
  } catch { return null; }
  const vtf = files.get(`materials/${base}.vtf`);
  if (!vtf) return { stock: base, additive };
  try {
    const { w, h, rgba } = decodeVTF(vtf);
    const c = canvas(w, h);
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return null;
    const img = ctx.createImageData(w, h);
    img.data.set(rgba);
    ctx.putImageData(img, 0, 0);
    return { src: c, w, h, additive };
  } catch {
    console.warn(`HUD preview: could not read materials/${base}.vtf in the imported HUD`);
    return null;
  }
}

/** Tests only: forget every decoded texture. */
export function _resetImportedArt(): void { CACHE.clear(); }
