// @vitest-environment node
//
// Node, not happy-dom: this reads the saved dll strings off disk with node:fs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PANEL_CHILDREN } from './children';
import { ELEMENTS } from './elements';

/**
 * The honest registry: a control may write a file key, and the editor may add
 * a child, only if client.dll names it. dll-hud-strings.txt is the dll's
 * string runs around its HUD code (regenerate with
 * `bash scripts/dll-hud-strings.sh`), and a name counts only as a whole
 * line: MSVC pools string literals, so a short name like `Head` or `Dead`
 * turns up inside other strings and proves nothing (spec section 0). Child
 * names that are not added by the editor are not demanded here, because the
 * stock files already prove the game reads those blocks (children.test.ts).
 */
const here = fileURLToPath(new URL('.', import.meta.url));

describe('the registry offers only what client.dll can read', () => {
  const lines = readFileSync(`${here}dll-hud-strings.txt`, 'latin1').split(/\r?\n/);
  const has = new Set(lines.filter((l) => !l.startsWith('# ')));
  it('was read from the dll the spec was written against', () => {
    expect(lines[0]).toBe('# client.dll md5 9be2860914a3e33cce82b91473148459');
  });
  it('names every file key a control writes', () => {
    for (const p of PANEL_CHILDREN) for (const c of p.children) for (const k of c.keys ?? []) expect(has.has(k.key), `${p.panelId} ${c.name} ${k.key}`).toBe(true);
    for (const el of ELEMENTS) for (const k of el.keys ?? []) expect(has.has(k.key), `${el.id} ${k.key}`).toBe(true);
  });
  it('names every child the editor can add, since only a looked-up child is live', () => {
    for (const p of PANEL_CHILDREN) for (const c of p.children.filter((x) => x.addable)) expect(has.has(c.name), `${p.panelId} ${c.name}`).toBe(true);
  });
  it('would catch a key the dll never names', () => {
    expect(has.has('monochrome_color')).toBe(true);
    expect(has.has('HudEdNotAKey')).toBe(false);
  });
});
