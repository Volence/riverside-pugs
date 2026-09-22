import { describe, it, expect, beforeEach, vi } from 'vitest';
import { childRects, drawPanel, drawSlotStyle, PANEL_FILE, _setImageFactory, _setCanvasFactory, _resetAssetCache } from './render';
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

  it('draws a restyled panel background from the design colour, not from the art', () => {
    const { ctx, calls } = recCtx();
    // stylePass repoints the TeamPlayer slot image, which lives in teamdisplayhud.res, not in the card file.
    // The card file's own BackgroundImage still names the stock frame, so this test targets the slot the
    // renderer is asked to draw: a hud/hudeditor/panelbg image key on a card child.
    const d = design({ styles: { panelBg: { kind: 'flat', color: '255 0 0 255' } } });
    drawPanel(ctx, d, 'teamColumn', { x: 0, y: 0 }, 1, { card: 0 });
    // Nothing in the card file points at hudeditor/, so no red rect here; the unit that does is drawSlotStyle:
    const { ctx: c2, calls: calls2 } = recCtx();
    drawSlotStyle(c2, d, 'panelbg', { name: 'x', kind: 'image', x: 1, y: 2, w: 30, h: 20, visible: true });
    const fills = calls2.filter((c) => c.m === 'fillRect');
    expect(fills.length).toBe(1);
    expect(c2.fillStyle).toBe('rgba(255,0,0,1)');
    expect(calls.length).toBeGreaterThan(0);
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
