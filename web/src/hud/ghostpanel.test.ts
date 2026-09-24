import { describe, it, expect, beforeEach } from 'vitest';
import { GHOST_PANEL, panelChildren } from './children';
import { elementById } from './elements';
import { buildHud, buildTrees, elementRect } from './build';
import { drawHud, hitTest } from './mock';
import { _setImageFactory, _resetAssetCache, DEFAULT_PREVIEW, type PreviewState } from './render';
import { artUrl } from './art';
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

describe('the spawn panel drawn from its file (plan task G2)', () => {
  const K = 2.25;
  const GHOST = { ...DEFAULT_PREVIEW, infected: 'ghost' as const };
  function calls(design: ReturnType<typeof validateDesign>, state: PreviewState = GHOST) {
    _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 128, naturalHeight: 128, onload: null, onerror: null }) as unknown as HTMLImageElement);
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
    drawHud(ctx, 1920, 1080, design, 'infected', null, undefined, { state });
    _setImageFactory(null);
    return out;
  }
  const texts = (c: { m: string; a: unknown[]; fill: string }[]) => c.filter((x) => x.m === 'fillText');
  const text = (c: { m: string; a: unknown[]; fill: string }[], s: string) => texts(c).find((x) => x.a[0] === s);

  beforeEach(() => { _resetAssetCache(); });

  it('draws the class, the title and the two warnings in the panel\'s Text and Warning colours (r3-a)', () => {
    const d = validateDesign({ v: 1, elements: { ghostPanel: { keys: { WhiteText: '0 255 255 255', RedText: '255 255 0 255' } } } });
    const all = calls(d);
    expect(text(all, 'HUNTER')!.fill).toBe('rgba(0,255,255,1)');
    expect(text(all, 'Choose Spawn Location')!.fill).toBe('rgba(0,255,255,1)');
    expect(text(all, "Can't spawn here")!.fill).toBe('rgba(255,255,0,1)');
    expect(text(all, 'This is a restricted area')!.fill).toBe('rgba(255,255,0,1)');
  });

  it('draws the stock colours when the panel keeps its file ones: grey text, red warnings (b13 ghost.png)', () => {
    const all = calls(validateDesign({ v: 1 }));
    expect(text(all, 'HUNTER')!.fill).toBe('rgba(192,192,192,1)');
    expect(text(all, "Can't spawn here")!.fill).toBe('rgba(246,5,5,1)');
  });

  it('puts the lines, the class picture and the box where the file says, as r3-a measured', () => {
    const d = validateDesign({ v: 1, children: { ghostPanel: { ClassName: { x: 150 }, ClassImage: { x: 240, y: 20, w: 60, h: 60 } } } });
    const r = elementRect(d, 'ghostPanel', d.aspect);
    const all = calls(d, { ...GHOST, siClass: 'smoker' });
    // The panel at c-175, c10: about 566, 562.5 px. SMOKER's ink starts at x 906 in r3-a (the text origin plus the glyph's bearing).
    expect(Math.abs(r.x * K - 566.25)).toBeLessThanOrEqual(0.5);
    // The origin, 150 units in: 903.75 px, the ink 2 px later.
    expect(Math.abs((text(all, 'SMOKER')!.a[1] as number) - 903.75)).toBeLessThanOrEqual(1);
    // The lines at x 95 units: 780 px, ink from x 781 in r3-a.
    expect(Math.abs((text(all, 'Choose Spawn Location')!.a[1] as number) - 780)).toBeLessThanOrEqual(1);
    const pic = all.find((x) => x.m === 'drawImage' && (x.a[0] as HTMLImageElement).src === artUrl('icon/tip_smoker'))!;
    expect(pic.a.slice(1)).toEqual([(r.x + 240) * K, (r.y + 20) * K, 60 * K, 60 * K]);
  });

  it('draws the rounded box in its colour at the Background block (x 589 to 1331, y 573 to 820 px in b13 ghost.png)', () => {
    const d = validateDesign({ v: 1, children: { ghostPanel: { Background: { keys: { bgcolor_override: '0 0 128 200' } } } } });
    const all = calls(d);
    const box = all.find((x) => x.m === 'roundRect')!.a as number[];
    // The game's box: dark from x 589 (x 588 partly) to 1330, y 573 to 819.
    for (const [got, want] of [[box[0], 588.75], [box[1], 573.75], [box[2], 742.5], [box[3], 247.5]]) expect(Math.abs(got - want)).toBeLessThanOrEqual(1);
    expect(all.some((x) => x.m === 'fill' && x.fill === `rgba(0,0,128,${200 / 255})`)).toBe(true);
  });

  it('shows only while you are a ghost, and is picked only then', () => {
    const d = validateDesign({ v: 1 });
    expect(text(calls(d, DEFAULT_PREVIEW), 'HUNTER')).toBeUndefined();
    expect(text(calls(d, { ...DEFAULT_PREVIEW, infected: 'dead' }), 'HUNTER')).toBeUndefined();
    const r = elementRect(d, 'ghostPanel', d.aspect);
    expect(hitTest(d, 'infected', r.x + r.w - 20, r.y + 20, GHOST)).toBe('ghostPanel');
    expect(hitTest(d, 'infected', r.x + r.w - 20, r.y + 20, DEFAULT_PREVIEW)).not.toBe('ghostPanel');
  });

  it('scales every piece with the element', () => {
    const d = validateDesign({ v: 1, elements: { ghostPanel: { scale: 2 } } });
    const r = elementRect(d, 'ghostPanel', d.aspect);
    const pic = calls(d).find((x) => x.m === 'drawImage' && (x.a[0] as HTMLImageElement).src === artUrl('icon/tip_hunter'))!;
    expect(pic.a.slice(1)).toEqual([(r.x + 30) * K, (r.y + 20) * K, 170 * K, 170 * K]);
  });
});
