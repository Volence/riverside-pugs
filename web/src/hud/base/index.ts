/**
 * The HUD files every build starts from.
 *
 * `stock` is the game's own files, untouched. `modern` holds only the files the
 * Modern HUD overrides and falls back to stock for the rest, which is exactly
 * how the game resolves them when the Modern HUD is mounted.
 */
export type Preset = 'stock' | 'modern';

const RAW = import.meta.glob('./{stock,modern}/**/*.{res,txt}', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const at = (preset: Preset, path: string) => RAW[`./${preset}/${path}`];

export const BASE_PATHS: string[] = Object.keys(RAW)
  .filter((k) => k.startsWith('./stock/'))
  .map((k) => k.slice('./stock/'.length))
  .sort();

export function baseFile(preset: Preset, path: string): string {
  const text = at(preset, path) ?? at('stock', path);
  if (text === undefined) throw new Error(`No base HUD file ${path}`);
  return text;
}

/** True when the preset ships its own copy, so a build must include the file even if nothing else touches it. */
export function presetOverrides(preset: Preset, path: string): boolean {
  return preset !== 'stock' && at(preset, path) !== undefined;
}
