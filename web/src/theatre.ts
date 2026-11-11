/**
 * The 3D theatre: a match map's SourceTV demo played back in 3D (docs/theatre-3d.md).
 *
 * The viewer is its own static page (web/public/theatre/viewer/, copied from the
 * theatre spike by tools/sync-theatre.sh, never edited here), embedded in the match
 * page in an iframe. It parses the .dem in a browser worker and reads the site's
 * bookmarks from the public match routes, so it only needs to be told which demo,
 * which match and which map ordinal. This module is the pure part: where the page
 * and its assets live, what the manifest says, and the iframe URL.
 */
import { mirrorMapOriginal } from '../../src/campaigns';

/** The viewer page. Same origin as the site on purpose: its demo worker must be
 *  same-origin, and it reads /api/matches/<id> and /api/replays/timeline/... with
 *  no CORS involved. */
export const THEATRE_PAGE = '/theatre/viewer/index.html';

/** Where the heavy assets (maps, models, sounds) and manifest.json live. Same origin
 *  for now (web/public/theatre/). Pointing this at the R2 bucket
 *  ('https://assets.riversidepug.com/theatre') needs a CORS rule on the bucket
 *  first; see docs/theatre-3d.md "Serving". */
export const THEATRE_ASSETS = '/theatre';

export interface TheatreMap {
  /** Has baked lighting (.lit.glb and its side files). */
  lit: boolean;
  /** Has the low-triangle variant the software-rendering tier loads. */
  low: boolean;
  /** What a viewer on a GPU downloads for this map: the full glb and its side files. */
  bytes: number;
}

export interface TheatreManifest {
  format: string;
  generated: string;
  bytes?: Record<string, number>;
  maps: Record<string, TheatreMap>;
}

/** Read manifest.json defensively: anything malformed is "no maps", never a throw,
 *  so a bad sync shows the no-map message instead of breaking the match page. */
export function parseManifest(raw: unknown): TheatreManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<TheatreManifest>;
  if (r.format !== 'theatre-manifest/1' || !r.maps || typeof r.maps !== 'object') return null;
  const maps: Record<string, TheatreMap> = {};
  for (const [name, m] of Object.entries(r.maps)) {
    if (!m || typeof m !== 'object') continue;
    maps[name] = { lit: Boolean(m.lit), low: Boolean(m.low), bytes: Number(m.bytes) || 0 };
  }
  return { format: r.format, generated: String(r.generated ?? ''), bytes: r.bytes, maps };
}

/** Why a map cannot be shown in 3D, or null when it can. */
export type TheatreGap = 'no-demo' | 'mirror' | 'no-map' | null;

export function theatreGap(map: string, hasDemo: boolean, manifest: TheatreManifest): TheatreGap {
  if (!hasDemo) return 'no-demo';
  if (manifest.maps[map]) return null;
  // Mirrored chapters are not converted; the viewer will draw them by mirroring
  // the original at load (owner, 2026-11-11), which it does not do yet.
  return mirrorMapOriginal(map) ? 'mirror' : 'no-map';
}

/** The iframe's URL for one map of one match.
 *
 *  demo= is the site's own demo route: it redirects to R2 in production (the
 *  fetch follows it, which needs CORS on the bucket) and streams the local file
 *  in dev. match= and ord= give the viewer the site's bookmarks for that map.
 *  map= names the map file outright rather than leaving it to the demo header,
 *  so the map starts loading while the demo is still downloading, and so the
 *  assets can move to another host without the viewer knowing. */
export function theatreSrc(
  { matchId, ordinal, map }: { matchId: number; ordinal: number; map: string },
  assets: string = THEATRE_ASSETS,
): string {
  const q = new URLSearchParams({
    demo: `/api/matches/${matchId}/demos/${ordinal}`,
    match: String(matchId),
    ord: String(ordinal),
    map: `${assets}/map/${map}.glb`,
    // The bookmarks come from this site's own API (see docs/theatre-3d.md
    // "Viewer changes": the viewer reads site=self once that change is in).
    site: 'self',
  });
  // The viewer's models default to ../models/out/ beside the page, which is
  // only right while the assets share its folder.
  if (assets !== THEATRE_ASSETS) q.set('modelbase', `${assets}/models/out/`);
  return `${THEATRE_PAGE}?${q.toString()}`;
}

/** The view a match page's map panel opens on, from the URL hash: #map-2-3d is the
 *  second map in 3D; anything else is the 2D replay. */
export function initialView(hash: string): '2d' | '3d' {
  return /^#map-\d+-3d$/.test(hash) ? '3d' : '2d';
}

let manifestPromise: Promise<TheatreManifest | null> | null = null;

/** manifest.json, fetched once per page load and shared. A failed fetch is not
 *  cached, so the next map switch tries again. */
export function loadTheatreManifest(fetchFn: typeof fetch = fetch): Promise<TheatreManifest | null> {
  if (!manifestPromise) {
    manifestPromise = fetchFn(`${THEATRE_ASSETS}/manifest.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then(parseManifest)
      .catch(() => null)
      .then((m) => { if (!m) manifestPromise = null; return m; });
  }
  return manifestPromise;
}
