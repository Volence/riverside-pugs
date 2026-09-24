import { describe, it, expect } from 'vitest';
import { GHOST_PANEL, panelChildren } from './children';
import { elementById } from './elements';
import { buildHud, buildTrees } from './build';
import { validateDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { baseFile } from './base';

/**
 * The spawn (ghost) panel's pieces (plan task G1). Probe answers,
 * /home/volence/l4d/hud/probe-phase2-rest/RESULTS.md:
 * - G1: HudGhostPanel's WhiteText and RedText colour the status lines (r3/shots/r3/r3-a.png).
 * - G2: a line's own fgcolor_override is ignored (r3-a, r5-a), so the lines offer no colour.
 * - G3: a line moves and takes a font (r3-a); G4: ClassImage moves and sizes (r3-a).
 * - Q21 (probe-phase2-infected): Background's bgcolor_override is honoured.
 */
const FILE = 'resource/ui/hudghostpanel.res';
const file = (preset: 'stock' | 'modern') => parseKv(baseFile(preset, FILE))[0].value as KvNode[];
const by = (n: string) => GHOST_PANEL.children.find((c) => c.name === n)!;
const LINES = ['ClassName', 'SelectSpawn', 'Ready', 'Info', 'SpawnLabel'];
const read = (d: ReturnType<typeof validateDesign>, path: string) =>
  parseKv(new TextDecoder('latin1').decode(buildHud(d).find((f) => f.path === path)!.data))[0].value as KvNode[];

describe('the spawn panel registry (plan task G1)', () => {
  it('is the single hudghostpanel.res, framed by its hudlayout.res block, and the element scales it', () => {
    expect(panelChildren('ghostPanel')).toBe(GHOST_PANEL);
    expect(GHOST_PANEL).toMatchObject({ file: FILE, repeat: 'single', frame: 'hudlayout' });
    expect(GHOST_PANEL.children.map((c) => c.name)).toEqual(['Background', 'ClassImage', ...LINES, 'SpawnBind']);
    const el = elementById('ghostPanel')!;
    expect(el.resize).toBe('scale');
    expect(el.children).toEqual([FILE]);
  });

  it('names blocks both presets have', () => {
    for (const preset of ['stock', 'modern'] as const) for (const def of GHOST_PANEL.children) {
      expect(kvFind(file(preset), [def.name]), `${preset} ${def.name}`).toBeDefined();
    }
  });

  it('gives the lines a place, a size and a font but no colour of their own (G2), and says what colours them', () => {
    for (const n of LINES) {
      expect(by(n), n).toMatchObject({ kind: 'label', box: 'wh', move: true, font: true, colour: false });
      expect(by(n).note, n).toContain("the panel's Text and Warning colours");
    }
    expect(by('ClassImage')).toMatchObject({ kind: 'other', box: 'square', move: true, colour: false });
    expect(by('SpawnBind')).toMatchObject({ kind: 'other', box: 'none', move: true, font: false, colour: false });
    expect(by('Background')).toMatchObject({ kind: 'other', box: 'wh', colour: false });
    expect(by('Background').keys!.map((k) => [k.key, k.type])).toEqual([['bgcolor_override', 'colour']]);
  });

  it('carries the two text colours on the element, named for what they colour, ungated', () => {
    const keys = elementById('ghostPanel')!.keys!;
    expect(keys.map((k) => [k.key, k.label, k.type])).toEqual([['WhiteText', 'Text colour', 'colour'], ['RedText', 'Warning colour', 'colour']]);
    for (const k of keys) expect(k.gate, k.key).toBeUndefined();
  });

  it('keeps the edits, drops a colour on a line and writes them all', () => {
    const d = validateDesign({ v: 1,
      elements: { ghostPanel: { keys: { WhiteText: '0 255 255 255', RedText: '255 255 0 255' } } },
      children: { ghostPanel: {
        ClassName: { x: 150, fontSize: 20, color: '255 0 255 255' },
        ClassImage: { x: 240, y: 20, w: 60, h: 70 },
        Background: { keys: { bgcolor_override: '0 0 128 200' } },
      } } });
    expect(d.children.ghostPanel.ClassName).toEqual({ x: 150, fontSize: 20 });
    expect(d.children.ghostPanel.ClassImage).toEqual({ x: 240, y: 20, w: 60, h: 60 });
    const layout = kvFind(read(d, 'scripts/hudlayout.res'), ['HudGhostPanel'])!;
    expect([kvGet(layout, 'WhiteText'), kvGet(layout, 'RedText')]).toEqual(['0 255 255 255', '255 255 0 255']);
    const t = read(d, FILE);
    expect(kvGet(kvFind(t, ['ClassName'])!, 'xpos')).toBe('150');
    expect(kvGet(kvFind(t, ['ClassName'])!, 'font')).toMatch(/^HudEd_FrameTitle_t20$/);
    expect(['xpos', 'ypos', 'wide', 'tall'].map((k) => kvGet(kvFind(t, ['ClassImage'])!, k))).toEqual(['240', '20', '60', '60']);
    expect(kvGet(kvFind(t, ['Background'])!, 'bgcolor_override')).toBe('0 0 128 200');
  });

  it('scales every piece and the container with the element', () => {
    const d = validateDesign({ v: 1, elements: { ghostPanel: { scale: 2 } } });
    const bg = kvFind(buildTrees(d)(FILE), ['Background'])!;
    expect(['xpos', 'ypos', 'wide', 'tall'].map((k) => kvGet(bg, k))).toEqual(['20', '10', '660', '220']);
    const el = kvFind(buildTrees(d)('scripts/hudlayout.res'), ['HudGhostPanel'])!;
    expect([kvGet(el, 'wide'), kvGet(el, 'tall')]).toEqual(['700', '310']);
  });
});
