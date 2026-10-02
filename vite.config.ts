import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

/** The API the dev proxy talks to. :8080 unless API_PORT says otherwise, so a
 *  second checkout can run its own API beside another session's. */
const apiPort = process.env.API_PORT ?? '8080';

/** Frontend build. Source lives in `web/`, output goes to `dist/public/`, which is
 *  what Fastify serves statically (see src/server.ts). `public/` no longer exists.
 *
 *  In dev the Vite server owns the browser and proxies everything the backend owns
 *  to :8080 (or API_PORT), so `npm run dev` gives HMR on the frontend without the API moving. */
/** The caster studio's OBS overlays are a second page (web/overlay.html) with
 *  no site chrome. In production the server answers /overlay/* with it (see
 *  the not-found handler in src/server.ts); this does the same in dev. */
const overlayPages: Plugin = {
  name: 'overlay-pages',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/overlay\/[a-z]+(\?|$)/.test(req.url)) req.url = `/overlay.html${req.url.slice(req.url.indexOf('?') >= 0 ? req.url.indexOf('?') : req.url.length)}`;
      next();
    });
  },
};

export default defineConfig({
  root: 'web',
  plugins: [preact(), overlayPages],
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./web/index.html', import.meta.url)),
        overlay: fileURLToPath(new URL('./web/overlay.html', import.meta.url)),
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
