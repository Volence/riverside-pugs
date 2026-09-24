import { describe, it, expect } from 'vitest';
import { TEAM_PANEL, OWN_PANEL, SI_PANEL, ABILITY_PANEL, ZCARD_PANEL, PANEL_CHILDREN, panelChildren, CONTENT_CHILDREN, FIT_SQUARED, childDef, panelOfFile, maxInset, linkedValue, unlinkedValue, type KeyDef } from './children';
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
  it('covers the teammate card, your own health, your infected health, the ability timer, the infected card, the use bar, the spawn panel and the too-far panel', () => {
    expect(PANEL_CHILDREN.map((p) => p.panelId)).toEqual(['teamColumn', 'ownHealth', 'siHealth', 'abilityRing', 'infectedRow', 'progressBar', 'ghostPanel', 'zombiePanel']);
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

  it('offers colour only on labels, the splatter and the portrait, and never on the health number or the state art', () => {
    for (const def of TEAM_PANEL.children) {
      if (def.colour) expect(def.kind === 'label' || def.name === 'BackgroundImage' || def.name === 'Head', def.name).toBe(true);
    }
    expect(TEAM_PANEL.children.find((c) => c.name === 'HealthNumber')!.colour).toBe(false);
    for (const n of ['Incapacitated', 'Dead', 'Voice']) expect(TEAM_PANEL.children.find((c) => c.name === n)!.colour, n).toBe(false);
  });

  // /home/volence/l4d/hud/probe-phase2/b1/shots/crops/card1-a.png (probe B1, S-items and S-head): the item icons
  // took the Items label's fgcolor_override (yellow) and the portraits the Head's drawColor (pink).
  it('colours the item icons and tints the portrait, each by the key the game was seen to honour', () => {
    const by = (n: string) => TEAM_PANEL.children.find((c) => c.name === n)!;
    expect([by('Items').colour, by('Items').kind]).toEqual([true, 'label']);
    expect([by('Head').colour, by('Head').kind]).toEqual([true, 'image']);
    expect(by('Head').note).toMatch(/tint/i);
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

/** Pinned to both presets' localplayerpanel.res, as the teammate entries are to teammatepanel.res. */
describe('the own health registry', () => {
  const own = (preset: 'stock' | 'modern') => parseKv(baseFile(preset, OWN_PANEL.file))[0].value as KvNode[];
  const by = (n: string) => OWN_PANEL.children.find((c) => c.name === n)!;

  it('is one panel in localplayerpanel.res, framed by LocalPlayer', () => {
    expect(OWN_PANEL.panelId).toBe('ownHealth');
    expect(OWN_PANEL.file).toBe('resource/ui/hud/localplayerpanel.res');
    expect(OWN_PANEL.repeat).toBe('single');
    expect(OWN_PANEL.frame).toEqual({ file: 'resource/ui/hud/localplayerdisplay.res', block: 'LocalPlayer' });
    expect(panelOfFile(OWN_PANEL.file)).toBe(OWN_PANEL);
  });

  for (const preset of ['stock', 'modern'] as const) {
    it(`finds every child in the ${preset} file, the scratches too where they ship as visible 0`, () => {
      for (const def of OWN_PANEL.children) expect(kvFind(own(preset), [def.name]), `${preset} ${def.name}`).toBeDefined();
    });

    it(`matches each child's kind to its ControlName in ${preset}`, () => {
      for (const def of OWN_PANEL.children) {
        const control = (kvGet(kvFind(own(preset), [def.name])!, 'ControlName') ?? '').toLowerCase();
        expect(control, `${preset} ${def.name}`).toBe(CONTROL[def.kind]);
      }
    });

    it(`gives every label child a font the ${preset} scheme defines`, () => {
      for (const def of OWN_PANEL.children.filter((c) => c.kind === 'label')) {
        const font = kvGet(kvFind(own(preset), [def.name])!, 'font');
        expect(font, `${preset} ${def.name}`).toBeDefined();
        expect(kvFind(scheme(preset), ['Fonts', font!]), `${preset} ${def.name} ${font}`).toBeDefined();
      }
    });

    it(`keeps square art square in ${preset}, or leaves it to the fit rule`, () => {
      for (const def of OWN_PANEL.children.filter((c) => c.box === 'square')) {
        const block = kvFind(own(preset), [def.name])!;
        const square = kvGet(block, 'wide') === kvGet(block, 'tall');
        expect(square || def.name === 'Incapacitated', `${preset} ${def.name}`).toBe(true);
      }
    });

    it(`frames the panel with a real LocalPlayer block in ${preset}`, () => {
      const frame = OWN_PANEL.frame as { file: string; block: string };
      const display = parseKv(baseFile(preset, frame.file))[0].value as KvNode[];
      expect(kvGet(kvFind(display, [frame.block])!, 'ControlName')).toBe('LocalPlayerPanel');
    });
  }

  it('leaves the scratches art to the splatter work', () => {
    expect(OWN_PANEL.children.filter((c) => c.art === 'splatter').map((c) => c.name)).toEqual(['HealthbarTextureTop', 'HealthbarTextureBottom']);
    for (const n of ['HealthbarTextureTop', 'HealthbarTextureBottom']) expect(by(n).note, n).toMatch(/under Splatter/);
  });

  it('gates exactly the controls the game may ignore', () => {
    const gated = OWN_PANEL.children.flatMap((c) => [
      ...(c.keys ?? []).filter((k) => k.gate).map((k) => `${c.name}.${k.key}:${k.gate}`),
      ...(c.colourGate ? [`${c.name}.colour:${c.colourGate}`] : []),
    ]);
    expect(gated).toEqual(['Health.monochrome_color:Q1', 'Health.inset:Q3', 'DuckingIcon.colour:Q8']);
    // Every other own piece offers no colour at all: code colours them by health.
    for (const def of OWN_PANEL.children) if (!def.colourGate) expect(def.colour, def.name).toBe(false);
  });

  it('calls the monochrome key a panel colour, because it tints the whole panel (probe B1 Q1)', () => {
    expect(by('Health').keys!.find((k) => k.key === 'monochrome_color')!.label).toMatch(/panel/i);
  });

  it('says in data when the state pieces show and what Down hides', () => {
    expect(by('Incapacitated').stateArt).toBe('down');
    expect(by('DuckingIcon').stateArt).toBe('crouched');
    expect(by('Head').hideIn).toEqual(['down']);
    expect(OWN_PANEL.children.filter((c) => c.fitPlace === 'keep').map((c) => c.name))
      .toEqual(['HealthbarTextureTop', 'HealthbarTextureBottom', 'DuckingIcon']);
  });

  it('never touches the Modern fill, which the fit rule sizes by name', () => {
    expect(childDef('ownHealth', 'ModBg')).toBeUndefined();
  });
});

describe('the panel colour and inset keys (probes Q1 and Q3, slice 2.F X10)', () => {
  const own = (n: string) => OWN_PANEL.children.find((c) => c.name === n)!;
  const team = (n: string) => TEAM_PANEL.children.find((c) => c.name === n)!;
  const key = (keys: KeyDef[] | undefined, k: string) => keys!.find((x) => x.key === k)!;

  it('labels monochrome_color "Panel colour" on both, with the note of what it recolours', () => {
    // RESULTS.md Q1: the whole own panel (bar, number, cross, scratches) in every state; on cards the bar and number.
    expect(key(own('Health').keys, 'monochrome_color')).toMatchObject({
      label: 'Panel colour', gate: 'Q1', note: 'Recolours the whole panel: bar, number, cross and scratches, in every health state.' });
    expect(key(team('Health').keys, 'monochrome_color')).toMatchObject({
      label: 'Panel colour', type: 'colour', gate: 'Q1', note: 'Recolours the bar and the number on every card.' });
  });

  it('offers the inset on a teammate card too, one HealthPanel class with the own bar', () => {
    expect(key(team('Health').keys, 'inset')).toMatchObject({ type: 'int', range: [0, 8], gate: 'Q3' });
    expect(key(team('Health').keys, 'inset').evidence).toMatch(/HealthPanel/);
  });

  it('keeps at least one unit of fill: 2 * inset < the bar\'s tall (review L1, like probe Q22\'s rule)', () => {
    // Stock teammate bar 7 tall, Modern own bar 6, stock own bar 10.
    expect([7, 6, 10, 3, 2, 1, 0].map(maxInset)).toEqual([3, 2, 4, 1, 0, 0, 0]);
  });

  it('says the scratches take the panel colour too', () => {
    for (const n of ['HealthbarTextureTop', 'HealthbarTextureBottom']) expect(own(n).note, n).toMatch(/or the panel colour/);
  });
});

describe('the health cross colour (probe Q5 failed, slice 2.F G4)', () => {
  it('offers no colour and waits on no gate: the game colours the cross itself', () => {
    // RESULTS.md Q5: fgcolor_override blue was ignored in b1v2 a and c and in b1 a.
    const cross = OWN_PANEL.children.find((c) => c.name === 'HealthIcon')!;
    expect(cross.colour).toBe(false);
    expect(cross.colourGate).toBeUndefined();
    expect(cross.note).toBe("The game colours this with the panel's health colour, or the Panel colour when one is set.");
  });
});

/**
 * Your special infected health, pinned to both presets' copies of the three
 * files the game reads (the Hunter's, which the Tank reads too, the Smoker's
 * and the Boomer's), as the own panel is pinned to localplayerpanel.res.
 * Probe answers: /home/volence/l4d/hud/probe-phase2-infected/RESULTS.md.
 */
describe('the infected health registry', () => {
  const SI_FILES = ['hunterhealth', 'smokerhealth', 'boomerhealth'].map((n) => `resource/ui/hud/${n}.res`);
  const si = (preset: 'stock' | 'modern', file: string) => parseKv(baseFile(preset, file))[0].value as KvNode[];
  const by = (n: string) => SI_PANEL.children.find((c) => c.name === n)!;

  it('is one panel in hunterhealth.res, framed by its hudlayout block, with the Smoker file the same and the Boomer file in proportion', () => {
    const p = panelChildren('siHealth')!;
    expect(p).toBe(SI_PANEL);
    expect(p.file).toBe('resource/ui/hud/hunterhealth.res');
    expect(p.repeat).toBe('single');
    expect(p.frame).toBe('hudlayout');
    expect(p.linked).toEqual([
      { file: 'resource/ui/hud/smokerhealth.res', rule: 'same' },
      { file: 'resource/ui/hud/boomerhealth.res', rule: 'delta' },
    ]);
    expect(SI_PANEL.children.map((c) => c.name)).toEqual(['BackgroundImage', 'Health', 'HealthNumber', 'DuckingIcon']);
  });

  for (const preset of ['stock', 'modern'] as const) {
    for (const file of SI_FILES) {
      it(`finds every child in the ${preset} ${file.split('/').pop()}, each of its kind`, () => {
        for (const def of SI_PANEL.children) {
          const block = kvFind(si(preset, file), [def.name]);
          expect(block, `${preset} ${file} ${def.name}`).toBeDefined();
          expect((kvGet(block!, 'ControlName') ?? '').toLowerCase(), `${preset} ${file} ${def.name}`).toBe(CONTROL[def.kind]);
        }
      });
    }

    it(`gives the health number a font the ${preset} scheme defines`, () => {
      const font = kvGet(kvFind(si(preset, SI_PANEL.file), ['HealthNumber'])!, 'font');
      expect(kvFind(scheme(preset), ['Fonts', font!]), `${preset} ${font}`).toBeDefined();
    });
  }

  it('never touches the Modern fill, as on your own health', () => {
    expect(childDef('siHealth', 'ModBg')).toBeUndefined();
  });

  it('gates the bar colour on Q24 and offers the inset ungated, the HealthPanel class Q3 proved', () => {
    const keys = by('Health').keys!;
    expect(keys.find((k) => k.key === 'monochrome_color')).toMatchObject({ type: 'colour', gate: 'Q24' });
    const inset = keys.find((k) => k.key === 'inset')!;
    expect(inset).toMatchObject({ type: 'int', range: [0, 8] });
    expect(inset.gate).toBeUndefined();
  });

  it('keeps the frame in the fit, tintable, as decoration (Q12)', () => {
    expect(by('BackgroundImage')).toMatchObject({ kind: 'image', role: 'decor', colour: true, fitPlace: 'keep' });
    expect(by('BackgroundImage').note).toMatch(/light art/);
  });

  it('offers the number a colour with no gate (Q13: the game keeps fgcolor_override)', () => {
    expect(by('HealthNumber')).toMatchObject({ kind: 'label', colour: true, font: true });
    expect(by('HealthNumber').colourGate).toBeUndefined();
  });

  it('shows the crouch icon only while crouched, keeps it in the fit and lets it take a tint', () => {
    expect(by('DuckingIcon')).toMatchObject({ kind: 'image', role: 'state', stateArt: 'crouched', fitPlace: 'keep', colour: true, box: 'square' });
  });
});

/**
 * One stored edit, three files (spec 3.2, plan decision 3): numbers are
 * stored in the Hunter's frame; the Smoker's file takes them as they are,
 * the Boomer's moves by the same amount from its own place and sizes in
 * proportion to its own block.
 */
describe('linked files: the Hunter frame mapped to the Smoker and Boomer files', () => {
  // The stock Health bar: Hunter 252,69 132x13, Boomer 322,69 64x13.
  const hunter = { x: 252, y: 69, w: 132, h: 13 };
  const boomer = { x: 322, y: 69, w: 64, h: 13 };

  it('copies every value for the same rule', () => {
    for (const [k, v] of [['x', 262], ['y', 60], ['w', 112], ['h', 20], ['visible', false], ['color', '0 0 255 255'], ['fontSize', 14]] as const) {
      expect(linkedValue('same', k, v, hunter, boomer), k).toBe(v);
    }
  });

  it('moves the Boomer by the same amount from its own place', () => {
    expect(linkedValue('delta', 'x', 262, hunter, boomer)).toBe(332);
    expect(linkedValue('delta', 'y', 60, hunter, boomer)).toBe(60);
  });

  it('sizes the Boomer in proportion to its own block', () => {
    expect(linkedValue('delta', 'w', 112, hunter, boomer)).toBe(Math.round(112 * 64 / 132));
    expect(linkedValue('delta', 'w', 112, hunter, boomer)).toBe(54);
    expect(linkedValue('delta', 'h', 26, hunter, boomer)).toBe(26);
  });

  it('passes visibility, colours, fonts and keys through untouched', () => {
    const keys = { inset: '3' };
    expect(linkedValue('delta', 'visible', false, hunter, boomer)).toBe(false);
    expect(linkedValue('delta', 'color', '0 0 255 255', hunter, boomer)).toBe('0 0 255 255');
    expect(linkedValue('delta', 'fontSize', 14, hunter, boomer)).toBe(14);
    expect(linkedValue('delta', 'keys', keys, hunter, boomer)).toBe(keys);
  });

  it('keeps a size as it is when the Hunter block has none to scale from (Modern\'s 0 x 0 frame)', () => {
    const none = { x: 0, y: 0, w: 0, h: 0 };
    expect(linkedValue('delta', 'w', 40, none, none)).toBe(40);
    expect(unlinkedValue('delta', 'w', 40, none, none)).toBe(40);
  });

  it('round-trips through its inverse within a unit', () => {
    for (const rule of ['same', 'delta'] as const) {
      for (const k of ['x', 'y', 'w', 'h'] as const) {
        for (const v of [0, 1, 54, 112, 262, 399]) {
          const back = unlinkedValue(rule, k, linkedValue(rule, k, v, hunter, boomer) as number, hunter, boomer) as number;
          expect(Math.abs(back - v), `${rule} ${k} ${v}`).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(unlinkedValue('delta', 'x', 332, hunter, boomer)).toBe(262);
    expect(unlinkedValue('delta', 'w', 74, hunter, boomer)).toBe(Math.round(74 * 132 / 64));
  });
});

describe('the ability timer\'s pieces (plan Task 6)', () => {
  const file = (preset: 'stock' | 'modern') => parseKv(baseFile(preset, ABILITY_PANEL.file))[0].value as KvNode[];
  const by = (n: string) => ABILITY_PANEL.children.find((c) => c.name === n)!;
  it('is the single abilitytimerhud.res, framed by its hudlayout.res block', () => {
    expect(panelChildren('abilityRing')).toBe(ABILITY_PANEL);
    expect(ABILITY_PANEL.file).toBe('resource/ui/hud/abilitytimerhud.res');
    expect(ABILITY_PANEL.repeat).toBe('single');
    expect(ABILITY_PANEL.frame).toBe('hudlayout');
    expect(ABILITY_PANEL.children.map((c) => c.name)).toEqual(['BackgroundImage', 'AbilityImage', 'Progress']);
  });
  it('names blocks both presets have', () => {
    for (const preset of ['stock', 'modern'] as const) {
      for (const def of ABILITY_PANEL.children) expect(kvFind(file(preset), [def.name]), `${preset} ${def.name}`).toBeDefined();
    }
  });
  it('moves, sizes square and hides each piece; code picks the backdrop\'s picture and the icon', () => {
    // Probe Q14 (/home/volence/l4d/hud/probe-phase2-infected/b9/shots/crops/br-bcd.png): code sets PZ_charge_bg over the file's image.
    expect(by('BackgroundImage')).toMatchObject({ kind: 'image', role: 'decor', box: 'square', move: true, colour: false });
    expect(by('BackgroundImage').note).toBe('The game picks this picture; you can move, size or hide it.');
    expect(by('AbilityImage')).toMatchObject({ kind: 'image', role: 'content', box: 'square', move: true, colour: false });
    expect(by('AbilityImage').note).toBe('The game picks the icon by class.');
    expect(by('Progress')).toMatchObject({ kind: 'other', role: 'content', box: 'square', move: true, colour: false });
    expect(by('Progress').note).toBe('The game fills this as your ability recharges.');
  });
});

/**
 * The infected teammate card (zombieteamdisplayplayer.res), plan Task 10.
 * Probe answers, /home/volence/l4d/hud/probe-phase2-infected/RESULTS.md:
 * Q17 the card's self block clips (b10/shots/crops/bl-abe.png), Q18 the
 * backdrop takes drawColor and the name fgcolor_override
 * (b9/shots/crops/bl-abeg.png), Q19 the dead card (Dead needs a height; the
 * skull at SkullIconPlacement; bar and icon hidden), Q20 the ghost card, and
 * the dll's AbilityProgress rule (0x10248700).
 */
describe('the infected card\'s pieces (plan Task 10)', () => {
  const file = (preset: 'stock' | 'modern') => parseKv(baseFile(preset, ZCARD_PANEL.file))[0].value as KvNode[];
  const by = (n: string) => ZCARD_PANEL.children.find((c) => c.name === n)!;
  const KIND: Record<string, string> = { image: 'imagepanel', label: 'label', bar: 'healthpanel' };
  it('is one file loaded per card, framed by its own ZombieTeamDisplayPlayer block', () => {
    expect(panelChildren('infectedRow')).toBe(ZCARD_PANEL);
    expect(ZCARD_PANEL.file).toBe('resource/ui/hud/zombieteamdisplayplayer.res');
    expect(ZCARD_PANEL.repeat).toBe('cards');
    expect(ZCARD_PANEL.frame).toEqual({ file: 'resource/ui/hud/zombieteamdisplayplayer.res', block: 'ZombieTeamDisplayPlayer' });
    expect(ZCARD_PANEL.children.map((c) => c.name)).toEqual(['BackgroundImage', 'PlayerImage', 'HealthPanel', 'NameLabel',
      'SpawnTimeLabel', 'AbilityProgress', 'Dead', 'SkullIconPlacement', 'Voice']);
  });
  for (const preset of ['stock', 'modern'] as const) {
    it(`names blocks the ${preset} file has, each of its kind, the frame too`, () => {
      expect(kvFind(file(preset), ['ZombieTeamDisplayPlayer'])).toBeDefined();
      for (const def of ZCARD_PANEL.children) {
        const b = kvFind(file(preset), [def.name]);
        expect(b, `${preset} ${def.name}`).toBeDefined();
        const control = (kvGet(b!, 'ControlName') ?? '').toLowerCase();
        expect(control, `${preset} ${def.name}`).toBe(KIND[def.kind] ?? (def.name === 'AbilityProgress' ? 'circularprogressbar' : 'panel'));
      }
    });
    it(`keeps square pieces square in ${preset}, and gives each label a font its scheme defines`, () => {
      for (const def of ZCARD_PANEL.children) {
        const b = kvFind(file(preset), [def.name])!;
        if (def.box === 'square') expect(kvGet(b, 'wide'), `${preset} ${def.name}`).toBe(kvGet(b, 'tall'));
        if (def.font) expect(kvFind(scheme(preset), ['Fonts', kvGet(b, 'font')!]), `${preset} ${def.name}`).toBeDefined();
      }
    });
  }
  it('keeps the backdrop in the fit, tintable, as decoration (Q18)', () => {
    expect(by('BackgroundImage')).toMatchObject({ kind: 'image', role: 'decor', box: 'wh', colour: true, fitPlace: 'keep' });
  });
  it('gives the name and the spawn time a font and a colour, ungated (Q18; decision 6)', () => {
    expect(by('NameLabel')).toMatchObject({ kind: 'label', role: 'content', box: 'wh', font: true, colour: true });
    expect(by('SpawnTimeLabel')).toMatchObject({ kind: 'label', role: 'state', stateArt: 'dead', font: true, colour: true });
    expect(by('SpawnTimeLabel').note).toBe("Your teammates' respawn countdown. Your own card never shows it.");
    expect(by('NameLabel').colourGate).toBeUndefined();
  });
  it('lets code pick the icon and hide it with the bar when dead, and gates the bar colour on Q24', () => {
    expect(by('PlayerImage')).toMatchObject({ kind: 'image', role: 'content', box: 'square', colour: false, hideInInfected: ['dead'] });
    expect(by('PlayerImage').note).toBe("The game picks the icon by class; a ghost's is faint.");
    expect(by('HealthPanel')).toMatchObject({ kind: 'bar', role: 'content', box: 'wh', hideInInfected: ['dead'] });
    expect(by('HealthPanel').keys!.find((k) => k.key === 'monochrome_color')).toMatchObject({ type: 'colour', gate: 'Q24' });
    expect(by('HealthPanel').keys!.find((k) => k.key === 'inset')!.gate).toBeUndefined();
  });
  it('says when code shows each state piece', () => {
    expect(by('AbilityProgress')).toMatchObject({ kind: 'other', role: 'state', stateArt: 'ability', box: 'square' });
    expect(by('AbilityProgress').note).toBe('Shown on a spawned Smoker, Boomer or Tank; never on a Hunter or a ghost.');
    expect(by('Dead')).toMatchObject({ kind: 'image', role: 'state', stateArt: 'dead', box: 'wh' });
    expect(by('Dead').note).toBe('The stock file gives this no height, so the game never shows it; give it a height to see it.');
    expect(by('SkullIconPlacement')).toMatchObject({ kind: 'other', role: 'state', stateArt: 'dead', box: 'square' });
    expect(by('Voice')).toMatchObject({ kind: 'other', role: 'state', stateArt: 'talking', box: 'square' });
  });
});
