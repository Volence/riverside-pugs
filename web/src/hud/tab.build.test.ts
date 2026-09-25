import { describe, it, expect, afterAll } from 'vitest';
import { buildHud, buildTrees } from './build';
import { DEFAULT_DESIGN, validateDesign, type HudDesign } from './design';
import { parseKv, writeKv, kvGet, pcFind, type KvNode } from './kv';
import { baseFile, baseOf, presetOverrides, registerImport, unregisterImport } from './base';
import { sampleHud } from './importFixtures';
import { parsePos, screenW, SCREEN_H } from './units';

/**
 * The Tab screen in the download (tab screen spec
 * docs/superpowers/specs/2026-09-25-hud-editor-tab-screen-design.md, 4.4,
 * tasks 6 to 8, and the probe answers of section 7).
 */
const SCOREBOARD = 'resource/ui/scoreboard.res';
const VERSUS = 'resource/ui/versusmodescoreboard.res';
const SURVIVOR_ROW = 'resource/ui/scoreboardsurvivor.res';
const FONTS = { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } };

const design = (patch: Partial<HudDesign>): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), elements: {}, ...patch });
const build = (d: HudDesign) => buildHud(d, FONTS);
const text = (files: { path: string; data: Uint8Array }[], path: string) => {
  const f = files.find((x) => x.path === path);
  return f ? new TextDecoder('latin1').decode(f.data) : undefined;
};
/** A file's root children as the build wrote it, or the stock file when the build left it alone. */
const tree = (files: { path: string; data: Uint8Array }[], path: string) =>
  parseKv(text(files, path) ?? baseFile('stock', path))[0].value as KvNode[];
const stockTree = (path: string) => parseKv(baseFile('stock', path))[0].value as KvNode[];
/** The block with this name and conditional, as the file has it. */
const blockOf = (nodes: KvNode[], key: string, cond?: string) => nodes.find((n) => n.key === key && n.cond === cond)!;
const kids = (c: HudDesign['children']) => design({ children: c });

describe('Tab files are read and written as the PC game reads them (pcFind)', () => {
  it('puts a backdrop colour on the 340-wide [$WIN32] BackgroundImage and leaves the [$X360] block byte for byte', () => {
    const got = tree(build(kids({ tabBoard: { BackgroundImage: { keys: { bgcolor_override: '0 0 96 200' } } } })), SCOREBOARD);
    const pc = blockOf(got, 'BackgroundImage', '[$WIN32]');
    expect(kvGet(pc, 'wide')).toBe('340');
    expect(kvGet(pc, 'bgcolor_override')).toBe('0 0 96 200');
    const console = blockOf(got, 'BackgroundImage', '[$X360]');
    expect(writeKv([console])).toBe(writeKv([blockOf(stockTree(SCOREBOARD), 'BackgroundImage', '[$X360]')]));
  });

  it('hides the PC backdrop, not the console one', () => {
    const got = tree(build(kids({ tabBoard: { BackgroundImage: { visible: false } } })), SCOREBOARD);
    expect(kvGet(blockOf(got, 'BackgroundImage', '[$WIN32]'), 'visible')).toBe('0');
    expect(writeKv([blockOf(got, 'BackgroundImage', '[$X360]')])).toBe(writeKv([blockOf(stockTree(SCOREBOARD), 'BackgroundImage', '[$X360]')]));
  });
});

describe('the versus panel\'s if_embedded blocks (spec 4.4, task 6)', () => {
  const versus = (c: Record<string, unknown>) => tree(build(kids({ tabVersus: c } as HudDesign['children'])), VERSUS);
  const emb = (n: KvNode) => pcFind(n.value as KvNode[], ['if_embedded'])!;

  it('puts a colour on TeamYours\' plain block: its if_embedded holds only xpos', () => {
    const got = versus({ TeamYours: { color: '255 255 0 255' } });
    const b = pcFind(got, ['TeamYours'])!;
    expect(kvGet(b, 'fgcolor_override')).toBe('255 255 0 255');
    expect(writeKv([emb(b)])).toBe(writeKv([emb(pcFind(stockTree(VERSUS), ['TeamYours'])!)]));
  });

  it('writes a key into if_embedded when that block has it, and into the plain block otherwise', () => {
    // No v1 piece moves (validateDesign drops a stored move), so the rule is
    // pinned on the build with a move handed to it directly.
    const b = pcFind(versus({ TeamYours: { x: 40, y: 50 } }), ['TeamYours'])!;
    expect(kvGet(emb(b), 'xpos')).toBe('40');
    expect(kvGet(b, 'xpos')).toBe('25');                         // the standalone panel's place is kept
    expect(kvGet(b, 'ypos')).toBe('50');
    expect(kvGet(emb(b), 'ypos')).toBeUndefined();
  });

  it('zeroes StatBreakdownHighlightImage\'s if_embedded wide on a hide, so the embedded view cannot undo it', () => {
    const b = pcFind(versus({ StatBreakdownHighlightImage: { visible: false } }), ['StatBreakdownHighlightImage'])!;
    expect([kvGet(b, 'visible'), kvGet(b, 'wide'), kvGet(b, 'tall')]).toEqual(['0', '0', '0']);
    expect(kvGet(emb(b), 'wide')).toBe('0');
    // The console and other-language lines stay as they were.
    expect((emb(b).value as KvNode[]).map((n) => [n.key, n.value, n.cond])).toEqual([['wide', '0', '[$ENGLISH]'], ['wide', '345', '[$!ENGLISH]']]);
    // Nothing is added to an if_embedded that lacks the key.
    const team = pcFind(versus({ TeamYours: { visible: false } }), ['TeamYours'])!;
    expect((emb(team).value as KvNode[]).map((n) => n.key)).toEqual(['xpos']);
  });

  it('turns DistanceLabel\'s auto_wide_tocontents off on a hide, so it cannot grow back to its text', () => {
    const b = pcFind(versus({ DistanceLabel: { visible: false } }), ['DistanceLabel'])!;
    expect([kvGet(b, 'visible'), kvGet(b, 'wide'), kvGet(b, 'tall'), kvGet(b, 'auto_wide_tocontents')]).toEqual(['0', '0', '0', '0']);
  });
});

describe('the row bars by health: a cleared key is taken out of the file (KeyDef.clear, probe TL3)', () => {
  const bar = (keys: Record<string, string>) => {
    const d = validateDesign({ v: 1, children: { tabSurvivors: { SurvivorStatsHealth: { keys } } } });
    const files = build(d);
    return { files, block: pcFind(tree(files, SURVIVOR_ROW), ['SurvivorStatsHealth'])! };
  };

  it('removes monochrome_color from SurvivorStatsHealth, writing no empty value', () => {
    const { files, block } = bar({ monochrome_color: '' });
    expect(kvGet(block, 'monochrome_color')).toBeUndefined();
    expect(text(files, SURVIVOR_ROW)).not.toMatch(/monochrome_color/i);
    // Only that line goes: the rest of the block is the file's.
    const stock = structuredClone(pcFind(stockTree(SURVIVOR_ROW), ['SurvivorStatsHealth'])!);
    stock.value = (stock.value as KvNode[]).filter((n) => n.key.toLowerCase() !== 'monochrome_color');
    expect(block).toEqual(stock);
  });

  it('writes one colour as the value (TS3)', () => {
    expect(kvGet(bar({ monochrome_color: '255 0 0 255' }).block, 'monochrome_color')).toBe('255 0 0 255');
  });
});

describe('moving the versus panel (task 7, probe TS4)', () => {
  it('writes the [$WIN32] ypos and the xpos, and leaves the [$X360] ypos line', () => {
    const files = build(validateDesign({ v: 1, elements: { tabVersus: { x: 420, y: 20 } } }));
    const b = pcFind(tree(files, SCOREBOARD), ['CVersusModeScoreboard'])!;
    const lines = (b.value as KvNode[]).filter((n) => ['xpos', 'ypos'].includes(n.key)).map((n) => [n.key, n.cond]);
    expect(lines).toEqual([['xpos', undefined], ['ypos', '[$WIN32]'], ['ypos', '[$X360]']]);
    const W = screenW('16:9');
    expect(parsePos(kvGet(b, 'xpos')!, W)).toBeCloseTo(420, 0);
    expect(parsePos(kvGet(b, 'ypos')!, SCREEN_H)).toBeCloseTo(20, 0);
    expect((b.value as KvNode[]).find((n) => n.key === 'ypos' && n.cond === '[$X360]')!.value).toBe('c-208');
  });
});

describe('the Tab screen\'s style slots (task 8)', () => {
  const styled = (styles: HudDesign['styles'], images: Record<string, Uint8ClampedArray> = {}) =>
    buildHud(validateDesign({ v: 1, styles }), { ...FONTS, images });
  const has = (files: { path: string }[], p: string) => files.some((f) => f.path === p);
  const image = (files: { path: string; data: Uint8Array }[], path: string, block: string) => kvGet(pcFind(tree(files, path), [block])!, 'image');

  it('a flat stat box ships tabstatbox.vtf and .vmt and repoints StatBreakdownHighlightImage', () => {
    const files = styled({ tabStatBox: { kind: 'flat', color: '0 128 0 255' } });
    expect(has(files, 'materials/vgui/hud/hudeditor/tabstatbox.vtf')).toBe(true);
    expect(has(files, 'materials/vgui/hud/hudeditor/tabstatbox.vmt')).toBe(true);
    // The form TAB-1 drew (../vgui/hud/hudeditor/probe_green), as the stock file writes its own.
    expect(image(files, VERSUS, 'StatBreakdownHighlightImage')).toBe('../vgui/hud/hudeditor/tabstatbox');
    expect(image(files, VERSUS, 'YourTeamHighlightImage')).toBe('../vgui/hud/ScalablePanel_bgBlack_outlineRed');
  });

  it('the team box slot repoints both highlight blocks', () => {
    const files = styled({ tabTeamBox: { kind: 'rounded', color: '255 0 255 255' } });
    expect(has(files, 'materials/vgui/hud/hudeditor/tabteambox.vtf')).toBe(true);
    for (const b of ['YourTeamHighlightImage', 'EnemyTeamHighlightImage']) expect(image(files, VERSUS, b), b).toBe('../vgui/hud/hudeditor/tabteambox');
    expect(image(files, VERSUS, 'StatBreakdownHighlightImage')).toBe('../vgui/hud/ScalablePanel_bgBlack_outlineRed');
  });

  it('the teammate rows slot repoints the survivor row\'s PlayerBackground, an uploaded picture too', () => {
    const files = styled({ tabRowBg: { kind: 'image' } }, { tabRowBg: new Uint8ClampedArray(256 * 32 * 4).fill(128) });
    expect(has(files, 'materials/vgui/hud/hudeditor/tabrowbg.vtf')).toBe(true);
    expect(image(files, SURVIVOR_ROW, 'PlayerBackground')).toBe('../vgui/hud/hudeditor/tabrowbg');
  });

  it('no slot, no file: stock styles ship nothing and touch no Tab file', () => {
    const files = styled({ tabStatBox: { kind: 'stock' }, tabTeamBox: { kind: 'stock' }, tabRowBg: { kind: 'stock' } });
    expect(files.filter((f) => /tab(statbox|teambox|rowbg)|scoreboard/.test(f.path))).toEqual([]);
    // An Image style with no upload falls back to stock, and so writes nothing.
    expect(styled({ tabRowBg: { kind: 'image' } }).filter((f) => /tabrowbg|scoreboard/.test(f.path))).toEqual([]);
  });
});

describe('no Tab edit, no Tab file (spec 4.4)', () => {
  const ID = '7'.repeat(64);
  afterAll(() => { unregisterImport(ID); });
  const TAB = [SCOREBOARD, VERSUS, SURVIVOR_ROW, 'resource/ui/scoreboardinfectedplayer.res'];
  const cases: [string, () => HudDesign][] = [
    ['stock', () => validateDesign({ v: 1 })],
    ['Modern', () => validateDesign({ v: 1, preset: 'modern' })],
    ['an imported HUD', () => { registerImport(ID, sampleHud()); return validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'x' } }); }],
    ['an imported HUD with other edits', () => {
      registerImport(ID, sampleHud());
      return validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'x' }, elements: { ownHealth: { x: 30, y: 400 } }, children: { teamColumn: { Head: { x: 30 } } } });
    }],
  ];
  for (const [name, make] of cases) {
    it(`${name} ships none of the Tab files, even after the preview has read them`, () => {
      const d = make();
      const before = build(d).map((f) => f.path);
      // The Tab preview reads every Tab file through buildTrees; the download must not follow it.
      const trees = buildTrees(d);
      for (const f of TAB) trees(f);
      const after = build(d);
      expect(after.map((f) => f.path)).toEqual(before);
      // Modern ships its own Tab files as it always has, unedited (they are the preset); stock and imports none.
      const own = TAB.filter((f) => presetOverrides(baseOf(d), f)).sort();
      expect(after.filter((f) => TAB.includes(f.path) || /hudeditor\/tab/.test(f.path)).map((f) => f.path)).toEqual(own);
      for (const f of own) expect(text(after, f), f).toBe(writeKv(parseKv(baseFile(baseOf(d), f))));
    });
  }
});
