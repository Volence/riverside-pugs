import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

/** Frontend build. Source lives in `web/`, output goes to `dist/public/`, which is
 *  what Fastify serves statically (see src/server.ts). `public/` no longer exists.
 *
 *  In dev the Vite server owns the browser and proxies everything the backend owns
 *  to :8080, so `npm run dev` gives HMR on the frontend without the API moving. */
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
      '/api': 'http://localhost:8080',
      '/auth': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
