import { describe, it, expect, beforeEach } from 'vitest';
import { visibleElements, hitTest, drawHud, childAt, panelBoxes, TEAM_CARDS, infectedCardRects, infectedCardClasses } from './mock';
import { selectionFrames, TEAMMATES } from './selection';
import { withTeamDir } from './edit';
import { DEFAULT_DESIGN, validateDesign, type HudDesign } from './design';
import { baseFile, registerImport, unregisterImport } from './base';
import { sampleHud } from './importFixtures';
import { artUrl, CROSSHAIR_OPEN, SKULL_ICON } from './art';
import { buildTrees, elementRect, teamCardRects, teamLayout, markerBox, markerPx } from './build';
import { elementById } from './elements';
import { kvFind, kvGet } from './kv';
import { SCREEN_H, screenW } from './units';
import { DEFAULT_STATE, PX_AT_1080 } from '../crosshair/draw';
import { PNG_PREFIX } from '../crosshair/model';
import { _setImageFactory, _setCanvasFactory, _resetAssetCache, childRects, DEFAULT_PREVIEW, type PreviewState } from './render';
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

  it('draws a restyled incapacitated or dead panel in advanced mode only, as the download ships it', () => {
    // QA 2026-09-25: the advanced state panels were written by the build but never drawn.
    _setImageFactory(instant);
    const fillsOf = (design: typeof DEFAULT_DESIGN, state: 'down' | 'dead') => {
      const fills: string[] = [];
      const ctx = { ...fakeCtx(() => {}) } as unknown as CanvasRenderingContext2D;
      const real = ctx.fillRect.bind(ctx);
      ctx.fillRect = ((...a: [number, number, number, number]) => { fills.push(ctx.fillStyle as string); return real(...a); }) as typeof ctx.fillRect;
      drawHud(ctx, 853, 480, design, 'survivor', null, undefined, { state });
      return fills;
    };
    const styles = { incapPanel: { kind: 'flat' as const, color: '0 255 0 255' }, deadPanel: { kind: 'flat' as const, color: '0 0 255 255' } };
    const adv = { ...DEFAULT_DESIGN, advanced: true, styles };
    expect(fillsOf(adv, 'down')).toContain('rgba(0,255,0,1)');
    expect(fillsOf(adv, 'dead')).toContain('rgba(0,0,255,1)');
    const normal = { ...DEFAULT_DESIGN, styles };
    expect(fillsOf(normal, 'down')).not.toContain('rgba(0,255,0,1)');
    expect(fillsOf(normal, 'dead')).not.toContain('rgba(0,0,255,1)');
  });

  it('draws the Modern kill notice box in the flat colour the download ships', () => {
    // QA 2026-09-25: the preview had no art for vgui/hud/mod_panel_flat and drew no box.
    _setImageFactory(instant);
    const fills: string[] = [];
    const ctx = { ...fakeCtx(() => {}) } as unknown as CanvasRenderingContext2D;
    const real = ctx.fillRect.bind(ctx);
    // The box is label4background's 25 tall (Modern's pzdamagerecordpanel.res), at 1:1 on a 480 tall canvas.
    ctx.fillRect = ((...a: [number, number, number, number]) => { fills.push(`${ctx.fillStyle} ${Math.round(a[3])}`); return real(...a); }) as typeof ctx.fillRect;
    drawHud(ctx, 853, 480, { ...DEFAULT_DESIGN, preset: 'modern' }, 'survivor', null);
    expect(fills.some((f) => /^rgba\(0, ?0, ?0, ?0\.549\d*\) 25$/.test(f))).toBe(true);
  });

  it('draws an uploaded panel background behind each teammate card', () => {
    // QA 2026-09-25: an Image style changed nothing in the preview.
    _setImageFactory(instant);
    const design = { ...DEFAULT_DESIGN, styles: { panelBg: { kind: 'image' as const } }, images: { panelBg: { w: 32, h: 32, png: 'AAAA' } } };
    const srcs: string[] = [];
    const ctx = fakeCtx(() => {});
    ctx.drawImage = ((img: HTMLImageElement) => { srcs.push(img.src); }) as unknown as typeof ctx.drawImage;
    drawHud(ctx, 853, 480, design, 'survivor', null);
    expect(srcs.filter((u) => u === 'data:image/png;base64,AAAA').length).toBe(3);   // one per teammate card
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

  it('clips the weapon selection to the panel the generator grew, which is the element frame (task W5)', () => {
    _setImageFactory(instant);
    const rects: number[][] = [];
    const ctx = fakeCtx(() => {});
    ctx.rect = ((...a: number[]) => { rects.push(a); }) as typeof ctx.rect;
    const d = validateDesign({ v: 1, weapons: { primaryBoxW: 150, itemSize: 50 } });
    drawHud(ctx, 853, 480, d, 'survivor', null);
    const w = elementRect(d, 'weaponSelection', d.aspect);
    const panel = kvFind(buildTrees(d)('scripts/hudlayout.res'), ['HudWeaponSelection'])!;
    const wide = parseFloat(kvGet(panel, 'wide')!), tall = parseFloat(kvGet(panel, 'tall')!);
    expect(wide).toBeGreaterThan(100);
    expect([w.w, w.h]).toEqual([wide, tall]);
    expect(rects).toContainEqual([w.x, w.y, wide, tall]);
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
          const wide = screenW(d.aspect) - 40;                            // wide f40: the screen's width less 40 (k-verify k-f)
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
      // Selected, as the game shows the bar only while you heal or revive (an occasional panel),
      // and the Occasional panels toggle would draw the others' fills too.
      drawHud(ctx, 1920, 1080, design, 'survivor', 'progressBar');
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
      // The infected cards draw pz_charge_meter too (their AbilityProgress): hidden, so every ring draw is the timer's.
      const noCards = { ...design, elements: { ...design.elements, infectedRow: { ...design.elements.infectedRow, visible: false } } };
      drawHud(ctx, 1920, 1080, noCards, 'infected', null, undefined, { state });
      _setImageFactory(null);
      return calls;
    }
    const src = (c: { a: unknown[] }) => (c.a[0] as { src?: string }).src;
    /** The draws of one material's art, whether drawn straight or through a tinted copy (render.ts's tinted keeps no src). */
    const drawsOf = (calls: { m: string; a: unknown[] }[], material: string) => calls.filter((c) => c.m === 'drawImage' && src(c) === artUrl(material));

    it('draws AbilityTimerHud.res: the splat, the class icon, and the whole meter while ready (probe B3 b, Q15)', () => {
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
      // Ready, the meter is whole: b10/shots/crops/ring-e.png (the 30 x 30 meter lit all round, R 203).
      const [meter] = drawsOf(calls, 'vgui/hud/pz_charge_meter');
      expect(meter.a.slice(1)).toEqual([(r.x + 10) * K, (r.y + 10) * K, 60 * K, 60 * K]);
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

    it('draws no meter while not ready: a standing Hunter\'s ring has no lit arc in game', () => {
      // /home/volence/l4d/hud/probe-phase2-infected/b10/shots/crops/ring-b.png (Hunter standing): the 30 x 30
      // Progress draws nothing; ring-c.png (crouched, ready) has it lit all round.
      const calls = ringCalls(DEFAULT_DESIGN, { ...DEFAULT_PREVIEW, ability: 'notReady' });
      expect(drawsOf(calls, 'vgui/hud/pz_charge_meter')).toEqual([]);
      expect(drawsOf(calls, 'vgui/hud/pz_charge_lunge')).toHaveLength(1);
      const r = elementRect(DEFAULT_DESIGN, 'abilityRing', DEFAULT_DESIGN.aspect);
      expect(calls.some((c) => c.m === 'arc' && Math.abs((c.a[0] as number) - (r.x + 40) * K) < 1e-9)).toBe(false);
    });

    it('draws the meter over the icon while recharging, lit from 12 o\'clock counter-clockwise for 0.4 of the turn', () => {
      // /home/volence/l4d/hud/probe-phase2-infected/b10/shots/crops/progress-f-zoom.png: 1.3 s into a 3 s
      // Smoker cooldown the lit arc runs from 12 o'clock down the left side.
      const r = elementRect(DEFAULT_DESIGN, 'abilityRing', DEFAULT_DESIGN.aspect);
      const calls = ringCalls(DEFAULT_DESIGN, { ...DEFAULT_PREVIEW, ability: 'recharging' });
      const [meter] = drawsOf(calls, 'vgui/hud/pz_charge_meter');
      expect(meter.a.slice(1)).toEqual([(r.x + 10) * K, (r.y + 10) * K, 60 * K, 60 * K]);
      const arc = calls.find((c) => c.m === 'arc' && Math.abs((c.a[0] as number) - (r.x + 40) * K) < 1e-9)!;
      expect(arc.a[3]).toBeCloseTo(-Math.PI / 2, 9);
      expect(arc.a[4]).toBeCloseTo(-Math.PI / 2 - 0.4 * 2 * Math.PI, 9);
      expect(arc.a[5]).toBe(true);                                      // anticlockwise
      expect(calls.indexOf(arc)).toBeLessThan(calls.indexOf(meter));
    });

    it('tints the icon and the backdrop by the state\'s colour, and never the meter (probe Q15, B15)', () => {
      // The meter's material is UnlitTwoTexture, which draws no vertex colour: in
      // /home/volence/l4d/hud/probe-phase2-infected/b15/shots/b15/b15-e.png (a Smoker 1.3 s into its cooldown, the
      // stock charging colour 127 grey) the lit arc samples 202 88 58 at x 1784, as bright as the ready meter in
      // b15-d, where the grey would halve it; client.dll 0x10228168 does set the colour, the shader ignores it.
      // /home/volence/l4d/hud/probe-phase2-infected/b9/shots/crops/br-bcd.png (magenta ready, cyan charging on
      // the icon and the ring art) and b10/shots/crops/ring-all.png (meter R 203 ready, R 101 charging with the
      // stock 127 grey): all three pieces take the state colour.
      const d = validateDesign({ v: 1, elements: { abilityRing: { keys: { ability_ready_color: '255 0 255 255', ability_charging_color: '0 255 255 255' } } } });
      const tints = (state: PreviewState) => {
        const made = new Map<unknown, { src: string; fill: string }>();
        _setCanvasFactory(() => {
          const entry = { src: '', fill: '' };
          const t = {
            globalCompositeOperation: 'source-over', fillStyle: '',
            drawImage: (img: { src?: string }) => { if (!entry.src) entry.src = img.src ?? ''; },
            fillRect: () => { if (t.globalCompositeOperation === 'multiply') entry.fill = String(t.fillStyle); },
          };
          const c = { width: 1, height: 1, getContext: () => t } as unknown as HTMLCanvasElement;
          made.set(c, entry);
          return c;
        });
        try {
          const calls = ringCalls(d, state);
          const ring = new Set(['pz_charge_bg', 'pz_charge_lunge', 'pz_charge_meter'].map((m) => artUrl(`vgui/hud/${m}`)));
          return calls.filter((c) => c.m === 'drawImage' && made.has(c.a[0])).map((c) => made.get(c.a[0])!)
            .filter((e) => ring.has(e.src)).map((e) => `${e.src.split('/').pop()} ${e.fill}`).sort();
        } finally { _setCanvasFactory(null); }
      };
      const names = (fill: string) => ['pz_charge_bg', 'pz_charge_lunge'].map((m) => `${artUrl(`vgui/hud/${m}`)!.split('/').pop()} ${fill}`).sort();
      expect(tints(DEFAULT_PREVIEW)).toEqual(names('rgb(255,0,255)'));
      expect(tints({ ...DEFAULT_PREVIEW, ability: 'recharging' })).toEqual(names('rgb(0,255,255)'));
      // Not ready: the icon and the backdrop in the charging colour, and no meter at all.
      _resetAssetCache();                                              // the tints above are cached by colour
      expect(tints({ ...DEFAULT_PREVIEW, ability: 'notReady' })).toEqual(names('rgb(0,255,255)'));
    });

    it('draws nothing while you are a ghost or dead: the game shows it only on a spawned infected', () => {
      // /home/volence/l4d/hud/probe-phase2-infected/b9/shots/b9/b9-a.png (ghost), b9-e.png (dead).
      for (const infected of ['ghost', 'dead'] as const) {
        const calls = ringCalls(DEFAULT_DESIGN, { ...DEFAULT_PREVIEW, infected });
        for (const m of ['pz_charge_bg', 'pz_charge_lunge', 'pz_charge_meter']) expect(drawsOf(calls, `vgui/hud/${m}`), `${infected} ${m}`).toEqual([]);
      }
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

  describe('the ability marker and the infected crosshair (plan Task 9)', () => {
    const K = 2.25;
    function calls(design: HudDesign, state: PreviewState = DEFAULT_PREVIEW) {
      _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement);
      const out: { m: string; a: unknown[] }[] = [];
      const base = fakeCtx(() => {}) as unknown as Record<string | symbol, unknown>;
      const ctx = new Proxy(base, {
        get: (t, k) => (typeof t[k] === 'function'
          ? (...a: unknown[]) => { out.push({ m: String(k), a }); return (t[k] as (...x: unknown[]) => unknown)(...a); }
          : t[k]),
        set: (t, k, v) => { t[k] = v; return true; },
      }) as unknown as CanvasRenderingContext2D;
      drawHud(ctx, 1920, 1080, design, 'infected', null, undefined, { state });
      _setImageFactory(null);
      return out;
    }
    const src = (c: { a: unknown[] }) => (c.a[0] as { src?: string }).src;
    const draws = (cs: { m: string; a: unknown[] }[], m: string) => cs.filter((c) => c.m === 'drawImage' && src(c) === artUrl(m));
    const marker = (size: number, extra: Record<string, string> = {}) =>
      validateDesign({ v: 1, elements: { abilityMarker: { keys: { ability_size: size, ...extra } } } });
    const centred = (c: { a: unknown[] }) => [(c.a[1] as number) + (c.a[3] as number) / 2, (c.a[2] as number) + (c.a[4] as number) / 2];

    it('draws PZ_charge_crosshair centred on the screen at its size in screen pixels, in the ready colour', () => {
      // /home/volence/l4d/hud/probe-phase2-infected/b9/shots-v2/crops/centre-af.png (c, d): a green ring round
      // the crosshair, centred at (959.5, 539.5), with ability_size 40 and ability_ready_color 0 255 0.
      const d = marker(40, { ability_ready_color: '255 255 255 255' });
      const [m] = draws(calls(d), 'vgui/hud/pz_charge_crosshair');
      const want = markerBox(d, d.aspect);
      expect(m.a.slice(1)).toEqual([want.x * K, want.y * K, want.w * K, want.h * K]);
      // The editor's 16:9 screen is 853 units, 1919.25 px at 1080p: its centre is 0.375 px left of the game's.
      for (const v of centred(m)) expect(Math.abs(v - (v > 700 ? 960 : 540))).toBeLessThanOrEqual(0.5);
      expect(want.w * K).toBeCloseTo(markerPx(40), 6);         // screen pixels, whatever the design's scale
      // The texture's ring is 0.657 of its box; in game the ring is 73.7 px across at size 40 (b9v2-d.png)
      // and 46.3 px at size 20 (/home/volence/l4d/hud/probe-phase2-infected/b15/shots/b15/b15-c.png).
      expect(Math.abs(markerPx(40) * 0.657 - 73.7)).toBeLessThan(1.5);
      expect(Math.abs(markerPx(20) * 0.657 - 46.3)).toBeLessThan(1.5);
    });

    it('draws the game\'s own crosshair, PZ_crosshair_open, in a 34 px box at the centre (b9v2-d: its circle x 944 to 975)', () => {
      const cs = calls(DEFAULT_DESIGN);
      const [x] = draws(cs, CROSSHAIR_OPEN);
      expect(x.a.slice(1)).toEqual([960 - 17, 540 - 17, 34, 34]);
      expect(draws(calls(DEFAULT_DESIGN, { ...DEFAULT_PREVIEW, infected: 'ghost' }), CROSSHAIR_OPEN)).toHaveLength(1);
    });

    it('draws no marker while not ready, a partial one while recharging, and none as a ghost or dead', () => {
      // client.dll 0x102412d6: below full progress the marker takes the charging colour and its arc shows the
      // progress, so a standing Hunter (no progress) draws nothing (centre-af.png b).
      const d = marker(40);
      expect(draws(calls(d, { ...DEFAULT_PREVIEW, ability: 'notReady' }), 'vgui/hud/pz_charge_crosshair')).toEqual([]);
      const cs = calls(d, { ...DEFAULT_PREVIEW, ability: 'recharging' });
      expect(draws(cs, 'vgui/hud/pz_charge_crosshair')).toHaveLength(1);
      const arc = cs.find((c) => c.m === 'arc' && Math.abs((c.a[0] as number) - 960) <= 0.5 && Math.abs((c.a[1] as number) - 540) <= 0.5)!;
      expect(arc.a[4]).toBeCloseTo(-Math.PI / 2 - 0.4 * 2 * Math.PI, 9);
      for (const infected of ['ghost', 'dead'] as const) {
        expect(draws(calls(d, { ...DEFAULT_PREVIEW, infected }), 'vgui/hud/pz_charge_crosshair'), infected).toEqual([]);
      }
      expect(draws(calls(d, { ...DEFAULT_PREVIEW, infected: 'dead' }), CROSSHAIR_OPEN)).toEqual([]);
    });

    it('draws neither with the game\'s crosshair hidden (probe Q16b, b10/shots/crops/centre-bcef.png)', () => {
      const d = { ...marker(40), hideGameCrosshair: true };
      const cs = calls(d);
      expect(draws(cs, 'vgui/hud/pz_charge_crosshair')).toEqual([]);
      expect(draws(cs, CROSSHAIR_OPEN)).toEqual([]);
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
    expect(all.texts).toContain('250');                      // siHealth's sample HealthNumber: the Hunter's full health
    // infectedRow only: zombieteamdisplayplayer.res's NameLabel, which siHealth's
    // file (hunterhealth.res) does not have, so these can only come from its cards.
    for (const n of ['Francis', 'Louis', 'Zoey']) expect(all.texts).toContain(n);
    // And one health bar per card: the same design with infectedRow hidden draws three fewer.
    const without = draw({ ...DEFAULT_DESIGN, elements: { infectedRow: { visible: false } } });
    expect(all.bars - without.bars).toBe(3);
  });

  it('draws your infected health as the class the view picks, clipped to its container', () => {
    // Probe Q11 (/home/volence/l4d/hud/probe-phase2-infected/b10/shots/crops/br-bce.png): HudZombieHealth clips its children.
    _setImageFactory(instant);
    const draw = (state: PreviewState) => {
      const texts: string[] = [];
      const rects: number[][] = [];
      const ctx = fakeCtx(() => {}, undefined, texts);
      ctx.rect = ((...a: number[]) => { rects.push(a); }) as typeof ctx.rect;
      drawHud(ctx, 853, 480, { ...DEFAULT_DESIGN, elements: { infectedRow: { visible: false } } }, 'infected', null, undefined, { state });
      return { texts, rects };
    };
    expect(draw({ ...DEFAULT_PREVIEW, siClass: 'boomer' }).texts).toContain('50');
    expect(draw({ ...DEFAULT_PREVIEW, siClass: 'tank' }).texts).toContain('6000');
    const k = 480 / SCREEN_H;
    const r = elementRect(DEFAULT_DESIGN, 'siHealth', DEFAULT_DESIGN.aspect);
    expect(draw(DEFAULT_PREVIEW).rects).toContainEqual([r.x * k, r.y * k, r.w * k, r.h * k]);
  });

  it('draws your infected health only while spawned: none as a ghost or dead (probe B14)', () => {
    // /home/volence/l4d/hud/probe-phase2-infected/b14/shots/b14/b14-a.png (ghost) and b14-g.png (dead): no
    // panel, where the preview drew it (parity/b14-ghost.png, b14-dead.png).
    _setImageFactory(instant);
    const texts = (state: PreviewState) => {
      const out: string[] = [];
      drawHud(fakeCtx(() => {}, undefined, out), 853, 480, { ...DEFAULT_DESIGN, elements: { infectedRow: { visible: false } } }, 'infected', null, undefined, { state });
      return out;
    };
    expect(texts(DEFAULT_PREVIEW)).toContain('250');
    expect(texts({ ...DEFAULT_PREVIEW, infected: 'ghost' })).not.toContain('250');
    expect(texts({ ...DEFAULT_PREVIEW, infected: 'dead' })).not.toContain('250');
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
    expect(cards[0]).toEqual({ x: 13, y: 441, w: 122, h: 36 });       // DEFAULT_DESIGN fits the stock card
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

describe('the infected cards, as the game lays them out (plan Task 12)', () => {
  const K = 2.25;
  /** Only the cards: every other infected element hidden, so each art draw is a card's. */
  const only = (extra: Record<string, unknown> = {}) => validateDesign({
    v: 1, crosshair: 'none',
    elements: { siHealth: { visible: false }, abilityRing: { visible: false }, abilityMarker: { visible: false }, infectedRow: extra },
  });
  type Call = { m: string; a: unknown[]; alpha: number };
  function cardCalls(design: HudDesign, state: PreviewState = DEFAULT_PREVIEW) {
    _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement);
    const out: Call[] = [];
    const base = fakeCtx(() => {}) as unknown as Record<string | symbol, unknown>;
    // The fake has no state stack; this keeps globalAlpha's, so each draw is recorded at its real alpha.
    const alphas: number[] = [];
    base.save = () => { alphas.push(base.globalAlpha as number); };
    base.restore = () => { base.globalAlpha = alphas.pop() ?? 1; };
    const ctx = new Proxy(base, {
      get: (t, k) => (typeof t[k] === 'function'
        ? (...a: unknown[]) => { out.push({ m: String(k), a, alpha: t.globalAlpha as number }); return (t[k] as (...x: unknown[]) => unknown)(...a); }
        : t[k]),
      set: (t, k, v) => { t[k] = v; return true; },
    }) as unknown as CanvasRenderingContext2D;
    drawHud(ctx, 1920, 1080, design, 'infected', null, undefined, { state });
    _setImageFactory(null);
    return out;
  }
  const src = (c: { a: unknown[] }) => (c.a[0] as { src?: string }).src;
  const draws = (cs: Call[], m: string) => cs.filter((c) => c.m === 'drawImage' && src(c) === artUrl(m));
  const icon = (cls: string) => `vgui/hud/zombieteamimage_${cls}`;
  const at = (c: Call) => (c.a.slice(1) as number[]).map((v) => Math.round(v * 1000) / 1000);
  const box = (x: number, y: number, w: number, h: number) => [x, y, w, h].map((v) => Math.round(v * K * 1000) / 1000);

  it('draws three cards, i x HorizPanelSpacing apart from the container, y 0, never four: Smoker, Boomer, Hunter', () => {
    // client.dll 0x10247a70: card i at (i x HorizPanelSpacing, 0); exactly three card panels (0x10247f01).
    for (const d of [only(), only({ fit: true, gap: 10 }), only({ scale: 1.5 })]) {
      const r = elementRect(d, 'infectedRow', d.aspect);
      const sp = teamLayout(d, elementById('infectedRow')!).spacing;
      const cards = infectedCardRects(d);
      expect(cards.map((c) => [c.x, c.y])).toEqual([0, 1, 2].map((i) => [r.x + i * sp, r.y]));
      expect(panelBoxes(d, 'infectedRow')).toEqual(cards.map(({ x, y, w, h }) => ({ x, y, w, h })));
      const cs = cardCalls(d);
      const img = kvFind(buildTrees(d)('resource/ui/hud/zombieteamdisplayplayer.res'), ['PlayerImage'])!;
      const p = ['xpos', 'ypos', 'wide', 'tall'].map((key) => parseFloat(kvGet(img, key)!));
      for (const [i, cls] of ['smoker', 'boomer', 'hunter'].entries()) {
        expect(draws(cs, icon(cls)).map(at), cls).toEqual([box(cards[i].x + p[0], cards[i].y + p[1], p[2], p[3])]);
      }
      expect(draws(cs, icon('tank'))).toEqual([]);
      // Each card is clipped to its own ZombieTeamDisplayPlayer block (probe Q17, b10/shots/crops/bl-abe.png).
      const rects = cs.filter((c) => c.m === 'rect').map((c) => (c.a as number[]).map((v) => Math.round(v * 1000) / 1000));
      for (const c of cards) expect(rects).toContainEqual(box(c.x, c.y, c.w, c.h));
    }
  });

  it('sizes each card by its generated self block: 256 x 128 on stock, 133 x 64 fitted', () => {
    expect(infectedCardRects(only()).map((c) => [c.w, c.h])).toEqual([[256, 128], [256, 128], [256, 128]]);
    expect(infectedCardRects(only({ fit: true })).map((c) => [c.w, c.h])).toEqual([[133, 64], [133, 64], [133, 64]]);
  });

  it('draws a live card\'s icon untinted and whole, its bar green, and the ability ring on the Smoker and Boomer only', () => {
    // b9/shots/crops/bl-abeg.png b (a white Hunter icon, a green bar) and g (the Smoker's card ring);
    // dll 0x10248700: the ring shows alive, not a ghost, not a Hunter.
    const d = only();
    const cs = cardCalls(d, { ...DEFAULT_PREVIEW, survivor: 'hurt' });      // the survivor state never reaches the cards
    for (const cls of ['smoker', 'boomer', 'hunter']) {
      const [c] = draws(cs, icon(cls));
      expect(c.alpha, cls).toBe(1);
    }
    const cards = infectedCardRects(d);
    const ring = kvFind(buildTrees(d)('resource/ui/hud/zombieteamdisplayplayer.res'), ['AbilityProgress'])!;
    const p = ['xpos', 'ypos', 'wide', 'tall'].map((key) => parseFloat(kvGet(ring, key)!));
    expect(draws(cs, 'vgui/hud/pz_charge_meter').map(at)).toEqual([0, 1].map((i) => box(cards[i].x + p[0], cards[i].y + p[1], p[2], p[3])));
    // Three bars, each filled whole (not the Hurt 40 %): healthbar_white across the inset box, never grey.
    expect(draws(cs, 'vgui/healthbar_white')).toHaveLength(3);
    expect(draws(cs, 'vgui/healthbar_grey')).toEqual([]);
  });

  it('draws a ghost card\'s icon faint and tinted 206 219 225, the bar kept, no ring, no spawn time (probe Q20)', () => {
    // bl-abeg.png a; dll 0x10248575 hard-codes the ghost colour 0xCE 0xDB 0xE1; GhostTeamImage_<class>.vmt
    // pulses its alpha between 0.02 and 0.3, drawn at the middle, 0.16.
    const fills: string[] = [];
    _setCanvasFactory(() => {
      const t = { globalCompositeOperation: 'source-over', fillStyle: '', drawImage: () => {},
        fillRect: () => { if (t.globalCompositeOperation === 'multiply') fills.push(String(t.fillStyle)); } };
      return { width: 1, height: 1, getContext: () => t } as unknown as HTMLCanvasElement;
    });
    try {
      const texts: string[] = [];
      const cs = cardCalls(only(), { ...DEFAULT_PREVIEW, infected: 'ghost' });
      const icons = cs.filter((c) => c.m === 'drawImage' && Math.abs(c.alpha - 0.16) < 1e-9);
      expect(icons).toHaveLength(3);
      expect(fills).toContain('rgb(206,219,225)');
      expect(cs.filter((c) => c.m === 'drawImage' && src(c) === artUrl('vgui/hud/pz_charge_meter'))).toEqual([]);
      drawHud(fakeCtx(() => {}, undefined, texts), 1920, 1080, only(), 'infected', null, undefined, { state: { ...DEFAULT_PREVIEW, infected: 'ghost' } });
      expect(texts).not.toContain('12');
    } finally { _setCanvasFactory(null); }
    _resetAssetCache();                                             // the stub canvases above are cached tints
    expect(draws(cardCalls(only(), { ...DEFAULT_PREVIEW, infected: 'ghost' }), 'vgui/healthbar_white')).toHaveLength(3);
  });

  it('draws a dead card as the skull at SkullIconPlacement and the spawn time, with no bar, no icon and no Dead art at 0 tall', () => {
    // bl-abeg.png e, b9/shots-v2/crops/dead-card-ij.png: the skull, the bar gone; the stock Dead is 0 tall.
    const d = only();
    const state = { ...DEFAULT_PREVIEW, infected: 'dead' as const };
    const cs = cardCalls(d, state);
    const cards = infectedCardRects(d);
    const skull = kvFind(buildTrees(d)('resource/ui/hud/zombieteamdisplayplayer.res'), ['SkullIconPlacement'])!;
    const p = ['xpos', 'ypos', 'wide', 'tall'].map((key) => parseFloat(kvGet(skull, key)!));
    expect(draws(cs, SKULL_ICON).map(at)).toEqual(cards.map((c) => box(c.x + p[0], c.y + p[1], p[2], p[3])));
    for (const cls of ['smoker', 'boomer', 'hunter']) expect(draws(cs, icon(cls)), cls).toEqual([]);
    expect(draws(cs, 'vgui/healthbar_white')).toEqual([]);
    expect(draws(cs, 'vgui/hud/overlay_dead')).toEqual([]);
    expect(draws(cs, 'vgui/s_panel_dead')).toEqual([]);
    const texts: string[] = [];
    drawHud(fakeCtx(() => {}, undefined, texts), 1920, 1080, d, 'infected', null, undefined, { state });
    expect(texts.filter((t) => t === '12')).toHaveLength(3);
    // Given a height, Dead draws its own file's art, hud/overlay_dead (Q19: shown only when given a height).
    const tall = validateDesign({ ...only(), children: { infectedRow: { Dead: { h: 40 } } } });
    expect(draws(cardCalls(tall, state), 'vgui/hud/overlay_dead')).toHaveLength(3);
  });

  it('with Show yourself on, you take the first card as the class you pick and the Hunter sample drops: still three', () => {
    const d = only();
    const cs = cardCalls(d, { ...DEFAULT_PREVIEW, siClass: 'tank', showSelf: true });
    const cards = infectedCardRects(d);
    const [tank] = draws(cs, icon('tank'));
    expect(at(tank)[0]).toBeCloseTo((cards[0].x + 9) * K, 3);
    expect(draws(cs, icon('smoker'))).toHaveLength(1);
    expect(draws(cs, icon('boomer'))).toHaveLength(1);
    expect(draws(cs, icon('hunter'))).toEqual([]);
    expect(infectedCardClasses({ ...DEFAULT_PREVIEW, showSelf: true, siClass: 'hunter' })).toEqual(['hunter', 'smoker', 'boomer']);
    expect(infectedCardClasses(DEFAULT_PREVIEW)).toEqual(['smoker', 'boomer', 'hunter']);
    // Your own card never shows the spawn countdown (Q19: the dead branch shows it only for a spawn time above 0).
    const texts: string[] = [];
    drawHud(fakeCtx(() => {}, undefined, texts), 1920, 1080, d, 'infected', null, undefined, { state: { ...DEFAULT_PREVIEW, infected: 'dead', showSelf: true } });
    expect(texts.filter((t) => t === '12')).toHaveLength(2);
  });

  it('draws a card\'s bar colour on its bar alone, never the name or the icon (probe B14, Q24 passed)', () => {
    // /home/volence/l4d/hud/probe-phase2-infected/b14/crops/card-b.png: HealthPanel monochrome_color 0 255 255
    // fills the card's bar cyan (31 174 173 at its top); "Mal" stays white and the Hunter icon white.
    const fills: string[] = [];
    _setCanvasFactory(() => {
      const t = { globalCompositeOperation: 'source-over', fillStyle: '', drawImage: () => {},
        fillRect: () => { if (t.globalCompositeOperation === 'multiply') fills.push(String(t.fillStyle)); } };
      return { width: 1, height: 1, getContext: () => t } as unknown as HTMLCanvasElement;
    });
    try {
      const d = validateDesign({ ...only(), children: { infectedRow: { HealthPanel: { keys: { monochrome_color: '0 255 255 255' } } } } });
      expect(d.children.infectedRow?.HealthPanel?.keys?.monochrome_color).toBe('0 255 255 255');
      const cs = cardCalls(d);
      expect(fills).toContain('rgb(0,255,255)');
      expect(fills).not.toContain('rgb(10,177,50)');
      for (const cls of ['smoker', 'boomer', 'hunter']) expect(draws(cs, icon(cls)), cls).toHaveLength(1);
      const texts: string[] = [];
      const styles: string[] = [];
      const ctx = fakeCtx(() => {}, undefined, texts);
      const fillText = ctx.fillText.bind(ctx);
      ctx.fillText = ((...a: Parameters<typeof ctx.fillText>) => { styles.push(String(ctx.fillStyle)); fillText(...a); }) as typeof ctx.fillText;
      drawHud(ctx, 1920, 1080, d, 'infected', null);
      expect(styles.some((c) => c.includes('0,255,255'))).toBe(false);
    } finally { _setCanvasFactory(null); }
  });

  it('tints the backdrop by its drawColor: stock 64 64 64 over infected_healthbar_bg_1', () => {
    const fills: string[] = [];
    _setCanvasFactory(() => {
      const t = { globalCompositeOperation: 'source-over', fillStyle: '', drawImage: () => {},
        fillRect: () => { if (t.globalCompositeOperation === 'multiply') fills.push(String(t.fillStyle)); } };
      return { width: 1, height: 1, getContext: () => t } as unknown as HTMLCanvasElement;
    });
    try {
      cardCalls(only());
      expect(fills).toContain('rgb(64,64,64)');
    } finally { _setCanvasFactory(null); }
  });

  it('finds a piece under the pointer by its own card\'s class: the ring on the Smoker card, none on the Hunter\'s', () => {
    const d = only();
    const cards = infectedCardRects(d);
    // AbilityProgress (2,18 36 x 36) and PlayerImage (9,23 24 x 24) overlap; (4, 20) is on the ring only.
    expect(childAt(d, DEFAULT_PREVIEW, cards[0].x + 4, cards[0].y + 20, 'infectedRow')).toEqual({ name: 'AbilityProgress', card: 0 });
    expect(childAt(d, DEFAULT_PREVIEW, cards[2].x + 4, cards[2].y + 20, 'infectedRow')?.name).not.toBe('AbilityProgress');
  });
});
