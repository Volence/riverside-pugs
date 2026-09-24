import { describe, it, expect, beforeEach } from 'vitest';
import { elementById } from './elements';
import { buildHud, elementRect } from './build';
import { validateDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { drawHud, hitTest } from './mock';
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

describe('the too-far / Tank takeover element (plan task Z1)', () => {
  it('is HudZombiePanel, on the infected side, shown while you are spawned', () => {
    expect(elementById('zombiePanel')).toMatchObject({ key: 'HudZombiePanel', side: 'infected', move: true, shownIn: ['alive'] });
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
  function calls(design: ReturnType<typeof validateDesign>, state: PreviewState = DEFAULT_PREVIEW) {
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
  const text = (c: { m: string; a: unknown[]; fill: string }[], s: string) => c.find((x) => x.m === 'fillText' && x.a[0] === s);
  beforeEach(() => { _resetAssetCache(); });

  it('draws the title, the line, the class picture and the box where r6-a has them', () => {
    const d = validateDesign({ v: 1, elements: { zombiePanel: { y: 40 } } });
    const r = elementRect(d, 'zombiePanel', d.aspect);
    const all = calls(d, { ...DEFAULT_PREVIEW, siClass: 'smoker' });
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
    expect(text(calls(d, { ...DEFAULT_PREVIEW, infected: 'ghost' }), 'TOO FAR FROM THE SURVIVORS')).toBeUndefined();
    const r = elementRect(d, 'zombiePanel', d.aspect);
    expect(hitTest(d, 'infected', r.x + r.w - 20, r.y + 20, DEFAULT_PREVIEW)).toBe('zombiePanel');
    expect(hitTest(d, 'infected', r.x + r.w - 20, r.y + 20, { ...DEFAULT_PREVIEW, infected: 'ghost' })).toBe('ghostPanel');
  });
});
