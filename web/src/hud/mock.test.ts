import { describe, it, expect, beforeEach } from 'vitest';
import { visibleElements, hitTest, drawHud, freeCardAt, childAt, childCornerAt } from './mock';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { artUrl } from './art';
import { buildTrees, elementRect, teamCardRects } from './build';
import { kvFind, kvGet } from './kv';
import { SCREEN_H } from './units';
import { _setImageFactory, _resetAssetCache, childRects } from './render';

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
    const s = visibleElements('survivor').map((e) => e.id);
    const i = visibleElements('infected').map((e) => e.id);
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
    expect(hitTest(DEFAULT_DESIGN, 'survivor', 426, 240)).toBe('xhair');
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

  it('draws siHealth and infectedRow from their generated files on the infected side', () => {
    _setImageFactory(instant);
    const green = artUrl('vgui/healthbar_green')!;
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
      return { w: parseFloat(kvGet(n, 'wide')!), h: parseFloat(kvGet(n, 'tall')!) };
    };
    const local = size('resource/ui/hud/localplayerdisplay.res', 'LocalPlayer');
    expect(local).toEqual({ w: 130, h: 85 });                         // stock, as shipped
    const own = elementRect(DEFAULT_DESIGN, 'ownHealth', DEFAULT_DESIGN.aspect);
    expect(rects).toContainEqual([own.x * k, own.y * k, local.w * k, local.h * k]);
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
    expect(freeCardAt(FREE, 68, 154)).toBe(0);
    expect(freeCardAt(FREE, 68, 204)).toBe(1);
    expect(hitTest(FREE, 'survivor', 426, 100)).toBeNull();
    // Card 4 shows only while spectating a full team: not drawn, not a target.
    expect(hitTest(FREE, 'survivor', 460, 478)).toBeNull();
    expect(freeCardAt(FREE, 460, 478)).toBeNull();
    expect(freeCardAt(DEFAULT_DESIGN, 73, 459)).toBeNull();           // not Free
  });

  it('outlines each card instead of the whole screen, the selected one solid', () => {
    const strokes: number[][] = [];
    const dashes: number[][] = [];
    const ctx = fakeCtx(() => {});
    ctx.strokeRect = ((...a: number[]) => { strokes.push(a); }) as typeof ctx.strokeRect;
    ctx.setLineDash = ((d: number[]) => { dashes.push(d); }) as typeof ctx.setLineDash;
    drawHud(ctx, 853, 480, FREE, 'survivor', 'teamColumn', undefined, { card: 1 });
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

  it('never picks decoration, a hidden child, or anything outside the cards', () => {
    const c = card2();
    // (120, 1) in the card is only the splatter and the Voice icon, which no state draws: decoration and an undrawn state child, so the card itself stays the target.
    expect(childAt(DEFAULT_DESIGN, 'healthy', c.x + 120, c.y + 1)).toBeNull();
    const hidden = { ...DEFAULT_DESIGN, children: { teamColumn: { Head: { visible: false } } } };
    expect(childAt(hidden, 'healthy', c.x + 11, c.y + 13)).toBeNull();
    expect(childAt(DEFAULT_DESIGN, 'healthy', 426, 100)).toBeNull();
  });

  it("finds a resizable child's corner, and never one that has no size of its own", () => {
    const c = card2();
    const head = childRects(DEFAULT_DESIGN, 'teamColumn', { x: c.x, y: c.y }, 1).find((r) => r.name === 'Head')!;
    expect(childCornerAt(DEFAULT_DESIGN, 'healthy', 'Head', head.x + head.w, head.y + head.h)).toBe(true);
    expect(childCornerAt(DEFAULT_DESIGN, 'healthy', 'Head', head.x, head.y)).toBe(false);
    const items = childRects(DEFAULT_DESIGN, 'teamColumn', { x: c.x, y: c.y }, 1).find((r) => r.name === 'Items')!;
    expect(childCornerAt(DEFAULT_DESIGN, 'healthy', 'Items', items.x + items.w, items.y + items.h)).toBe(false);
  });

  it('outlines the selected child in every drawn card', () => {
    _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement);
    const strokes: number[][] = [];
    const ctx = fakeCtx(() => {});
    ctx.strokeRect = ((...a: number[]) => { strokes.push(a); }) as typeof ctx.strokeRect;
    drawHud(ctx, 853, 480, DEFAULT_DESIGN, 'survivor', 'teamColumn', undefined, { child: 'Head' });
    for (const c of teamCardRects(DEFAULT_DESIGN, DEFAULT_DESIGN.aspect).slice(0, 3)) {
      const head = childRects(DEFAULT_DESIGN, 'teamColumn', { x: c.x, y: c.y }, 1).find((r) => r.name === 'Head')!;
      expect(strokes).toContainEqual([head.x, head.y, head.w, head.h]);
    }
  });
});
