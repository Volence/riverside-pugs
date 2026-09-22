import { describe, it, expect } from 'vitest';
import { ELEMENTS, elementById } from './elements';
import { SLOTS } from './slots';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
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

  // A path that merely exists is not a pin: a typo could swap in a different
  // real base file and the existence check above would still pass. These
  // check the actual shape the generator (task 8) reads out of each file.
  it('team files have four sized teammate panels', () => {
    for (const e of ELEMENTS) {
      if (!e.team?.file) continue;
      const teamRoot = root('stock', e.team.file);
      for (let n = 1; n <= 4; n++) {
        const panel = kvFind(teamRoot, [`TeamPlayer${n}`]);
        expect(panel, `${e.id}: ${e.team.file} TeamPlayer${n}`).toBeDefined();
        expect(kvGet(panel!, 'wide'), `${e.id}: TeamPlayer${n} wide`).toBeDefined();
        expect(kvGet(panel!, 'tall'), `${e.id}: TeamPlayer${n} tall`).toBeDefined();
      }
    }
  });

  it('children files parse to one root block with children', () => {
    for (const e of ELEMENTS) for (const f of e.children) {
      const nodes = parseKv(baseFile('stock', f));
      expect(nodes.length, `${e.id}: ${f}`).toBe(1);
      const kids = nodes[0].value;
      expect(Array.isArray(kids), `${e.id}: ${f}`).toBe(true);
      expect((kids as KvNode[]).length, `${e.id}: ${f}`).toBeGreaterThan(0);
    }
  });

  it('cannot move the two full-screen containers', () => {
    expect(elementById('killFeed')!.move).toBe(false);
    expect(elementById('targetId')!.move).toBe(false);
  });

  // scalePass multiplies a file in place and Work memoises parsed trees, so
  // scaling the same file for two elements would square the factor. Nothing
  // in the code stops that; this does.
  it('never gives the same child file to two scaled elements', () => {
    const children = ELEMENTS.filter((e) => e.resize === 'scale').flatMap((e) => e.children);
    expect(new Set(children).size, children.join(' ')).toBe(children.length);
  });

  // Only 'visible' is wired up in v1: 'color', 'bg' and 'fontSize' stay in
  // the type because the spec declares them, but nothing reads or writes
  // them, and the side panel would render a control it cannot honour.
  it('lists no prop beyond visible', () => {
    expect(ELEMENTS.flatMap((e) => e.props).filter((p) => p !== 'visible')).toEqual([]);
  });
});

describe('SLOTS', () => {
  it('points every target at a real image key in the stock file', () => {
    for (const s of SLOTS) for (const t of s.targets) {
      const panel = kvFind(root('stock', t.file), t.path);
      expect(panel, `${s.id}: ${t.file} ${t.path.join('/')}`).toBeDefined();
      // Finding the panel is not enough: the key itself must name a real
      // field on it, or a typo like "imag" for "image" passes silently.
      expect(kvGet(panel!, t.key), `${s.id}: ${t.file} ${t.path.join('/')} ${t.key}`).toBeDefined();
    }
  });
  // No targets means no normal-mode route: nothing points a .res image key at
  // the new texture, so the slot can only work from a VPK mounted ahead of
  // pak01. The old guard also required stockNames, which let a slot with
  // neither skip the check entirely.
  it('marks every slot with no normal-mode route advanced only', () => {
    for (const s of SLOTS) if (s.targets.length === 0) expect(s.advancedOnly, s.id).toBe(true);
  });
});
