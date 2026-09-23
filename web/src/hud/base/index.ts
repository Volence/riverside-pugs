/**
 * The HUD files every build starts from.
 *
 * `stock` is the game's own files, untouched. `modern` holds only the files the
 * Modern HUD overrides and falls back to stock for the rest, which is exactly
 * how the game resolves them when the Modern HUD is mounted. An imported HUD
 * is the same kind of layer: the player's upload, falling back to stock
 * whole-file where the upload has no copy, because that is how the game
 * resolves an addon's files. It is never merged key by key.
 *
 * Everything that reads a base file takes a BaseKey rather than a Preset:
 * the preset alone cannot tell two imports apart, and every cache of a
 * parsed base file is keyed by it. An import's id is the SHA-256 of its
 * files (upload.ts's hudId), so what a key names never changes and a cache
 * entry for it stays valid for ever.
 *
 * The imported files live in a synchronous in-memory registry, filled by
 * the page from IndexedDB before it first draws, so baseFile stays
 * synchronous. An import that is not in the registry throws
 * MissingImportError: falling back to stock would draw the wrong HUD and
 * cache it under the import's key.
 */
import { decodeText } from '../text';

export type Preset = 'stock' | 'modern' | 'imported';
export type BaseKey = 'stock' | 'modern' | `imported:${string}`;

const RAW = import.meta.glob('./{stock,modern}/**/*.{res,txt}', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const at = (preset: 'stock' | 'modern', path: string) => RAW[`./${preset}/${path}`];

export const BASE_PATHS: string[] = Object.keys(RAW)
  .filter((k) => k.startsWith('./stock/'))
  .map((k) => k.slice('./stock/'.length))
  .sort();

export class MissingImportError extends Error {
  constructor(readonly id: string) { super(`The imported HUD ${id.slice(0, 12)} is not loaded in this browser`); }
}

const IMPORTS = new Map<string, ReadonlyMap<string, Uint8Array>>();
/** Paths are lower case with forward slashes, as upload.ts gives them. */
export function registerImport(id: string, files: ReadonlyMap<string, Uint8Array>): void { IMPORTS.set(id, files); }
export function unregisterImport(id: string): void { IMPORTS.delete(id); }
export function hasImport(id: string): boolean { return IMPORTS.has(id); }

/** The upload's files for an imported key, null for Stock and Modern. */
export function importedFiles(key: BaseKey): ReadonlyMap<string, Uint8Array> | null {
  if (!key.startsWith('imported:')) return null;
  const id = key.slice('imported:'.length);
  const files = IMPORTS.get(id);
  if (!files) throw new MissingImportError(id);
  return files;
}

/** A design's base key. validateDesign never lets an imported design through without its reference. */
export function baseOf(d: { preset: Preset; imported?: { id: string } }): BaseKey {
  if (d.preset !== 'imported') return d.preset;
  if (!d.imported) throw new Error('An imported design has no imported HUD');
  return `imported:${d.imported.id}`;
}

export function baseFile(key: BaseKey, path: string): string {
  const layer = importedFiles(key);
  if (layer) {
    const own = layer.get(path.toLowerCase());
    return own ? decodeText(own).text : baseFile('stock', path);
  }
  const text = at(key as 'stock' | 'modern', path) ?? at('stock', path);
  if (text === undefined) throw new Error(`No base HUD file ${path}`);
  return text;
}

/**
 * True when Modern ships its own copy, so a build must include the file even
 * if nothing else touches it. An import's own files reach the download
 * through buildHud's pass-through instead, byte for byte.
 */
export function presetOverrides(key: BaseKey, path: string): boolean {
  return key === 'modern' && at('modern', path) !== undefined;
}
