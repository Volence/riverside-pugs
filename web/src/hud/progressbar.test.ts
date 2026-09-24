import { describe, it, expect } from 'vitest';
import { PROGRESS_PANEL, panelChildren } from './children';
import { elementById } from './elements';
import { buildHud, buildTrees, elementRect } from './build';
import { validateDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { baseFile } from './base';
import { childAt, panelBoxes } from './mock';

/**
 * The use / revive bar's pieces (plan task U1). Probe answers,
 * /home/volence/l4d/hud/probe-phase2-rest/RESULTS.md:
 * - P1, P2: BarLabel's fgcolor_override and font are honoured (r1/shots/crops/bar-e.png).
 * - P3: AwardIcon moves and sizes (r1/shots/crops/bar-e-icon.png).
 * - Q22 (probe-phase2): every Bar key is honoured.
 * - P4: Subtext never shows in a self heal; its keys are plain Label keys.
 */
const FILE = 'resource/ui/hud/progressbar.res';
const file = (preset: 'stock' | 'modern') => parseKv(baseFile(preset, FILE))[0].value as KvNode[];
const by = (n: string) => PROGRESS_PANEL.children.find((c) => c.name === n)!;
const rect = (n: KvNode) => ['xpos', 'ypos', 'wide', 'tall'].map((k) => kvGet(n, k));

describe('the use bar registry (plan task U1)', () => {
  it('is the single progressbar.res, framed by its hudlayout.res block, and the element scales it', () => {
    expect(panelChildren('progressBar')).toBe(PROGRESS_PANEL);
    expect(PROGRESS_PANEL).toMatchObject({ file: FILE, repeat: 'single', frame: 'hudlayout' });
    expect(PROGRESS_PANEL.children.map((c) => c.name)).toEqual(['BarLabel', 'Bar', 'AwardIcon', 'Subtext']);
    const el = elementById('progressBar')!;
    expect(el.resize).toBe('scale');
    expect(el.children).toEqual([FILE]);
  });

  it('names blocks both presets have', () => {
    for (const preset of ['stock', 'modern'] as const) for (const def of PROGRESS_PANEL.children) {
      expect(kvFind(file(preset), [def.name]), `${preset} ${def.name}`).toBeDefined();
    }
  });

  it('offers what the probes proved on each piece', () => {
    expect(by('BarLabel')).toMatchObject({ kind: 'label', box: 'wh', move: true, font: true, colour: true });
    expect(by('Bar')).toMatchObject({ kind: 'other', box: 'wh', move: true, font: false, colour: false });
    expect(by('Bar').keys!.map((k) => [k.key, k.type])).toEqual([
      ['fill_color', 'colour'], ['empty_color', 'colour'], ['border_color', 'colour'], ['shadow_color', 'colour'],
      ['gap', 'int'], ['border_thickness', 'int'], ['shadow_thickness', 'int'],
    ]);
    expect(by('AwardIcon')).toMatchObject({ kind: 'other', box: 'square', move: true, font: false, colour: false });
    expect(by('AwardIcon').note).toBe('The game picks healing or reviving.');
    expect(by('Subtext')).toMatchObject({ kind: 'label', box: 'wh', move: true, font: true, colour: true });
    expect(by('Subtext').note).toBe('Shows a name when someone heals or revives you; not seen in our tests.');
    for (const c of PROGRESS_PANEL.children) expect(c.colourGate, c.name).toBeUndefined();
  });

  it('keeps the pieces\' edits and cuts the border and gap so the bar keeps a unit of fill', () => {
    const d = validateDesign({ v: 1, children: { progressBar: {
      BarLabel: { color: '255 0 255 255', fontSize: 20, x: 40 },
      AwardIcon: { x: 232, y: 0, w: 40, h: 50 },
      Bar: { keys: { fill_color: '0 255 0 255', border_thickness: 3, gap: 3, shadow_thickness: 1 } },
    } } });
    expect(d.children.progressBar.BarLabel).toEqual({ color: '255 0 255 255', fontSize: 20, x: 40 });
    expect(d.children.progressBar.AwardIcon).toEqual({ x: 232, y: 0, w: 40, h: 40 });
    // The stock bar is 8 tall: 2 x (border + gap) + shadow < 8 leaves border 3, gap 0 (probe Q22's rule).
    expect(d.children.progressBar.Bar.keys).toEqual({ fill_color: '0 255 0 255', border_thickness: '3', gap: '0', shadow_thickness: '1' });
    const tall = validateDesign({ v: 1, children: { progressBar: { Bar: { h: 20, keys: { border_thickness: 3, gap: 3 } } } } });
    expect(tall.children.progressBar.Bar.keys).toEqual({ border_thickness: '3', gap: '3' });
  });

  it('writes the edits into progressbar.res', () => {
    const d = validateDesign({ v: 1, children: { progressBar: {
      BarLabel: { color: '255 0 255 255' }, AwardIcon: { x: 232, y: 0, w: 40, h: 40 },
      Bar: { keys: { fill_color: '0 255 0 255' } }, Subtext: { visible: false },
    } } });
    const t = parseKv(new TextDecoder('latin1').decode(buildHud(d).find((f) => f.path === FILE)!.data))[0].value as KvNode[];
    expect(kvGet(kvFind(t, ['BarLabel'])!, 'fgcolor_override')).toBe('255 0 255 255');
    expect(rect(kvFind(t, ['AwardIcon'])!)).toEqual(['232', '0', '40', '40']);
    expect(kvGet(kvFind(t, ['Bar'])!, 'fill_color')).toBe('0 255 0 255');
    expect(rect(kvFind(t, ['Subtext'])!).slice(2)).toEqual(['0', '0']);
  });

  it('cuts a live border past the bar\'s own tall in the build too', () => {
    const t = buildTrees({ ...validateDesign({ v: 1 }), children: { progressBar: { Bar: { keys: { border_thickness: '3', gap: '3', shadow_thickness: '1' } } } } })(FILE);
    expect(['border_thickness', 'gap'].map((k) => kvGet(kvFind(t, ['Bar'])!, k))).toEqual(['3', '0']);
  });

  it('scales every piece and the container with the element', () => {
    const d = validateDesign({ v: 1, elements: { progressBar: { scale: 2 } } });
    const t = buildTrees(d)(FILE);
    expect(rect(kvFind(t, ['Bar'])!)).toEqual(['56', '30', '400', '16']);
    expect(rect(kvFind(t, ['AwardIcon'])!)).toEqual(['4', '0', '48', '48']);
    const el = kvFind(buildTrees(d)('scripts/hudlayout.res'), ['HudProgressBar'])!;
    expect([kvGet(el, 'wide'), kvGet(el, 'tall')]).toEqual(['600', '90']);
  });

  it('frames the pieces in the real container, so a piece moved past the old stand-in size is still picked', () => {
    const d = validateDesign({ v: 1, children: { progressBar: { AwardIcon: { x: 232, y: 0, w: 40, h: 40 } } } });
    const r = elementRect(d, 'progressBar', d.aspect);
    expect(panelBoxes(d, 'progressBar')).toEqual([{ x: r.x, y: r.y, w: 300, h: 45 }]);
    expect(childAt(d, 'healthy', r.x + 250, r.y + 20, 'progressBar')).toEqual({ name: 'AwardIcon', card: 0 });
    expect(childAt(d, 'healthy', r.x + 100, r.y + 20, 'progressBar')).toEqual({ name: 'Bar', card: 0 });
  });
});
