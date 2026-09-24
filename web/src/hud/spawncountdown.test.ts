import { describe, it, expect, beforeEach } from 'vitest';
import { elementById } from './elements';
import { buildHud, buildTrees, elementRect } from './build';
import { validateDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { drawHud, hitTest } from './mock';
import { _setImageFactory, _resetAssetCache, DEFAULT_PREVIEW, type PreviewState } from './render';
import { parsePos, SCREEN_H, screenW } from './units';

/**
 * The dead infected spawn countdown (plan task M4): spectatorinfected.res's
 * InfectedState (code writes "You will enter Spawn Mode in N seconds"
 * there) and SpawnModeLabel above it ("YOU ARE DEAD"), moved as one
 * element; the colour and text size go on InfectedState. The addon copy of
 * the file is read (probe Q23, /home/volence/l4d/hud/probe-phase2-infected/b9/shots/b9/b9-e.png).
 */
const FILE = 'resource/ui/spectatorinfected.res';
const DEAD: PreviewState = { ...DEFAULT_PREVIEW, infected: 'dead' };
const read = (d: ReturnType<typeof validateDesign>, path: string) =>
  parseKv(new TextDecoder('latin1').decode(buildHud(d).find((f) => f.path === path)!.data))[0].value as KvNode[];
const pos = (n: KvNode) => [parsePos(kvGet(n, 'xpos')!, screenW('16:9')), parsePos(kvGet(n, 'ypos')!, SCREEN_H)];

describe('the spawn countdown element (plan task M4)', () => {
  it('is InfectedState in spectatorinfected.res, moving SpawnModeLabel with it, shown while you are dead', () => {
    expect(elementById('spawnCountdown')).toMatchObject({
      key: 'InfectedState', file: FILE, moveWith: ['SpawnModeLabel'], side: 'infected', move: true, resize: 'none', shownIn: ['dead'],
    });
  });

  it('sits where the file puts InfectedState', () => {
    const d = validateDesign({ v: 1 });
    const r = elementRect(d, 'spawnCountdown', d.aspect);
    expect([r.x, r.y, r.w, r.h]).toEqual([parsePos('c-150', screenW('16:9')), 14, 300, 24]);
  });

  it('moves both labels by the same amount and writes nothing into hudlayout.res', () => {
    const d = validateDesign({ v: 1, elements: { spawnCountdown: { x: 20, y: 100 } } });
    const files = buildHud(d);
    const t = read(d, FILE);
    expect(pos(kvFind(t, ['InfectedState'])!)).toEqual([20, 100]);
    // SpawnModeLabel keeps its 10 units above InfectedState.
    expect(pos(kvFind(t, ['SpawnModeLabel'])!)).toEqual([20, 90]);
    const layout = (fs: typeof files) => fs.find((f) => f.path === 'scripts/hudlayout.res')!.data;
    expect(layout(files)).toEqual(layout(buildHud(validateDesign({ v: 1 }))));
  });

  it('colours and sizes the countdown line only', () => {
    const d = validateDesign({ v: 1, elements: { spawnCountdown: { color: '255 0 255 255', fontSize: 20 } } });
    const t = buildTrees(d)(FILE);
    expect(kvGet(kvFind(t, ['InfectedState'])!, 'fgcolor_override')).toBe('255 0 255 255');
    expect(kvGet(kvFind(t, ['InfectedState'])!, 'font')).toBe('HudEd_default_t20');
    expect(kvGet(kvFind(t, ['SpawnModeLabel'])!, 'fgcolor_override')).toBe('128 128 128 255');
    expect(kvGet(kvFind(t, ['SpawnModeLabel'])!, 'font')).toBe('MenuTitle');
  });

  it('hard-hides both labels', () => {
    const t = read(validateDesign({ v: 1, elements: { spawnCountdown: { visible: false } } }), FILE);
    for (const n of ['InfectedState', 'SpawnModeLabel']) expect(['visible', 'wide', 'tall'].map((k) => kvGet(kvFind(t, [n])!, k)), n).toEqual(['0', '0', '0']);
  });

  it('leaves the download alone when untouched', () => {
    expect(buildHud(validateDesign({ v: 1 })).some((f) => f.path === FILE)).toBe(false);
  });
});

describe('the spawn countdown drawn from its file (plan task M4)', () => {
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

  it('draws the title and the countdown, centred on the screen, the countdown in its colour', () => {
    const all = calls(validateDesign({ v: 1, elements: { spawnCountdown: { color: '255 0 255 255' } } }), DEAD);
    const title = text(all, 'YOU ARE DEAD')!;
    expect(title.fill).toBe('rgba(128,128,128,1)');
    expect(Math.abs((title.a[1] as number) - 960)).toBeLessThanOrEqual(1);
    const line = text(all, 'You will enter Spawn Mode in 12 seconds')!;
    expect(line.fill).toBe('rgba(255,0,255,1)');
    expect(Math.abs((line.a[1] as number) - 960)).toBeLessThanOrEqual(1);
  });

  it('shows only while you are dead, and is picked only then', () => {
    const d = validateDesign({ v: 1 });
    expect(text(calls(d, DEFAULT_PREVIEW), 'YOU ARE DEAD')).toBeUndefined();
    const r = elementRect(d, 'spawnCountdown', d.aspect);
    expect(hitTest(d, 'infected', r.x + 10, r.y + 10, DEAD)).toBe('spawnCountdown');
    expect(hitTest(d, 'infected', r.x + 10, r.y + 10, DEFAULT_PREVIEW)).not.toBe('spawnCountdown');
  });
});
