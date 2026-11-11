import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

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

/** The 3D viewer's static folder (web/public/theatre/, tools/sync-theatre.sh):
 *  a missing file there is a 404, as in production (isPageRequest in
 *  src/server.ts), not the app shell Vite's HTML fallback would hand back. The
 *  viewer probes for optional files and reads any 200 as the file. Files that
 *  exist are served by Vite's public-folder middleware before this runs. */
const theatre404: Plugin = {
  name: 'theatre-404',
  configureServer(server) {
    const root = fileURLToPath(new URL('./web/public/', import.meta.url));
    server.middlewares.use((req, res, next) => {
      const path = req.url?.split('?')[0] ?? '';
      if (!path.startsWith('/theatre/')) return next();
      let file: string;
      try { file = normalize(join(root, decodeURIComponent(path))); } catch { file = ''; }
      if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) return next();
      res.statusCode = 404;
      res.end('not found');
    });
  },
};

export default defineConfig({
  root: 'web',
  plugins: [preact(), overlayPages, theatre404],
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
