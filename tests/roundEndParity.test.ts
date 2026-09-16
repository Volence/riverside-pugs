import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseLogDatagram } from '../src/logParse.js';

/** Parity backstop between the plugin's ROUND_END emit and src/logParse.ts.
 *
 *  Same family as tests/eventKindsParity.test.ts and statKeysParity, and the
 *  same hazard: the line is free text over UDP, so a field the plugin renames
 *  or drops is not an error anywhere, it is a column that quietly goes null
 *  forever. survivors_alive is the newest and therefore the likeliest to be
 *  lost in a future edit of EmitRoundEnd, and its absence reads downstream as
 *  "not measured", which looks exactly like normal old data.
 *
 *  Deliberately regex-over-text, like its siblings. The non-vacuous assertion
 *  below is what stops a shape change from turning this into a silent pass. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginSrc = readFileSync(join(__dirname, '../plugin/pug-match.sp'), 'utf8');

/** The format string the plugin emits ROUND_END with. */
function roundEndFormat(src: string): string {
  const m = src.match(/EmitPug\(\s*"(ROUND_END[^"]*)"/);
  return m ? m[1] : '';
}

describe('ROUND_END parity between plugin and parser', () => {
  const fmt = roundEndFormat(pluginSrc);

  it('finds the emit at all', () => {
    // Guards the regex itself: if EmitRoundEnd is restructured so this stops
    // matching, fail loudly here rather than pass every assertion below on an
    // empty string.
    expect(fmt).toMatch(/^ROUND_END /);
  });

  it('still carries every field the parser reads', () => {
    for (const field of ['map', 'half', 'surv', 'score', 'alive']) {
      expect(fmt).toContain(`${field}=`);
    }
  });

  it('parses a line built from the plugin format with real values', () => {
    // Substitutes the printf placeholders in order, so this exercises the
    // actual emitted shape rather than a hand-copied imitation of it.
    const values = ['l4d_vs_hospital01_apartment', '2', 'b', '412', '3'];
    let i = 0;
    const body = fmt.replace(/%[sd]/g, () => values[i++]);
    const token = 'a'.repeat(32);
    const ev = parseLogDatagram(Buffer.from(`\xff\xff\xff\xffPUG ${token} ${body}\n`, 'binary'));
    expect(ev).toMatchObject({
      kind: 'round_end', map: 'l4d_vs_hospital01_apartment', half: 2, surv: 'b', score: 412, alive: 3,
    });
  });
});
