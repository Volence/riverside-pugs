import { readFileSync } from 'node:fs';

/**
 * Load .env into the environment, the way systemd does for the service.
 *
 * The app itself never reads .env: `pug-web.service` has EnvironmentFile and
 * that is the only thing that supplies DB_PATH, DEMO_DIR and the R2 keys. A
 * script run by hand inherits none of it and would otherwise report "R2 is not
 * configured" while sitting next to a perfectly good .env file, which is a
 * confusing way to be told to prefix a command with `set -a`.
 *
 * Deliberately does not override anything already set, so a one-off
 * `DEMO_DIR=/somewhere npx tsx ...` still wins. Deliberately lives here and not
 * in src/config.ts: how the SERVER gets its configuration is systemd's job and
 * is not being changed.
 */
export function loadDotEnv(path = '.env'): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // No .env is fine: the environment may already carry everything.
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    // Strip one layer of matching quotes, which systemd also accepts.
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    process.env[m[1]] ??= value;
  }
}
