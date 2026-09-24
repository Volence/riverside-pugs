import { describe, it, expect } from 'vitest';
import { TEAM_PANEL, PANEL_CHILDREN, CONTENT_CHILDREN, FIT_SQUARED, childDef, panelOfFile } from './children';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { baseFile } from './base';
import { SPLATTERS } from './splatter';

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

  it('offers colour only on labels and the splatter, and never on the health number or the other art', () => {
    for (const def of TEAM_PANEL.children) {
      if (def.colour) expect(def.kind === 'label' || def.name === 'BackgroundImage', def.name).toBe(true);
    }
    expect(TEAM_PANEL.children.find((c) => c.name === 'HealthNumber')!.colour).toBe(false);
    expect(TEAM_PANEL.children.find((c) => c.name === 'Head')!.colour).toBe(false);
  });

  it('makes the splatter a movable, free-sized, tintable piece, still decoration', () => {
    const splatter = TEAM_PANEL.children.find((c) => c.name === 'BackgroundImage')!;
    expect(splatter.move).toBe(true);
    expect(splatter.box).toBe('wh');
    expect(splatter.colour).toBe(true);
    expect(splatter.role).toBe('decor');
  });

  it('offers the splatter Opacity only, and its note sends the art itself to the Splatter panel', () => {
    const splatter = TEAM_PANEL.children.find((c) => c.name === 'BackgroundImage')!;
    expect(splatter.opacityOnly).toBe(true);
    expect(splatter.note).toMatch(/under Splatter/);
    // Nothing else claims opacityOnly: it means nothing without colour, and no other art is flat.
    for (const def of TEAM_PANEL.children) if (def.name !== 'BackgroundImage') expect(def.opacityOnly, def.name).toBeFalsy();
  });
});

describe('the per-panel registry', () => {
  it('repeats the teammate card per teammate and gives it no frame block of its own', () => {
    expect(TEAM_PANEL.repeat).toBe('cards');
    expect(TEAM_PANEL.frame).toBeUndefined();
  });

  it('says in data what the preview used to hard-code for each teammate state', () => {
    const by = (n: string) => TEAM_PANEL.children.find((c) => c.name === n)!;
    expect([by('Incapacitated').stateArt, by('Dead').stateArt, by('Voice').stateArt]).toEqual(['down', 'dead', 'talking']);
    expect(by('Head').hideIn).toEqual(['down', 'dead']);
    for (const n of ['Health', 'HealthNumber', 'Items']) expect(by(n).hideIn, n).toEqual(['dead']);
  });

  it('finds a child by panel and name, whatever the case, and a panel by its file', () => {
    expect(childDef('teamColumn', 'healthnumber')?.name).toBe('HealthNumber');
    expect(childDef('teamColumn', 'Nope')).toBeUndefined();
    expect(childDef('nope', 'Head')).toBeUndefined();
    expect(panelOfFile('resource/ui/hud/teammatepanel.res')?.panelId).toBe('teamColumn');
  });

  it('marks exactly the pieces the splatter work restyles, and each is a splatter entry', () => {
    const marked = PANEL_CHILDREN.flatMap((p) => p.children.filter((c) => c.art === 'splatter').map((c) => `${p.file}#${c.name}`));
    for (const m of marked) expect(SPLATTERS.map((s) => `${s.file}#${s.block}`), m).toContain(m);
  });

  it('keeps stateArt and fitPlace on pieces that are not content, and gates only real controls', () => {
    for (const p of PANEL_CHILDREN) for (const c of p.children) {
      if (c.stateArt) expect(c.role, c.name).toBe('state');
      if (c.fitPlace) expect(c.role, c.name).not.toBe('content');
      if (c.colourGate) expect(c.colour, c.name).toBe(true);
    }
  });
});
