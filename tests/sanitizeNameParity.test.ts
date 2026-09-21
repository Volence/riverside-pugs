import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** The plugin half of the roster name fix. src/logParse.ts no longer reads a
 *  field out of a name, but a name that LOOKS like fields is still a lure for
 *  the next parser, the rcon dump and anyone reading a raw log, so SanitizeName
 *  takes the two characters that make one: '=' and '"'.
 *
 *  Regex-over-text like the other parity tests, since nothing here can run
 *  SourcePawn. The first assertion guards the regex itself. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginSrc = readFileSync(join(__dirname, '../plugin/pug-match.sp'), 'utf8');

function sanitizeNameBody(src: string): string {
  const m = src.match(/\nvoid SanitizeName\([^)]*\)\n\{\n([\s\S]*?)\n\}\n/);
  return m ? m[1] : '';
}

describe('SanitizeName', () => {
  const body = sanitizeNameBody(pluginSrc);

  it('is found at all', () => {
    expect(body).toContain('GetClientName');
  });

  it('still drops control bytes', () => {
    expect(body).toMatch(/raw\[i\] >= 32 && raw\[i\] != 127/);
  });

  it('replaces = and " so a name cannot look like a field', () => {
    expect(body).toMatch(/raw\[i\] == '='/);
    expect(body).toMatch(/raw\[i\] == '\\?"'/);
    expect(body).toMatch(/out\[w\+\+\] = '_'/);
  });
});
