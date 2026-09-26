import { describe, it, expect, afterAll } from 'vitest';
import { buildHud, buildTrees, elementRect } from './build';
import { placeElement, setAspect } from './edit';
import { DEFAULT_DESIGN, validateDesign, type HudDesign } from './design';
import { parseKv, writeKv, kvGet, pcFind, type KvNode } from './kv';
import { baseFile, baseOf, presetOverrides, registerImport, unregisterImport } from './base';
import { sampleHud } from './importFixtures';
import { parsePos, screenW, SCREEN_H } from './units';
import { layoutBlocks, versusEstimate } from './tablayout';

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

describe('the versus panel through an aspect change (review 5)', () => {
  it('shows and downloads the same x after 16:9 to 4:3: the move is held on the narrower screen', () => {
    const wide = placeElement({ ...structuredClone(DEFAULT_DESIGN), aspect: '16:9' }, 'tabVersus', 499, 20);
    expect(wide.elements.tabVersus).toEqual({ x: 499, y: 20 });
    const narrow = setAspect(wide, '4:3');
    expect(narrow.aspect).toBe('4:3');
    const shown = elementRect(narrow, 'tabVersus', narrow.aspect).x;
    const b = pcFind(tree(build(validateDesign(narrow)), SCOREBOARD), ['CVersusModeScoreboard'])!;
    expect(parsePos(kvGet(b, 'xpos')!, screenW('4:3'))).toBeCloseTo(shown, 0);
    expect(shown).toBe(640 - 354);
    // Nothing else of the design changes, and an aspect already set is no edit.
    expect(setAspect(narrow, '4:3')).toBe(narrow);
    expect(setAspect(DEFAULT_DESIGN, '4:3')).toEqual({ ...DEFAULT_DESIGN, aspect: '4:3' });
  });
});

describe('your own Tab row, which code shows (ChildDef.codeShown, review 6)', () => {
  it('keeps no stored visible true, so a shared file cannot write "visible" "1" on it', () => {
    for (const panel of ['tabSurvivors', 'tabInfected'] as const) {
      const raw = { v: 1, children: { [panel]: { PlayerBackground_Selected: { visible: true } } } };
      const d = validateDesign(raw);
      expect(d.children[panel], panel).toBeUndefined();
      const path = panel === 'tabSurvivors' ? SURVIVOR_ROW : 'resource/ui/scoreboardinfectedplayer.res';
      const b = pcFind(tree(build(d), path), ['PlayerBackground_Selected'])!;
      expect(kvGet(b, 'visible'), panel).toBe('0');
      // A hide is the one visible it keeps.
      expect(validateDesign({ v: 1, children: { [panel]: { PlayerBackground_Selected: { visible: false } } } }).children[panel], panel)
        .toEqual({ PlayerBackground_Selected: { visible: false } });
    }
  });
});

/**
 * Moving the versus panel's pieces one by one: probes PIECES-1 and PIECES-2
 * (/home/volence/l4d/hud/probe-tab-pieces/RESULTS.md, with the keys each
 * wrote in build.mts and their edit logs piecesN/build-log.txt).
 */
describe('moving the versus pieces (probe PIECES-1 and PIECES-2)', () => {
  const moved = (c: Record<string, unknown>) => build(validateDesign({ v: 1, children: { tabVersus: c } }));
  const piece = (files: { path: string; data: Uint8Array }[], name: string) => pcFind(tree(files, VERSUS), [name])!;
  const stockPiece = (name: string) => pcFind(stockTree(VERSUS), [name])!;
  const emb = (n: KvNode) => pcFind(n.value as KvNode[], ['if_embedded']);
  const panel = (files: { path: string; data: Uint8Array }[]) => pcFind(tree(files, SCOREBOARD), ['CVersusModeScoreboard'])!;
  const PINS = ['pin_to_sibling', 'pin_corner_to_sibling', 'pin_to_sibling_corner'];
  const pins = (n: KvNode) => PINS.map((k) => kvGet(n, k));

  it('keeps a stored move on the eleven pieces that move and drops one on the Survival Multiplier line', () => {
    const d = validateDesign({ v: 1, children: { tabVersus: { TeamYours: { x: 10, y: 5 }, HealthAmount: { x: 300, y: 40 }, SurvivalMultLabel: { x: 300, y: 150 },
      SurvivalMultAmount: { x: 20, y: 15, color: '255 0 0 255' } } } });
    expect(d.children.tabVersus).toEqual({ TeamYours: { x: 10, y: 5 }, HealthAmount: { x: 300, y: 40 }, SurvivalMultAmount: { color: '255 0 0 255' } });
  });

  for (const [name, x, y] of [['TeamYours', 10, 5], ['TeamEnemy', 360, 5], ['TeamYourScoreSurvivors', 140, 45], ['TeamEnemyScoreSurvivors', 140, 75],
    ['YourTeamHighlightImage', 10, 40], ['EnemyTeamHighlightImage', 360, 40]] as const) {
    it(`writes ${name}'s x into its if_embedded xpos, the one the game reads, and its y into the plain block`, () => {
      const b = piece(moved({ [name]: { x, y } }), name);
      expect(kvGet(emb(b)!, 'xpos')).toBe(String(x));
      expect(kvGet(b, 'ypos')).toBe(String(y));
      expect(kvGet(emb(b)!, 'ypos')).toBeUndefined();
      // The standalone panel's plain xpos is left, dead under the if_embedded one (PIECES-2, TeamEnemy).
      expect(kvGet(b, 'xpos')).toBe(kvGet(stockPiece(name), 'xpos'));
    });
  }

  it('writes the stat box and "Average Distance:" on their plain blocks, which carry no if_embedded xpos', () => {
    const files = moved({ StatBreakdownHighlightImage: { x: 10, y: 205 }, DistanceLabel: { x: 30, y: 110 } });
    const box = piece(files, 'StatBreakdownHighlightImage');
    expect([kvGet(box, 'xpos'), kvGet(box, 'ypos')]).toEqual(['10', '205']);
    expect(writeKv([emb(box)!])).toBe(writeKv([emb(stockPiece('StatBreakdownHighlightImage'))!]));
    const label = piece(files, 'DistanceLabel');
    expect([kvGet(label, 'xpos'), kvGet(label, 'ypos')]).toEqual(['30', '110']);
  });

  it('leaves the rest of the line pinned to "Average Distance:" when it moves, so the game carries it along', () => {
    const files = moved({ DistanceLabel: { x: 13, y: 150 } });
    for (const n of ['DistanceAmount', 'HealthLabel', 'HealthAmount']) expect(writeKv([piece(files, n)]), n).toBe(writeKv([stockPiece(n)]));
  });

  it('unpins a line piece moved on its own and writes its exact place; the piece pinned to it keeps following it', () => {
    const files = moved({ HealthLabel: { x: 200, y: 30 } });
    const b = piece(files, 'HealthLabel');
    expect(pins(b)).toEqual([undefined, undefined, undefined]);
    expect([kvGet(b, 'xpos'), kvGet(b, 'ypos')]).toEqual(['200', '30']);
    expect(pins(piece(files, 'HealthAmount'))).toEqual(['HealthLabel', '0', '1']);
    expect(writeKv([piece(files, 'HealthAmount')])).toBe(writeKv([stockPiece('HealthAmount')]));
    expect(writeKv([piece(files, 'DistanceAmount')])).toBe(writeKv([stockPiece('DistanceAmount')]));
    // The last piece of the line, alone: only its own pins go.
    const last = moved({ HealthAmount: { x: 300, y: 40 } });
    expect(pins(piece(last, 'HealthAmount'))).toEqual([undefined, undefined, undefined]);
    expect([kvGet(piece(last, 'HealthAmount'), 'xpos'), kvGet(piece(last, 'HealthAmount'), 'ypos')]).toEqual(['300', '40']);
    expect(pins(piece(last, 'HealthLabel'))).toEqual(['DistanceAmount', '0', '1']);
  });

  it('writes an unpinned piece one plain xpos and ypos, dropping the other languages\' lines, so every client draws it there (review I1)', () => {
    // Stock DistanceAmount, HealthLabel and HealthAmount carry "xpos" [$ENGLISH] and "xpos" [$!ENGLISH]; a
    // non-English client left with its own 5 or 10 would draw the unpinned piece near the panel's left edge.
    for (const name of ['DistanceAmount', 'HealthLabel', 'HealthAmount']) {
      const b = piece(moved({ [name]: { x: 250, y: 60 } }), name);
      const lines = (b.value as KvNode[]).filter((n) => ['xpos', 'ypos'].includes(n.key.toLowerCase())).map((n) => [n.key, n.value, n.cond]);
      expect(lines, name).toEqual([['xpos', '250', undefined], ['ypos', '60', undefined]]);
    }
  });

  it('fills the other axis of a lone move from where the piece is laid out, so an unpinned piece never loses its place', () => {
    const files = moved({ HealthAmount: { y: 30 } });
    const b = piece(files, 'HealthAmount');
    expect(pins(b)).toEqual([undefined, undefined, undefined]);
    const laid = layoutBlocks(stockTree(VERSUS), { w: 354, h: 120, embedded: true, ...versusEstimate(() => 12) });
    expect(kvGet(b, 'xpos')).toBe(String(Math.round(laid.find((l) => l.name === 'HealthAmount')!.x)));
    expect(kvGet(b, 'ypos')).toBe('30');
  });

  it('grows the panel to cover a moved piece, from where it is, and not otherwise', () => {
    const across = panel(moved({ TeamEnemy: { x: 400, y: 30 } }));
    expect(kvGet(across, 'wide')).toBe(String(400 + 125));
    expect(kvGet(across, 'tall')).toBe('120');
    expect(kvGet(across, 'xpos')).toBe('15');
    expect(kvGet(across, 'ypos')).toBe('c-215');
    const down = panel(moved({ StatBreakdownHighlightImage: { x: 0, y: 300 } }));
    expect([kvGet(down, 'wide'), kvGet(down, 'tall')]).toEqual(['354', String(300 + 45)]);
    // A move inside the stock panel grows nothing, and ships no scoreboard.res.
    expect(text(moved({ TeamYours: { x: 30, y: 30 } }), SCOREBOARD)).toBeUndefined();
    expect(text(moved({ TeamYours: { color: '255 0 0 255' } }), SCOREBOARD)).toBeUndefined();
  });

  it('grows the panel over the pieces a moved piece carries (the line after "Average Distance:")', () => {
    const files = moved({ DistanceLabel: { x: 13, y: 300 } });
    const p = panel(files);
    const laid = layoutBlocks(tree(files, VERSUS), { w: 354, h: 120, embedded: true, ...versusEstimate(() => 12) });
    const amount = laid.find((l) => l.name === 'HealthAmount')!;
    expect(amount.y).toBe(300);
    expect(Number(kvGet(p, 'tall'))).toBe(320);
    expect(Number(kvGet(p, 'wide'))).toBe(Math.ceil(amount.x + amount.w));
  });
});
