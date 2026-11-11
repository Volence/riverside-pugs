/**
 * The 3D theatre: a match map's SourceTV demo played back in 3D (docs/theatre-3d.md).
 *
 * The viewer is its own static page (web/public/theatre/viewer/, copied from the
 * theatre spike by tools/sync-theatre.sh, never edited here), embedded in the match
 * page in an iframe. It parses the .dem in a browser worker and reads the site's
 * bookmarks from the public match routes, so it only needs to be told which demo,
 * which match, which map ordinal and where the heavy files are. This module is the
 * pure part: where the page and its assets live, what the manifest says, the
 * iframe URL, and which view a visitor starts on.
 */

/** The viewer page. Same origin as the site on purpose: its demo and sound
 *  workers are module workers, which must come from the page's origin, and it
 *  reads /api/matches/<id> and /api/replays/timeline/... with no CORS involved. */
export const THEATRE_PAGE = '/theatre/viewer/index.html';

/** The synced manifest (tools/sync-theatre.sh): same origin, beside the page,
 *  because it names the asset version every other URL is built from. */
export const THEATRE_MANIFEST = '/theatre/manifest.json';

/** Where the heavy files' versioned folders live (maps, models, sounds, light):
 *  `<host><version>/map/...`. R2 in production, which sends CORS for the site's
 *  origin on GET and HEAD; this site's own /theatre/ in development, where
 *  vite.config.ts serves `/theatre/<version>/` from theatre-assets/<version>/.
 *  VITE_THEATRE_ASSETS overrides either (a local stand-in for R2 in a test). */
export const THEATRE_ASSET_HOST: string = (import.meta.env.VITE_THEATRE_ASSETS as string | undefined)
  ?? (import.meta.env.PROD ? 'https://assets.riversidepug.com/theatre/' : '/theatre/');

/** One asset version's folder, with the trailing slash the viewer's assets= wants. */
export function theatreAssets(version: string, host: string = THEATRE_ASSET_HOST): string {
  return `${host.replace(/\/*$/, '/')}${version}/`;
}

export interface TheatreMap {
  /** Has baked lighting (.lit.glb and its side files). */
  lit: boolean;
  /** Has the low-triangle variant the software-rendering tier loads. */
  low: boolean;
  /** What a viewer on a GPU downloads for this map: the full glb and its side files. */
  bytes: number;
  /** A mirror map: the viewer draws it by reflecting this original's files. */
  mirrorOf?: string;
}

export interface TheatreManifest {
  /** The heavy set's content version: its folder under the asset host. */
  version: string;
  generated: string;
  /** Whether the synced viewer can draw a mirror map from its original. */
  mirrors: boolean;
  maps: Record<string, TheatreMap>;
}

/** Read manifest.json defensively: anything malformed is "no maps", never a throw,
 *  so a bad sync shows the no-map message instead of breaking the match page. */
export function parseManifest(raw: unknown): TheatreManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as {
    format?: unknown; version?: unknown; generated?: unknown;
    viewer?: { mirrors?: unknown }; maps?: Record<string, unknown>;
  };
  if (r.format !== 'theatre-manifest/2' || typeof r.version !== 'string' || !/^[A-Za-z0-9._-]+$/.test(r.version)) return null;
  if (!r.maps || typeof r.maps !== 'object') return null;
  const maps: Record<string, TheatreMap> = {};
  for (const [name, v] of Object.entries(r.maps)) {
    if (!v || typeof v !== 'object') continue;
    const m = v as { lit?: unknown; low?: unknown; bytes?: unknown; mirror_of?: unknown };
    maps[name] = { lit: Boolean(m.lit), low: Boolean(m.low), bytes: Number(m.bytes) || 0 };
    if (typeof m.mirror_of === 'string' && m.mirror_of) maps[name].mirrorOf = m.mirror_of;
  }
  return { version: r.version, generated: String(r.generated ?? ''), mirrors: r.viewer?.mirrors === true, maps };
}

/** Why a map cannot be shown in 3D, or null when it can. */
export type TheatreGap = 'no-demo' | 'mirror' | 'no-map' | null;

/** Entirely from the manifest: a map it lists can be shown; a mirror it lists can
 *  be shown once the synced viewer draws mirrors (it reflects the original at
 *  load) and the original is there too; anything else is not converted yet. */
export function theatreGap(map: string, hasDemo: boolean, manifest: TheatreManifest): TheatreGap {
  if (!hasDemo) return 'no-demo';
  const m = manifest.maps[map];
  if (!m) return 'no-map';
  if (!m.mirrorOf) return null;
  return manifest.mirrors && manifest.maps[m.mirrorOf] ? null : 'mirror';
}

/** The iframe's URL for one map of one match (viewer README "Site embedding").
 *
 *  demo= is the site's own demo route: it redirects to R2 in production (the
 *  fetch follows it; the bucket sends CORS for the site) and streams the local
 *  file in dev. site=self with match= and ord= reads that map's bookmarks from
 *  this origin's API. assets= is the version's folder for maps, models and
 *  sounds; ambbase= puts the character light there too. map= names the map file
 *  outright so it starts loading while the demo downloads; not for a mirror,
 *  whose files are its original's and which the viewer resolves itself. */
export function theatreSrc(
  { matchId, ordinal, map, mirror = false }: { matchId: number; ordinal: number; map: string; mirror?: boolean },
  assets: string,
): string {
  const base = assets.replace(/\/*$/, '/');
  const q = new URLSearchParams({
    embed: '1',
    site: 'self',
    match: String(matchId),
    ord: String(ordinal),
    demo: `/api/matches/${matchId}/demos/${ordinal}`,
    assets: base,
    ambbase: `${base}light/`,
  });
  if (!mirror) q.set('map', `${base}map/${map}.glb`);
  return `${THEATRE_PAGE}?${q.toString()}`;
}

/** How far behind the newest released data the live view plays, in seconds.
 *  srcds writes a growing demo in 688 KiB pieces about every 25 s (measured,
 *  docs/theatre-3d.md), so the viewer must hold more than one piece in hand or
 *  it stalls between them; the site's own 10 s hold comes on top. */
export const LIVE_BUFFER_S = 30;

/** The iframe's URL for a live match: the match's live demo feed
 *  (src/routes/demoLive.ts) as the viewer's live= relay, over WebSocket on the
 *  page's own host. No map=: the map changes during a match, and the viewer
 *  loads the one each recording's header names (a mirror too). Opens on the
 *  top-down overview (owner, 2026-11-11). */
export function theatreLiveSrc(
  { matchId }: { matchId: number },
  assets: string,
  origin: { protocol: string; host: string },
): string {
  const base = assets.replace(/\/*$/, '/');
  const ws = `${origin.protocol === 'https:' ? 'wss' : 'ws'}://${origin.host}/api/demos/live/match/${matchId}/ws`;
  const q = new URLSearchParams({
    embed: '1',
    live: ws,
    livebuf: String(LIVE_BUFFER_S),
    view: 'top',
    assets: base,
    ambbase: `${base}light/`,
  });
  return `${THEATRE_PAGE}?${q.toString()}`;
}

export type TheatreView = '2d' | '3d';

/** The view a link asks for: #map-2-3d is the second map in 3D. A plain #map-2
 *  (or no hash) asks for nothing, and the visitor's own default applies. */
export function hashView(hash: string): TheatreView | null {
  return /^#map-\d+-3d$/.test(hash) ? '3d' : null;
}

const VIEW_KEY = 'theatre.view';

/** The view this browser last picked with the 2D / 3D switch, if any. */
export function storedView(): TheatreView | null {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === '2d' || v === '3d' ? v : null;
  } catch { return null; }
}

export function storeView(v: TheatreView): void {
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* private window: it holds for this visit */ }
}

/** The renderer strings of a browser drawing WebGL on the CPU: SwiftShader
 *  (Chrome without a usable GPU, or with it blocklisted), llvmpipe / softpipe
 *  (Mesa), Microsoft Basic Render Driver. The viewer runs there at 4 to 6 fps. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/** What a visitor sees first when no link and no earlier pick says otherwise.
 *
 *  3D, except where it would be a bad first look: a phone (a coarse pointer on
 *  a narrow screen, or a mobile user agent: a 15 to 100 MB demo, a small screen,
 *  a hot battery), a browser without WebGL2, or one whose WebGL is software
 *  rendered (the renderer string names a CPU rasteriser). Those start on 2D;
 *  the switch still offers 3D. Decided once per page load. */
export function deviceView(env: {
  phone?: boolean; renderer?: string | null; webgl2?: boolean;
} = probeDevice()): TheatreView {
  if (env.phone) return '2d';
  if (!env.webgl2) return '2d';
  if (env.renderer && SOFTWARE_RENDERER.test(env.renderer)) return '2d';
  return '3d';
}

let probed: { phone: boolean; renderer: string | null; webgl2: boolean } | null = null;

/** The browser facts deviceView reads. A throw anywhere is "no WebGL2". */
export function probeDevice(): { phone: boolean; renderer: string | null; webgl2: boolean } {
  if (probed) return probed;
  let phone = false;
  let renderer: string | null = null;
  let webgl2 = false;
  try {
    phone = /Mobi|Android|iPhone|iPod/i.test(navigator.userAgent)
      || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse) and (max-width: 900px)').matches);
  } catch { /* no navigator: not a phone */ }
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl) {
      webgl2 = true;
      // Chrome and Firefox now give the real renderer in RENDERER; the debug
      // extension is the older way and still the only one in some browsers.
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { webgl2 = false; }
  probed = { phone, renderer, webgl2 };
  return probed;
}

let manifestPromise: Promise<TheatreManifest | null> | null = null;

/** For tests: forget the shared manifest (and the device probe). */
export function resetTheatreCache(): void {
  manifestPromise = null;
  probed = null;
}

/** manifest.json, fetched once per page load and shared. A failed fetch is not
 *  cached, so the next map switch tries again. */
export function loadTheatreManifest(fetchFn: typeof fetch = fetch): Promise<TheatreManifest | null> {
  if (!manifestPromise) {
    manifestPromise = fetchFn(THEATRE_MANIFEST, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then(parseManifest)
      .catch(() => null)
      .then((m) => { if (!m) manifestPromise = null; return m; });
  }
  return manifestPromise;
}
