import { describe, it, expect } from 'vitest';
import { parseKv, writeKv, kvFind, kvGet, kvSet, pcApplies, pcFind, pcBlocks, type KvNode } from './kv';
import { BASE_PATHS, baseFile } from './base';

describe('parseKv', () => {
  it('reads quoted and bare tokens, nesting and comments', () => {
    const t = parseKv('"Root"\r\n{\r\n\tPanel // a comment\r\n\t{\r\n\t\t"xpos"\t"r125"\r\n\t\twide 150\r\n\t}\r\n}\r\n');
    expect(t).toEqual([{ key: 'Root', value: [{ key: 'Panel', value: [
      { key: 'xpos', value: 'r125' }, { key: 'wide', value: '150' },
    ] }] }]);
  });

  it('reads a form feed or vertical tab as whitespace, as the game does, so a comment after one stays a comment', () => {
    const t = parseKv('"Root"\n{\n\t"labelText" a\f// "command" "engine quit"\n\t"x"\v1\n}\n');
    expect(t).toEqual([{ key: 'Root', value: [{ key: 'labelText', value: 'a' }, { key: 'x', value: '1' }] }]);
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

/**
 * The Tab screen's scoreboard.res holds a console block before the PC one
 * under the same name (BackgroundImage [$X360], 400 wide, then [$WIN32], 340
 * wide) and console-only labels (MoveSelectionButton and the rest). kvFind
 * returns the first name match, so the Tab code reads through these instead
 * (tab screen spec 1.1, task 2).
 */
describe('the PC-aware block lookup', () => {
  const board = (preset: 'stock' | 'modern') => parseKv(baseFile(preset, 'resource/ui/scoreboard.res'))[0].value as KvNode[];
  for (const preset of ['stock', 'modern'] as const) {
    it(`finds the [$WIN32] backdrop in ${preset} scoreboard.res, not the console one kvFind finds`, () => {
      expect(kvGet(kvFind(board(preset), ['BackgroundImage'])!, 'wide')).toBe('400');
      const pc = pcFind(board(preset), ['BackgroundImage'])!;
      expect(pc.cond).toBe('[$WIN32]');
      expect(kvGet(pc, 'wide')).toBe('340');
    });
    it(`lists the blocks the PC game keeps in ${preset} scoreboard.res`, () => {
      const names = pcBlocks(board(preset)).map((n) => n.key);
      for (const n of ['MoveSelectionButton', 'MoveSelectionLabel', 'VoteKickButton', 'VoteKickLabel', 'GamerCardButton', 'GamerCardLabel']) {
        expect(names, n).not.toContain(n);
      }
      expect(names.filter((n) => n === 'BackgroundImage')).toHaveLength(1);
      for (const n of ['scores', 'MissionTitle', 'Survivor1', 'Infected5', 'CVersusModeScoreboard']) expect(names, n).toContain(n);
    });
  }
  it('walks a path through PC blocks only, case-insensitively, and lists blocks, not value lines', () => {
    const t = parseKv('A { B [$X360] { C { k 1 } } B [$WIN32] { c { k 2 } } v 3 D [!$WIN32] { } }')[0].value as KvNode[];
    expect(kvGet(pcFind(t, ['b', 'C'])!, 'k')).toBe('2');
    expect(pcFind(t, ['D'])).toBeUndefined();
    expect(pcFind(t, ['B', 'nope'])).toBeUndefined();
    expect(pcBlocks(t).map((n) => `${n.key}${n.cond ?? ''}`)).toEqual(['B[$WIN32]']);
  });
});
