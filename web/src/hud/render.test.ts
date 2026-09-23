import { describe, it, expect, beforeEach, vi } from 'vitest';
import { childRects, drawPanel, PANEL_FILE, hiddenInState, ITEM_ROW, itemRowStart, _setImageFactory, _setCanvasFactory, _resetAssetCache } from './render';
import { ICON_ADVANCE, ICON_SPACE } from './art/index';
import { buildHud } from './build';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { artUrl } from './art';

/** An untouched design: no element overrides, not even DEFAULT_DESIGN's fitted teammate card. */
const design = (patch: Partial<HudDesign>): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), elements: {}, ...patch });
const text = (files: { path: string; data: Uint8Array }[], path: string) =>
  new TextDecoder('latin1').decode(files.find((f) => f.path === path)!.data);

/** A recording 2D context: every method the renderer calls logs its name, and save/restore keep a real alpha stack. */
function recCtx() {
  const calls: { m: string; a: unknown[]; font: string; fill: string; op: string; alpha: number }[] = [];
  const stack: number[] = [];
  // Each call snapshots ctx.font, ctx.fillStyle, the composite op and the alpha at the moment it was made, so a test can pin how a child was drawn.
  const noop = (m: string) => (...a: unknown[]) => {
    calls.push({ m, a, font: ctx.font, fill: ctx.fillStyle, op: ctx.globalCompositeOperation, alpha: ctx.globalAlpha });
  };
  const ctx = {
    canvas: { width: 853, height: 480 },
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1, lineWidth: 1,
    globalCompositeOperation: 'source-over',
    save: (...a: unknown[]) => { stack.push(ctx.globalAlpha); noop('save')(...a); },
    restore: (...a: unknown[]) => { ctx.globalAlpha = stack.pop() ?? 1; noop('restore')(...a); },
    beginPath: noop('beginPath'), rect: noop('rect'), clip: noop('clip'),
    fillRect: noop('fillRect'), strokeRect: noop('strokeRect'), fillText: noop('fillText'), drawImage: noop('drawImage'),
    setLineDash: noop('setLineDash'), moveTo: noop('moveTo'), lineTo: noop('lineTo'), stroke: noop('stroke'), fill: noop('fill'),
    arc: noop('arc'), closePath: noop('closePath'), measureText: () => ({ width: 10 }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

/** An image that is "loaded" the moment it is created, so drawImage fires synchronously. */
const instantImage = (url: string) => ({ src: url, complete: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null }) as unknown as HTMLImageElement;

beforeEach(() => { _resetAssetCache(); _setImageFactory(instantImage); });

describe('childRects', () => {
  it('reads every child of the teammate card from the generated file, scaled and offset', () => {
    const d = design({ elements: { teamColumn: { scale: 1.5 } } });
    const k = 2;
    const rects = childRects(d, 'teamColumn', { x: 100, y: 200 }, k);
    const written = parseKv(text(buildHud(d), PANEL_FILE.teamColumn))[0].value as KvNode[];
    const health = kvFind(written, ['Health'])!;
    const r = rects.find((c) => c.name === 'Health')!;
    expect(r.kind).toBe('bar');
    expect(r.x).toBe(100 + parseFloat(kvGet(health, 'xpos')!) * k);
    expect(r.y).toBe(200 + parseFloat(kvGet(health, 'ypos')!) * k);
    expect(r.w).toBe(parseFloat(kvGet(health, 'wide')!) * k);
    expect(r.h).toBe(parseFloat(kvGet(health, 'tall')!) * k);
    // Draw order is the file's order sorted (stably) by zpos, as VGUI paints; a child with no zpos is 0.
    const z = (n: KvNode) => parseFloat(kvGet(n, 'zpos') ?? '0') || 0;
    const children = written.filter((n) => typeof n.value !== 'string');
    const drawOrder = children.map((n, i) => ({ n, i })).sort((a, b) => z(a.n) - z(b.n) || a.i - b.i).map((x) => x.n.key);
    expect(rects.map((c) => c.name)).toEqual(drawOrder);
  });

  it('agrees with the downloaded file for every panel in both presets', () => {
    // Against what buildHud writes, parsed back, not against buildTrees: the
    // rects must match the file a player installs. The fitted variant moves
    // the item icons and turns the health number on, so the card is re-fitted.
    for (const preset of ['stock', 'modern'] as const) for (const fit of [false, true]) {
      const d = design({ preset,
        elements: { ownHealth: { scale: 1.25 }, siHealth: { scale: 0.8 }, infectedRow: { scale: 1.3 }, teamColumn: { scale: 1.5, ...(fit ? { fit: true } : {}) } },
        children: fit ? { teamColumn: { Items: { x: 37, y: 40 }, HealthNumber: { on: true, x: 140 } } } : {} });
      const files = buildHud(d, { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } });
      for (const panelId of Object.keys(PANEL_FILE)) {
        const written = parseKv(text(files, PANEL_FILE[panelId]))[0].value as KvNode[];
        const nodes = written.filter((n) => typeof n.value !== 'string');
        const rects = childRects(d, panelId, { x: 0, y: 0 }, 1);
        expect(rects.length, `${preset} ${fit} ${panelId}`).toBe(nodes.length);
        // rects are in draw order, not file order, so pair each file child with its rect by name.
        for (const n of nodes) {
          const r = rects.find((c) => c.name === n.key);
          const at = `${preset} ${fit} ${panelId} ${n.key}`;
          expect(r, at).toBeDefined();
          expect([r!.x, r!.y, r!.w, r!.h], at).toEqual(['xpos', 'ypos', 'wide', 'tall'].map((key) => parseFloat(kvGet(n, key) ?? '0') || 0));
        }
      }
    }
  });

  it('reports visible 0 children as not visible', () => {
    // The stock teammate card's Voice panel ships visible 0.
    const rects = childRects(design({}), 'teamColumn', { x: 0, y: 0 }, 1);
    expect(rects.find((c) => c.name === 'Voice')!.visible).toBe(false);
  });

  it('classifies kinds by ControlName', () => {
    const kinds = Object.fromEntries(childRects(design({}), 'ownHealth', { x: 0, y: 0 }, 1).map((c) => [c.name, c.kind]));
    expect(kinds.Head).toBe('image');
    expect(kinds.Health).toBe('bar');
    expect(kinds.HealthNumber).toBe('label');
    expect(kinds.Incapacitated).toBe('image');
  });

  it('agrees with the downloaded file for the teammate card with fit, inside edits, a background and every layout', () => {
    const FOUR = [{ x: 8, y: 100 }, { x: 8, y: 150 }, { x: 700, y: 100 }, { x: 400, y: 440 }];
    for (const preset of ['stock', 'modern'] as const) {
      for (const dir of ['row', 'column', 'free'] as const) {
        const d = design({ preset,
          elements: { teamColumn: { fit: true, scale: 1.25, dir, gap: 6, slots: FOUR } },
          children: { teamColumn: { Head: { w: 30, h: 30 }, Items: { y: 20, fontSize: 22 }, HealthNumber: { on: true, x: 110 }, Incapacitated: { x: 40 } } },
          styles: { panelBg: { kind: 'rounded', color: '0 0 0 150' } } });
        const files = buildHud(d, { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } });
        const nodes = (parseKv(text(files, PANEL_FILE.teamColumn))[0].value as KvNode[]).filter((n) => typeof n.value !== 'string');
        const rects = childRects(d, 'teamColumn', { x: 0, y: 0 }, 1);
        expect(rects.length, `${preset} ${dir}`).toBe(nodes.length);
        for (const n of nodes) {
          const r = rects.find((c) => c.name === n.key)!;
          expect([r.x, r.y, r.w, r.h], `${preset} ${dir} ${n.key}`)
            .toEqual(['xpos', 'ypos', 'wide', 'tall'].map((key) => parseFloat(kvGet(n, key) ?? '0') || 0));
        }
      }
    }
  });
});

describe('drawPanel', () => {
  it('draws the own health panel: a portrait image, the bar art, and the number', () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({}), 'ownHealth', { x: 10, y: 10 }, 1);
    const drawn = calls.filter((c) => c.m === 'drawImage').length;
    expect(drawn).toBeGreaterThanOrEqual(2);                           // portrait + bar fill at least
    expect(calls.some((c) => c.m === 'fillText' && c.a[0] === '100')).toBe(true);
  });

  it('never draws the state children the game controls', () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({}), 'teamColumn', { x: 0, y: 0 }, 1, { card: 1 });
    // Every fillText must be one of the sample strings; nothing for Incapacitated/Dead/Voice.
    for (const c of calls.filter((c) => c.m === 'fillText')) expect(['Louis', '100', '+', '']).toContain(c.a[0]);
  });

  it('never draws the infected spawn timer, which game code shows only while dead or ghosted', () => {
    // Stock SpawnTimeLabel (39,40) sits right over the HealthPanel (38,41); drawing it would put a dead-state number on a live bar.
    for (const preset of ['stock', 'modern'] as const) {
      const { ctx, calls } = recCtx();
      drawPanel(ctx, design({ preset }), 'infectedRow', { x: 0, y: 0 }, 1, { card: 0 });
      // The card has two labels, NameLabel and SpawnTimeLabel; only the name may be drawn.
      expect(childRects(design({ preset }), 'infectedRow', { x: 0, y: 0 }, 1).some((c) => c.name === 'SpawnTimeLabel'), preset).toBe(true);
      expect(calls.filter((c) => c.m === 'fillText').map((c) => c.a[0]), preset).toEqual(['Francis']);
    }
  });

  it('draws a fillcolor ImagePanel as a filled rect (the Modern backgrounds)', () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({ preset: 'modern' }), 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 });
    expect(calls.some((c) => c.m === 'fillRect')).toBe(true);
  });

  it('draws the injected card background at the card size, from the design colour', () => {
    const flat = design({ elements: { teamColumn: { fit: true } }, styles: { panelBg: { kind: 'flat', color: '255 0 0 255' } } });
    const bg = childRects(flat, 'teamColumn', { x: 5, y: 7 }, 2).find((c) => c.name === 'HudEdCardBg')!;
    expect([bg.x, bg.y, bg.w, bg.h]).toEqual([5, 7, 242, 72]);
    const a = recCtx();
    drawPanel(a.ctx, flat, 'teamColumn', { x: 5, y: 7 }, 2, { card: 0 });
    expect(a.calls.some((c) => c.m === 'fillRect' && c.fill === 'rgba(255,0,0,1)' && c.a.join() === [5, 7, 242, 72].join())).toBe(true);

    const rounded = design({ elements: { teamColumn: { fit: true } }, styles: { panelBg: { kind: 'rounded', color: '0 255 0 255' } } });
    const b = recCtx();
    drawPanel(b.ctx, rounded, 'teamColumn', { x: 5, y: 7 }, 2, { card: 0 });
    expect(b.calls.some((c) => c.m === 'fill' && c.fill === 'rgba(0,255,0,1)')).toBe(true);
  });

  it('uses the scheme font size for a label, scaled to pixels', () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({}), 'ownHealth', { x: 0, y: 0 }, 2);
    // HUDHealth is 18 tall in the stock scheme; at k = 2 the canvas font is 36px.
    const numberCall = calls.find((c) => c.m === 'fillText' && c.a[0] === '100')!;
    expect(numberCall.font).toMatch(/^(bold )?36px /);
  });

  it('draws a face named Bold in bold, whatever its weight says', () => {
    // Stock HUDHealth is "Trade Gothic Bold" at weight 0 and PlayerDisplayName is the same face at 400:
    // the boldness is in the face, not the weight, so the canvas has to read the name.
    const own = recCtx();
    drawPanel(own.ctx, design({}), 'ownHealth', { x: 0, y: 0 }, 1);
    expect(own.calls.find((c) => c.m === 'fillText' && c.a[0] === '100')!.font).toMatch(/^bold /);
    const team = recCtx();
    drawPanel(team.ctx, design({}), 'teamColumn', { x: 0, y: 0 }, 1, { card: 1 });
    expect(team.calls.find((c) => c.m === 'fillText' && c.a[0] === 'Louis')!.font).toMatch(/^bold /);
    // With Roboto on the stock preset, fontPass renames both Trade Gothic faces to plain "Roboto Condensed"
    // at their own weights, so the game draws these regular, and so must the preview.
    const roboto = recCtx();
    drawPanel(roboto.ctx, design({ font: 'roboto' }), 'ownHealth', { x: 0, y: 0 }, 1);
    expect(roboto.calls.find((c) => c.m === 'fillText' && c.a[0] === '100')!.font).not.toMatch(/^bold /);
  });

  it("draws a scaled parent's label at the scaled size", () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({ elements: { ownHealth: { scale: 1.5 } } }), 'ownHealth', { x: 0, y: 0 }, 1);
    // scalePass wrote HudEd_HUDHealth_150 with tall 27 and pointed the label at it.
    const numberCall = calls.find((c) => c.m === 'fillText' && c.a[0] === '100')!;
    expect(numberCall.font).toMatch(/^(bold )?27px /);
  });

  // The missing-art path (hatch and one warning) lives in render.missing.test.ts, which mocks ./art.

  it('draws the stock bar art whatever the styles say, since the game draws bar fills in code (probe T8)', () => {
    const green = artUrl('vgui/healthbar_green')!;
    // barGreen is a slot the editor no longer has; a raw design that still carries it changes nothing.
    const styles = { barGreen: { kind: 'flat' as const, color: '255 0 0 255' } };
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({ advanced: true, styles }), 'ownHealth', { x: 0, y: 0 }, 1);
    expect(calls.filter((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === green)).toHaveLength(1);
    expect(calls.some((c) => c.m === 'fillRect' && c.fill === 'rgba(255,0,0,1)')).toBe(false);
  });

  it('hatches a texture that fails to load and asks for a redraw, instead of drawing nothing for ever', () => {
    const scratches = artUrl('vgui/hud/detail_scratches_top_1')!;
    const failing = new Map<string, HTMLImageElement & { onerror: (() => void) | null }>();
    _setImageFactory((url) => {
      if (url !== scratches) return instantImage(url);
      const img = { src: url, complete: false, naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null } as unknown as HTMLImageElement & { onerror: (() => void) | null };
      failing.set(url, img);
      return img;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let redraws = 0;
      const d = design({});
      const r = childRects(d, 'ownHealth', { x: 0, y: 0 }, 1).find((c) => c.name === 'HealthbarTextureTop')!;
      const first = recCtx();
      drawPanel(first.ctx, d, 'ownHealth', { x: 0, y: 0 }, 1, { onAsset: () => { redraws++; } });
      expect(first.calls.filter((c) => c.m === 'strokeRect').map((c) => c.a)).not.toContainEqual([r.x, r.y, r.w, r.h]);   // still loading
      const img = failing.get(scratches)!;
      expect(typeof img.onerror).toBe('function');
      img.onerror!();
      expect(redraws).toBe(1);
      const second = recCtx();
      drawPanel(second.ctx, d, 'ownHealth', { x: 0, y: 0 }, 1, { onAsset: () => { redraws++; } });
      expect(second.calls.filter((c) => c.m === 'strokeRect').map((c) => c.a)).toContainEqual([r.x, r.y, r.w, r.h]);
    } finally { warn.mockRestore(); }
  });

  it("tints an image by its drawColor, as the stock infected card's dark frame is drawn", () => {
    // Stock zombieteamdisplayplayer.res draws BackgroundImage with drawColor 64 64 64 255: about a quarter
    // brightness. The tint is made on a scratch canvas (multiply, then cut back to the image's own alpha) so
    // the frame's transparent parts do not darken whatever is behind the card; the card then draws that.
    const scratch = recCtx();
    const made: { width: number; height: number }[] = [];
    _setCanvasFactory((w, h) => {
      const c = { width: w, height: h, getContext: () => scratch.ctx } as unknown as HTMLCanvasElement;
      made.push(c);
      return c;
    });
    try {
      const { ctx, calls } = recCtx();
      drawPanel(ctx, design({}), 'infectedRow', { x: 0, y: 0 }, 1, { card: 0 });
      const bg = childRects(design({}), 'infectedRow', { x: 0, y: 0 }, 1).find((c) => c.name === 'BackgroundImage')!;
      expect(made).toHaveLength(1);
      const multiply = scratch.calls.find((c) => c.m === 'fillRect' && c.op === 'multiply');
      expect(multiply?.fill).toBe('rgb(64,64,64)');
      expect(scratch.calls.some((c) => c.m === 'drawImage' && c.op === 'destination-in')).toBe(true);
      expect(calls.some((c) => c.m === 'drawImage' && c.a[0] === made[0]
        && c.a[1] === bg.x && c.a[2] === bg.y && c.a[3] === bg.w && c.a[4] === bg.h)).toBe(true);
      // A child with no drawColor of its own draws its art untinted (e.g. Head, drawn via its own
      // portrait branch, never reaches this tint code at all). The own-health panel's scratch overlays
      // are the deliberate exception (see "tints the own-health scratch overlays" below): they add two
      // more canvases here, one each for HealthbarTextureTop and HealthbarTextureBottom.
      drawPanel(recCtx().ctx, design({}), 'ownHealth', { x: 0, y: 0 }, 1);
      expect(made).toHaveLength(3);
    } finally { _setCanvasFactory(null); }
  });

  it('draws nothing for a hidden splatter, now written at size 0 and alpha 0 as well as visible 0', () => {
    const bg = artUrl('vgui/hud/healthbar_bg_1')!;
    const d = design({ children: { teamColumn: { BackgroundImage: { visible: false } } } });
    const r = childRects(d, 'teamColumn', { x: 0, y: 0 }, 1).find((c) => c.name === 'BackgroundImage')!;
    expect([r.visible, r.w, r.h]).toEqual([false, 0, 0]);
    const { ctx, calls } = recCtx();
    drawPanel(ctx, d, 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 });
    expect(calls.some((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === bg)).toBe(false);
  });

  it('draws the stock teammate splatter faintly, as the game does at full health, and leaves Modern alone', () => {
    // Probe T6: the splatter shrunk to the card was faintly visible at full health. It is drawn, not hidden.
    const bg = artUrl('vgui/hud/healthbar_bg_1')!;
    const stock = recCtx();
    drawPanel(stock.ctx, design({}), 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 });
    const splatter = stock.calls.filter((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === bg);
    expect(splatter).toHaveLength(1);
    expect(splatter[0].alpha).toBeCloseTo(0.35);
    // Nothing drawn after it inherits the reduced opacity.
    expect(stock.calls.find((c) => c.m === 'fillText' && c.a[0] === 'Francis')!.alpha).toBe(1);

    const modern = recCtx();
    drawPanel(modern.ctx, design({ preset: 'modern' }), 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 });
    // Modern's ModBg paints its fillcolor background; its BackgroundImage ships visible 0.
    expect(modern.calls.some((c) => c.m === 'fillRect')).toBe(true);
  });

  it('tints the splatter from the design tree, the faint 0.35 composing with the tint alpha', () => {
    // The splatter is now editable: a player's drawColor override on BackgroundImage goes through the
    // same tint path as the stock infected card's frame, and SPLATTER_ALPHA is still the preview's
    // stand-in for the game's faint look on top of it, not a replacement for it.
    const scratch = recCtx();
    const made: { width: number; height: number }[] = [];
    _setCanvasFactory((w, h) => {
      const c = { width: w, height: h, getContext: () => scratch.ctx } as unknown as HTMLCanvasElement;
      made.push(c);
      return c;
    });
    try {
      const d = design({ children: { teamColumn: { BackgroundImage: { color: '200 20 20 255' } } } });
      const { ctx, calls } = recCtx();
      drawPanel(ctx, d, 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 });
      const multiply = scratch.calls.find((c) => c.m === 'fillRect' && c.op === 'multiply');
      expect(multiply?.fill).toBe('rgb(200,20,20)');
      const splatter = calls.find((c) => c.m === 'drawImage' && c.a[0] === made[0]);
      expect(splatter).toBeTruthy();
      expect(splatter!.alpha).toBeCloseTo(0.35);
    } finally { _setCanvasFactory(null); }
  });

  it('composes the faint splatter alpha with an Opacity override, the realistic case (white, alpha only)', () => {
    // The splatter's own art is pure black, so the editor's Opacity control never touches r, g or b
    // (ContextPanel.tsx's opacityOnly); white at alpha 128 stays untinted (drawImageChild's own
    // r < 255 || g < 255 || b < 255 check skips the scratch canvas), and only globalAlpha changes:
    // SPLATTER_ALPHA (0.35) times the override's own alpha fraction (128 / 255).
    const bg = artUrl('vgui/hud/healthbar_bg_1')!;
    const d = design({ children: { teamColumn: { BackgroundImage: { color: '255 255 255 128' } } } });
    const { ctx, calls } = recCtx();
    drawPanel(ctx, d, 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 });
    const splatter = calls.find((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === bg);
    expect(splatter).toBeTruthy();
    expect(splatter!.alpha).toBeCloseTo(0.35 * (128 / 255));
  });

  it('tints the own-health scratch overlays with the health colour, matching the in-game screenshot at full health', () => {
    // Stock localplayerpanel.res's HealthbarTextureTop/Bottom (detail_scratches_top_1/bottom_1) carry no
    // drawColor of their own, but the owner's screenshot at full health shows them the same bright green
    // as the health number and bar: "HealthGreen" "0 200 0 255" in clientscheme.res's Colors block. This
    // reuses the same scratch-canvas tint path as the infected card's drawColor above.
    const scratch = recCtx();
    const made: { width: number; height: number }[] = [];
    _setCanvasFactory((w, h) => {
      const c = { width: w, height: h, getContext: () => scratch.ctx } as unknown as HTMLCanvasElement;
      made.push(c);
      return c;
    });
    try {
      const { ctx, calls } = recCtx();
      drawPanel(ctx, design({}), 'ownHealth', { x: 0, y: 0 }, 1);
      expect(made).toHaveLength(2);   // top and bottom scratches are different materials, each tinted once
      const multiplies = scratch.calls.filter((c) => c.m === 'fillRect' && c.op === 'multiply');
      expect(multiplies.length).toBeGreaterThanOrEqual(2);
      for (const m of multiplies) expect(m.fill).toBe('rgb(0,200,0)');
      expect(calls.some((c) => c.m === 'drawImage' && made.includes(c.a[0] as HTMLCanvasElement))).toBe(true);
    } finally { _setCanvasFactory(null); }
  });

  it('draws the infected card head as a silhouette, never a survivor portrait', () => {
    const portraits = ['biker', 'manager', 'namvet', 'teenangst'].map((c) => artUrl(`vgui/s_panel_${c}`)!);
    for (const preset of ['stock', 'modern'] as const) {
      for (const card of [undefined, 0, 1, 2]) {
        const { ctx, calls } = recCtx();
        drawPanel(ctx, design({ preset }), 'infectedRow', { x: 0, y: 0 }, 1, { card });
        const srcs = calls.filter((c) => c.m === 'drawImage').map((c) => (c.a[0] as HTMLImageElement).src);
        for (const p of portraits) expect(srcs, `${preset} card ${card}`).not.toContain(p);
        expect(calls.some((c) => c.m === 'arc'), `${preset} card ${card}`).toBe(true);
      }
    }
  });
});

describe('the teammate card states', () => {
  const fitted = (children: HudDesign['children'] = {}) => design({ elements: { teamColumn: { fit: true } }, children });
  const srcs = (calls: { m: string; a: unknown[] }[]) =>
    calls.filter((c) => c.m === 'drawImage').map((c) => (c.a[0] as HTMLImageElement).src);
  const imageAt = (calls: { m: string; a: unknown[] }[], url: string) =>
    calls.find((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === url);

  it('Healthy draws the portrait and never the down or dead art', () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, fitted(), 'teamColumn', { x: 0, y: 0 }, 1, { card: 1 });
    expect(srcs(calls)).toContain(artUrl('vgui/s_panel_manager'));
    expect(srcs(calls)).not.toContain(artUrl('vgui/s_panel_manager_incap'));
    expect(srcs(calls)).not.toContain(artUrl('vgui/s_panel_dead'));
  });

  it("Down draws the character's incap art square at the card height, a red bar and 299 in red, and no portrait", () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, fitted({ teamColumn: { HealthNumber: { on: true } } }), 'teamColumn', { x: 10, y: 20 }, 2, { card: 1, state: 'down' });
    // Stock fitted: a 36-unit square at the card's top-left (the Head's x, which fit moved to 0), at k = 2.
    expect(imageAt(calls, artUrl('vgui/s_panel_manager_incap')!)!.a.slice(1)).toEqual([10, 20, 72, 72]);
    expect(srcs(calls)).not.toContain(artUrl('vgui/s_panel_manager'));
    expect(srcs(calls)).toContain(artUrl('vgui/healthbar_red'));
    expect(srcs(calls)).not.toContain(artUrl('vgui/healthbar_green'));
    const number = calls.find((c) => c.m === 'fillText' && c.a[0] === '299')!;
    expect(number.fill).toBe('rgba(192,28,0,1)');                       // the scheme's HealthHurtRed
  });

  it('Dead draws the dead art square, dims the name, and draws no bar, number, portrait or icons', () => {
    const d = fitted({ teamColumn: { HealthNumber: { on: true } } });
    const items = childRects(d, 'teamColumn', { x: 10, y: 20 }, 2).find((c) => c.name === 'Items')!;
    const { ctx, calls } = recCtx();
    drawPanel(ctx, d, 'teamColumn', { x: 10, y: 20 }, 2, { card: 1, state: 'dead' });
    expect(imageAt(calls, artUrl('vgui/s_panel_dead')!)!.a.slice(1)).toEqual([10, 20, 72, 72]);
    expect(srcs(calls).some((s) => /healthbar_(green|red)/.test(s))).toBe(false);
    expect(srcs(calls)).not.toContain(artUrl('vgui/s_panel_manager'));
    expect(calls.some((c) => c.m === 'fillText' && (c.a[0] === '100' || c.a[0] === '299'))).toBe(false);
    expect(calls.find((c) => c.m === 'fillText' && c.a[0] === 'Louis')!.alpha).toBeCloseTo(0.5);
    expect(calls.some((c) => c.m === 'strokeRect' && c.a[0] === items.x)).toBe(false);
    expect(srcs(calls).some((u) => /icon-item-/.test(u))).toBe(false);
  });

  it('hides by state only on the teammate card', () => {
    expect(hiddenInState('teamColumn', 'Head', 'down')).toBe(true);
    expect(hiddenInState('teamColumn', 'Incapacitated', 'down')).toBe(false);
    expect(hiddenInState('ownHealth', 'Incapacitated', 'down')).toBe(true);
    expect(hiddenInState('teamColumn', 'Voice', 'healthy')).toBe(true);
  });

  const icon = <C extends { m: string; a: unknown[] }>(calls: C[], name: string) =>
    calls.find((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === artUrl(name));

  it('draws the real item icons, a full loadout in the game\'s order, one font size tall where the Items label sits', () => {
    const d = design({});
    const r = childRects(d, 'teamColumn', { x: 0, y: 0 }, 1).find((c) => c.name === 'Items')!;
    const { ctx, calls } = recCtx();
    drawPanel(ctx, d, 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 });
    // L4D_Icons_medium is 18 tall in the stock scheme; the label box is 14, so the icons centre on it.
    const s = 18, y = r.y + (r.h - s) / 2;
    const medkit = icon(calls, 'icon/item/medkit')!, pills = icon(calls, 'icon/item/pills')!, pipe = icon(calls, 'icon/item/pipebomb')!;
    // The test images are 64 x 64, so each draws s wide; the row advances by each glyph's own advance plus a space.
    expect(medkit.a.slice(1)).toEqual([r.x, y, s, s]);
    const x2 = r.x + (ICON_ADVANCE['icon/item/medkit'] + ICON_SPACE) * s;
    expect(pills.a.slice(1)).toEqual([x2, y, s, s]);
    expect(pipe.a.slice(1)).toEqual([x2 + (ICON_ADVANCE['icon/item/pills'] + ICON_SPACE) * s, y, s, s]);
    expect(calls.indexOf(medkit)).toBeLessThan(calls.indexOf(pills));
    expect(calls.indexOf(pills)).toBeLessThan(calls.indexOf(pipe));
    // One throwable at a time, as the game carries it, and no stand-in outlines.
    expect(icon(calls, 'icon/item/molotov')).toBeUndefined();
    expect(calls.some((c) => c.m === 'strokeRect' && c.a[0] === r.x)).toBe(false);
  });

  it('scales the icons with the preview and with the icon size the player picks', () => {
    const d = design({ children: { teamColumn: { Items: { fontSize: 36 } } } });
    const r = childRects(d, 'teamColumn', { x: 10, y: 20 }, 2).find((c) => c.name === 'Items')!;
    const { ctx, calls } = recCtx();
    drawPanel(ctx, d, 'teamColumn', { x: 10, y: 20 }, 2, { card: 0 });
    expect(icon(calls, 'icon/item/medkit')!.a.slice(1)).toEqual([r.x, r.y + (r.h - 72) / 2, 72, 72]);
  });

  it('lays the icon row out by the label\'s textAlignment', () => {
    const s = 10;
    const row = ITEM_ROW.reduce((w, n, i) => w + ICON_ADVANCE[n] * s + (i ? ICON_SPACE * s : 0), 0);
    expect(itemRowStart(100, 50, s, 'west')).toBe(100);
    expect(itemRowStart(100, 50, s, 'north-west')).toBe(100);
    expect(itemRowStart(100, 50, s, 'east')).toBeCloseTo(150 - row);
    expect(itemRowStart(100, 50, s, 'center')).toBeCloseTo(100 + (50 - row) / 2);
  });

  it('keeps a full stock loadout inside the stock Items label', () => {
    // The game's own row, medkit, space, pills, space, throwable, fits the 50-wide label at 18 tall.
    const s = 18;
    const row = ITEM_ROW.reduce((w, n, i) => w + ICON_ADVANCE[n] * s + (i ? ICON_SPACE * s : 0), 0);
    expect(row).toBeLessThanOrEqual(50);
  });

  // The game draws the icon glyphs inside the Items label and nowhere else. An
  // icon taller than its label (Modern: a 16-tall icon in a 13-tall label at
  // y 10, right under the Name at y 2..13) would otherwise spill up over the
  // name text, so the icons are clipped to the label rect.
  for (const preset of ['stock', 'modern'] as const) {
    it(`draws the item icons only inside the Items label: ${preset}`, () => {
      // Stock at icon size 36, whose label grows to 100 x 36 so the icons still fit; Modern as it ships.
      const d = design({ preset, children: preset === 'stock' ? { teamColumn: { Items: { fontSize: 36 } } } : {} });
      const rects = childRects(d, 'teamColumn', { x: 0, y: 0 }, 1);
      const r = rects.find((c) => c.name === 'Items')!;
      const { ctx, calls } = recCtx();
      drawPanel(ctx, d, 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 });
      const first = calls.indexOf(icon(calls, 'icon/item/medkit')!);
      expect(first, preset).toBeGreaterThan(0);
      const clip = calls.slice(0, first).map((c) => c.m).lastIndexOf('clip');
      expect(clip, preset).toBeGreaterThan(0);
      expect(calls[clip - 1].m).toBe('rect');
      expect(calls[clip - 1].a).toEqual([r.x, r.y, r.w, r.h]);
      // The clip is dropped again before the next child draws.
      expect(calls.slice(first).findIndex((c) => c.m === 'restore')).toBeGreaterThan(0);
      if (preset === 'stock') {
        // The whole row, the throwable last, fits inside the widened label.
        const pipe = icon(calls, 'icon/item/pipebomb')!;
        expect((pipe.a[1] as number) + ICON_ADVANCE['icon/item/pipebomb'] * 36).toBeLessThanOrEqual(r.x + r.w);
      } else {
        // Unclipped, the icon row would start above the label, over the Name text.
        const name = rects.find((c) => c.name === 'Name')!;
        expect(calls[first].a[2] as number).toBeLessThan(r.y);
        expect(r.y).toBeGreaterThan(name.y + name.h / 2);
      }
    });
  }

  it('falls back to the stand-in outlines when an icon fails to load', () => {
    const pills = artUrl('icon/item/pills')!;
    const failing: (HTMLImageElement & { onerror: (() => void) | null })[] = [];
    _setImageFactory((url) => {
      if (url !== pills) return instantImage(url);
      const img = { src: url, complete: false, naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null } as unknown as HTMLImageElement & { onerror: (() => void) | null };
      failing.push(img);
      return img;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const d = design({});
      const r = childRects(d, 'teamColumn', { x: 0, y: 0 }, 1).find((c) => c.name === 'Items')!;
      drawPanel(recCtx().ctx, d, 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 });
      failing[0].onerror!();
      const { ctx, calls } = recCtx();
      drawPanel(ctx, d, 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 });
      expect(calls.filter((c) => c.m === 'strokeRect').map((c) => c.a)).toContainEqual([r.x, r.y + (r.h - 18) / 2, 18, 18]);
      expect(icon(calls, 'icon/item/medkit')).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  it('keeps drawing the card background child in Down and Dead, since the spec says it is visible in every state', () => {
    const flat = design({ elements: { teamColumn: { fit: true } }, styles: { panelBg: { kind: 'flat', color: '255 0 0 255' } } });
    for (const state of ['down', 'dead'] as const) {
      const { ctx, calls } = recCtx();
      drawPanel(ctx, flat, 'teamColumn', { x: 5, y: 7 }, 2, { card: 0, state });
      expect(calls.some((c) => c.m === 'fillRect' && c.fill === 'rgba(255,0,0,1)'), state).toBe(true);
    }
  });
});
