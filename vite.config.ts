import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

/** The API the dev proxy talks to. :8080 unless API_PORT says otherwise, so a
 *  second checkout can run its own API beside another session's. */
const apiPort = process.env.API_PORT ?? '8080';

/** Frontend build. Source lives in `web/`, output goes to `dist/public/`, which is
 *  what Fastify serves statically (see src/server.ts). `public/` no longer exists.
 *
 *  In dev the Vite server owns the browser and proxies everything the backend owns
 *  to :8080 (or API_PORT), so `npm run dev` gives HMR on the frontend without the API moving. */
/** The caster studio's OBS overlays are a second page (web/overlay.html) with
 *  no site chrome, and the players' stream widgets a third (web/widget.html).
 *  In production the server answers /overlay/* and /widget/<steamid>/<kind>
 *  with them (see the not-found handler in src/server.ts); this does the same
 *  in dev. */
const overlayPages: Plugin = {
  name: 'overlay-pages',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/overlay\/[a-z]+\/?(\?|$)/.test(req.url)) req.url = `/overlay.html${req.url.slice(req.url.indexOf('?') >= 0 ? req.url.indexOf('?') : req.url.length)}`;
      else if (req.url && /^\/widget\/\d{17}\/[a-z]+\/?(\?|$)/.test(req.url)) req.url = `/widget.html${req.url.slice(req.url.indexOf('?') >= 0 ? req.url.indexOf('?') : req.url.length)}`;
      next();
    });
  },
};

/** Content types for the theatre's heavy set in dev (the same table as
 *  scripts/upload-theatre.ts gives R2). */
const THEATRE_TYPES: Record<string, string> = {
  '.glb': 'model/gltf-binary', '.json': 'application/json', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.webp': 'image/webp', '.ogg': 'audio/ogg',
};

/** The 3D theatre in dev (docs/theatre-3d.md, tools/sync-theatre.sh).
 *
 *  - `/theatre/<version>/...` is the heavy set (maps, models, sounds, light),
 *    which production loads from R2 and which the sync stages in
 *    theatre-assets/<version>/, outside web/ so a build never copies it. Served
 *    from there, so dev runs the same URLs as production on its own origin.
 *  - Anything else under /theatre/ is the small set in web/public/theatre/
 *    (served by Vite's public-folder middleware before this runs). A missing
 *    file there is a 404, as in production (isPageRequest in src/server.ts),
 *    not the app shell Vite's HTML fallback would hand back: the viewer probes
 *    for optional files and reads any 200 as the file. */
const theatreDev: Plugin = {
  name: 'theatre-dev',
  configureServer(server) {
    const root = fileURLToPath(new URL('./web/public/', import.meta.url));
    const assets = fileURLToPath(new URL('./theatre-assets/', import.meta.url));
    server.middlewares.use((req, res, next) => {
      const path = req.url?.split('?')[0] ?? '';
      if (!path.startsWith('/theatre/')) return next();
      let decoded: string;
      try { decoded = decodeURIComponent(path); } catch { decoded = ''; }
      const version = /^\/theatre\/([A-Za-z0-9._-]+)\//.exec(decoded)?.[1];
      if (version && version !== 'viewer' && version !== 'sound' && existsSync(join(assets, version))) {
        const file = normalize(join(assets, decoded.slice('/theatre/'.length)));
        if (file.startsWith(join(assets, version)) && existsSync(file) && statSync(file).isFile()) {
          res.setHeader('Content-Type', THEATRE_TYPES[extname(file)] ?? 'application/octet-stream');
          res.setHeader('Content-Length', String(statSync(file).size));
          if (req.method === 'HEAD') { res.end(); return; }
          createReadStream(file).pipe(res);
          return;
        }
      } else {
        const file = normalize(join(root, decoded));
        if (decoded && file.startsWith(root) && existsSync(file) && statSync(file).isFile()) return next();
      }
      res.statusCode = 404;
      res.end('not found');
    });
  },
};

export default defineConfig({
  root: 'web',
  plugins: [preact(), overlayPages, theatreDev],
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./web/index.html', import.meta.url)),
        overlay: fileURLToPath(new URL('./web/overlay.html', import.meta.url)),
        widget: fileURLToPath(new URL('./web/widget.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/auth': `http://localhost:${apiPort}`,
      '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
});
