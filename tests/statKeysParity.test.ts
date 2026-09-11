import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STAT_DEFS } from '../src/statKeys.js';

/** Parity backstop between plugin/pug-stats.inc and src/statKeys.ts.
 *
 *  g_sStatKey in the plugin is index-aligned with the PugStat enum and must
 *  match STAT_DEFS in both content and order: a single misordered entry
 *  silently mislabels every stat after it. This was verified once by hand
 *  (see the plugin's own "MUST match src/statKeys.ts exactly" comment) and
 *  was otherwise unprotected against the next edit to either file.
 *
 *  Parsing is deliberately simple regex-over-text rather than a real
 *  SourcePawn parser. If the plugin's shape changes enough that these
 *  regexes stop matching, every extractor below throws or returns an empty
 *  array, and the explicit non-zero-count assertions turn that into a loud
 *  test failure rather than a silent, vacuously-passing "0 == 0". */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = join(__dirname, '../plugin/pug-stats.inc');
const pluginSrc = readFileSync(PLUGIN_PATH, 'utf8');

function extractBlock(src: string, pattern: RegExp, what: string): string {
  const m = src.match(pattern);
  if (!m) throw new Error(`statKeysParity: could not find ${what} in ${PLUGIN_PATH}; plugin/pug-stats.inc shape changed`);
  return m[1];
}

/** Enum member names, in declaration order, with the PS_MAX sentinel dropped. */
function extractEnumMembers(src: string): string[] {
  const block = extractBlock(src, /enum\s+PugStat\s*\{([\s\S]*?)\}/, 'enum PugStat { ... }');
  const members = block.match(/PS_[A-Za-z0-9]+/g) ?? [];
  return members.filter((m) => m !== 'PS_MAX');
}

/** g_sStatKey string literals, in array order. */
function extractStatKeyArray(src: string): string[] {
  const block = extractBlock(
    src,
    /g_sStatKey\[PS_MAX\]\[\d+\]\s*=\s*\{([\s\S]*?)\};/,
    'g_sStatKey[PS_MAX][...] = { ... };',
  );
  return Array.from(block.matchAll(/"([^"]*)"/g)).map((m) => m[1]);
}

/** Enum members named in StatNeedsSkillDetect's `s != PS_X && ...` condition:
 *  exactly the ones for which the function returns false, i.e. needsSkillDetect
 *  should be false in STAT_DEFS. */
function extractNeedsSkillDetectFalseMembers(src: string): string[] {
  const block = extractBlock(
    src,
    /StatNeedsSkillDetect\(PugStat s\)\s*\{([\s\S]*?)\}/,
    'StatNeedsSkillDetect(PugStat s) { ... }',
  );
  return block.match(/PS_[A-Za-z0-9]+/g) ?? [];
}

describe('plugin/pug-stats.inc <-> src/statKeys.ts parity', () => {
  const enumMembers = extractEnumMembers(pluginSrc);
  const statKeyArray = extractStatKeyArray(pluginSrc);
  const falseMembers = extractNeedsSkillDetectFalseMembers(pluginSrc);

  it('parsed a non-zero, internally consistent set from the plugin file', () => {
    // Guards the parser itself: if any regex above stopped matching, these
    // extractors would all return [], and every comparison below would pass
    // vacuously on empty arrays. Fail loudly instead.
    expect(enumMembers.length).toBeGreaterThan(0);
    expect(statKeyArray.length).toBeGreaterThan(0);
    expect(falseMembers.length).toBeGreaterThan(0);
    expect(enumMembers.length).toBe(statKeyArray.length);
  });

  it('has the same count as STAT_DEFS', () => {
    expect(statKeyArray.length).toBe(STAT_DEFS.length);
  });

  it('matches STAT_DEFS keys in the same order', () => {
    expect(statKeyArray).toEqual(STAT_DEFS.map((d) => d.key));
  });

  it("StatNeedsSkillDetect's false-set matches STAT_DEFS's needsSkillDetect: false entries", () => {
    // enumMembers and statKeyArray are index-aligned (both read off the same
    // positions in the plugin), so this maps enum member name -> wire key
    // without needing to know the enum's own spelling convention.
    const memberToKey = new Map(enumMembers.map((m, i) => [m, statKeyArray[i]]));
    const falseKeys = new Set(falseMembers.map((m) => {
      const key = memberToKey.get(m);
      if (!key) throw new Error(`statKeysParity: StatNeedsSkillDetect references unknown enum member ${m}`);
      return key;
    }));
    const expectedFalseKeys = new Set(STAT_DEFS.filter((d) => !d.needsSkillDetect).map((d) => d.key));
    expect(falseKeys).toEqual(expectedFalseKeys);
  });
});

describe('plugin wire-key buffer', () => {
  it('keeps every key inside the plugin char[24]', () => {
    // g_sStatKey is char[PS_MAX][24]. A longer key is truncated on the wire and
    // arrives as an unknown key the backend drops, which looks exactly like a
    // stat that was never captured.
    for (const key of extractStatKeyArray(pluginSrc)) expect(key.length).toBeLessThan(24);
  });
});
