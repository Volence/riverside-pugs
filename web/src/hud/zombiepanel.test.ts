import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { elementById } from './elements';
import { ZPANEL_PANEL, panelChildren, childPath } from './children';
import { buildHud, elementRect, panelChild } from './build';
import { baseFile } from './base';
import { probe, _setProbe } from './probes';
import { drawnPieces } from './selection';
import { validateDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { drawHud, hitTest, childAt, panelBoxes } from './mock';
import { _setImageFactory, _resetAssetCache, DEFAULT_PREVIEW, type PreviewState } from './render';
import { artUrl } from './art';
import { parsePos, SCREEN_H } from './units';

/**
 * The too-far / Tank takeover panel (plan task Z1). Probe answers,
 * /home/volence/l4d/hud/probe-phase2-rest/RESULTS.md, R6 (a spawned Smoker
 * culled far from the survivors, r6/shots/r6/r6-a.png, crop
 * r6/shots/crops/toofar-a.png):
 * - Z1: HudZombiePanel moves (ypos c-200: the box at the top, y 101 px).
 * - Z2: TooFarTitle's fgcolor_override is honoured (magenta).
 * - Z4: the too-far Background's bgcolor_override is honoured (navy).
 */
const FILE = 'resource/ui/zombiepanel.res';
const read = (d: ReturnType<typeof validateDesign>, path: string) =>
  parseKv(new TextDecoder('latin1').decode(buildHud(d).find((f) => f.path === path)!.data))[0].value as KvNode[];
const K = 2.25;
const OCCASIONAL: PreviewState = { ...DEFAULT_PREVIEW, occasional: true };

describe('the too-far / Tank takeover element (plan task Z1)', () => {
  it('is HudZombiePanel, on the infected side, shown while you are spawned and only now and then', () => {
    expect(elementById('zombiePanel')).toMatchObject({ key: 'HudZombiePanel', side: 'infected', move: true, shownIn: ['alive'], occasional: true });
    expect(elementById('zombiePanel')!.note).toMatch(/far from the survivors/);
  });

  it('writes a move into HudZombiePanel (r6-a: ypos c-200, 40 units down)', () => {
    const d = validateDesign({ v: 1, elements: { zombiePanel: { y: 40 } } });
    const n = kvFind(read(d, 'scripts/hudlayout.res'), ['HudZombiePanel'])!;
    // Anchored to the nearer edge, as every move is: the top, 40 units down, where c-200 is.
    expect(parsePos(kvGet(n, 'ypos')!, SCREEN_H)).toBe(parsePos('c-200', SCREEN_H));
  });

  it('hard-hides it', () => {
    const d = validateDesign({ v: 1, elements: { zombiePanel: { visible: false } } });
    const n = kvFind(read(d, 'scripts/hudlayout.res'), ['HudZombiePanel'])!;
    expect(['visible', 'wide', 'tall'].map((k) => kvGet(n, k))).toEqual(['0', '0', '0']);
  });
});

describe('the too-far box drawn from zombiepanel.res (plan task Z1)', () => {
  function calls(design: ReturnType<typeof validateDesign>, state: PreviewState = OCCASIONAL, selected: string | null = null) {
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
    drawHud(ctx, 1920, 1080, design, 'infected', selected, undefined, { state });
    _setImageFactory(null);
    return out;
  }
  const text = (c: { m: string; a: unknown[]; fill: string }[], s: string) => c.find((x) => x.m === 'fillText' && x.a[0] === s);
  beforeEach(() => { _resetAssetCache(); });

  it('draws the title, the line, the class picture and the box where r6-a has them', () => {
    const d = validateDesign({ v: 1, elements: { zombiePanel: { y: 40 } } });
    const r = elementRect(d, 'zombiePanel', d.aspect);
    const all = calls(d, { ...OCCASIONAL, siClass: 'smoker' });
    // The box: x 622 to 1296, y 101 to 313 px.
    const box = all.find((x) => x.m === 'roundRect')!.a as number[];
    for (const [got, want] of [[box[0], 622.5], [box[1], 101.25], [box[2], 675], [box[3], 213.75]]) expect(Math.abs(got - want)).toBeLessThanOrEqual(1);
    // The title at x 90 in the box: 825 px, its ink from x 825.
    const title = text(all, 'TOO FAR FROM THE SURVIVORS')!;
    expect(Math.abs((title.a[1] as number) - 825)).toBeLessThanOrEqual(1);
    expect(title.fill).toBe('rgba(192,192,192,1)');
    // The line, which code places after the key: ink from x 884.
    expect(Math.abs((text(all, 'Move closer to the Survivors')!.a[1] as number) - 883.5)).toBeLessThanOrEqual(1.5);
    const pic = all.find((x) => x.m === 'drawImage' && (x.a[0] as HTMLImageElement).src === artUrl('icon/tip_smoker'))!;
    expect(pic.a.slice(1)).toEqual([(r.x + 10) * K, (r.y + 10) * K, 85 * K, 85 * K]);
  });

  it('shows only while you are spawned, and is picked only then', () => {
    const d = validateDesign({ v: 1 });
    expect(text(calls(d, { ...OCCASIONAL, infected: 'ghost' }), 'TOO FAR FROM THE SURVIVORS')).toBeUndefined();
    const r = elementRect(d, 'zombiePanel', d.aspect);
    expect(hitTest(d, 'infected', r.x + r.w - 20, r.y + 20, OCCASIONAL)).toBe('zombiePanel');
    expect(hitTest(d, 'infected', r.x + r.w - 20, r.y + 20, { ...OCCASIONAL, infected: 'ghost' })).toBe('ghostPanel');
  });

  it('is an occasional panel: left out of the everyday preview, drawn with Occasional panels on or while it is selected', () => {
    const d = validateDesign({ v: 1 });
    expect(text(calls(d, DEFAULT_PREVIEW), 'TOO FAR FROM THE SURVIVORS')).toBeUndefined();
    expect(text(calls(d, OCCASIONAL), 'TOO FAR FROM THE SURVIVORS')).toBeDefined();
    // Picking it (or one of its pieces, which selects its panel) in Layers shows it with the toggle off.
    expect(text(calls(d, DEFAULT_PREVIEW, 'zombiePanel'), 'TOO FAR FROM THE SURVIVORS')).toBeDefined();
    const r = elementRect(d, 'zombiePanel', d.aspect);
    expect(hitTest(d, 'infected', r.x + r.w - 20, r.y + 20, DEFAULT_PREVIEW)).not.toBe('zombiePanel');
  });
});

describe('the too-far pieces, and the Tank offer pieces behind gate Z3 (plan task Z2)', () => {
  const by = (n: string) => ZPANEL_PANEL.children.find((c) => c.name === n)!;
  const TOO_FAR = ['TooFarFromSurvivors/TooFarTitle', 'TooFarFromSurvivors/TooFarText', 'TooFarFromSurvivors/SurvivorsImage', 'TooFarFromSurvivors/Background'];
  const TANK = ['TankTakeover/Title', 'TankTakeover/Text', 'TankTakeover/TankImage', 'TankTakeover/Background'];
  afterEach(() => { _setProbe('Z3', null); });

  it('names each piece by its path inside the box that holds it, framed by the too-far box', () => {
    expect(panelChildren('zombiePanel')).toBe(ZPANEL_PANEL);
    expect(ZPANEL_PANEL).toMatchObject({ file: FILE, repeat: 'single', frame: { file: FILE, block: 'TooFarFromSurvivors' }, inFrame: true });
    expect(ZPANEL_PANEL.children.map((c) => c.name)).toEqual([...TOO_FAR, ...TANK]);
    expect(childPath('TooFarFromSurvivors/TooFarTitle')).toEqual(['TooFarFromSurvivors', 'TooFarTitle']);
    expect(childPath('Items')).toEqual(['Items']);
    for (const preset of ['stock', 'modern'] as const) {
      const t = parseKv(baseFile(preset, FILE))[0].value as KvNode[];
      for (const def of ZPANEL_PANEL.children) expect(kvFind(t, childPath(def.name)), `${preset} ${def.name}`).toBeDefined();
    }
  });

  it('offers what R6 proved on the too-far box, and gates every Tank offer piece on Z3', () => {
    expect(by('TooFarFromSurvivors/TooFarTitle')).toMatchObject({ kind: 'label', box: 'wh', move: true, font: true, colour: true });
    // Code places the line after the key: it has no xpos or wide in the file.
    expect(by('TooFarFromSurvivors/TooFarText')).toMatchObject({ kind: 'label', move: false, colour: true });
    expect(by('TooFarFromSurvivors/SurvivorsImage')).toMatchObject({ kind: 'other', box: 'square', move: true, colour: false });
    expect(by('TooFarFromSurvivors/Background').keys!.map((k) => k.key)).toEqual(['bgcolor_override']);
    for (const n of TOO_FAR) expect(by(n).gate, n).toBeUndefined();
    for (const n of TANK) expect(by(n).gate, n).toBe('Z3');
    // V1b (probe-phase2-rest/v1/crops/v1b-tank-offer.png, debug_zombie_panel 1): title, text and box honoured.
    expect(probe('Z3')).toBe(true);
  });

  it('keeps too-far edits and drops Tank offer edits while Z3 is closed', () => {
    _setProbe('Z3', false);
    const raw = { v: 1, children: { zombiePanel: {
      'TooFarFromSurvivors/TooFarTitle': { color: '255 0 255 255' },
      'TooFarFromSurvivors/Background': { keys: { bgcolor_override: '0 0 128 200' } },
      'TankTakeover/Title': { color: '255 255 0 255' },
    } } };
    expect(Object.keys(validateDesign(raw).children.zombiePanel)).toEqual(['TooFarFromSurvivors/TooFarTitle', 'TooFarFromSurvivors/Background']);
    _setProbe('Z3', true);
    expect(validateDesign(raw).children.zombiePanel['TankTakeover/Title']).toEqual({ color: '255 255 0 255' });
  });

  it('writes each edit into its own nested block (R6: TooFarFromSurvivors/TooFarTitle, not TankTakeover\'s)', () => {
    _setProbe('Z3', true);
    const d = validateDesign({ v: 1, children: { zombiePanel: {
      'TooFarFromSurvivors/TooFarTitle': { color: '255 0 255 255', x: 100 },
      'TooFarFromSurvivors/Background': { keys: { bgcolor_override: '0 0 128 200' } },
      'TankTakeover/Title': { color: '255 255 0 255' },
      'TooFarFromSurvivors/SurvivorsImage': { visible: false },
    } } });
    const t = read(d, FILE);
    const get = (path: string[], key: string) => kvGet(kvFind(t, path)!, key);
    expect(get(['TooFarFromSurvivors', 'TooFarTitle'], 'fgcolor_override')).toBe('255 0 255 255');
    expect(get(['TooFarFromSurvivors', 'TooFarTitle'], 'xpos')).toBe('100');
    expect(get(['TankTakeover', 'Title'], 'fgcolor_override')).toBe('255 255 0 255');
    expect(get(['TooFarFromSurvivors', 'Background'], 'bgcolor_override')).toBe('0 0 128 200');
    expect(get(['TankTakeover', 'Background'], 'bgcolor_override')).toBe('0 0 0 245');
    expect(['visible', 'wide', 'tall'].map((k) => get(['TooFarFromSurvivors', 'SurvivorsImage'], k))).toEqual(['0', '0', '0']);
  });

  it('reads a piece back where the side panel shows it, and picks it on the canvas, never a Tank offer piece', () => {
    const d = validateDesign({ v: 1 });
    expect(panelChild(d, 'zombiePanel', 'TooFarFromSurvivors/TooFarTitle')).toMatchObject({ x: 90, y: 9, w: 200, h: 35 });
    const [box] = panelBoxes(d, 'zombiePanel');
    const r = elementRect(d, 'zombiePanel', d.aspect);
    expect(box).toEqual({ x: r.x + 10, y: r.y + 5, w: 300, h: 95 });
    expect(childAt(d, DEFAULT_PREVIEW, box.x + 150, box.y + 20, 'zombiePanel')).toEqual({ name: 'TooFarFromSurvivors/TooFarTitle', card: 0 });
    expect(childAt(d, DEFAULT_PREVIEW, box.x + 40, box.y + 40, 'zombiePanel')).toEqual({ name: 'TooFarFromSurvivors/SurvivorsImage', card: 0 });
    // Z3 passed (V1b), so the Tank offer pieces are listed, but the preview draws the too-far box only: no point
    // of the box picks one.
    for (let x = 0; x < box.w; x += 5) for (let y = 0; y < box.h; y += 5) {
      expect(childAt(d, DEFAULT_PREVIEW, box.x + x, box.y + y, 'zombiePanel')?.name.startsWith('TankTakeover/') ?? false).toBe(false);
    }
  });

  it('draws the edited title colour and box colour in the preview (r6-a: magenta title, navy box)', () => {
    const d = validateDesign({ v: 1, children: { zombiePanel: {
      'TooFarFromSurvivors/TooFarTitle': { color: '255 0 255 255' },
      'TooFarFromSurvivors/Background': { keys: { bgcolor_override: '0 0 128 200' } },
    } } });
    _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 128, naturalHeight: 128, onload: null, onerror: null }) as unknown as HTMLImageElement);
    const fills: { m: string; a: unknown[]; fill: string }[] = [];
    const t: Record<string | symbol, unknown> = { fillStyle: '', font: '', textAlign: 'left', globalAlpha: 1, canvas: { width: 1920, height: 1080 }, measureText: (s: string) => ({ width: s.length * 10 }) };
    for (const m of ['fillRect', 'fillText', 'drawImage', 'beginPath', 'rect', 'clip', 'fill', 'save', 'restore', 'roundRect', 'strokeRect', 'setLineDash', 'stroke', 'moveTo', 'lineTo']) t[m] = () => {};
    const ctx = new Proxy(t, {
      get: (o, k) => (typeof o[k] === 'function' ? (...a: unknown[]) => { fills.push({ m: String(k), a, fill: String(o.fillStyle) }); return (o[k] as (...x: unknown[]) => unknown)(...a); } : o[k]),
      set: (o, k, v) => { o[k] = v; return true; },
    }) as unknown as CanvasRenderingContext2D;
    // Selected, as picking it in Layers draws it with Occasional panels off.
    drawHud(ctx, 1920, 1080, d, 'infected', 'zombiePanel', undefined, { state: DEFAULT_PREVIEW });
    _setImageFactory(null);
    expect(fills.find((x) => x.m === 'fillText' && x.a[0] === 'TOO FAR FROM THE SURVIVORS')!.fill).toBe('rgba(255,0,255,1)');
    expect(fills.some((x) => x.m === 'fill' && x.fill === `rgba(0,0,128,${200 / 255})`)).toBe(true);
  });
});
