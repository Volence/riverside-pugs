import { describe, it, expect, afterEach } from 'vitest';
import {
  buildHud, elementRect, ownBarX, yourItemsBlocked, yourItemsOn, yourItemsHome, yourItemsInput, yourItemsLayout, yourItemsLimits,
  ITEMS_OWN_NOTE, ITEMS_UNREAD_NOTE,
} from './build';
import { DEFAULT_DESIGN, validateDesign, type HudDesign, type ElementOverride } from './design';
import { baseFile, registerImport, unregisterImport } from './base';
import { sampleHud } from './importFixtures';
import { panelBoxes, visibleElements } from './mock';
import { childRects } from './render';
import { weaponSlots } from './weapons';
import { ammoOnly } from './edit';
import { YOUR_ITEMS, itemRowWidth, BAR_EDGE_LABEL } from './youritems';
import type { Aspect } from './units';

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
    expect(h.x).toBeCloseTo(797.4332, 3);
    expect(h.y).toBeCloseTo(233.13, 2);
  });
});

describe('the element on the canvas', () => {
  it('is off in a new design, drawn at its home, a full loadout wide', () => {
    const d = base('stock', '16:9');
    const r = elementRect(d, YOUR_ITEMS, d.aspect);
    expect(r.visible).toBe(false);
    expect(r.x).toBeCloseTo(797.4332, 3);
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
