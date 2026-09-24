import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FRUST_PANEL, panelChildren } from './children';
import { elementById } from './elements';
import { elementRect, buildTrees } from './build';
import { validateDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { baseFile } from './base';
import { childAt, drawHud, hitTest, panelBoxes } from './mock';
import { _setImageFactory, _resetAssetCache, DEFAULT_PREVIEW, type PreviewState } from './render';
import { probe, _setProbe } from './probes';

/**
 * The Tank frustration meter (plan task Z3). No probe has seen it drawn:
 * /home/volence/l4d/hud/probe-phase2-rest/RESULTS.md, T1..T4 (r3-h..k, r6-i..l,
 * ../probe-2f/i/shots-tank-control/). Its pieces wait on gate T1; the
 * preview draws the file as it stands whatever the gate, since it only
 * reads the file.
 */
const FILE = 'resource/ui/hud/frustrationmeter.res';
const TANK: PreviewState = { ...DEFAULT_PREVIEW, siClass: 'tank' };
const NAMES = ['Countdown', 'Warning', 'Warning2', 'FrustrationBar', 'FrustrationLabel'];
const K = 2.25;

describe('the frustration meter pieces, behind gate T1 (plan task Z3)', () => {
  afterEach(() => { _setProbe('T1', null); });

  it('is the single frustrationmeter.res, framed by its hudlayout.res block, every piece gated on T1', () => {
    expect(panelChildren('tankPanel')).toBe(FRUST_PANEL);
    expect(FRUST_PANEL).toMatchObject({ file: FILE, repeat: 'single', frame: 'hudlayout' });
    expect(FRUST_PANEL.children.map((c) => c.name)).toEqual(NAMES);
    for (const c of FRUST_PANEL.children) expect(c.gate, c.name).toBe('T1');
    expect(FRUST_PANEL.children.find((c) => c.name === 'FrustrationBar')!.keys!.map((k) => [k.key, k.type, k.gate])).toEqual([['east_aligned', 'bool', 'T1']]);
    for (const n of ['Countdown', 'Warning', 'Warning2', 'FrustrationLabel']) {
      expect(FRUST_PANEL.children.find((c) => c.name === n), n).toMatchObject({ kind: 'label', move: true, font: true, colour: true });
    }
    // V1d (probe-phase2-rest/v1/crops/v1d-frustration-a.png): every piece honoured, so T1 passed.
    expect(probe('T1')).toBe(true);
  });

  it('names blocks the file both presets read has (Modern ships none: the stock one)', () => {
    for (const preset of ['stock', 'modern'] as const) {
      const t = parseKv(baseFile(preset, FILE))[0].value as KvNode[];
      for (const n of NAMES) expect(kvFind(t, [n]), `${preset} ${n}`).toBeDefined();
    }
  });

  it('keeps no edit while T1 is closed, and writes them once it passes', () => {
    _setProbe('T1', false);
    const raw = { v: 1, children: { tankPanel: { Countdown: { color: '255 0 255 255' }, FrustrationBar: { keys: { east_aligned: false } } } } };
    expect(validateDesign(raw).children.tankPanel).toBeUndefined();
    _setProbe('T1', true);
    const d = validateDesign(raw);
    expect(d.children.tankPanel).toEqual({ Countdown: { color: '255 0 255 255' }, FrustrationBar: { keys: { east_aligned: '0' } } });
    const t = buildTrees(d)(FILE);
    expect(kvGet(kvFind(t, ['Countdown'])!, 'fgcolor_override')).toBe('255 0 255 255');
    expect(kvGet(kvFind(t, ['FrustrationBar'])!, 'east_aligned')).toBe('0');
  });

  it('never picks a piece while T1 is closed', () => {
    _setProbe('T1', false);
    const d = validateDesign({ v: 1 });
    const [box] = panelBoxes(d, 'tankPanel');
    expect(childAt(d, TANK, box.x + 20, box.y + 12, 'tankPanel')).toBeNull();
  });

  it('picks the title on the canvas now that T1 passed (V1d)', () => {
    const d = validateDesign({ v: 1 });
    const [box] = panelBoxes(d, 'tankPanel');
    expect(childAt(d, TANK, box.x + 20, box.y + 12, 'tankPanel')).toEqual({ name: 'Countdown', card: 0 });
  });
});

describe('the frustration meter drawn from its file (plan task Z3)', () => {
  function calls(design: ReturnType<typeof validateDesign>, state: PreviewState) {
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
    drawHud(ctx, 1920, 1080, design, 'infected', null, undefined, { state });
    _setImageFactory(null);
    return out;
  }
  const text = (c: { m: string; a: unknown[]; fill: string }[], s: string) => c.find((x) => x.m === 'fillText' && x.a[0] === s);
  beforeEach(() => { _resetAssetCache(); });
  afterEach(() => { _setProbe('T1', null); });

  it('draws the stock lines in their file colour and the bar half full from the east', () => {
    const d = validateDesign({ v: 1 });
    const r = elementRect(d, 'tankPanel', d.aspect);
    const all = calls(d, TANK);
    for (const s of ['ATTACK THE SURVIVORS', 'You must attack or you will', 'lose control of the Tank', 'CONTROL']) {
      expect(text(all, s)?.fill, s).toBe('rgba(255,255,255,1)');
    }
    // FrustrationBar: 0, 53, 150 x 8, east_aligned 1: the fill is the right half.
    const fill = all.filter((x) => x.m === 'fillRect').map((x) => x.a as number[])
      .find((a) => Math.abs(a[0] - (r.x + 75) * K) < 0.01 && Math.abs(a[1] - (r.y + 53) * K) < 0.01);
    expect(fill).toEqual([(r.x + 75) * K, (r.y + 53) * K, 75 * K, 8 * K]);
  });

  it('draws a west bar from the west once the file says so', () => {
    _setProbe('T1', true);
    const d = validateDesign({ v: 1, children: { tankPanel: { FrustrationBar: { keys: { east_aligned: false } } } } });
    const r = elementRect(d, 'tankPanel', d.aspect);
    const all = calls(d, TANK);
    expect(all.filter((x) => x.m === 'fillRect').map((x) => x.a)).toContainEqual([r.x * K, (r.y + 53) * K, 75 * K, 8 * K]);
  });

  it('shows only for a spawned Tank, and is picked only then', () => {
    const d = validateDesign({ v: 1 });
    expect(text(calls(d, DEFAULT_PREVIEW), 'ATTACK THE SURVIVORS')).toBeUndefined();
    expect(text(calls(d, { ...TANK, infected: 'dead' }), 'ATTACK THE SURVIVORS')).toBeUndefined();
    const r = elementRect(d, 'tankPanel', d.aspect);
    expect(hitTest(d, 'infected', r.x + 5, r.y + 70, TANK)).toBe('tankPanel');
    expect(hitTest(d, 'infected', r.x + 5, r.y + 70, DEFAULT_PREVIEW)).not.toBe('tankPanel');
    expect(elementById('tankPanel')).toMatchObject({ shownIn: ['alive'], shownFor: ['tank'] });
  });
});
