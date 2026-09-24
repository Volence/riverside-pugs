import { describe, it, expect, beforeEach } from 'vitest';
import { PROGRESS_PANEL, panelChildren } from './children';
import { elementById } from './elements';
import { buildHud, buildTrees, elementRect } from './build';
import { validateDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { baseFile } from './base';
import { childAt, panelBoxes, drawHud, visibleElements, hitTest } from './mock';
import { _setImageFactory, _resetAssetCache } from './render';
import { artUrl } from './art';

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

describe('the use bar is a survivor element', () => {
  // Every label the bar can carry is a heal, revive or help-up
  // (client.dll #L4D_progress_* strings), and server.so starts the bar only
  // from CTerrorPlayer::StartHealing / StartReviving, the first aid kit, and
  // a map's timed button (CButtonTimed::UseTimed). Drawn on the infected
  // side, the sample sat over the spawn panel.
  it('is listed, drawn and picked on the survivor side only', () => {
    const d = validateDesign({ v: 1 });
    expect(elementById('progressBar')!.side).toBe('survivor');
    expect(visibleElements('survivor', d).map((e) => e.id)).toContain('progressBar');
    expect(visibleElements('infected', d).map((e) => e.id)).not.toContain('progressBar');
    const r = elementRect(d, 'progressBar', d.aspect);
    expect(hitTest(d, 'infected', r.x + 5, r.y + 5)).not.toBe('progressBar');
  });
});

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

describe('the use bar preview from its edited file (plan task U2)', () => {
  const K = 2.25;
  function calls(design: ReturnType<typeof validateDesign>) {
    _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement);
    const out: { m: string; a: unknown[]; fill: string }[] = [];
    const t: Record<string | symbol, unknown> = {
      fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1, lineWidth: 1,
      canvas: { width: 1920, height: 1080, getContext: () => null },
      measureText: (s: string) => ({ width: s.length * 10 }),
    };
    for (const m of ['clearRect', 'fillRect', 'strokeRect', 'fillText', 'drawImage', 'putImageData', 'beginPath', 'rect', 'clip', 'arc', 'stroke',
      'fill', 'save', 'restore', 'setLineDash', 'moveTo', 'lineTo', 'closePath', 'roundRect']) t[m] = () => {};
    const ctx = new Proxy(t, {
      get: (o, k) => (typeof o[k] === 'function'
        ? (...a: unknown[]) => { out.push({ m: String(k), a, fill: String(o.fillStyle) }); return (o[k] as (...x: unknown[]) => unknown)(...a); }
        : o[k]),
      set: (o, k, v) => { o[k] = v; return true; },
    }) as unknown as CanvasRenderingContext2D;
    drawHud(ctx, 1920, 1080, design, 'survivor', null);
    _setImageFactory(null);
    return out;
  }
  const icon = (c: { m: string; a: unknown[] }[]) => c.find((x) => x.m === 'drawImage' && (x.a[0] as HTMLImageElement).src === artUrl('icon/healing'))!;

  beforeEach(() => { _resetAssetCache(); });

  it('draws the label in its colour and the icon at its moved rect, clipped to the real 300 x 45 container (r1 bar-e, bar-e-icon)', () => {
    const d = validateDesign({ v: 1, children: { progressBar: { BarLabel: { color: '255 0 255 255' }, AwardIcon: { x: 232, y: 0, w: 40, h: 40 } } } });
    const r = elementRect(d, 'progressBar', d.aspect);
    const all = calls(d);
    const label = all.filter((c) => c.m === 'fillText' && c.a[0] === 'HEALING YOURSELF');
    expect(label.at(-1)!.fill).toBe('rgba(255,0,255,1)');
    expect(icon(all).a.slice(1)).toEqual([(r.x + 232) * K, r.y * K, 40 * K, 40 * K]);
    expect(all.filter((c) => c.m === 'rect').map((c) => c.a)).toContainEqual([r.x * K, r.y * K, 300 * K, 45 * K]);
  });

  it('keeps drawing the bar keys, now from the edit', () => {
    const d = validateDesign({ v: 1, children: { progressBar: { Bar: { keys: { fill_color: '0 255 0 255' } } } } });
    expect(calls(d).some((c) => c.m === 'fillRect' && c.fill === 'rgba(0,255,0,1)')).toBe(true);
  });

  it('scales every piece with the element', () => {
    const d = validateDesign({ v: 1, elements: { progressBar: { scale: 2 } } });
    const r = elementRect(d, 'progressBar', d.aspect);
    const all = calls(d);
    expect(icon(all).a.slice(1)).toEqual([(r.x + 4) * K, r.y * K, 48 * K, 48 * K]);
    expect(all.filter((c) => c.m === 'rect').map((c) => c.a)).toContainEqual([r.x * K, r.y * K, 600 * K, 90 * K]);
    // The ring's top strip: the bar at 56, 30, 400 wide. Its thicknesses are file keys the scale leaves
    // alone (scalePass scales places and sizes only), so the file still says 1 unit: 2 px thick, 2 px of shadow.
    const bx = Math.floor(r.x * K) + Math.floor(56 * K), by = Math.floor(r.y * K) + Math.floor(30 * K);
    expect(all.filter((c) => c.m === 'fillRect' && c.fill === 'rgba(255,255,255,1)').map((c) => c.a)).toContainEqual([bx, by, 400 * K - 2, 2]);
  });
});
