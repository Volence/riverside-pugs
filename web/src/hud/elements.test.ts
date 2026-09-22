import { describe, it, expect } from 'vitest';
import { ELEMENTS, elementById } from './elements';
import { SLOTS } from './slots';
import { parseKv, kvFind, type KvNode } from './kv';
import { baseFile, BASE_PATHS } from './base';

const root = (preset: 'stock' | 'modern', file: string) => parseKv(baseFile(preset, file))[0].value as KvNode[];

describe('ELEMENTS', () => {
  it('has unique ids and the thirteen first-version elements', () => {
    const ids = ELEMENTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['abilityRing', 'chat', 'ghostPanel', 'infectedRow', 'killFeed', 'ownHealth',
      'progressBar', 'siHealth', 'tankPanel', 'targetId', 'teamColumn', 'weaponSelection', 'xhair'].sort());
  });

  for (const preset of ['stock', 'modern'] as const) {
    it(`every key exists in ${preset} hudlayout.res`, () => {
      const layout = root(preset, 'scripts/hudlayout.res');
      for (const e of ELEMENTS) {
        if (e.id === 'xhair') continue;            // added by the generator, absent from stock
        expect(kvFind(layout, [e.key]), e.id).toBeDefined();
      }
    });
  }

  it('names only child files that exist', () => {
    for (const e of ELEMENTS) for (const f of [...e.children, ...(e.team?.file ? [e.team.file] : [])]) {
      expect(BASE_PATHS, `${e.id}: ${f}`).toContain(f);
    }
  });

  it('cannot move the two full-screen containers', () => {
    expect(elementById('killFeed')!.move).toBe(false);
    expect(elementById('targetId')!.move).toBe(false);
  });
});

describe('SLOTS', () => {
  it('points every target at a real image key in the stock file', () => {
    for (const s of SLOTS) for (const t of s.targets) {
      const panel = kvFind(root('stock', t.file), t.path);
      expect(panel, `${s.id}: ${t.file} ${t.path.join('/')}`).toBeDefined();
    }
  });
  it('gives stock names only to advanced-only slots or slots with no targets', () => {
    for (const s of SLOTS) if (s.stockNames.length && s.targets.length === 0) expect(s.advancedOnly).toBe(true);
  });
});
