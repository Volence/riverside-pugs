import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drawHud, hitTest, paintYourItems, panelBoxes, LIMIT_COLOUR } from './mock';
import { elementRect, yourItemsLimits } from './build';
import { setYourItems, setItemsLook } from './edit';
import { childRects, _setImageFactory, _resetAssetCache, DEFAULT_PREVIEW } from './render';
import { artUrl } from './art';
import { DEFAULT_DESIGN, validateDesign, type HudDesign } from './design';
import { baseFile, registerImport, unregisterImport } from './base';
import { sampleHud } from './importFixtures';
import { YOUR_ITEMS, BAR_EDGE_LABEL, CENTRE_EDGE_LABEL } from './youritems';

/** An image that is "loaded" the moment it is created, so drawImage fires synchronously. */
const instantImage = (url: string) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement;
beforeEach(() => { _resetAssetCache(); _setImageFactory(instantImage); });

/**
 * A 2D context stand-in answering every method, recording drawImage (with the alpha then), fillText, fillRect and paths.
 * measureText is 10 px wide unless `textW` gives a width per string.
 */
function proxyCtx(textW?: (s: string) => number) {
  const draws: { src: string; a: number[]; alpha: number }[] = [];
  const texts: string[] = [];
  const fills: number[][] = [];
  const path: (string | number)[][] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '', strokeStyle: '', font: '', canvas: { width: 853, height: 480 } };
  const stack: number[] = [];
  const ctx = new Proxy(state, {
    get: (t, k) => (typeof k === 'string' && k in t ? t[k] : (...a: unknown[]) => {
      if (k === 'save') stack.push(t.globalAlpha as number);
      if (k === 'restore') t.globalAlpha = stack.pop() ?? 1;
      if (k === 'drawImage') draws.push({ src: (a[0] as HTMLImageElement).src, a: a.slice(1) as number[], alpha: t.globalAlpha as number });
      if (k === 'fillText') texts.push(a[0] as string);
      if (k === 'fillRect') fills.push(a as number[]);
      if (k === 'moveTo') path.push(['M', ...(a as number[])]);
      if (k === 'lineTo') path.push(['L', ...(a as number[])]);
      if (k === 'measureText') return { width: textW ? textW(a[0] as string) : 10 };
      if (k === 'getImageData') return { data: new Uint8ClampedArray(4) };
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return { addColorStop() {} };
      return undefined;
    }),
    set: (t, k, v) => { t[k as string] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, draws, texts, fills, path };
}
const ICONS = ['icon/item/medkit', 'icon/item/pills', 'icon/item/pipebomb'].map((n) => artUrl(n));
const D: HudDesign = structuredClone(DEFAULT_DESIGN);

describe('the Your items row in the preview', () => {
  it('draws the full loadout in the row\'s box, one font tall, right-aligned in it', () => {
    const d = setYourItems(D, true);
    const r = elementRect(d, YOUR_ITEMS, d.aspect);
    const { ctx, draws } = proxyCtx();
    paintYourItems(ctx, r, d, 1);
    expect(draws.map((c) => c.src)).toEqual(ICONS);
    expect(draws[0].a[0]).toBeCloseTo(r.x, 9);
    expect(draws[0].a.slice(1)).toEqual([r.y, 18, 18]);
  });
  it('lays the row against the right of a box wider than one row, as the Label\'s east alignment does', () => {
    const d = setYourItems(D, true);
    const r = elementRect(d, YOUR_ITEMS, d.aspect);
    const { ctx, draws } = proxyCtx();
    paintYourItems(ctx, { ...r, w: r.w + 40 }, d, 1);
    expect(draws[0].a[0]).toBeCloseTo(r.x + 40, 9);
  });
  it('draws it empty while you are down or dead, and the same while crouched', () => {
    const d = setYourItems(D, true);
    const r = elementRect(d, YOUR_ITEMS, d.aspect);
    for (const survivor of ['down', 'dead'] as const) {
      const { ctx, draws } = proxyCtx();
      paintYourItems(ctx, r, d, 1, undefined, { state: { ...DEFAULT_PREVIEW, survivor } });
      expect(draws, survivor).toEqual([]);
    }
    const { ctx, draws } = proxyCtx();
    paintYourItems(ctx, r, d, 1, undefined, { state: { ...DEFAULT_PREVIEW, crouched: true } });
    expect(draws).toHaveLength(3);
  });
  it('takes the colour\'s alpha, as the cards\' Items do', () => {
    const d0 = setYourItems(D, true);
    const d = { ...d0, elements: { ...d0.elements, yourItems: { ...d0.elements.yourItems, color: '255 255 255 128' } } };
    const { ctx, draws } = proxyCtx();
    paintYourItems(ctx, elementRect(d, YOUR_ITEMS, d.aspect), d, 1);
    expect(draws[0].alpha).toBeCloseTo(128 / 255, 6);
  });
  it('is drawn by drawHud only once on, and picked by a click', () => {
    const d = setYourItems(D, true);
    const r = elementRect(d, YOUR_ITEMS, d.aspect);
    // The item icons only: the weapon panel's grenade slot starts on the same line as the row's home spot.
    const inRow = (c: { src: string; a: number[] }) => ICONS.includes(c.src) && c.a[0] >= r.x - 0.5 && c.a[0] <= r.x + r.w && Math.abs(c.a[1] - r.y) < 0.5;
    const off = proxyCtx();
    drawHud(off.ctx, 853, 480, D, 'survivor', null);
    expect(off.draws.filter(inRow)).toEqual([]);
    const onDraw = proxyCtx();
    drawHud(onDraw.ctx, 853, 480, d, 'survivor', null);
    expect(onDraw.draws.filter(inRow).map((c) => c.src)).toEqual(ICONS);
    expect(hitTest(d, 'survivor', r.x + r.w / 2, r.y + r.h / 2)).toBe(YOUR_ITEMS);
    expect(hitTest(D, 'survivor', r.x + r.w / 2, r.y + r.h / 2)).not.toBe(YOUR_ITEMS);
  });
  it('leaves your own health card exactly as it draws with the element off', () => {
    const d = setYourItems(D, true);
    expect(panelBoxes(d, 'ownHealth')).toEqual(panelBoxes(D, 'ownHealth'));
    const [box] = panelBoxes(D, 'ownHealth');
    expect(childRects(d, 'ownHealth', box, 1)).toEqual(childRects(D, 'ownHealth', box, 1));
  });
});

describe('the limit while Your items is placed (spec section 2)', () => {
  it('shades everything left of the bar full height and draws a labelled line there', () => {
    const d = setYourItems(D, true);
    const { ctx, fills, path, texts } = proxyCtx();
    drawHud(ctx, 853, 480, d, 'survivor', [YOUR_ITEMS], undefined, { limits: yourItemsLimits(d) });
    expect(fills).toContainEqual([0, 0, 754, 480]);
    expect(path).toContainEqual(['M', 754, 0]);
    expect(path).toContainEqual(['L', 754, 480]);
    expect(texts).toContain(BAR_EDGE_LABEL);
  });
  it('shades right of Centre\'s right-hand limit too', () => {
    const d = setItemsLook(setYourItems(D, true), { itemAlign: 'center' });
    const lines = yourItemsLimits(d);
    const { ctx, fills, texts } = proxyCtx();
    drawHud(ctx, 853, 480, d, 'survivor', [YOUR_ITEMS], undefined, { limits: lines });
    expect(fills).toContainEqual([lines[1].x, 0, 853 - lines[1].x, 480]);
    expect(texts).toContain(CENTRE_EDGE_LABEL);
  });
  /** The limit label plates drawn: 14 px tall fills (the shade fills are full height). */
  const plates = (fills: number[][]) => fills.filter((f) => f[3] === 14);
  /** About 6 px a character, near an 11 px sans-serif, so the plates are their real width. */
  const realW = (s: string) => s.length * 6;
  it('stacks Centre\'s two label plates so neither covers the other', () => {
    const d = setItemsLook(setYourItems(D, true), { itemAlign: 'center' });
    const lines = yourItemsLimits(d);
    expect(lines).toHaveLength(2);
    const { ctx, fills } = proxyCtx(realW);
    drawHud(ctx, 853, 480, d, 'survivor', [YOUR_ITEMS], undefined, { limits: lines });
    const [a, b] = plates(fills);
    // The two plates would overlap side by side (the limits are close), so they must not share any height.
    expect(a[0] < b[0] + b[2] && b[0] < a[0] + a[2]).toBe(true);
    expect(a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1]).toBe(true);
  });
  it('keeps the bar\'s label plate on a narrow canvas, the line still at the bar', () => {
    const d = setYourItems(D, true);
    const [line] = yourItemsLimits(d);
    const pxW = 800, pxH = 450, k = pxH / 480;
    const { ctx, fills, path } = proxyCtx(realW);
    drawHud(ctx, pxW, pxH, d, 'survivor', [YOUR_ITEMS], undefined, { limits: [line] });
    const [p] = plates(fills);
    expect(line.x * k + 4 + p[2]).toBeGreaterThan(pxW);   // unclamped, it would run off the canvas
    expect(p[0]).toBeGreaterThanOrEqual(0);
    expect(p[0] + p[2]).toBeLessThanOrEqual(pxW);
    expect(path).toContainEqual(['M', line.x * k, 0]);
  });
  it('draws nothing of it without view.limits, as a share or a screenshot draws', () => {
    const d = setYourItems(D, true);
    const { ctx, texts } = proxyCtx();
    drawHud(ctx, 853, 480, d, 'survivor', null);
    expect(texts).not.toContain(BAR_EDGE_LABEL);
  });
  it('is a colour of its own, not the pink of the snap guides', () => {
    expect(LIMIT_COLOUR.toLowerCase()).not.toBe('#ff4fa3');
  });
});

describe('an import that already places your items (spec section 3)', () => {
  const ID = 'c'.repeat(64);
  const OWN = 'resource/ui/hud/localplayerpanel.res';
  /** An own panel file with an Items Label of its author's, as build.youritems.test.ts builds it. */
  const withOwnItems = baseFile('stock', OWN).replace(/\}\s*$/, '\t"Items"\r\n\t{\r\n\t\t"ControlName"\t"Label"\r\n\t\t"fieldName"\t"Items"\r\n'
    + '\t\t"xpos"\t"26"\r\n\t\t"ypos"\t"0"\r\n\t\t"wide"\t"60"\r\n\t\t"tall"\t"20"\r\n\t\t"visible"\t"1"\r\n\t\t"font"\t"L4D_Icons_medium"\r\n\t}\r\n}\r\n');
  afterEach(() => { unregisterImport(ID); });
  it('never draws the row, even picked, nor any limit', () => {
    unregisterImport(ID);
    registerImport(ID, sampleHud({ [OWN]: withOwnItems }));
    const d = validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'x' }, elements: { yourItems: { visible: true, x: 780, y: 200 } } });
    const r = elementRect(d, YOUR_ITEMS, d.aspect);
    const { ctx, draws, texts } = proxyCtx();
    drawHud(ctx, 853, 480, d, 'survivor', [YOUR_ITEMS], undefined, { limits: yourItemsLimits(d) });
    expect(draws.filter((c) => ICONS.includes(c.src) && Math.abs(c.a[1] - r.y) < 0.5)).toEqual([]);
    expect(texts).not.toContain(BAR_EDGE_LABEL);
  });
});
