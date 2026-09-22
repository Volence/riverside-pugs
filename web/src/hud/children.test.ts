import { describe, it, expect } from 'vitest';
import { TEAM_PANEL, PANEL_CHILDREN, CONTENT_CHILDREN, FIT_SQUARED } from './children';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { baseFile } from './base';

const card = (preset: 'stock' | 'modern') => parseKv(baseFile(preset, TEAM_PANEL.file))[0].value as KvNode[];
const scheme = (preset: 'stock' | 'modern') => parseKv(baseFile(preset, 'resource/clientscheme.res'))[0].value as KvNode[];
const CONTROL: Record<string, string> = { image: 'imagepanel', label: 'label', bar: 'healthpanel' };

/**
 * The registry names blocks in a real file, and a typo would land in a
 * player's game, so every entry is pinned to both presets' teammatepanel.res
 * the way elements.test.ts pins element keys to hudlayout.res.
 */
describe('the teammate card registry', () => {
  it('covers only the teammate card in this phase', () => {
    expect(PANEL_CHILDREN.map((p) => p.panelId)).toEqual(['teamColumn']);
    expect(TEAM_PANEL.file).toBe('resource/ui/hud/teammatepanel.res');
  });

  for (const preset of ['stock', 'modern'] as const) {
    it(`finds every child in the ${preset} card file, or the sibling an addable one goes after`, () => {
      for (const def of TEAM_PANEL.children) {
        if (def.addable) {
          expect(kvFind(card(preset), [def.addable.after]), `${preset} ${def.name} after ${def.addable.after}`).toBeDefined();
          continue;
        }
        expect(kvFind(card(preset), [def.name]), `${preset} ${def.name}`).toBeDefined();
      }
    });

    it(`matches each child's kind to its ControlName in ${preset}`, () => {
      for (const def of TEAM_PANEL.children) {
        const block = kvFind(card(preset), [def.name]) ?? def.addable!.template;
        const control = (kvGet(block, 'ControlName') ?? '').toLowerCase();
        if (def.kind === 'other') expect(Object.values(CONTROL), `${preset} ${def.name}`).not.toContain(control);
        else expect(control, `${preset} ${def.name}`).toBe(CONTROL[def.kind]);
      }
    });

    it(`gives every label child a font the ${preset} scheme defines`, () => {
      for (const def of TEAM_PANEL.children.filter((c) => c.kind === 'label')) {
        const block = kvFind(card(preset), [def.name]) ?? def.addable!.template;
        const font = kvGet(block, 'font');
        expect(font, `${preset} ${def.name}`).toBeDefined();
        expect(kvFind(scheme(preset), ['Fonts', font!]), `${preset} ${def.name} ${font}`).toBeDefined();
      }
    });

    it(`keeps every aspect-locked child square in ${preset}, or leaves it to the fit rule`, () => {
      for (const def of TEAM_PANEL.children.filter((c) => c.box === 'square')) {
        const block = kvFind(card(preset), [def.name])!;
        const square = kvGet(block, 'wide') === kvGet(block, 'tall');
        expect(square || FIT_SQUARED.includes(def.name), `${preset} ${def.name}`).toBe(true);
      }
    });
  }

  it('has the health number block only on Modern, which is why it is addable', () => {
    expect(kvFind(card('stock'), ['HealthNumber'])).toBeUndefined();
    expect(kvFind(card('modern'), ['HealthNumber'])).toBeDefined();
  });

  it('builds the fit box from exactly the steady-state children', () => {
    expect(CONTENT_CHILDREN).toEqual(['Head', 'Health', 'Name', 'HealthNumber', 'Items', 'Status']);
  });

  it('aspect-locks exactly the square game art', () => {
    expect(TEAM_PANEL.children.filter((c) => c.box === 'square').map((c) => c.name)).toEqual(['Head', 'Incapacitated', 'Dead', 'Voice']);
  });

  it('offers colour only on labels, and never on the health number, which the game colours by health', () => {
    for (const def of TEAM_PANEL.children) if (def.colour) expect(def.kind, def.name).toBe('label');
    expect(TEAM_PANEL.children.find((c) => c.name === 'HealthNumber')!.colour).toBe(false);
  });
});
