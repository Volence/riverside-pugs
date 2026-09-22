import { describe, it, expect } from 'vitest';
import { parseKv, writeKv, kvFind, kvGet, kvSet } from './kv';
import { BASE_PATHS, baseFile } from './base';

describe('parseKv', () => {
  it('reads quoted and bare tokens, nesting and comments', () => {
    const t = parseKv('"Root"\r\n{\r\n\tPanel // a comment\r\n\t{\r\n\t\t"xpos"\t"r125"\r\n\t\twide 150\r\n\t}\r\n}\r\n');
    expect(t).toEqual([{ key: 'Root', value: [{ key: 'Panel', value: [
      { key: 'xpos', value: 'r125' }, { key: 'wide', value: '150' },
    ] }] }]);
  });

  it('keeps conditionals on values and on blocks', () => {
    const t = parseKv('A { "6" "resource/marlett.ttf" [$OSX]\n B [$X360] { k v } }');
    const a = t[0].value as ReturnType<typeof parseKv>;
    expect(a[0]).toEqual({ key: '6', value: 'resource/marlett.ttf', cond: '[$OSX]' });
    expect(a[1]).toEqual({ key: 'B', cond: '[$X360]', value: [{ key: 'k', value: 'v' }] });
  });

  it('keeps duplicate keys, in order', () => {
    const a = parseKv('A { k 1 k 2 }')[0].value as { key: string; value: string }[];
    expect(a.map((n) => n.value)).toEqual(['1', '2']);
  });

  it('names the line of an unclosed block', () => {
    expect(() => parseKv('A {\n k v\n')).toThrow(/line/);
  });
});

describe('round trip', () => {
  // The generator rewrites every file it touches, so anything the parser
  // drops is silently missing from the player's HUD. hudanimations.txt is not
  // KeyValues (it is a list of `event` scripts) and is patched as text instead.
  const files = BASE_PATHS.filter((p) => p !== 'scripts/hudanimations.txt');
  for (const preset of ['stock', 'modern'] as const) {
    for (const path of files) {
      it(`${preset} ${path}`, () => {
        const first = parseKv(baseFile(preset, path));
        expect(first.length).toBeGreaterThan(0);
        expect(parseKv(writeKv(first))).toEqual(first);
      });
    }
  }
});

describe('kvFind, kvGet, kvSet', () => {
  const tree = () => parseKv('"Resource/HudLayout.res" { CHudTeamDisplay { "xpos" "0" "Wide" "f0" } }');
  it('finds case-insensitively', () => {
    const t = tree();
    const panel = kvFind(t[0].value as never, ['chudteamdisplay'])!;
    expect(kvGet(panel, 'wide')).toBe('f0');
  });
  it('replaces in place and appends when absent', () => {
    const t = tree();
    const panel = kvFind(t[0].value as never, ['CHudTeamDisplay'])!;
    kvSet(panel, 'XPOS', '8');
    kvSet(panel, 'visible', '0');
    expect(writeKv(t)).toContain('"xpos"\t\t"8"');
    expect((panel.value as unknown[]).length).toBe(3);
  });
});
