import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

/** Two projects, because the halves of this repo need different environments:
 *  the backend suite talks to sqlite/sockets and must stay on node, while the
 *  frontend needs a DOM. Splitting them here keeps `npm test` a single command. */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        plugins: [preact()],
        test: {
          name: 'web',
          environment: 'happy-dom',
          include: ['web/**/*.test.{ts,tsx}'],
          setupFiles: ['web/src/testSetup.ts'],
        },
      },
    ],
  },
});
