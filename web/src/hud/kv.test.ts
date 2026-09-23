import { describe, it, expect } from 'vitest';
import { parseKv, writeKv, kvFind, kvGet, kvSet, pcApplies } from './kv';
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

describe('platform conditionals, as the Windows English client reads them', () => {
  it('keeps the lines the PC game keeps and drops the rest', () => {
    for (const c of [undefined, '[$WIN32]', '[$WINDOWS]', '[$ENGLISH]', '[!$X360]', '[!$OSX]', '[$WIN32 && $ENGLISH]', '[$OSX || $WINDOWS]']) {
      expect(pcApplies(c), String(c)).toBe(true);
    }
    for (const c of ['[$X360]', '[$OSX]', '[$LINUX]', '[$POSIX]', '[$!ENGLISH]', '[!$ENGLISH]', '[!$WIN32]', '[$WIN32 && $X360]']) {
      expect(pcApplies(c), c).toBe(false);
    }
  });

  // localplayerpanel.res gives the health number's xpos as 39 [$OSX] then 36 [$WINDOWS]:
  // the game on the PC reads 36, and an edit has to land on that line, not beside it.
  it('reads and writes the line the PC applies, leaving the other platforms alone', () => {
    const [root] = parseKv('"A" { "xpos" "39" [$OSX] "xpos" "36" [$WINDOWS] "tall" "9" [$X360] }');
    expect(kvGet(root, 'xpos')).toBe('36');
    expect(kvGet(root, 'tall')).toBeUndefined();
    kvSet(root, 'xpos', '50');
    kvSet(root, 'tall', '12');
    expect(writeKv([root]).replace(/\s+/g, ' ')).toContain('"xpos" "39" [$OSX] "xpos" "50" [$WINDOWS] "tall" "9" [$X360] "tall" "12"');
  });
});
