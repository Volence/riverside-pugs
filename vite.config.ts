import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

/** The API the dev proxy talks to. :8080 unless API_PORT says otherwise, so a
 *  second checkout can run its own API beside another session's. */
const apiPort = process.env.API_PORT ?? '8080';

/** Frontend build. Source lives in `web/`, output goes to `dist/public/`, which is
 *  what Fastify serves statically (see src/server.ts). `public/` no longer exists.
 *
 *  In dev the Vite server owns the browser and proxies everything the backend owns
 *  to :8080 (or API_PORT), so `npm run dev` gives HMR on the frontend without the API moving. */
export default defineConfig({
  root: 'web',
  plugins: [preact()],
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
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
