import { describe, it, expect } from 'vitest';
import { embeddedView, layoutBlocks, cornerOf, type LaidBlock } from './tablayout';
import { parseKv, kvGet, kvFind, type KvNode } from './kv';
import { baseFile } from './base';
import { hardHide } from './build';

/**
 * The Tab screen's layout step (tab screen spec 3.2, task 12): a versus
 * panel child read as the embedded panel reads it (its PC keys with its
 * if_embedded keys over them), a label as wide as its text
 * (auto_wide_tocontents), and a pinned block placed from its sibling's
 * corner (pin_to_sibling), from the stock file.
 */
const VERSUS = 'resource/ui/versusmodescoreboard.res';
const file = (preset: 'stock' | 'modern') => parseKv(baseFile(preset, VERSUS))[0].value as KvNode[];
/** Every label's text is 10 units a character, so a width says which text was measured. */
const measure = (_n: KvNode, text: string) => text.length * 10;
const TEXT: Record<string, string> = { DistanceLabel: 'Average Distance:', DistanceAmount: '1%', HealthLabel: 'Health Bonus:', HealthAmount: '200' };
const lay = (nodes: KvNode[]) => layoutBlocks(nodes, { w: 354, h: 120, embedded: true, textOf: (n) => TEXT[n.key] ?? '', measure });
const by = (laid: LaidBlock[], name: string) => laid.find((b) => b.name === name)!;

describe('embeddedView', () => {
  it('lays the if_embedded keys over the plain ones, as the embedded versus panel reads them', () => {
    const nodes = file('stock');
    const team = embeddedView(kvFind(nodes, ['TeamYours'])!);
    expect(kvGet(team, 'xpos')).toBe('20');
    expect(kvGet(team, 'ypos')).toBe('30');
    expect(kvGet(team, 'wide')).toBe('125');
    expect(kvFind(team.value as KvNode[], ['if_embedded'])).toBeUndefined();
    expect(kvGet(embeddedView(kvFind(nodes, ['StatBreakdownHighlightImage'])!), 'wide')).toBe('320');
    expect(kvGet(embeddedView(kvFind(nodes, ['BackgroundImage'])!), 'visible')).toBe('0');
  });
  it('keeps only the lines the PC reads: the English wide, not the other languages\'', () => {
    const v = embeddedView(kvFind(file('stock'), ['TeamEnemy'])!);
    expect((v.value as KvNode[]).filter((c) => c.key === 'wide').map((c) => c.value)).toEqual(['125']);
    expect(kvGet(v, 'xpos')).toBe('160');
  });
  it('adds a key the if_embedded block has and the plain block lacks (TS8: TeamYours ypos 60)', () => {
    const [n] = parseKv('"TeamYours" { "xpos" "25" "ypos" "30" "if_embedded" { "xpos" "20" "ypos" "60" } }');
    const v = embeddedView(n);
    expect([kvGet(v, 'xpos'), kvGet(v, 'ypos')]).toEqual(['20', '60']);
  });
});

describe('layoutBlocks', () => {
  it('places a plain block at its embedded place and size', () => {
    const laid = lay(file('stock'));
    expect(by(laid, 'YourTeamHighlightImage')).toMatchObject({ x: 20, y: 43, w: 125, h: 32, visible: true });
    expect(by(laid, 'StatBreakdownHighlightImage')).toMatchObject({ x: 0, y: 70, w: 320, h: 45 });
    expect(by(laid, 'BackgroundImage').visible).toBe(false);
  });
  it('sizes an auto_wide_tocontents label to its text, and leaves the others at their wide', () => {
    const laid = lay(file('stock'));
    expect(by(laid, 'DistanceLabel').w).toBe(170);
    expect(by(laid, 'HealthAmount').w).toBe(220);
  });
  it('starts DistanceAmount 10 units right of DistanceLabel\'s text end (pin corner 0 to corner 1)', () => {
    const laid = lay(file('stock'));
    const label = by(laid, 'DistanceLabel');
    expect(label).toMatchObject({ x: 13, y: 80 });
    expect(by(laid, 'DistanceAmount')).toMatchObject({ x: 13 + 170 + 10, y: 80 });
    // And down the chain: 30 past the amount's own text end, then 10.
    expect(by(laid, 'HealthLabel').x).toBe(13 + 170 + 10 + 20 + 30);
    expect(by(laid, 'HealthAmount').x).toBe(13 + 170 + 10 + 20 + 30 + 130 + 10);
  });
  it('puts HealthAmount 40 units right of DistanceAmount\'s end when HealthLabel is 0 wide (30 + 10), and hides it with the label', () => {
    const nodes = file('stock');
    hardHide(kvFind(nodes, ['HealthLabel'])!, true);
    const laid = lay(nodes);
    const amount = by(laid, 'DistanceAmount');
    expect(by(laid, 'HealthLabel')).toMatchObject({ w: 0, visible: false });
    expect(by(laid, 'HealthAmount').x).toBe(amount.x + amount.w + 40);
    // TS7 (TAB-1 tab-a): the number pinned to a hidden label is gone too.
    expect(by(laid, 'HealthAmount').visible).toBe(false);
  });
  it('reads Modern the same way (its amounts are DefaultMedium, the chain unchanged)', () => {
    const laid = lay(file('modern'));
    expect(by(laid, 'DistanceAmount').x).toBe(193);
    expect(by(laid, 'YourTeamHighlightImage')).toMatchObject({ x: 20, y: 46, h: 28 });
  });
  it('drops the blocks the PC does not have, and lays them in file order', () => {
    const [root] = parseKv('"x" { "A" [$X360] { "xpos" "1" } "A" [$WIN32] { "xpos" "2" } "B" { "xpos" "c-10" "wide" "f20" } }');
    const laid = layoutBlocks(root.value as KvNode[], { w: 100, h: 50, textOf: () => '', measure });
    expect(laid.map((b) => [b.name, b.x])).toEqual([['A', 2], ['B', 40]]);
    expect(by(laid, 'B').w).toBe(80);
  });
  it('places a block pinned by its own bottom-right corner, and survives a pin loop', () => {
    const [root] = parseKv(`"x" {
      "S" { "xpos" "10" "ypos" "10" "wide" "20" "tall" "10" }
      "P" { "xpos" "0" "ypos" "0" "wide" "5" "tall" "5" "pin_to_sibling" "S" "pin_corner_to_sibling" "3" "pin_to_sibling_corner" "3" }
      "L1" { "pin_to_sibling" "L2" } "L2" { "pin_to_sibling" "L1" } }`);
    const laid = layoutBlocks(root.value as KvNode[], { w: 100, h: 50, textOf: () => '', measure });
    expect(by(laid, 'P')).toMatchObject({ x: 25, y: 15 });
    expect(by(laid, 'L1')).toBeDefined();
  });
});

describe('cornerOf', () => {
  it('numbers the corners as VGUI does: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right', () => {
    const r = { x: 1, y: 2, w: 10, h: 20 };
    expect([0, 1, 2, 3].map((c) => cornerOf(r, c))).toEqual([{ x: 1, y: 2 }, { x: 11, y: 2 }, { x: 1, y: 22 }, { x: 11, y: 22 }]);
  });
});
