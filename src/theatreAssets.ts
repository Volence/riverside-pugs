/**
 * The 3D theatre's heavy set on R2 (docs/theatre-3d.md, scripts/upload-theatre.ts).
 *
 * tools/sync-theatre.sh stages one folder per content version under
 * theatre-assets/<version>/ (maps, models, sounds, character light and the
 * manifest), and the upload puts each file at theatre/<version>/<path> in the
 * bucket, which serves it at https://assets.riversidepug.com/theatre/<version>/.
 * A version never changes once cut (its name is a hash of its content), so the
 * objects are cached for a year, and an old site build keeps its own folder.
 */

/** The object key for one file of one version. */
export function theatreKey(version: string, rel: string): string {
  return `theatre/${version}/${rel.split(/[\\/]+/).filter(Boolean).join('/')}`;
}

/** Versioned, so immutable: see the module comment. */
export const THEATRE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const TYPES: Record<string, string> = {
  glb: 'model/gltf-binary',
  json: 'application/json',
  bin: 'application/octet-stream',
  png: 'image/png',
  webp: 'image/webp',
  ogg: 'audio/ogg',
};

/** The Content-Type for a staged file, or null for anything the heavy set
 *  should not hold (the upload refuses it rather than guessing). */
export function theatreContentType(rel: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(rel)?.[1]?.toLowerCase();
  return ext ? TYPES[ext] ?? null : null;
}

/** Files that must never be published, whatever the staging folder holds:
 *  the spike's backups and logs, the viewer's bookmark files (raw SteamID64
 *  keys) and the parser's research samples (raw SteamIDs). The sync never
 *  copies them; this is the upload's own check. */
export function theatreForbidden(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  return /(^|\/)[^/]*before[^/]*(\/|$)/.test(p)
    || /(^|\/)bookmarks\//.test(p)
    || /(^|\/)sample-[^/]*$/.test(p)
    || /\.(log|part|bak)$/.test(p)
    || /\.stats\.json$/.test(p);
}

/** A SteamID in text: SteamID64, STEAM_X:Y:Z or [U:1:N]. The SteamID64 base
 *  (76561197960265728) is a constant in the viewer's code, not a person. */
export function findSteamIds(text: string): string[] {
  const hits = text.match(/7656119\d{10}|STEAM_[0-5]:[01]:\d{4,}|\[U:1:\d{4,}\]/g) ?? [];
  return [...new Set(hits)].filter((h) => h !== '76561197960265728');
}
