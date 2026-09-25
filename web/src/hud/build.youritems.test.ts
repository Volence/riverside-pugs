import { describe, it, expect, afterEach } from 'vitest';
import {
  buildHud, elementRect, ownBarX, yourItemsBlocked, yourItemsOn, yourItemsHome, yourItemsInput, yourItemsLayout, yourItemsLimits,
  ITEMS_OWN_NOTE, ITEMS_UNREAD_NOTE,
} from './build';
import { DEFAULT_DESIGN, validateDesign, type HudDesign, type ElementOverride } from './design';
import { baseFile, baseOf, registerImport, unregisterImport } from './base';
import { sampleHud } from './importFixtures';
import { panelBoxes, visibleElements } from './mock';
import { childRects } from './render';
import { weaponSlots } from './weapons';
import { ammoOnly } from './edit';
import { YOUR_ITEMS, itemRowWidth, BAR_EDGE_LABEL, EDGE_MARGIN, LABEL_PAD } from './youritems';
import { parsePos, parseSize, screenW, SCREEN_H, type Aspect } from './units';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import type { VpkFile } from '../vpk';

const OWN = 'resource/ui/hud/localplayerpanel.res';
const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };
const ASPECTS: Aspect[] = ['16:9', '16:10', '4:3'];
/** A fresh design (your health fitted, as new designs ship) on a preset and aspect, with your health's override merged in. */
const base = (preset: 'stock' | 'modern', aspect: Aspect, own?: ElementOverride): HudDesign => {
  const d: HudDesign = { ...structuredClone(DEFAULT_DESIGN), preset, aspect };
  return own ? { ...d, elements: { ...d.elements, ownHealth: { ...d.elements.ownHealth, ...own } } } : d;
};
/** An own panel file with an Items Label of its author's: a HUD that already places your items. */
const withOwnItems = baseFile('stock', OWN).replace(/\}\s*$/, '\t"Items"\r\n\t{\r\n\t\t"ControlName"\t"Label"\r\n\t\t"fieldName"\t"Items"\r\n'
  + '\t\t"xpos"\t"26"\r\n\t\t"ypos"\t"0"\r\n\t\t"wide"\t"60"\r\n\t\t"tall"\t"20"\r\n\t\t"visible"\t"1"\r\n\t\t"font"\t"L4D_Icons_medium"\r\n\t}\r\n}\r\n');
/** An own panel file whose health bar is placed by a centre token: nothing the editor can re-express. */
const withCentredBar = baseFile('stock', OWN).replace(/("Health"\s*\{[^}]*?"xpos"\s*)"26"/, '$1"c-100"');

describe('ownBarX: your health bar as the preview draws it', () => {
  it('is 754 on stock and 42 on Modern at 16:9', () => {
    expect(ownBarX(base('stock', '16:9'))).toBe(754);
    expect(ownBarX(base('modern', '16:9'))).toBe(42);
  });
  it('follows every move, scale and fit, exactly where the preview draws the Health piece', () => {
    const designs = [
      base('stock', '16:9'), base('modern', '16:9'), base('stock', '4:3'), base('modern', '16:10'),
      base('stock', '16:9', { x: 20, y: 380 }), base('stock', '16:9', { scale: 1.5 }), base('modern', '16:9', { scale: 2, fit: false }),
      base('stock', '16:10', { x: 380, y: 200 }),
    ];
    for (const d of designs) {
      const [box] = panelBoxes(d, 'ownHealth');
      const bar = childRects(d, 'ownHealth', box, 1).find((r) => r.name === 'Health')!;
      expect(ownBarX(d), `${d.preset} ${d.aspect} ${JSON.stringify(d.elements.ownHealth)}`).toBeCloseTo(bar.x, 6);
    }
  });
});

describe('yourItemsHome: where the row first shows', () => {
  it('puts the row\'s right end at the weapon boxes\' right edge and its top just under the pistol row', () => {
    for (const d of [...ASPECTS.map((a) => base('stock', a)), base('modern', '16:9'), ammoOnly(base('stock', '16:9'))]) {
      const r = elementRect(d, 'weaponSelection', d.aspect);
      const [, pistol] = weaponSlots(d, d.aspect, r.w);
      const home = yourItemsHome(d);
      expect(home.x + itemRowWidth(yourItemsInput(d).tall), d.aspect).toBeCloseTo(r.x + pistol.box.x + pistol.box.w, 6);
      expect(home.y, d.aspect).toBeCloseTo(r.y + pistol.frame.y + pistol.frame.h, 6);
    }
    const h = yourItemsHome(base('stock', '16:9'));
    expect(h.x).toBeCloseTo(805.3465, 3);
    expect(h.y).toBeCloseTo(233.13, 2);
  });
});

describe('the element on the canvas', () => {
  it('is off in a new design, drawn at its home, a full loadout wide', () => {
    const d = base('stock', '16:9');
    const r = elementRect(d, YOUR_ITEMS, d.aspect);
    expect(r.visible).toBe(false);
    expect(r.x).toBeCloseTo(805.3465, 3);
    expect(r.w).toBeCloseTo(itemRowWidth(yourItemsInput(d).tall), 9);
    expect(r.h).toBe(18);
    expect(yourItemsOn(d)).toBe(false);
  });
  it('is shown once turned on, where yourItemsLayout draws it', () => {
    const d = { ...base('stock', '16:9'), elements: { ...DEFAULT_DESIGN.elements, yourItems: { visible: true, x: 760, y: 100 } } };
    expect(yourItemsOn(d)).toBe(true);
    const r = elementRect(d, YOUR_ITEMS, d.aspect);
    expect(r).toMatchObject({ ...yourItemsLayout(d).row, visible: true });
    expect(r.x).toBeGreaterThanOrEqual(754);
  });
  it('is offered on the survivor side, right after Your health, never on the infected side', () => {
    const s = visibleElements('survivor', DEFAULT_DESIGN).map((e) => e.id);
    expect(s.indexOf(YOUR_ITEMS)).toBe(s.indexOf('ownHealth') + 1);
    expect(visibleElements('infected', DEFAULT_DESIGN).map((e) => e.id)).not.toContain(YOUR_ITEMS);
  });
  it('shows the bar\'s edge as its limit', () => {
    expect(yourItemsLimits(base('stock', '16:9'))).toEqual([{ x: 754, side: 'left', label: BAR_EDGE_LABEL }]);
  });
  it('builds exactly the files it built before while it is off, whatever it stores', () => {
    for (const preset of ['stock', 'modern'] as const) {
      const d = base(preset, '16:9');
      const stored = { ...d, elements: { ...d.elements, yourItems: { visible: false, x: 700, y: 100, itemFont: 'L4D_Icons_large' as const, itemAlign: 'center' as const, color: '1 2 3 4' } } };
      expect(buildHud(stored, { fonts })).toEqual(buildHud(d, { fonts }));
    }
  });
});

describe('an imported HUD', () => {
  const ID = 'b'.repeat(64);
  afterEach(() => { unregisterImport(ID); });
  const imported = (over: Record<string, string>, yourItems: Record<string, unknown> = { visible: true, x: 780, y: 200 }): HudDesign => {
    // A fresh registration: the parsed-tree caches keep an id's files until it is unregistered.
    unregisterImport(ID);
    registerImport(ID, sampleHud(over));
    return validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'x' }, elements: { yourItems } });
  };
  it('as stock files: offered like stock', () => {
    const d = imported({});
    expect(yourItemsBlocked(d)).toBeNull();
    expect(yourItemsOn(d)).toBe(true);
  });
  it('whose own panel already has Items: blocked, with the note, and off', () => {
    const d = imported({ [OWN]: withOwnItems });
    expect(yourItemsBlocked(d)).toBe(ITEMS_OWN_NOTE);
    expect(ITEMS_OWN_NOTE).toBe('This HUD already places your items itself.');
    expect(yourItemsOn(d)).toBe(false);
    expect(elementRect(d, YOUR_ITEMS, d.aspect).visible).toBe(false);
    expect(yourItemsLimits(d)).toEqual([]);
  });
  it('whose health bar is not at a plain number: blocked, with the note', () => {
    const d = imported({ [OWN]: withCentredBar });
    expect(yourItemsBlocked(d)).toBe(ITEMS_UNREAD_NOTE);
    expect(yourItemsOn(d)).toBe(false);
  });
  // Spec section 5: off, the download is unchanged for an import as for Stock and Modern.
  it('builds exactly the files it built before while it is off, whatever it stores', () => {
    const stored = { visible: false, x: 700, y: 100, itemFont: 'L4D_Icons_large', itemAlign: 'center', color: '1 2 3 4' };
    for (const [over, blocked] of [[{}, null], [{ [OWN]: withOwnItems }, ITEMS_OWN_NOTE]] as [Record<string, string>, string | null][]) {
      const d = imported(over, stored);
      // Each case really builds its own import: only the one with an Items child is blocked.
      expect(yourItemsBlocked(d)).toBe(blocked);
      const off = buildHud(d, { fonts });
      const plain = buildHud(validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'x' } }), { fonts });
      expect(off).toEqual(plain);
    }
  });
});

const BOX = 'resource/ui/hud/localplayerdisplay.res';
const LAYOUT = 'scripts/hudlayout.res';
const CLEAR = 'materials/vgui/hud/hudeditor/clear';
const text = (files: VpkFile[], path: string) => { const f = files.find((x) => x.path === path); return f && new TextDecoder('latin1').decode(f.data); };
/** A file as the game reads it from this download: the shipped copy, or the base's own when none ships. */
const treeOf = (files: VpkFile[], d: HudDesign, path: string) => parseKv(text(files, path) ?? baseFile(baseOf(d), path))[0].value as KvNode[];
/** Your items on (or stored and off) with the item slots off, as setYourItems leaves a design. */
const withItems = (d: HudDesign, on: boolean, o: ElementOverride = {}): HudDesign => ({
  ...d, weapons: { ...d.weapons, itemSize: 0, itemIcons: false },
  elements: { ...d.elements, [YOUR_ITEMS]: { x: 805, y: 233, ...o, visible: on } },
});
type Rect = { x: number; y: number; w: number; h: number };
/**
 * Every own-panel piece's box on screen as the game lays out the built
 * files: CHudLocalPlayerDisplay on the screen, LocalPlayer in it, each piece
 * in LocalPlayer, each token read against its parent's size. The Items Label
 * (the element's own, or the hidden revive anchor) is not a piece of the card.
 */
function ownScreenBoxes(files: VpkFile[], d: HudDesign): Record<string, Rect> {
  const W = screenW(d.aspect);
  const c = kvFind(treeOf(files, d, LAYOUT), ['CHudLocalPlayerDisplay'])!;
  const cw = parseSize(kvGet(c, 'wide') ?? '0', W), ch = parseSize(kvGet(c, 'tall') ?? '0', SCREEN_H);
  const cx = parsePos(kvGet(c, 'xpos') ?? '0', W), cy = parsePos(kvGet(c, 'ypos') ?? '0', SCREEN_H);
  const lp = kvFind(treeOf(files, d, BOX), ['LocalPlayer'])!;
  const lw = parseSize(kvGet(lp, 'wide') ?? '0', cw), lh = parseSize(kvGet(lp, 'tall') ?? '0', ch);
  const lx = cx + parsePos(kvGet(lp, 'xpos') ?? '0', cw), ly = cy + parsePos(kvGet(lp, 'ypos') ?? '0', ch);
  const out: Record<string, Rect> = {};
  for (const n of treeOf(files, d, OWN)) {
    if (typeof n.value === 'string' || n.key === 'Items') continue;
    out[n.key] = {
      x: lx + parsePos(kvGet(n, 'xpos') ?? '0', lw), y: ly + parsePos(kvGet(n, 'ypos') ?? '0', lh),
      w: parseSize(kvGet(n, 'wide') ?? '0', lw), h: parseSize(kvGet(n, 'tall') ?? '0', lh),
    };
  }
  return out;
}

describe('the download with Your items on (spec section 3)', () => {
  const variants: [string, ElementOverride | undefined][] = [
    ['as it ships', undefined], ['moved, scaled 1.5 and unfitted', { x: 20, y: 380, scale: 1.5, fit: false }], ['moved to the centre', { x: 380, y: 200 }],
  ];
  for (const preset of ['stock', 'modern'] as const) {
    for (const aspect of ASPECTS) {
      for (const [name, own] of variants) {
        it(`${preset} ${aspect}, your health ${name}: every piece is where it was with the element off`, () => {
          const d = base(preset, aspect, own);
          const on = ownScreenBoxes(buildHud(withItems(d, true), { fonts }), d);
          const off = ownScreenBoxes(buildHud(withItems(d, false), { fonts }), d);
          expect(Object.keys(on).sort()).toEqual(Object.keys(off).sort());
          for (const k of Object.keys(off)) for (const f of ['x', 'y', 'w', 'h'] as const) expect(on[k][f], `${k} ${f}`).toBeCloseTo(off[k][f], 6);
        });
      }
    }
  }

  it('stock: writes the pieces as r positions and the Items Label at the bar\'s written x (probe p3: r99)', () => {
    const d = withItems(base('stock', '16:9'), true);
    const files = buildHud(d, { fonts });
    const own = treeOf(files, d, OWN);
    const bar = kvFind(own, ['Health'])!, items = kvFind(own, ['Items'])!;
    expect([kvGet(bar, 'xpos'), kvGet(bar, 'ypos')]).toEqual(['r99', 'r23']);
    expect(kvGet(items, 'xpos')).toBe(kvGet(bar, 'xpos'));
    expect(yourItemsLayout(d).label).toEqual({ x: 754, y: 230, w: 91, h: 18 + 2 * LABEL_PAD });
    expect(['ControlName', 'fieldName', 'ypos', 'wide', 'tall', 'visible', 'enabled', 'labelText', 'textAlignment', 'font', 'zpos'].map((k) => kvGet(items, k)))
      .toEqual(['Label', 'Items', 'c-10', '91', '24', '1', '1', '', 'east', 'L4D_Icons_medium', '3']);
    expect(kvGet(items, 'fgcolor_override')).toBeUndefined();
    // reviveAnchorPass found the Label and added no hidden one.
    expect(own.filter((n) => n.key === 'Items')).toHaveLength(1);
  });

  it('Modern: plain numbers from the left, r from the bottom (probe p2: 8 / r46)', () => {
    const d = withItems(base('modern', '16:9'), true);
    const own = treeOf(buildHud(d, { fonts }), d, OWN);
    const bar = kvFind(own, ['Health'])!;
    expect([kvGet(bar, 'xpos'), kvGet(bar, 'ypos')]).toEqual(['42', 'r22']);
    expect(kvGet(kvFind(own, ['Items'])!, 'xpos')).toBe('42');
    expect(own.filter((n) => n.key === 'Items')).toHaveLength(1);
  });

  it('Centre, a font and a colour: the Label spans bar to 2 x centre - bar', () => {
    const d = withItems(base('modern', '16:9'), true, { x: 420, y: 250, itemAlign: 'center', itemFont: 'L4D_Icons_large', color: '255 0 255 255' });
    const items = kvFind(treeOf(buildHud(d, { fonts }), d, OWN), ['Items'])!;
    const { label } = yourItemsLayout(d);
    expect(label.w % 2).toBe(0);
    expect([kvGet(items, 'textAlignment'), kvGet(items, 'font'), kvGet(items, 'fgcolor_override'), kvGet(items, 'wide'), kvGet(items, 'tall')])
      .toEqual(['center', 'L4D_Icons_large', '255 0 255 255', String(label.w), String(24 + 2 * LABEL_PAD)]);
  });

  it('makes the container and LocalPlayer the whole screen, with the clear texture as its image, shipped once', () => {
    for (const weapons of [{ itemSize: 0, itemIcons: false }, { itemSize: 24, itemIcons: true }]) {
      const d = { ...withItems(base('stock', '16:9'), true), weapons };
      const files = buildHud(d, { fonts });
      const c = kvFind(treeOf(files, d, LAYOUT), ['CHudLocalPlayerDisplay'])!;
      expect(['xpos', 'ypos', 'wide', 'tall'].map((k) => kvGet(c, k))).toEqual(['0', '0', 'f0', 'f0']);
      const lp = kvFind(treeOf(files, d, BOX), ['LocalPlayer'])!;
      expect(['xpos', 'ypos', 'wide', 'tall', 'image'].map((k) => kvGet(lp, k))).toEqual(['0', '0', 'f0', 'f0', '../vgui/hud/hudeditor/clear']);
      for (const ext of ['vtf', 'vmt']) expect(files.filter((f) => f.path === `${CLEAR}.${ext}`), `${JSON.stringify(weapons)} ${ext}`).toHaveLength(1);
    }
  });

  it('with Your health hidden: the container is written shown, every other piece is hard-hidden, the items show', () => {
    for (const preset of ['stock', 'modern'] as const) {
      const d0 = base(preset, '16:9');
      const d = withItems({ ...d0, elements: { ...d0.elements, ownHealth: { ...d0.elements.ownHealth, visible: false } } }, true);
      const files = buildHud(d, { fonts });
      const own = treeOf(files, d, OWN);
      const { label } = yourItemsLayout(d);
      for (const n of own) {
        if (typeof n.value === 'string') continue;
        const want = n.key === 'Items' ? ['1', String(label.w), '24'] : ['0', '0', '0'];
        expect(['visible', 'wide', 'tall'].map((k) => kvGet(n, k)), `${preset} ${n.key}`).toEqual(want);
      }
      const c = kvFind(treeOf(files, d, LAYOUT), ['CHudLocalPlayerDisplay'])!;
      const lp = kvFind(treeOf(files, d, BOX), ['LocalPlayer'])!;
      expect(['visible', 'wide', 'tall'].map((k) => kvGet(c, k)), preset).toEqual(['1', 'f0', 'f0']);
      expect(['visible', 'wide', 'tall'].map((k) => kvGet(lp, k)), preset).toEqual(['1', 'f0', 'f0']);
    }
  });

  it('draws a row stored left of a moved health bar at the new limit, without rewriting it', () => {
    const d0 = withItems(base('stock', '16:9'), true, { x: 797 });
    const d: HudDesign = { ...d0, elements: { ...d0.elements, ownHealth: { ...d0.elements.ownHealth, x: 778, y: 389 } } };
    expect(ownBarX(d)).toBe(804);
    const own = treeOf(buildHud(d, { fonts }), d, OWN);
    const items = kvFind(own, ['Items'])!;
    expect(kvGet(items, 'xpos')).toBe(kvGet(kvFind(own, ['Health'])!, 'xpos'));
    expect(kvGet(items, 'xpos')).toBe('r49');
    expect(kvGet(items, 'wide')).toBe(String(Math.ceil(itemRowWidth(18))));
    expect(d.elements.yourItems!.x).toBe(797);
    expect(elementRect(d, YOUR_ITEMS, d.aspect).x).toBeGreaterThanOrEqual(804);
  });

  it('holds a row placed at 16:9 on a 4:3 screen', () => {
    const d = withItems(base('stock', '4:3'), true, { x: 840 });
    const { label, row } = yourItemsLayout(d);
    expect(label.x + label.w).toBeLessThanOrEqual(640 - EDGE_MARGIN);
    const items = kvFind(treeOf(buildHud(d, { fonts }), d, OWN), ['Items'])!;
    expect(kvGet(items, 'wide')).toBe(String(label.w));
    expect(elementRect(d, YOUR_ITEMS, d.aspect).x).toBeCloseTo(row.x, 9);
  });

  it('builds a design with no stored place at the home spot the preview draws', () => {
    for (const preset of ['stock', 'modern'] as const) {
      const d0 = base(preset, '16:9');
      const d = { ...d0, weapons: { itemSize: 0, itemIcons: false }, elements: { ...d0.elements, yourItems: { visible: true } } };
      const items = kvFind(treeOf(buildHud(d, { fonts }), d, OWN), ['Items'])!;
      const { label } = yourItemsLayout(d);
      expect(kvGet(items, 'wide'), preset).toBe(String(label.w));
      expect(parsePos(kvGet(items, 'ypos')!, SCREEN_H), preset).toBe(label.y);
      if (preset === 'stock') expect(kvGet(items, 'ypos')).toBe('c-10');
    }
  });
});

describe('the download of an imported HUD with Your items on', () => {
  const ID = 'c'.repeat(64);
  afterEach(() => { unregisterImport(ID); });
  const imported = (over: Record<string, string>): HudDesign => {
    registerImport(ID, sampleHud(over));
    return withItems(validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'x' } }), true);
  };
  it('keeps an own Items Label as its author wrote it, and the panel where it was', () => {
    const d = imported({ [OWN]: withOwnItems });
    const files = buildHud(d, { fonts });
    expect(text(files, OWN)).toBe(withOwnItems);
    expect(kvGet(kvFind(treeOf(files, d, LAYOUT), ['CHudLocalPlayerDisplay'])!, 'wide')).toBe('150');
  });
  it('writes nothing where it cannot read the panel', () => {
    const d = imported({ [OWN]: withCentredBar });
    const files = buildHud(d, { fonts });
    expect(kvFind(treeOf(files, d, OWN), ['Items'])).toBeUndefined();
    expect(kvGet(kvFind(treeOf(files, d, LAYOUT), ['CHudLocalPlayerDisplay'])!, 'xpos')).toBe('r125');
  });
  it('builds a stock-shaped import like stock', () => {
    const d = imported({});
    expect(kvGet(kvFind(treeOf(buildHud(d, { fonts }), d, OWN), ['Items'])!, 'xpos')).toBe('r99');
  });
});
