import { describe, it, expect, beforeEach } from 'vitest';
import { visibleElements, hitTest, drawHud, childAt, panelBoxes, TEAM_CARDS } from './mock';
import { selectionFrames, TEAMMATES } from './selection';
import { withTeamDir } from './edit';
import { DEFAULT_DESIGN, validateDesign, type HudDesign } from './design';
import { baseFile, registerImport, unregisterImport } from './base';
import { sampleHud } from './importFixtures';
import { artUrl } from './art';
import { buildTrees, elementRect, teamCardRects } from './build';
import { kvFind, kvGet } from './kv';
import { SCREEN_H } from './units';
import { DEFAULT_STATE, PX_AT_1080 } from '../crosshair/draw';
import { PNG_PREFIX } from '../crosshair/model';
import { _setImageFactory, _resetAssetCache, childRects, DEFAULT_PREVIEW, type PreviewState } from './render';
import { canvasFont, fontCell } from './fonts';

/** The RichText's top inset measured in b2-e (see mock.ts CHAT_INSET). */
const CHAT_INSET_Y_PX = 1.5;

/**
 * A minimal stand-in for CanvasRenderingContext2D: happy-dom has no real
 * canvas, so this is the only way to assert what drawHud calls on it. Every
 * method drawHud or a painter (mock.ts) or drawCrosshair (crosshair/draw.ts)
 * touches gets a no-op; clearRect is tracked instead of no-op'd so the test
 * can assert it is never called. `methods` (if given) records every method
 * name called, in order; `texts` (if given) records every fillText string.
 */
function fakeCtx(onClearRect: () => void, methods?: string[], texts?: string[]): CanvasRenderingContext2D {
  const rec = (name: string, fn: (...a: unknown[]) => unknown = () => {}) => (...a: unknown[]) => {
    methods?.push(name);
    return fn(...a);
  };
  return {
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1, lineWidth: 1, lineCap: 'butt', lineJoin: 'round',
    canvas: { width: 853, height: 480, getContext: () => null },
    clearRect: onClearRect,
    fillRect: rec('fillRect'), strokeRect: rec('strokeRect'), fillText: rec('fillText', (...a: unknown[]) => { texts?.push(a[0] as string); }),
    drawImage: rec('drawImage'), putImageData: rec('putImageData'), measureText: rec('measureText', () => ({ width: 10 })),
    beginPath: rec('beginPath'), rect: rec('rect'), clip: rec('clip'), arc: rec('arc'),
    stroke: rec('stroke'), fill: rec('fill'), save: rec('save'), restore: rec('restore'),
    setLineDash: rec('setLineDash'), moveTo: rec('moveTo'), lineTo: rec('lineTo'), closePath: rec('closePath'),
    roundRect: rec('roundRect'),
  } as unknown as CanvasRenderingContext2D;
}

beforeEach(() => { _resetAssetCache(); });

describe('visibleElements', () => {
  it('splits by side and shares the "both" elements', () => {
    const s = visibleElements('survivor', DEFAULT_DESIGN).map((e) => e.id);
    const i = visibleElements('infected', DEFAULT_DESIGN).map((e) => e.id);
    expect(s).toContain('ownHealth'); expect(s).not.toContain('abilityRing');
    expect(i).toContain('abilityRing'); expect(i).not.toContain('ownHealth');
    expect(s).toContain('chat'); expect(i).toContain('chat');
  });
});

describe('hitTest', () => {
  it('finds the health panel in the bottom right on stock', () => {
    expect(hitTest(DEFAULT_DESIGN, 'survivor', 780, 430)).toBe('ownHealth');
  });
  it('returns null over empty screen', () => {
    expect(hitTest(DEFAULT_DESIGN, 'survivor', 426, 100)).toBeNull();
  });
  it('prefers the smaller of two overlapping elements', () => {
    expect(hitTest({ ...DEFAULT_DESIGN, crosshair: 'addon' }, 'survivor', 426, 240)).toBe('xhair');
  });
  it('skips hidden elements', () => {
    const d = { ...DEFAULT_DESIGN, elements: { ownHealth: { visible: false } } };
    expect(hitTest(d, 'survivor', 780, 430)).toBeNull();
  });
});

describe('drawHud', () => {
  it('never clears the canvas: the caller paints the backdrop first, and drawHud draws over it', () => {
    let cleared = false;
    const ctx = fakeCtx(() => { cleared = true; });

    // Survivor and infected sides exercise every painter; a hidden + selected
    // element exercises the dimmed/outline and selection-handle branches too.
    drawHud(ctx, 960, 540, DEFAULT_DESIGN, 'survivor', 'ownHealth');
    drawHud(ctx, 960, 540, DEFAULT_DESIGN, 'infected', 'abilityRing');
    const hiddenDesign = { ...DEFAULT_DESIGN, elements: { ownHealth: { visible: false } } };
    drawHud(ctx, 960, 540, hiddenDesign, 'survivor', 'ownHealth');

    expect(cleared).toBe(false);
  });
});

describe('drawHud, the crosshair', () => {
  /** fakeCtx, with every call's arguments recorded as well. */
  function argsCtx() {
    const calls: { m: string; a: unknown[] }[] = [];
    const base = fakeCtx(() => {}) as unknown as Record<string | symbol, unknown>;
    const ctx = new Proxy(base, {
      get: (t, k) => (typeof t[k] === 'function'
        ? (...a: unknown[]) => { calls.push({ m: String(k), a }); return (t[k] as (...x: unknown[]) => unknown)(...a); }
        : t[k]),
      set: (t, k, v) => { t[k] = v; return true; },
    });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
  }
  const DOT = { ...DEFAULT_STATE, shape: 'dot' as const, dot: 4, outline: 0 };
  const at = (d: HudDesign) => elementRect(d, 'xhair', d.aspect);
  const centred = (calls: { m: string; a: unknown[] }[], d: HudDesign) => calls.some((c) => c.m === 'arc'
    && Math.abs((c.a[0] as number) - (at(d).x + 13)) < 1e-9 && Math.abs((c.a[1] as number) - (at(d).y + 13)) < 1e-9);
  const outlined = (calls: { m: string; a: unknown[] }[], d: HudDesign) => calls.some((c) => c.m === 'strokeRect'
    && c.a[0] === at(d).x && c.a[1] === at(d).y && c.a[2] === 26 && c.a[3] === 26);

  it("draws the design's own built crosshair at the xHair rect, at the size the game draws it", () => {
    const d: HudDesign = { ...DEFAULT_DESIGN, crosshair: 'bundle', xhairArt: { kind: 'built', state: DOT } };
    const { ctx, calls } = argsCtx();
    drawHud(ctx, 853, 480, d, 'survivor', null);
    expect(centred(calls, d)).toBe(true);
    expect(outlined(calls, d)).toBe(false);
    // A 4-pixel dot at 1080p: radius 2 of the 26 units' PX_AT_1080 screen
    // pixels, as the texture scales it, not 2 whole HUD units.
    const arc = calls.find((c) => c.m === 'arc')!;
    expect(arc.a[2]).toBeCloseTo(2 * 26 / PX_AT_1080, 9);
  });

  it("draws the design's own image crosshair fitted into the xHair rect, once it has loaded", () => {
    _resetAssetCache();
    const png = `${PNG_PREFIX}AAAA`;
    const loaded: string[] = [];
    _setImageFactory((url) => { loaded.push(url); return { src: url, complete: true, naturalWidth: 64, naturalHeight: 32 } as unknown as HTMLImageElement; });
    try {
      const d: HudDesign = { ...DEFAULT_DESIGN, crosshair: 'bundle', xhairArt: { kind: 'image', png, w: 64, h: 32 } };
      const { ctx, calls } = argsCtx();
      drawHud(ctx, 853, 480, d, 'survivor', null);
      expect(loaded).toContain(png);
      const r = at(d);
      const draw = calls.find((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === png)!;
      expect(draw.a.slice(1)).toEqual([r.x, r.y + 6.5, 26, 13]);
    } finally {
      _setImageFactory(null);
      _resetAssetCache();
    }
  });

  it('draws a neutral placeholder for a legacy addon crosshair, whatever the design carries', () => {
    const d: HudDesign = { ...DEFAULT_DESIGN, crosshair: 'addon', xhairArt: { kind: 'built', state: DOT } };
    const { ctx, calls } = argsCtx();
    drawHud(ctx, 853, 480, d, 'survivor', null);
    expect(outlined(calls, d)).toBe(true);
    expect(centred(calls, d)).toBe(false);
  });

  it('draws nothing for the game default, whatever the design carries', () => {
    const d: HudDesign = { ...DEFAULT_DESIGN, crosshair: 'none', xhairArt: { kind: 'built', state: DOT } };
    const { ctx, calls } = argsCtx();
    drawHud(ctx, 853, 480, d, 'survivor', null);
    expect(outlined(calls, d)).toBe(false);
    expect(centred(calls, d)).toBe(false);
  });
});

describe('drawHud delegates panels to the renderer', () => {
  const instant = (url: string) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement;

  it('draws the survivor side with real images, not grey boxes', () => {
    _setImageFactory(instant);
    const calls: string[] = [];
    const ctx = fakeCtx(() => {}, calls);
    drawHud(ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null);
    expect(calls.filter((m) => m === 'drawImage').length).toBeGreaterThanOrEqual(4);   // 3 cards' portraits + own portrait at least
  });

  it('draws three teammate cards from one file, each with its own name', () => {
    _setImageFactory(instant);
    const texts: string[] = [];
    const ctx = fakeCtx(() => {}, undefined, texts);
    drawHud(ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null);
    for (const n of ['Francis', 'Louis', 'Zoey']) expect(texts).toContain(n);
  });

  it('passes onAsset through so a late texture can trigger a redraw', () => {
    let onload: (() => void) | null = null;
    _setImageFactory((url) => {
      const img = { src: url, complete: false, naturalWidth: 0, naturalHeight: 0, onerror: null } as unknown as HTMLImageElement & { onload: (() => void) | null };
      Object.defineProperty(img, 'onload', { set(f) { onload = f; }, get() { return onload; } });
      return img;
    });
    let redraws = 0;
    drawHud(fakeCtx(() => {}), 853, 480, DEFAULT_DESIGN, 'survivor', null, () => { redraws++; });
    expect(onload).not.toBeNull();
    onload!();
    expect(redraws).toBe(1);
  });

  it('draws a restyled survivor panel background behind each teammate card', () => {
    // The background is a child of the card file now (HudEdCardBg), so
    // drawPanel draws it from the tree, once per card, and nothing else does.
    _setImageFactory(instant);
    const design = { ...DEFAULT_DESIGN, styles: { ...DEFAULT_DESIGN.styles, panelBg: { kind: 'flat' as const, color: '255 0 0 255' } } };
    const fills: { a: unknown[]; fill: string }[] = [];
    const ctx = { ...fakeCtx(() => {}) } as unknown as CanvasRenderingContext2D;
    // Wrap fillRect to record both the args and the fillStyle at call time.
    const realFillRect = ctx.fillRect.bind(ctx);
    ctx.fillRect = ((...a: [number, number, number, number]) => { fills.push({ a, fill: ctx.fillStyle as string }); return realFillRect(...a); }) as typeof ctx.fillRect;
    drawHud(ctx, 853, 480, design, 'survivor', null);
    const redFills = fills.filter((f) => f.fill === 'rgba(255,0,0,1)');
    expect(redFills.length).toBe(3);   // one per teammate card
  });

  it('draws the weapon selection from the game art, clipped to its element, with no stand-in boxes', () => {
    // The game paints the slots inside the HudWeaponSelection panel and VGUI
    // clips that paint to the panel, so the preview clips to elementRect.
    _setImageFactory(instant);
    const srcs: string[] = [];
    const rects: number[][] = [];
    const fills: string[] = [];
    const ctx = fakeCtx(() => {});
    ctx.drawImage = ((img: HTMLImageElement) => { srcs.push(img.src); }) as unknown as typeof ctx.drawImage;
    ctx.rect = ((...a: number[]) => { rects.push(a); }) as typeof ctx.rect;
    const realFill = ctx.fillRect.bind(ctx);
    ctx.fillRect = ((...a: [number, number, number, number]) => { fills.push(ctx.fillStyle as string); return realFill(...a); }) as typeof ctx.fillRect;
    drawHud(ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null);
    expect(srcs).toContain(artUrl('vgui/hud/scalablepanel_bgmidgrey_glow'));
    for (const n of ['pumpshotgun', 'dualpistols', 'molotov', 'medkit', 'pills']) expect(srcs).toContain(artUrl(`icon/equip/${n}`));
    const w = elementRect(DEFAULT_DESIGN, 'weaponSelection', DEFAULT_DESIGN.aspect);
    expect(rects).toContainEqual([w.x, w.y, w.w, w.h]);
    expect(fills).not.toContain('rgba(210,190,60,0.85)');
  });

  describe('the kill notices', () => {
    const NOTICE = 'Hunter incapacitated Francis';
    const box = () => artUrl('vgui/hud/scalablepanel_bgblack_outlinegrey')!;
    /** drawHud at 1920 x 1080 (2.25 px to a unit), every call recorded with the fill and alignment current at the time. */
    function killCalls(design: HudDesign) {
      _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 128, naturalHeight: 128, onload: null, onerror: null }) as unknown as HTMLImageElement);
      const calls: { m: string; a: unknown[]; fill: string; align: string; font: string }[] = [];
      const base = fakeCtx(() => {}) as unknown as Record<string | symbol, unknown>;
      // measureText: 10 px a character, so the box's width is known.
      base.measureText = (t: string) => ({ width: t.length * 10 });
      const ctx = new Proxy(base, {
        get: (t, k) => (typeof t[k] === 'function'
          ? (...a: unknown[]) => { calls.push({ m: String(k), a, fill: String(t.fillStyle), align: String(t.textAlign), font: String(t.font) }); return (t[k] as (...x: unknown[]) => unknown)(...a); }
          : t[k]),
        set: (t, k, v) => { t[k] = v; return true; },
      }) as unknown as CanvasRenderingContext2D;
      drawHud(ctx, 1920, 1080, design, 'survivor', null);
      _setImageFactory(null);
      return calls;
    }

    it('draws one notice at the left, in the row\'s colour and font, in the notice box, as the game does (probe B2 f)', () => {
      // /home/volence/l4d/hud/probe-phase2/b2/shots-kill/b2-killnotice/b2-f.png: the text's first ink at x 46 px
      // (origin 45 = element x 10 + row xpos 10, times 2.25), the box x 30 to 333 px, y 382 to 416 px (row 0's
      // 15 units at the element's top, y 170). label_textalign west in hudlayout.res beats the rows' own east.
      const calls = killCalls(DEFAULT_DESIGN);
      const text = calls.filter((c) => c.m === 'fillText' && c.a[0] === NOTICE);
      expect(text).toHaveLength(1);
      expect(text[0].align).toBe('left');
      expect(text[0].a[1] as number).toBeCloseTo(20 * 2.25, 6);
      expect(text[0].fill).toBe('rgba(246,5,5,1)');
      // Default: Trade Gothic 12 tall, at 2.25 px a unit.
      expect(text[0].font).toBe(canvasFont('Trade Gothic', 400, 12 * 2.25));
      // Nine-sliced (nine drawImage calls), before the text, 11 units either side of it, the file's
      // label4background tall (25) centred on the 15-unit row: the rim (10.1 px in) lands on x 30 and y 382.
      const slices = calls.filter((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === box());
      expect(slices).toHaveLength(9);
      expect(calls.indexOf(slices[8])).toBeLessThan(calls.indexOf(text[0]));
      const left = Math.min(...slices.map((c) => c.a[5] as number));
      const right = Math.max(...slices.map((c) => (c.a[5] as number) + (c.a[7] as number)));
      const top = Math.min(...slices.map((c) => c.a[6] as number));
      const bottom = Math.max(...slices.map((c) => (c.a[6] as number) + (c.a[8] as number)));
      expect(left).toBeCloseTo(45 - 11 * 2.25, 6);
      expect(right).toBeCloseTo(45 + NOTICE.length * 10 + 11 * 2.25, 6);
      expect(top).toBeCloseTo((170 - 5) * 2.25, 6);
      expect(bottom).toBeCloseTo((170 + 20) * 2.25, 6);
      // The corners: the file's draw_corner_width 8 units, cut from its src_corner_width 16 texels.
      expect(slices[0].a.slice(1, 5)).toEqual([0, 0, 16, 16]);
      expect(slices[0].a[7] as number).toBeCloseTo(8 * 2.25, 6);
      expect(calls.some((c) => c.m === 'fillText' && c.a[0] === 'Bill killed a Hunter')).toBe(false);
    });

    it('follows label_textalign east and center when a HUD sets them, the box around the text', () => {
      const ID = '7'.repeat(64);
      const layout = baseFile('stock', 'scripts/hudlayout.res');
      for (const [align, want] of [['east', 'right'], ['center', 'center']] as const) {
        const id = align === 'east' ? ID : '8'.repeat(64);
        registerImport(id, sampleHud({ 'scripts/hudlayout.res': layout.replace(/("label_textalign"\s*)"west"/, `$1"${align}"`) }));
        try {
          const d = validateDesign({ v: 1, preset: 'imported', imported: { id, name: 'k' }, crosshair: 'none' });
          const calls = killCalls(d);
          const text = calls.find((c) => c.m === 'fillText' && c.a[0] === NOTICE)!;
          expect(text.align).toBe(want);
          const r = elementRect(d, 'killNotices', d.aspect);
          const row = kvFind(buildTrees(d)('resource/ui/hud/pzdamagerecordpanel.res'), ['recordlabel0'])!;
          const wide = r.w - 40;                                          // wide f40
          const xpos = parseFloat(kvGet(row, 'xpos')!);
          const at = align === 'east' ? (r.x + xpos + wide) * 2.25 : (r.x + xpos + wide / 2) * 2.25;
          expect(text.a[1] as number).toBeCloseTo(at, 6);
          const slices = calls.filter((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === box());
          const right = Math.max(...slices.map((c) => (c.a[5] as number) + (c.a[7] as number)));
          const textRight = align === 'east' ? at : at + NOTICE.length * 5;
          expect(right).toBeCloseTo(textRight + 11 * 2.25, 6);
        } finally { unregisterImport(id); }
      }
    });

    it('is clipped to the element, as VGUI clips the rows to their container', () => {
      const rects: number[][] = [];
      const ctx = fakeCtx(() => {});
      ctx.rect = ((...a: number[]) => { rects.push(a); }) as typeof ctx.rect;
      drawHud(ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null);
      const r = elementRect(DEFAULT_DESIGN, 'killNotices', DEFAULT_DESIGN.aspect);
      expect(rects).toContainEqual([r.x, r.y, r.w, r.h]);           // 853 x 480: one pixel to a unit
    });
  });

  describe('the chat', () => {
    /** drawHud on the survivor side at 1920 x 1080, recording every call with its fill and font. */
    function chatCalls(design: HudDesign) {
      const calls: { m: string; a: unknown[]; fill: string; font: string }[] = [];
      const base = fakeCtx(() => {}) as unknown as Record<string | symbol, unknown>;
      base.measureText = (t: string) => ({ width: t.length * 10 });
      const ctx = new Proxy(base, {
        get: (t, k) => (typeof t[k] === 'function'
          ? (...a: unknown[]) => { calls.push({ m: String(k), a, fill: String(t.fillStyle), font: String(t.font) }); return (t[k] as (...x: unknown[]) => unknown)(...a); }
          : t[k]),
        set: (t, k, v) => { t[k] = v; return true; },
      }) as unknown as CanvasRenderingContext2D;
      drawHud(ctx, 1920, 1080, design, 'survivor', null);
      return calls;
    }
    const CHAT_TEXT = ['Zoey : ', 'watch the closet', 'Francis : ', 'got it'];
    /** The chat's own calls: from its clip (the element's rect) to the texts it draws. */
    const chatTexts = <T extends { m: string; a: unknown[] }>(calls: T[]) => calls.filter((c) => c.m === 'fillText' && CHAT_TEXT.includes(c.a[0] as string));

    it('draws the closed chat: the history lines only, no box (probe B2 e)', () => {
      // /home/volence/l4d/hud/probe-phase2/b2/shots/b2/b2-e.png: "Mal : probe" with its ink from x 53, y 663 px, the
      // name in 139 183 221 and the text in 210 200 152, a black drop shadow, nothing behind it. paintChat used to
      // fill the whole element: that is the open chat, which no probe has shot.
      const calls = chatCalls(DEFAULT_DESIGN);
      const r = elementRect(DEFAULT_DESIGN, 'chat', DEFAULT_DESIGN.aspect);
      const px = { x: r.x * 2.25, y: r.y * 2.25, w: r.w * 2.25, h: r.h * 2.25 };
      const inChat = (c: { a: unknown[] }) => (c.a[0] as number) >= px.x && (c.a[0] as number) < px.x + px.w && (c.a[1] as number) >= px.y && (c.a[1] as number) < px.y + px.h;
      expect(calls.filter((c) => c.m === 'fillRect' && inChat(c))).toEqual([]);
      const texts = chatTexts(calls);
      // Each piece twice: its shadow, then itself.
      expect(texts.map((c) => c.a[0])).toEqual(['Zoey : ', 'Zoey : ', 'watch the closet', 'watch the closet', 'Francis : ', 'Francis : ', 'got it', 'got it']);
      expect(texts.map((c) => c.fill)).toEqual(['rgba(0,0,0,1)', 'rgba(139,183,221,1)', 'rgba(0,0,0,1)', 'rgba(210,200,152,1)', 'rgba(0,0,0,1)', 'rgba(139,183,221,1)', 'rgba(0,0,0,1)', 'rgba(210,200,152,1)']);
      const name = texts[1];
      // The history's left (element x 10 + history xpos 10 = 20 units, 45 px) plus the RichText's 3-unit inset.
      expect(name.a[1] as number).toBeCloseTo(23 * 2.25, 6);
      // The shadow one pixel right and down.
      expect(texts[0].a[1] as number).toBeCloseTo((name.a[1] as number) + 1, 6);
      expect(texts[0].a[2] as number).toBeCloseTo((name.a[2] as number) + 1, 6);
      // The message follows the name, measured.
      expect(texts[3].a[1] as number).toBeCloseTo((name.a[1] as number) + 'Zoey : '.length * 10, 6);
      // ChatFont's 1024 to 1199 line entry: Tahoma 20 pixels at 1080, not scaled by the HUD's units.
      expect(name.font).toBe(canvasFont('Tahoma', 700, 20));
      // The second line one cell lower.
      expect((texts[5].a[2] as number) - (name.a[2] as number)).toBeCloseTo(20, 6);
    });

    it('puts the lines at the top of the moved and resized history', () => {
      const d = { ...structuredClone(DEFAULT_DESIGN), elements: { chat: { x: 500, y: 20, w: 300, h: 150 } } };
      const calls = chatCalls(d);
      const r = elementRect(d, 'chat', d.aspect);
      const hist = kvFind(buildTrees(d)('resource/ui/basechat.res'), ['HudChatHistory'])!;
      const hx = parseFloat(kvGet(hist, 'xpos')!), hy = parseFloat(kvGet(hist, 'ypos')!);
      const name = chatTexts(calls)[1];
      expect(name.a[1] as number).toBeCloseTo((r.x + hx + 3) * 2.25, 6);
      const cellTop = (name.a[2] as number) - fontCell('Tahoma', 20).ascent;
      expect(cellTop).toBeCloseTo((r.y + hy) * 2.25 + CHAT_INSET_Y_PX, 6);
    });
  });

  describe('the use/heal bar', () => {
    /** drawHud at 1920 x 1080 (2.25 px a unit) with every call and its fill recorded, art loaded at once. */
    function barCalls(design: HudDesign) {
      _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement);
      const calls: { m: string; a: unknown[]; fill: string }[] = [];
      const base = fakeCtx(() => {}) as unknown as Record<string | symbol, unknown>;
      const ctx = new Proxy(base, {
        get: (t, k) => (typeof t[k] === 'function'
          ? (...a: unknown[]) => { calls.push({ m: String(k), a, fill: String(t.fillStyle) }); return (t[k] as (...x: unknown[]) => unknown)(...a); }
          : t[k]),
        set: (t, k, v) => { t[k] = v; return true; },
      }) as unknown as CanvasRenderingContext2D;
      drawHud(ctx, 1920, 1080, design, 'survivor', null);
      _setImageFactory(null);
      return calls;
    }
    const K = 2.25;

    it('draws progressbar.res: the healing icon, the label and the bar at its fill, as the game does (probe B13 heal)', () => {
      // /home/volence/l4d/hud/probe-phase2/b13/b13-stock/heal/mid-heal.png: icon x 708 to 760, y 562 to 614;
      // "HEALING YOURSELF"; bar ring x 767 to 1214, y 595 to 610, 2 px border, 2 px gap, fill to x 946 of an
      // inner 771 to 1210 (0.4), a 2 px black shadow right and below. No slab.
      const d = DEFAULT_DESIGN;
      const r = elementRect(d, 'progressBar', d.aspect);
      const calls = barCalls(d);
      const icon = calls.find((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === artUrl('icon/healing'))!;
      expect(icon.a.slice(1)).toEqual([(r.x + 2) * K, r.y * K, 24 * K, 24 * K]);
      expect(calls.some((c) => c.m === 'fillText' && c.a[0] === 'HEALING YOURSELF')).toBe(true);
      // On whole pixels, as the game places it: the element's pixel, then the child's offset, each cut.
      const bx = Math.floor(r.x * K) + Math.floor(28 * K), by = Math.floor(r.y * K) + Math.floor(15 * K);
      const fills = calls.filter((c) => c.m === 'fillRect');
      // The ring: four white strips, 2 px (1 unit, cut to whole pixels) thick, round the rect less the shadow.
      const white = fills.filter((c) => c.fill === 'rgba(255,255,255,1)').map((c) => c.a as number[]);
      expect(white).toContainEqual([bx, by, 200 * K - 2, 2]);
      // The fill: 4 px in (border 2 + gap 2), 0.4 of the inner width.
      const inner = 200 * K - 2 - 8;
      expect(white).toContainEqual([bx + 4, by + 4, inner * 0.4, 8 * K - 2 - 8]);
      // The shadow, black, right and below.
      const black = fills.filter((c) => c.fill === 'rgba(0,0,0,1)').map((c) => c.a as number[]);
      expect(black).toContainEqual([bx + 200 * K - 2, by + 2, 2, 8 * K - 2]);
      expect(black).toContainEqual([bx + 2, by + 8 * K - 2, 200 * K - 2, 2]);
      // Nothing wider than the Bar: the old slab filled the element.
      for (const c of fills) expect(c.a[2] as number).toBeLessThanOrEqual(200 * K);
    });

    it('draws the file\'s content, not the element\'s width, for a HUD whose element is wider (the owner\'s)', () => {
      // The owner's hudlayout.res: HudProgressBar xpos 0, ypos r24, wide 300, tall 45, and no progressbar.res, so
      // the stock one (228 units of content) draws inside a 300-wide element (b13-owner/heal/mid-heal.png: bar
      // x 63 to 510 px).
      const id = '9'.repeat(64);
      const layout = baseFile('stock', 'scripts/hudlayout.res')
        .replace(/("fieldName" "HudProgressBar"\s*"xpos"\s*)"c-114"(\s*"ypos"\s*)"c10"/, '$1"0"$2"r24"');
      expect(layout).toContain('"r24"');
      registerImport(id, sampleHud({ 'scripts/hudlayout.res': layout }));
      try {
        const d = validateDesign({ v: 1, preset: 'imported', imported: { id, name: 'o' }, crosshair: 'none' });
        const r = elementRect(d, 'progressBar', d.aspect);
        expect([r.x, r.w]).toEqual([0, 300]);
        const fills = barCalls(d).filter((c) => c.m === 'fillRect').map((c) => c.a as number[]);
        const right = Math.max(...fills.map((a) => a[0] + a[2]));
        expect(right).toBeCloseTo(Math.floor(28 * K) + 200 * K, 6);   // 228 units, the offset cut to whole pixels
      } finally { unregisterImport(id); }
    });

    it('draws only the border when an imported file\'s border and gap eat the bar, as the game does (probe Q22)', () => {
      const id = 'a1'.repeat(32);
      const bar = baseFile('stock', 'resource/ui/hud/progressbar.res')
        .replace(/"gap"\s*"1"/, '"gap" "3"').replace(/"border_thickness"\s*"1"/, '"border_thickness" "3"');
      registerImport(id, sampleHud({ 'resource/ui/hud/progressbar.res': bar }));
      try {
        const d = validateDesign({ v: 1, preset: 'imported', imported: { id, name: 'q' }, crosshair: 'none' });
        const r = elementRect(d, 'progressBar', d.aspect);
        const bx = Math.floor(r.x * K) + Math.floor(28 * K), by = Math.floor(r.y * K) + Math.floor(15 * K);
        const white = barCalls(d).filter((c) => c.m === 'fillRect' && c.fill === 'rgba(255,255,255,1)').map((c) => c.a as number[]);
        expect(white).toContainEqual([bx, by, 200 * K - 2, 6]);     // the ring, 3 units cut to 6 px
        expect(white.filter((a) => a[1] > by + 6 && a[1] < by + 8 * K - 8)).toEqual([]);   // nothing inside it
      } finally { unregisterImport(id); }
    });
  });

  describe('the ability timer', () => {
    const K = 2.25;
    /** drawHud on the infected side at 1920 x 1080, every call recorded with its alpha, art loaded at once. */
    function ringCalls(design: HudDesign, state: PreviewState = DEFAULT_PREVIEW) {
      _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 128, naturalHeight: 128, onload: null, onerror: null }) as unknown as HTMLImageElement);
      const calls: { m: string; a: unknown[] }[] = [];
      const base = fakeCtx(() => {}) as unknown as Record<string | symbol, unknown>;
      const ctx = new Proxy(base, {
        get: (t, k) => (typeof t[k] === 'function'
          ? (...a: unknown[]) => { calls.push({ m: String(k), a }); return (t[k] as (...x: unknown[]) => unknown)(...a); }
          : t[k]),
        set: (t, k, v) => { t[k] = v; return true; },
      }) as unknown as CanvasRenderingContext2D;
      drawHud(ctx, 1920, 1080, design, 'infected', null, undefined, { state });
      _setImageFactory(null);
      return calls;
    }
    const src = (c: { a: unknown[] }) => (c.a[0] as { src?: string }).src;
    /** The draws of one material's art, whether drawn straight or through a tinted copy (render.ts's tinted keeps no src). */
    const drawsOf = (calls: { m: string; a: unknown[] }[], material: string) => calls.filter((c) => c.m === 'drawImage' && src(c) === artUrl(material));

    it('draws AbilityTimerHud.res: the splat, the class icon, and no meter while ready (probe B3 b)', () => {
      // /home/volence/l4d/hud/probe-phase2/b3/shots-rerun/b3-rerun/b3-b.png: the black pz_charge_bg splat behind,
      // the Hunter's pz_charge_lunge (its red rings are in the texture) centred at (1847, 899), no orange meter.
      const r = elementRect(DEFAULT_DESIGN, 'abilityRing', DEFAULT_DESIGN.aspect);
      const calls = ringCalls(DEFAULT_DESIGN);
      const [bg] = drawsOf(calls, 'vgui/hud/pz_charge_bg');
      expect(bg.a.slice(1)).toEqual([r.x * K, r.y * K, 80 * K, 80 * K]);
      const cx = (bg.a[1] as number) + (bg.a[3] as number) / 2, cy = (bg.a[2] as number) + (bg.a[4] as number) / 2;
      expect(Math.abs(cx - 1847)).toBeLessThanOrEqual(1);
      expect(Math.abs(cy - 899)).toBeLessThanOrEqual(1);
      // The icon, 10 in, 60 square; ability_ready_color is white, so it is drawn untinted.
      const [icon] = drawsOf(calls, 'vgui/hud/pz_charge_lunge');
      expect(icon.a.slice(1)).toEqual([(r.x + 10) * K, (r.y + 10) * K, 60 * K, 60 * K]);
      expect(calls.indexOf(bg)).toBeLessThan(calls.indexOf(icon));
      expect(drawsOf(calls, 'vgui/hud/pz_charge_meter')).toEqual([]);
      const inRing = (c: { m: string; a: unknown[] }) => c.m === 'arc' && (c.a[0] as number) > r.x * K && (c.a[0] as number) < (r.x + 80) * K
        && (c.a[1] as number) > r.y * K && (c.a[1] as number) < (r.y + 80) * K;
      expect(calls.some(inRing)).toBe(false);                          // the old stand-in's white arcs are gone
      // Clipped to the 80 x 70 element, as VGUI clips its children: the splat's bottom 10 units are cut.
      expect(calls.filter((c) => c.m === 'rect').map((c) => c.a)).toContainEqual([r.x * K, r.y * K, 80 * K, 70 * K]);
    });

    it('draws the chosen class\'s icon', () => {
      for (const [siClass, material] of [['smoker', 'pz_charge_smoker'], ['boomer', 'pz_charge_boomer'], ['tank', 'pz_charge_tank']] as const) {
        const calls = ringCalls(DEFAULT_DESIGN, { ...DEFAULT_PREVIEW, siClass });
        expect(drawsOf(calls, `vgui/hud/${material}`), siClass).toHaveLength(1);
        expect(drawsOf(calls, 'vgui/hud/pz_charge_lunge'), siClass).toEqual([]);
      }
    });

    it('draws the meter over the icon while charging, cut to its sweep', () => {
      const r = elementRect(DEFAULT_DESIGN, 'abilityRing', DEFAULT_DESIGN.aspect);
      const calls = ringCalls(DEFAULT_DESIGN, { ...DEFAULT_PREVIEW, ability: 'charging' });
      const [meter] = drawsOf(calls, 'vgui/hud/pz_charge_meter');
      expect(meter.a.slice(1)).toEqual([(r.x + 10) * K, (r.y + 10) * K, 60 * K, 60 * K]);
      const arc = calls.find((c) => c.m === 'arc' && Math.abs((c.a[0] as number) - (r.x + 40) * K) < 1e-9)!;
      expect(arc.a[3]).toBeCloseTo(-Math.PI / 2, 9);
      expect(arc.a[4]).toBeCloseTo(-Math.PI / 2 + 0.6 * 2 * Math.PI, 9);
    });

    it('draws no splat on Modern, whose file hides BackgroundImage', () => {
      const d = { ...structuredClone(DEFAULT_DESIGN), preset: 'modern' as const };
      const calls = ringCalls(d);
      expect(drawsOf(calls, 'vgui/hud/pz_charge_bg')).toEqual([]);
      const r = elementRect(d, 'abilityRing', d.aspect);
      const [icon] = drawsOf(calls, 'vgui/hud/pz_charge_lunge');
      expect(icon.a.slice(1)).toEqual([(r.x + 5) * K, (r.y + 5) * K, 46 * K, 46 * K]);
    });
  });

  it('draws siHealth and infectedRow from their generated files on the infected side', () => {
    _setImageFactory(instant);
    const green = artUrl('vgui/healthbar_white')!;                 // every HealthPanel's fill (slice 2.F X9)
    const draw = (design: HudDesign) => {
      const texts: string[] = [];
      const srcs: string[] = [];
      const ctx = fakeCtx(() => {}, undefined, texts);
      ctx.drawImage = ((img: HTMLImageElement) => { srcs.push(img.src); }) as unknown as typeof ctx.drawImage;
      drawHud(ctx, 853, 480, design, 'infected', null);
      return { texts, bars: srcs.filter((s) => s === green).length };
    };
    const all = draw(DEFAULT_DESIGN);
    expect(all.texts).toContain('100');                      // siHealth's sample HealthNumber
    // infectedRow only: zombieteamdisplayplayer.res's NameLabel, which siHealth's
    // file (hunterhealth.res) does not have, so these can only come from its cards.
    for (const n of ['Francis', 'Louis', 'Zoey']) expect(all.texts).toContain(n);
    // And one health bar per card: the same design with infectedRow hidden draws three fewer.
    const without = draw({ ...DEFAULT_DESIGN, elements: { infectedRow: { visible: false } } });
    expect(all.bars - without.bars).toBe(3);
  });

  it('clips each panel to its real parent, the rect VGUI clips its children to', () => {
    // ownHealth's children live inside LocalPlayer (localplayerdisplay.res), each teammate card's inside
    // TeamPlayerN (teamdisplayhud.res). Both sizes are read here from the generator's own trees.
    _setImageFactory(instant);
    const rects: number[][] = [];
    const ctx = fakeCtx(() => {});
    ctx.rect = ((...a: number[]) => { rects.push(a); }) as typeof ctx.rect;
    drawHud(ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null);
    const k = 480 / SCREEN_H;
    const size = (file: string, key: string) => {
      const n = kvFind(buildTrees(DEFAULT_DESIGN)(file), [key])!;
      return { x: parseFloat(kvGet(n, 'xpos')!), y: parseFloat(kvGet(n, 'ypos')!), w: parseFloat(kvGet(n, 'wide')!), h: parseFloat(kvGet(n, 'tall')!) };
    };
    const local = size('resource/ui/hud/localplayerdisplay.res', 'LocalPlayer');
    // Fitted to its contents by default (slice 2.F G2): stock ships 0,0 130 x 85, the fit moves the
    // frame onto what it shows and the children back by the same amount.
    expect(local).toEqual({ x: 0, y: 32, w: 130, h: 53 });
    const own = elementRect(DEFAULT_DESIGN, 'ownHealth', DEFAULT_DESIGN.aspect);
    expect(rects).toContainEqual([(own.x + local.x) * k, (own.y + local.y) * k, local.w * k, local.h * k]);
    // Each teammate card is clipped where the generated file puts it, at its own size.
    const cards = teamCardRects(DEFAULT_DESIGN, DEFAULT_DESIGN.aspect).slice(0, 3);
    expect(cards[0]).toEqual({ x: 13, y: 441, w: 121, h: 36 });       // DEFAULT_DESIGN fits the stock card
    for (const c of cards) expect(rects).toContainEqual([c.x * k, c.y * k, c.w * k, c.h * k]);
  });
});

const FREE: HudDesign = { ...DEFAULT_DESIGN, elements: { teamColumn: { fit: true, dir: 'free',
  slots: [{ x: 8, y: 100 }, { x: 8, y: 150 }, { x: 700, y: 100 }, { x: 400, y: 440 }] } } };

describe('Free teammate cards', () => {
  it('hits each drawn card as the teammates, and not the screen-sized container around them', () => {
    // The fitted cards are drawn (13, 36) in from their slots: card 1 at (21, 136), card 2 at (21, 186).
    expect(hitTest(FREE, 'survivor', 68, 154)).toBe('teamColumn');
    expect(hitTest(FREE, 'survivor', 426, 100)).toBeNull();
    // Card 4 shows only while spectating a full team: not drawn, not a target.
    expect(hitTest(FREE, 'survivor', 460, 478)).toBeNull();
  });

  it('outlines each card instead of the whole screen when the Free teammates are selected', () => {
    const strokes: number[][] = [];
    const ctx = fakeCtx(() => {});
    ctx.strokeRect = ((...a: number[]) => { strokes.push(a); }) as typeof ctx.strokeRect;
    drawHud(ctx, 853, 480, FREE, 'survivor', 'teamColumn', undefined, { frames: selectionFrames(FREE, TEAMMATES) });
    for (const c of teamCardRects(FREE, FREE.aspect).slice(0, 3)) expect(strokes).toContainEqual([c.x, c.y, c.w, c.h]);
    expect(strokes).not.toContainEqual([0, 0, 853, 480]);
  });
});

describe('drawHud passes the preview state to the teammate cards', () => {
  it('draws every card down when asked', () => {
    _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement);
    const srcs: string[] = [];
    const ctx = fakeCtx(() => {});
    ctx.drawImage = ((img: HTMLImageElement) => { srcs.push(img.src); }) as unknown as typeof ctx.drawImage;
    drawHud(ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null, undefined, { state: 'down' });
    for (const c of ['biker', 'manager', 'teenangst']) expect(srcs).toContain(artUrl(`vgui/s_panel_${c}_incap`));
  });
});

describe('teammate card children on the canvas', () => {
  // DEFAULT_DESIGN: stock, fitted, card 2 at (153, 441); the fitted Head is (0, 2, 23, 23) inside it.
  const card2 = () => teamCardRects(DEFAULT_DESIGN, DEFAULT_DESIGN.aspect)[1];

  it('finds the child under the pointer in whichever card it is', () => {
    const c = card2();
    expect(childAt(DEFAULT_DESIGN, 'healthy', c.x + 11, c.y + 13)).toEqual({ name: 'Head', card: 1 });
  });

  it('finds what the state draws: the down picture where the portrait was', () => {
    const c = card2();
    expect(childAt(DEFAULT_DESIGN, 'down', c.x + 11, c.y + 13)).toEqual({ name: 'Incapacitated', card: 1 });
  });

  it('picks the splatter, the lowest-priority piece, where no other piece is', () => {
    const c = card2();
    // (120, 1) in the card is only the splatter and the Voice icon, which no state draws in
    // healthy: the splatter is the lowest-priority target there, so it wins over nothing.
    expect(childAt(DEFAULT_DESIGN, 'healthy', c.x + 120, c.y + 1)).toEqual({ name: 'BackgroundImage', card: 1 });
    // A real piece drawn on top of the splatter still wins.
    expect(childAt(DEFAULT_DESIGN, 'healthy', c.x + 11, c.y + 13)).toEqual({ name: 'Head', card: 1 });
  });

  it('skips the blank Status text and picks the splatter under it', () => {
    const c = teamCardRects(DEFAULT_DESIGN, DEFAULT_DESIGN.aspect)[2];
    // (105, 6) in the card is Status text's own box (top right), but its labelText is blank in
    // every preview state: it is skipped as a hit target, and the splatter under it wins instead
    // of the point meaning nothing there, which used to pick an invisible label.
    expect(childAt(DEFAULT_DESIGN, 'healthy', c.x + 105, c.y + 6)).toEqual({ name: 'BackgroundImage', card: 2 });
    // A label that does draw something is still hit on its whole box, not just its drawn text: a
    // short name leaves most of Name's 120-wide box blank, and a click there still picks Name.
    expect(childAt(DEFAULT_DESIGN, 'healthy', c.x + 112, c.y + 30)).toEqual({ name: 'Name', card: 2 });
  });

  it('never picks a hidden child, decoration that is hidden too, or anything outside the cards', () => {
    const c = card2();
    // Hiding the portrait alone still leaves the splatter under it, the new lowest-priority target.
    const hiddenHead = { ...DEFAULT_DESIGN, children: { teamColumn: { Head: { visible: false } } } };
    expect(childAt(hiddenHead, 'healthy', c.x + 11, c.y + 13)).toEqual({ name: 'BackgroundImage', card: 1 });
    // Hiding both leaves nothing there.
    const hiddenBoth = { ...DEFAULT_DESIGN, children: { teamColumn: { Head: { visible: false }, BackgroundImage: { visible: false } } } };
    expect(childAt(hiddenBoth, 'healthy', c.x + 11, c.y + 13)).toBeNull();
    // With the splatter itself hidden, its own spot has nothing left to pick.
    const noSplatter = { ...DEFAULT_DESIGN, children: { teamColumn: { BackgroundImage: { visible: false } } } };
    expect(childAt(noSplatter, 'healthy', c.x + 120, c.y + 1)).toBeNull();
    expect(childAt(DEFAULT_DESIGN, 'healthy', 426, 100)).toBeNull();
  });

  it('outlines a selected piece in every drawn card', () => {
    _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement);
    const strokes: number[][] = [];
    const ctx = fakeCtx(() => {});
    ctx.strokeRect = ((...a: number[]) => { strokes.push(a); }) as typeof ctx.strokeRect;
    const frames = selectionFrames(DEFAULT_DESIGN, { kind: 'children', names: ['Head'], card: 0 });
    drawHud(ctx, 853, 480, DEFAULT_DESIGN, 'survivor', 'teamColumn', undefined, { frames });
    for (const c of teamCardRects(DEFAULT_DESIGN, DEFAULT_DESIGN.aspect).slice(0, 3)) {
      const head = childRects(DEFAULT_DESIGN, 'teamColumn', { x: c.x, y: c.y }, 1).find((r) => r.name === 'Head')!;
      expect(strokes).toContainEqual([head.x, head.y, head.w, head.h]);
    }
  });
});

describe('selection chrome', () => {
  const recording = () => {
    const strokes: number[][] = [];
    const fills: number[][] = [];
    const dashes: number[][] = [];
    const texts: string[] = [];
    const path: (string | number)[][] = [];
    const ctx = fakeCtx(() => {}, undefined, texts);
    ctx.strokeRect = ((...a: number[]) => { strokes.push(a); }) as typeof ctx.strokeRect;
    ctx.fillRect = ((...a: number[]) => { fills.push(a); }) as typeof ctx.fillRect;
    ctx.setLineDash = ((d: number[]) => { dashes.push(d); }) as typeof ctx.setLineDash;
    ctx.moveTo = ((...a: number[]) => { path.push(['M', ...a]); }) as typeof ctx.moveTo;
    ctx.lineTo = ((...a: number[]) => { path.push(['L', ...a]); }) as typeof ctx.lineTo;
    return { ctx, strokes, fills, dashes, texts, path };
  };

  it('draws the selection box and a 7-pixel handle centred on each handle point', () => {
    const r = recording();
    const box = { x: 100, y: 50, w: 40, h: 20 };
    drawHud(r.ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null, undefined, { box, handles: [{ x: 100, y: 50 }, { x: 140, y: 70 }] });
    expect(r.strokes).toContainEqual([100, 50, 40, 20]);
    expect(r.fills).toContainEqual([96.5, 46.5, 7, 7]);
    expect(r.fills).toContainEqual([136.5, 66.5, 7, 7]);
  });

  it('scales HUD units to canvas pixels, and keeps handles 7 pixels', () => {
    const r = recording();
    drawHud(r.ctx, 960, 540, DEFAULT_DESIGN, 'survivor', null, undefined, { box: { x: 100, y: 50, w: 40, h: 20 }, handles: [{ x: 100, y: 50 }] });
    expect(r.strokes).toContainEqual([112.5, 56.25, 45, 22.5]);
    expect(r.fills).toContainEqual([109, 52.75, 7, 7]);
  });

  it('draws the hover outline dashed, with its name', () => {
    const r = recording();
    drawHud(r.ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null, undefined, { hover: { rects: [{ x: 10, y: 20, w: 30, h: 40 }], label: 'Portrait' } });
    expect(r.strokes).toContainEqual([10, 20, 30, 40]);
    expect(r.dashes).toContainEqual([3, 3]);
    expect(r.texts).toContain('Portrait');
  });

  it('draws the Shift+drag box filled and outlined', () => {
    const r = recording();
    drawHud(r.ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null, undefined, { marquee: { x: 5, y: 6, w: 70, h: 80 } });
    expect(r.strokes).toContainEqual([5, 6, 70, 80]);
    expect(r.fills).toContainEqual([5, 6, 70, 80]);
  });

  it('draws each guide as a line across its span', () => {
    const r = recording();
    drawHud(r.ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null, undefined, {
      guides: [{ axis: 'x', at: 100, from: 10, to: 200 }, { axis: 'y', at: 50, from: 0, to: 853 }],
    });
    expect(r.path).toContainEqual(['M', 100, 10]);
    expect(r.path).toContainEqual(['L', 100, 200]);
    expect(r.path).toContainEqual(['M', 0, 50]);
    expect(r.path).toContainEqual(['L', 853, 50]);
  });

  it('still draws a hidden element dimmed when it is one of several selected', () => {
    const hidden = { ...DEFAULT_DESIGN, elements: { ...DEFAULT_DESIGN.elements, chat: { visible: false } } };
    const texts: string[] = [];
    drawHud(fakeCtx(() => {}, undefined, texts), 853, 480, hidden, 'survivor', ['ownHealth', 'chat']);
    expect(texts).toContain('got it');
    const without: string[] = [];
    drawHud(fakeCtx(() => {}, undefined, without), 853, 480, hidden, 'survivor', ['ownHealth']);
    expect(without).not.toContain('got it');
  });
});

describe('panelBoxes', () => {
  it('gives the drawn teammate cards, as plain boxes, in Row, Column and Free', () => {
    for (const d of [DEFAULT_DESIGN, withTeamDir(DEFAULT_DESIGN, 'column'), withTeamDir(DEFAULT_DESIGN, 'free')]) {
      const want = teamCardRects(d, d.aspect).slice(0, TEAM_CARDS).map(({ x, y, w, h }) => ({ x, y, w, h }));
      expect(panelBoxes(d, 'teamColumn')).toEqual(want);
    }
  });
  it('gives nothing for a panel the registry does not have', () => {
    expect(panelBoxes(DEFAULT_DESIGN, 'chat')).toEqual([]);
  });
  it("gives your own health's LocalPlayer inside the element, following the fit", () => {
    const at = { ...structuredClone(DEFAULT_DESIGN), elements: { ownHealth: { x: 20, y: 380 } } };
    const r = elementRect(at, 'ownHealth', at.aspect);
    expect(panelBoxes(at, 'ownHealth')).toEqual([{ x: r.x, y: r.y, w: 130, h: 85 }]);
    const fitted = { ...at, elements: { ownHealth: { x: 20, y: 380, fit: true } } };
    expect(panelBoxes(fitted, 'ownHealth')).toEqual([{ x: r.x, y: r.y + 32, w: 130, h: 53 }]);
  });
});

describe('hitTest on a fitted own health panel', () => {
  it('misses the empty top of the container that fit cut away, and hits the panel', () => {
    const d = { ...structuredClone(DEFAULT_DESIGN), elements: {} };
    const r = elementRect(d, 'ownHealth', d.aspect);
    const fitted = { ...d, elements: { ownHealth: { fit: true } } };
    expect(hitTest(d, 'survivor', r.x + 5, r.y + 10)).toBe('ownHealth');
    expect(hitTest(fitted, 'survivor', r.x + 5, r.y + 10)).toBeNull();
    expect(hitTest(fitted, 'survivor', r.x + 5, r.y + 40)).toBe('ownHealth');
  });
});

describe('drawHud passes the preview state to your own health', () => {
  it('draws the crouch icon when the view is crouched', () => {
    _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement);
    const srcs = (state?: PreviewState) => {
      const got: string[] = [];
      const ctx = fakeCtx(() => {});
      ctx.drawImage = ((img: HTMLImageElement) => { got.push(img.src); }) as unknown as typeof ctx.drawImage;
      drawHud(ctx, 853, 480, DEFAULT_DESIGN, 'survivor', null, undefined, { state });
      return got;
    };
    expect(srcs()).not.toContain(artUrl('vgui/hud/crouch_survivor'));
    expect(srcs({ ...DEFAULT_PREVIEW, crouched: true })).toContain(artUrl('vgui/hud/crouch_survivor'));
  });
});
