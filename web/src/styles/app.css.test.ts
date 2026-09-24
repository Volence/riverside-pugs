// web/src/styles/app.css.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The stylesheet has to parse.
 *
 * A block left open by a deletion does not fail a component test, because no
 * unit test in this repo parses CSS: it fails `npm run build`, and until then
 * every rule written after the open block silently moves inside it. That is
 * how the whole live board, every admin table and every admin form ended up
 * scoped to `@media (max-width: 480px)` and invisible at desktop width while
 * 3486 tests stayed green.
 */
const css = readFileSync(join(__dirname, 'app.css'), 'utf8');

/** Line numbers of every `{` that is never closed, and of every stray `}`. */
function unbalanced(source: string): { unclosed: number[]; extra: number[] } {
  // A brace inside a comment is text, not structure.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[{}]/g, ' '));
  const unclosed: number[] = [];
  const extra: number[] = [];
  let line = 1;
  for (const ch of stripped) {
    if (ch === '\n') line += 1;
    else if (ch === '{') unclosed.push(line);
    else if (ch === '}') {
      if (unclosed.length === 0) extra.push(line);
      else unclosed.pop();
    }
  }
  return { unclosed, extra };
}

describe('app.css', () => {
  it('closes every block it opens', () => {
    const { unclosed, extra } = unbalanced(css);
    expect(unclosed, 'blocks opened and never closed, by line').toEqual([]);
    expect(extra, 'closing braces with nothing open, by line').toEqual([]);
  });

  // An action column inside the sideways scroll of a phone-width table is an
  // action nobody can reach. Two tables need it, so the rule is a modifier
  // rather than something scoped to whichever table asked for it first.
  it('pins the last column of a table that asks for it, whichever table that is', () => {
    const rule = css.match(/\.admin-table--pin-last[^{]*\{[^}]*\}/);
    expect(rule, '.admin-table--pin-last is not defined').toBeTruthy();
    expect(rule![0]).toContain('position: sticky');
    expect(rule![0]).toContain('right: 0');
    // Scoped to the modifier, never to one table's own class.
    expect(css).not.toMatch(/\.admin-table--recent[^,{]*last-child/);
  });
});
