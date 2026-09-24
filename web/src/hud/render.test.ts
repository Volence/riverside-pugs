import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { childRects, drawPanel, setFont, PANEL_FILE, hiddenInState, previewOf, DEFAULT_PREVIEW, ITEM_ROW, itemRowStart, paintAdditive, paintLinearOver, healthRgb, shownKey, panelColour, _setImageFactory, _setCanvasFactory, _resetAssetCache, _cacheSizes, splatterSource, tinted, type SurvivorState } from './render';
import { linearOverAlpha } from './additive';
import { ICON_ADVANCE, ICON_SPACE } from './art/index';
import { buildHud } from './build';
import { DEFAULT_DESIGN, validateDesign, type HudDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { artUrl } from './art';
import { fadeTexture } from './textures';
import { cssFamily, fontCell, _resetImportFaces } from './fonts';
import { registerImport, unregisterImport, baseFile } from './base';
import { sampleHud, fakeCanvas, recordingCtx, hostileFont, type HostileFontKind } from './importFixtures';
import { _resetImportedArt } from './importArt';
import { TEAM_PANEL } from './children';
import { _setProbe } from './probes';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** An untouched design: no element overrides, not even DEFAULT_DESIGN's fitted teammate card. */
const design = (patch: Partial<HudDesign>): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), elements: {}, ...patch });
const text = (files: { path: string; data: Uint8Array }[], path: string) =>
  new TextDecoder('latin1').decode(files.find((f) => f.path === path)!.data);

describe('the splatter caches', () => {
  afterEach(() => { _setCanvasFactory(null); });

  it('keeps a bounded number of Fade and tint canvases through a long colour drag', () => {
    _setCanvasFactory(fakeCanvas().factory);
    for (let i = 0; i < 300; i++) {
      const d = design({ splatters: { splatTop: { kind: 'fade', color: `${i % 256} 0 0 ${i % 255}` } } });
      const got = splatterSource(d, 'splatTop')!;
      tinted(got.src, got.key, 10, 177, 50, 256, 64);
    }
    const { fades, tints } = _cacheSizes();
    expect(fades).toBeLessThanOrEqual(8);
    expect(tints).toBeLessThanOrEqual(64);
  });

  it('keeps the most recently used entry when it evicts', () => {
    const { factory, made } = fakeCanvas();
    _setCanvasFactory(factory);
    const fade = (c: string) => splatterSource(design({ splatters: { splatTop: { kind: 'fade', color: c } } }), 'splatTop')!;
    const first = fade('1 2 3 255');
    for (let i = 0; i < 20; i++) { fade(`${i} 9 9 255`); fade('1 2 3 255'); }
    const n = made.length;
    expect(fade('1 2 3 255').src).toBe(first.src);
    expect(made).toHaveLength(n);
  });

  it('keys an uploaded picture by a short hash, not its whole data URL', () => {
    const png = 'A'.repeat(20000);
    const d = design({ splatters: { splatTop: { kind: 'image' } }, images: { splatTop: { w: 256, h: 64, png } } });
    const key = splatterSource(d, 'splatTop')!.key;
    expect(key.length).toBeLessThan(64);
    const other = design({ splatters: { splatTop: { kind: 'image' } }, images: { splatTop: { w: 256, h: 64, png: `${png}B` } } });
    expect(splatterSource(other, 'splatTop')!.key).not.toBe(key);
    const same = design({ splatters: { splatTop: { kind: 'image' } }, images: { splatTop: { w: 256, h: 64, png: 'A'.repeat(20000) } } });
    expect(splatterSource(same, 'splatTop')!.key).toBe(key);
  });
});

/** A recording 2D context: every method the renderer calls logs its name, and save/restore keep a real alpha stack. */
function recCtx() {
  const calls: { m: string; a: unknown[]; font: string; fill: string; op: string; alpha: number; baseline: string }[] = [];
  const stack: number[] = [];
  // Each call snapshots ctx.font, ctx.fillStyle, the composite op and the alpha at the moment it was made, so a test can pin how a child was drawn.
  const noop = (m: string) => (...a: unknown[]) => {
    calls.push({ m, a, font: ctx.font, fill: ctx.fillStyle, op: ctx.globalCompositeOperation, alpha: ctx.globalAlpha, baseline: ctx.textBaseline });
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

  it('adds text in an additive scheme font onto the scene, and blends the rest', () => {
    // HUDHealth (the own health number) says "additive" "1"; PlayerDisplayName
    // (the teammate's name) does not. The game adds an additive font's glyphs
    // to what is behind them, which the canvas's 'lighter' composite does too.
    const own = recCtx();
    drawPanel(own.ctx, design({}), 'ownHealth', { x: 0, y: 0 }, 1);
    expect(own.calls.find((c) => c.m === 'fillText' && c.a[0] === '100')!.op).toBe('lighter');
    const team = recCtx();
    drawPanel(team.ctx, design({}), 'teamColumn', { x: 0, y: 0 }, 1, { card: 1 });
    expect(team.calls.find((c) => c.m === 'fillText' && c.a[0] === 'Louis')!.op).toBe('source-over');
  });

  it("adds the teammate's item icons onto the scene, as their additive icon font is drawn", () => {
    // The Items label's font, L4D_Icons_medium, is the ToolBox face with "additive" "1".
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({}), 'teamColumn', { x: 0, y: 0 }, 1, { card: 1 });
    const icons = calls.filter((c) => c.m === 'drawImage' && ITEM_ROW.some((n) => (c.a[0] as HTMLImageElement).src === artUrl(n)));
    expect(icons.length).toBe(ITEM_ROW.length);
    for (const c of icons) expect(c.op).toBe('lighter');
  });

  it("colours the own health number and its + by health, as client.dll does, whatever the file's colour", () => {
    // client.dll sets HealthNumber's and HealthIcon's fgcolor to the health
    // colour on every update, so a file's own colour never shows. At the
    // preview's full health that is the green (10, 177, 50).
    for (const preset of ['stock', 'modern'] as const) {
      const { ctx, calls } = recCtx();
      drawPanel(ctx, design({ preset }), 'ownHealth', { x: 0, y: 0 }, 1);
      const texts = calls.filter((c) => c.m === 'fillText');
      expect(texts.find((c) => c.a[0] === '100')!.fill, preset).toBe('rgba(10,177,50,1)');
      expect(texts.find((c) => c.a[0] !== '100')!.fill, preset).toBe('rgba(10,177,50,1)');
    }
  });

  it('writes the own health icon as the file does, a "," in the ToolBox icon face, which is the game\'s "+"', () => {
    // localplayerpanel.res: HealthIcon, labelText ",", font L4D_Icons (ToolBox, 16 tall, additive).
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({}), 'ownHealth', { x: 0, y: 0 }, 2);
    const icon = calls.find((c) => c.m === 'fillText' && c.a[0] !== '100')!;
    expect(icon.a[0]).toBe(',');
    expect(icon.font).toBe(`400 ${fontCell('ToolBox', 32).em}px ${cssFamily('ToolBox')}`);
  });

  it("colours a teammate's health number by health too, over the Modern file's White", () => {
    // The same panel class draws the teammate card (TeammatePanel.res); the
    // owner's Modern screenshot shows the numbers green, not the file's White.
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({ preset: 'modern' }), 'teamColumn', { x: 0, y: 0 }, 1, { card: 1 });
    expect(calls.find((c) => c.m === 'fillText' && c.a[0] === '100')!.fill).toBe('rgba(10,177,50,1)');
    expect(calls.find((c) => c.m === 'fillText' && c.a[0] === 'Louis')!.fill).not.toBe('rgba(10,177,50,1)');
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

  it('fills your own health background first, in its colour', () => {
    const d = design({ styles: { ownBg: { kind: 'flat', color: '1 2 3 255' } } });
    const bg = childRects(d, 'ownHealth', { x: 5, y: 7 }, 2).find((c) => c.name === 'HudEdOwnBg')!;
    expect([bg.x, bg.y, bg.w, bg.h]).toEqual([5, 7, 260, 170]);
    const { ctx, calls } = recCtx();
    drawPanel(ctx, d, 'ownHealth', { x: 5, y: 7 }, 2);
    const draws = calls.filter((c) => ['fillRect', 'drawImage', 'fillText', 'fill'].includes(c.m));
    expect(draws[0].m).toBe('fillRect');
    expect(draws[0].fill).toBe('rgba(1,2,3,1)');
    expect(draws[0].a).toEqual([5, 7, 260, 170]);
  });

  it('draws a Trade Gothic label in the exported face, sized by its cell as the game sizes it', () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({}), 'ownHealth', { x: 0, y: 0 }, 2);
    // HUDHealth is Trade Gothic Bold, 18 tall, weight 0. At k = 2 its cell is
    // 36 pixels, which the face's VDMX table makes 29 ppem, 29 of it above
    // the baseline. Weight 0 is regular: the face itself is the bold one.
    const numberCall = calls.find((c) => c.m === 'fillText' && c.a[0] === '100')!;
    expect(numberCall.font).toBe(`400 29px ${cssFamily('Trade Gothic Bold')}`);
    // The game draws text from the top of its cell, centred in a west label,
    // so the baseline sits the ascent below the cell's top.
    const r = childRects(design({}), 'ownHealth', { x: 0, y: 0 }, 2).find((c) => c.name === 'HealthNumber')!;
    expect(numberCall.baseline).toBe('alphabetic');
    expect(numberCall.a[2]).toBe(r.y + (r.h - 36) / 2 + 29);
  });

  it('draws the teammate name in its face at the scheme weight', () => {
    // PlayerDisplayName is Trade Gothic Bold at weight 400, 12 tall.
    const team = recCtx();
    drawPanel(team.ctx, design({}), 'teamColumn', { x: 0, y: 0 }, 2, { card: 1 });
    expect(team.calls.find((c) => c.m === 'fillText' && c.a[0] === 'Louis')!.font).toBe(`400 ${fontCell('Trade Gothic Bold', 24).em}px ${cssFamily('Trade Gothic Bold')}`);
  });

  it('draws in Roboto Condensed on the Modern preset and in the Roboto option, at the scheme weight', () => {
    // Modern's PlayerDisplayName is Roboto Condensed at weight 700, 12 tall; Roboto has no VDMX, so the em is the cell scaled by winAscent + winDescent.
    const modern = recCtx();
    drawPanel(modern.ctx, design({ preset: 'modern' }), 'teamColumn', { x: 0, y: 0 }, 2, { card: 1 });
    expect(modern.calls.find((c) => c.m === 'fillText' && c.a[0] === 'Louis')!.font).toBe(`700 ${fontCell('Roboto Condensed', 24).em}px ${cssFamily('Roboto Condensed')}`);
    // With Roboto on the stock preset, fontPass renames both Trade Gothic faces to plain "Roboto Condensed"
    // at their own weights, so the game draws these regular, and so must the preview.
    const roboto = recCtx();
    drawPanel(roboto.ctx, design({ font: 'roboto' }), 'ownHealth', { x: 0, y: 0 }, 2);
    expect(roboto.calls.find((c) => c.m === 'fillText' && c.a[0] === '100')!.font).toBe(`400 ${fontCell('Roboto Condensed', 36).em}px ${cssFamily('Roboto Condensed')}`);
  });

  it("draws a scaled parent's label at the scaled size", () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({ elements: { ownHealth: { scale: 1.5 } } }), 'ownHealth', { x: 0, y: 0 }, 1);
    // scalePass wrote HudEd_HUDHealth_150 with tall 27 and pointed the label at it: a 27 cell.
    const numberCall = calls.find((c) => c.m === 'fillText' && c.a[0] === '100')!;
    expect(numberCall.font).toBe(`400 ${fontCell('Trade Gothic Bold', 27).em}px ${cssFamily('Trade Gothic Bold')}`);
  });

  // The missing-art path (hatch and one warning) lives in render.missing.test.ts, which mocks ./art.

  it('draws the stock bar art whatever the styles say, since the game draws bar fills in code (probe T8)', () => {
    // The fill is healthbar_white tinted by code (slice 2.F Task X9); no style can replace it.
    const green = artUrl('vgui/healthbar_white')!;
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
      // The frame, then the card's HealthPanel outline and fill, which code tints by health (slice 2.F X9).
      expect(made).toHaveLength(3);
      const multiply = scratch.calls.find((c) => c.m === 'fillRect' && c.op === 'multiply');
      expect(multiply?.fill).toBe('rgb(64,64,64)');
      expect(scratch.calls.some((c) => c.m === 'drawImage' && c.op === 'destination-in')).toBe(true);
      expect(calls.some((c) => c.m === 'drawImage' && c.a[0] === made[0]
        && c.a[1] === bg.x && c.a[2] === bg.y && c.a[3] === bg.w && c.a[4] === bg.h)).toBe(true);
      // A child with no drawColor of its own draws its art untinted (e.g. Head, drawn via its own
      // portrait branch, never reaches this tint code at all). The own-health panel's scratch overlays
      // are the deliberate exception (see "tints the own-health scratch overlays" below): they add two
      // more canvases here, one each for HealthbarTextureTop and HealthbarTextureBottom (the bar's green
      // outline and fill are already in the tint cache from the infected card's bar).
      drawPanel(recCtx().ctx, design({}), 'ownHealth', { x: 0, y: 0 }, 1);
      expect(made).toHaveLength(5);
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
    // drawColor of their own; client.dll sets their draw colour to the health colour every update (healthRgb),
    // the green (10, 177, 50) at full health. This reuses the same scratch-canvas tint path as the infected
    // card's drawColor above.
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
      expect(made).toHaveLength(4);   // top and bottom scratches, each tinted once, and the bar's outline and fill (X9)
      const multiplies = scratch.calls.filter((c) => c.m === 'fillRect' && c.op === 'multiply');
      expect(multiplies.length).toBeGreaterThanOrEqual(2);
      for (const m of multiplies) expect(m.fill).toBe('rgb(10,177,50)');
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

  it("Down draws the character's incap art square at the card height, a bar and 299 in red, and no portrait", () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, fitted({ teamColumn: { HealthNumber: { on: true } } }), 'teamColumn', { x: 10, y: 20 }, 2, { card: 1, state: 'down' });
    // Stock fitted: a 121-unit square (the card's own width) at x 0, y -27
    // (the band centred on the card), at k = 2: 10 + 0, 20 + -27*2, 242, 242.
    expect(imageAt(calls, artUrl('vgui/s_panel_manager_incap')!)!.a.slice(1)).toEqual([10, -34, 242, 242]);
    expect(srcs(calls)).not.toContain(artUrl('vgui/s_panel_manager'));
    expect(srcs(calls)).toContain(artUrl('vgui/healthbar_white'));      // tinted the incap red (X9; happy-dom has no tint canvas)
    expect(srcs(calls)).not.toContain(artUrl('vgui/healthbar_green'));
    const number = calls.find((c) => c.m === 'fillText' && c.a[0] === '299')!;
    expect(number.fill).toBe('rgba(161,25,25,1)');                      // client.dll's incapacitated health colour
  });

  it('Dead draws the dead art square, dims the name, and draws no bar, number, portrait or icons', () => {
    const d = fitted({ teamColumn: { HealthNumber: { on: true } } });
    const items = childRects(d, 'teamColumn', { x: 10, y: 20 }, 2).find((c) => c.name === 'Items')!;
    const { ctx, calls } = recCtx();
    drawPanel(ctx, d, 'teamColumn', { x: 10, y: 20 }, 2, { card: 1, state: 'dead' });
    expect(imageAt(calls, artUrl('vgui/s_panel_dead')!)!.a.slice(1)).toEqual([10, -34, 242, 242]);
    expect(srcs(calls).some((s) => /healthbar_(green|red|white|grey)|s_healthbar_outline/.test(s))).toBe(false);
    expect(srcs(calls)).not.toContain(artUrl('vgui/s_panel_manager'));
    expect(calls.some((c) => c.m === 'fillText' && (c.a[0] === '100' || c.a[0] === '299'))).toBe(false);
    expect(calls.find((c) => c.m === 'fillText' && c.a[0] === 'Louis')!.alpha).toBeCloseTo(0.5);
    expect(calls.some((c) => c.m === 'strokeRect' && c.a[0] === items.x)).toBe(false);
    expect(srcs(calls).some((u) => /icon-item-/.test(u))).toBe(false);
  });

  it('hides by state on the registered panels', () => {
    expect(hiddenInState('teamColumn', 'Head', 'down')).toBe(true);
    expect(hiddenInState('teamColumn', 'Incapacitated', 'down')).toBe(false);
    expect(hiddenInState('ownHealth', 'Incapacitated', 'down')).toBe(false);
    expect(hiddenInState('siHealth', 'Incapacitated', 'down')).toBe(true);
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
    // A bare north or south is centred across, as VGUI places the text.
    expect(itemRowStart(100, 50, s, 'north')).toBeCloseTo(100 + (50 - row) / 2);
    expect(itemRowStart(100, 50, s, 'south')).toBeCloseTo(100 + (50 - row) / 2);
    expect(itemRowStart(100, 50, s, 'south-east')).toBeCloseTo(150 - row);
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

describe('paintLinearOver', () => {
  it('blends the art over the scene in linear light off screen, then draws the result back through the clip', () => {
    // The scene: 2 x 1 at 47 grey. The art alone: skull grey 129 at 156 over the left pixel, nothing on the right.
    const drawn: unknown[][] = [];
    const main = {
      globalAlpha: 0.5, canvas: { width: 100, height: 100 },
      getImageData: (x: number, y: number, w: number, h: number) => {
        expect([x, y, w, h]).toEqual([10, 20, 2, 1]);
        return { data: new Uint8ClampedArray([47, 47, 47, 255, 47, 47, 47, 255]) };
      },
      putImageData: () => { throw new Error('putImageData ignores the clip; the result goes back through drawImage'); },
      save: () => {}, restore: () => {}, setTransform: (...a: unknown[]) => drawn.push(['setTransform', ...a]),
      drawImage: (...a: unknown[]) => drawn.push(['drawImage', ...a]),
    };
    let wrote: Uint8ClampedArray | undefined;
    const painted: unknown[] = [];
    const off = {
      globalAlpha: 1,
      translate: (x: number, y: number) => painted.push(['translate', x, y]),
      getImageData: () => ({ data: new Uint8ClampedArray([129, 129, 129, 156, 0, 0, 0, 0]) }),
      putImageData: (d: { data: Uint8ClampedArray }) => { wrote = d.data; },
    };
    const canvas = { width: 2, height: 1, getContext: () => off };
    _setCanvasFactory(() => canvas as unknown as HTMLCanvasElement);
    try {
      paintLinearOver(main as unknown as CanvasRenderingContext2D, { x: 10.4, y: 20.2, w: 1.2, h: 0.5 }, (c) => { painted.push(['paint', c === (off as unknown), c.globalAlpha]); }, () => { throw new Error('no fallback'); });
    } finally { _setCanvasFactory(null); }
    expect(painted).toEqual([['translate', -10, -20], ['paint', true, 0.5]]);
    expect([...wrote!]).toEqual([106, 106, 106, 255, 47, 47, 47, 255]);
    expect(drawn).toEqual([['setTransform', 1, 0, 0, 1, 0, 0], ['drawImage', canvas, 10, 20]]);
  });

  it('takes the fallback where pixels cannot be read', () => {
    const { ctx, calls } = recCtx();
    Object.assign(ctx, { canvas: () => undefined });
    let fell = false;
    paintLinearOver(ctx, { x: 0, y: 0, w: 5, h: 5 }, (c) => c.fillText('x', 0, 0), () => { fell = true; });
    expect(fell).toBe(true);
    expect(calls.some((c) => c.m === 'fillText')).toBe(false);
  });
});

describe('paintAdditive', () => {
  it('draws the glyphs alone off screen, then adds them onto the scene in linear light, in place', () => {
    // The scene: a 2 x 1 wall of (135, 126, 110). The glyphs, drawn alone:
    // grey 128 over the left pixel, nothing over the right one.
    const put: { data: Uint8ClampedArray; x: number; y: number }[] = [];
    const main = {
      font: '12px X', fillStyle: 'rgba(128,128,128,1)', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      getImageData: (x: number, y: number, w: number, h: number) => {
        expect([x, y, w, h]).toEqual([10, 20, 2, 1]);
        return { data: new Uint8ClampedArray([135, 126, 110, 255, 135, 126, 110, 255]) };
      },
      putImageData: (d: { data: Uint8ClampedArray }, x: number, y: number) => put.push({ data: d.data, x, y }),
      canvas: { width: 100, height: 100 },
    };
    const painted: unknown[] = [];
    const off = {
      font: '', fillStyle: '', textAlign: '', textBaseline: '', globalAlpha: 1,
      translate: (x: number, y: number) => painted.push(['translate', x, y]),
      getImageData: () => ({ data: new Uint8ClampedArray([128, 128, 128, 255, 0, 0, 0, 0]) }),
    };
    _setCanvasFactory((w, h) => ({ width: w, height: h, getContext: () => off }) as unknown as HTMLCanvasElement);
    try {
      paintAdditive(main as unknown as CanvasRenderingContext2D, { x: 10.4, y: 20.2, w: 1.2, h: 0.5 }, (c) => {
        painted.push(['paint', c === (off as unknown), c.font, c.fillStyle]);
      });
    } finally { _setCanvasFactory(null); }
    // The box is widened to whole pixels, the glyphs painted in the scene's coordinates with its font and colour.
    expect(painted).toEqual([['translate', -10, -20], ['paint', true, '12px X', 'rgba(128,128,128,1)']]);
    expect(put).toHaveLength(1);
    expect([put[0].x, put[0].y]).toEqual([10, 20]);
    expect([...put[0].data]).toEqual([180, 174, 164, 255, 135, 126, 110, 255]);
  });

  it('never reads pixels from a context without a canvas of known size, as the page tests stub one', () => {
    // Hud.test.tsx's stub answers every getImageData with one shared buffer;
    // adding onto it in place spoiled the crosshair texture the download packs.
    const { ctx, calls } = recCtx();
    const read = vi.fn(() => ({ data: new Uint8ClampedArray(4) }));
    Object.assign(ctx, { getImageData: read, canvas: () => undefined });
    paintAdditive(ctx, { x: 0, y: 0, w: 5, h: 5 }, (c) => c.fillText('8', 0, 0));
    expect(read).not.toHaveBeenCalled();
    expect(calls.find((c) => c.m === 'fillText')!.op).toBe('lighter');
  });

  it("falls back to the canvas's own 'lighter' sum where pixels cannot be read, and puts the composite back", () => {
    const { ctx, calls } = recCtx();
    paintAdditive(ctx, { x: 0, y: 0, w: 5, h: 5 }, (c) => c.fillText('8', 0, 0));
    expect(calls.find((c) => c.m === 'fillText')!.op).toBe('lighter');
    expect(ctx.globalCompositeOperation).toBe('source-over');
  });
});

describe('healthRgb', () => {
  it("is client.dll's table: green over half health, orange down to 15%, red at or under, red when down", () => {
    // Thresholds 0.5 and 0.15 (0x10516de4, 0x10516de8) on health / max
    // health clamped to 0..1; colours from the table at 0x10516dec.
    const green = [10, 177, 50], orange = [216, 146, 12], red = [161, 25, 25];
    expect(healthRgb(100, 100, false)).toEqual(green);
    expect(healthRgb(51, 100, false)).toEqual(green);
    expect(healthRgb(50, 100, false)).toEqual(orange);
    expect(healthRgb(16, 100, false)).toEqual(orange);
    expect(healthRgb(15, 100, false)).toEqual(red);
    expect(healthRgb(0, 100, false)).toEqual(red);
    expect(healthRgb(300, 100, false)).toEqual(green);
    expect(healthRgb(100, 100, true)).toEqual(red);
  });
});

describe("an imported HUD's own fonts", () => {
  const ID = '9'.repeat(64);
  afterEach(() => { unregisterImport(ID); _resetImportFaces(); });
  const ttf = new Uint8Array(readFileSync(join(__dirname, 'art/font-trade-gothic.ttf')));
  const scheme = (fontName: string) => baseFile('stock', 'resource/clientscheme.res')
    .replace(/CustomFontFiles\s*\{/, (m) => `${m}\r\n\t\t"9"\t\t"resource/MyHud.ttf"`)
    .replace(/(\n\tFonts\s*\{)/, (m) => `${m}\r\n\t\t"HudImpFont"\r\n\t\t{\r\n\t\t\t"1"\r\n\t\t\t{\r\n\t\t\t\t"name"\t\t"${fontName}"\r\n\t\t\t\t"tall"\t\t"30"\r\n\t\t\t\t"weight"\t"0"\r\n\t\t\t}\r\n\t\t}`);
  const design = (fontName: string, withFile = true) => {
    registerImport(ID, sampleHud({ 'resource/clientscheme.res': scheme(fontName), ...(withFile ? { 'resource/myhud.ttf': ttf } : {}) }));
    return validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'e' }, crosshair: 'none' });
  };

  it('draws a label in the face the upload carries, under its own name, sized by its VDMX', () => {
    const ctx = {} as CanvasRenderingContext2D;
    const cell = setFont(ctx, design('Trade Gothic'), 'HudImpFont', 1);
    expect(ctx.font).toMatch(/^400 25px "HudImp_9{12}_Trade_Gothic", /);
    expect(cell).toMatchObject({ em: 25, ascent: 24, cell: 30 });
  });

  it('falls back as today for a face the upload does not carry', () => {
    const ctx = {} as CanvasRenderingContext2D;
    setFont(ctx, design('Futurot', false), 'HudImpFont', 1);
    expect(ctx.font).not.toMatch(/HudImp_/);
  });

  it.each<[string, HostileFontKind]>([
    ['random bytes', 'garbage'],
    ['a real TTF cut off mid-file', 'truncated'],
    ['a name table offset that points past the end', 'nameOffset'],
    ['a VDMX group offset that points past the end', 'vdmxOffset'],
    ['a name table whose record count claims more room than it has', 'nameCount'],
    ['a VDMX table whose ratio count claims more room than it has', 'vdmxCount'],
  ])('never throws and falls back to the default face when the named font file is %s', (_label, kind) => {
    registerImport(ID, sampleHud({
      'resource/clientscheme.res': scheme('Trade Gothic'),
      'resource/myhud.ttf': hostileFont(kind, ttf),
    }));
    const d = validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'e' }, crosshair: 'none' });
    const ctx = {} as CanvasRenderingContext2D;
    expect(() => setFont(ctx, d, 'HudImpFont', 1)).not.toThrow();
    expect(ctx.font).not.toMatch(/HudImp_/);
  });
});

describe("an imported HUD's own textures", () => {
  const ID = '7'.repeat(64);
  const card = (image: string) => baseFile('stock', 'resource/ui/hud/teammatepanel.res').replace(/\}\s*$/,
    `\t"HudImpArt"\r\n\t{\r\n\t\t"ControlName" "ImagePanel"\r\n\t\t"fieldName" "HudImpArt"\r\n\t\t"xpos" "0"\r\n\t\t"ypos" "0"\r\n\t\t"wide" "20"\r\n\t\t"tall" "10"\r\n\t\t"visible" "1"\r\n\t\t"image" "${image}"\r\n\t\t"scaleImage" "1"\r\n\t}\r\n}\r\n`);
  afterEach(() => { unregisterImport(ID); _setCanvasFactory(null); _resetImportedArt(); _resetAssetCache(); });
  const design = (over: Record<string, string | Uint8Array>) => {
    registerImport(ID, sampleHud(over));
    return validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'e' }, crosshair: 'none' });
  };
  const drawnFrom = (calls: { m: string; a: unknown[] }[]) => calls.filter((c) => c.m === 'drawImage').map((c) => c.a[0] as { rec?: { pixels?: Uint8ClampedArray } });

  it('draws an ImagePanel that names a material the upload carries from that material, stretched to the panel', () => {
    const { factory, made } = fakeCanvas();
    _setCanvasFactory(factory);
    const d = design({ 'resource/ui/hud/teammatepanel.res': card('hud/myart') });
    const { ctx, calls } = recordingCtx();
    drawPanel(ctx, d, 'teamColumn', { x: 100, y: 50 }, 2);
    const own = calls.find((c) => c.m === 'drawImage' && (c.a[0] as { rec?: unknown }).rec);
    expect(own?.a.slice(1)).toEqual([100, 50, 40, 20]);
    expect(made[0]).toMatchObject({ w: 2, h: 2 });
    expect([...made[0].pixels!.subarray(0, 4)]).toEqual([255, 0, 0, 255]);        // the fixture's red texel, decoded from BGRA
    expect(drawnFrom(calls).some((s) => s.rec)).toBe(true);
  });

  it('draws it added onto the scene when its material says $additive 1', () => {
    _setCanvasFactory(fakeCanvas().factory);
    const vmt = '"UnlitGeneric"\r\n{\r\n\t"$baseTexture" "vgui/hud/myart"\r\n\t"$additive" "1"\r\n}\r\n';
    const d = design({ 'resource/ui/hud/teammatepanel.res': card('hud/myglow'), 'materials/vgui/hud/myglow.vmt': vmt });
    const { ctx, calls } = recordingCtx();
    drawPanel(ctx, d, 'teamColumn', { x: 0, y: 0 }, 1);
    const own = calls.find((c) => c.m === 'drawImage' && (c.a[0] as { rec?: unknown }).rec)!;
    expect(own.gco).toBe('lighter');
  });

  it('uses the stock art when the upload has no material by that name', () => {
    _setCanvasFactory(fakeCanvas().factory);
    const d = design({});
    const { ctx, calls } = recordingCtx();
    drawPanel(ctx, d, 'teamColumn', { x: 0, y: 0 }, 1);
    // A tint canvas (the bar's outline and fill, X9) is a scratch canvas too, but holds no decoded pixels.
    expect(drawnFrom(calls).some((s) => s.rec?.pixels)).toBe(false);
  });
});

describe('custom splatter', () => {
  const TEAM = { x: 0, y: 0 };
  const draws = (calls: ReturnType<typeof recCtx>['calls']) => calls.filter((c) => c.m === 'drawImage');

  it('draws a Fade from exactly the pixels the download ships, at the stand-in rect, at full strength', () => {
    const { factory, made } = fakeCanvas();
    _setCanvasFactory(factory);
    try {
      const d = design({ splatters: { splatTeam: { kind: 'fade', color: '200 0 0 255' } } });
      const stand = childRects(d, 'teamColumn', TEAM, 1).find((c) => c.name === 'HudEdSplatter')!;
      const { ctx, calls } = recCtx();
      drawPanel(ctx, d, 'teamColumn', TEAM, 1, { card: 0 });
      const fade = made.find((m) => m.w === 512 && m.h === 256)!;
      // Compared byte by byte by hand: toEqual on half a million bytes takes most of a second, and timed out under the full suite.
      const want = fadeTexture(512, 256, '200 0 0 255');
      expect(fade.pixels!.length).toBe(want.length);
      expect(fade.pixels!.every((v, i) => v === want[i])).toBe(true);
      const hit = draws(calls).find((c) => c.a[1] === stand.x && c.a[2] === stand.y && c.a[3] === stand.w && c.a[4] === stand.h)!;
      expect(hit.alpha).toBe(1);                                  // no SPLATTER_ALPHA: the stand-in is not code-managed
    } finally { _setCanvasFactory(null); }
  });

  it('draws nothing for the stock splatter underneath, now at alpha 0', () => {
    const d = design({ splatters: { splatTeam: { kind: 'fade' } } });
    const { ctx, calls } = recCtx();
    drawPanel(ctx, d, 'teamColumn', TEAM, 1, { card: 0 });
    expect(draws(calls).some((c) => (c.a[0] as HTMLImageElement).src === artUrl('vgui/hud/healthbar_bg_1'))).toBe(false);
  });

  it('draws an uploaded picture from the stored PNG, and the stock art when no picture is stored', () => {
    const png = 'iVBORw0KGgo=';
    const withPic = design({ splatters: { splatTeam: { kind: 'image' } }, images: { splatTeam: { w: 512, h: 256, png } } });
    const a = recCtx();
    drawPanel(a.ctx, withPic, 'teamColumn', TEAM, 1, { card: 0 });
    expect(draws(a.calls).some((c) => (c.a[0] as HTMLImageElement).src === `data:image/png;base64,${png}`)).toBe(true);
    const b = recCtx();
    drawPanel(b.ctx, design({ splatters: { splatTeam: { kind: 'image' } } }), 'teamColumn', TEAM, 1, { card: 0 });
    expect(draws(b.calls).find((c) => (c.a[0] as HTMLImageElement).src === artUrl('vgui/hud/healthbar_bg_1'))!.alpha).toBeCloseTo(0.35);
  });

  it("draws each card's own stock splatter, as client.dll picks healthbar_bg_N by slot", () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({}), 'teamColumn', TEAM, 1, { card: 1 });
    expect(draws(calls).some((c) => (c.a[0] as HTMLImageElement).src === artUrl('vgui/hud/healthbar_bg_2'))).toBe(true);
  });

  it('tints a scratch upload by health, and not with Keep my colours', () => {
    const scratch = recCtx();
    _setCanvasFactory((w, h) => ({ width: w, height: h, getContext: () => scratch.ctx }) as unknown as HTMLCanvasElement);
    try {
      const png = 'iVBORw0KGgo=';
      const img = { splatTop: { w: 256, h: 64, png } };
      drawPanel(recCtx().ctx, design({ splatters: { splatTop: { kind: 'image' } }, images: img }), 'ownHealth', TEAM, 1);
      const green = scratch.calls.filter((c) => c.m === 'fillRect' && c.op === 'multiply' && c.fill === 'rgb(10,177,50)').length;
      expect(green).toBe(4);                                      // the uploaded top, the stock bottom, the bar outline and fill: all health green
      scratch.calls.length = 0;
      _resetAssetCache(); _setImageFactory(instantImage);
      drawPanel(recCtx().ctx, design({ splatters: { splatTop: { kind: 'image', keepColours: true } }, images: img }), 'ownHealth', TEAM, 1);
      // Only HealthbarTextureBottom and the bar (stock, tinted) make a multiply now; the kept-colour top makes none.
      expect(scratch.calls.filter((c) => c.m === 'fillRect' && c.op === 'multiply')).toHaveLength(3);
    } finally { _setCanvasFactory(null); }
  });
});

describe('the preview state', () => {
  // The table the registry replaced, copied here so the change is provably the same picture.
  const OLD: Record<'healthy' | 'down' | 'dead', string[]> = {
    healthy: ['incapacitated', 'dead', 'voice'],
    down: ['head', 'dead', 'voice'],
    dead: ['head', 'incapacitated', 'voice', 'health', 'healthnumber', 'items'],
  };
  it('hides exactly what the old teammate table hid, in every state', () => {
    for (const state of ['healthy', 'down', 'dead'] as const) {
      for (const def of TEAM_PANEL.children) {
        expect(hiddenInState('teamColumn', def.name, state), `${state} ${def.name}`).toBe(OLD[state].includes(def.name.toLowerCase()));
      }
    }
  });
  it('takes a whole preview state as well as a survivor state', () => {
    expect(hiddenInState('teamColumn', 'Head', { ...DEFAULT_PREVIEW, survivor: 'down' })).toBe(true);
    expect(previewOf('dead')).toEqual({ ...DEFAULT_PREVIEW, survivor: 'dead' });
    expect(previewOf()).toEqual(DEFAULT_PREVIEW);
  });
  it('shows Hurt as Healthy shows it, piece for piece', () => {
    for (const def of TEAM_PANEL.children) expect(hiddenInState('teamColumn', def.name, 'hurt'), def.name).toBe(hiddenInState('teamColumn', def.name, 'healthy'));
  });
  it('keeps the old always-hidden list for panels the registry does not have yet', () => {
    for (const n of ['DuckingIcon', 'Incapacitated', 'SpawnTimeLabel', 'SkullIconPlacement']) expect(hiddenInState('siHealth', n, 'healthy'), n).toBe(true);
  });
  it('shows your own health pieces by the registry: crouch icon when crouched, down art when down', () => {
    expect(hiddenInState('ownHealth', 'DuckingIcon', 'healthy')).toBe(true);
    expect(hiddenInState('ownHealth', 'DuckingIcon', { ...DEFAULT_PREVIEW, crouched: true })).toBe(false);
    for (const s of ['healthy', 'hurt', 'dead'] as const) expect(hiddenInState('ownHealth', 'Incapacitated', s), s).toBe(true);
    expect(hiddenInState('ownHealth', 'Incapacitated', 'down')).toBe(false);
    // Q9 default: the portrait gives way to the down art, as on a teammate card.
    expect(hiddenInState('ownHealth', 'Head', 'down')).toBe(true);
    for (const s of ['healthy', 'hurt'] as const) {
      for (const n of ['Head', 'Health', 'HealthIcon', 'HealthNumber', 'HealthbarTextureTop', 'HealthbarTextureBottom']) {
        expect(hiddenInState('ownHealth', n, s), `${s} ${n}`).toBe(false);
      }
    }
  });
  it('leaves an unregistered piece of a registered panel alone (the card background, the splatter stand-in)', () => {
    expect(hiddenInState('teamColumn', 'HudEdCardBg', 'dead')).toBe(false);
  });
});

describe('your own health in every preview state', () => {
  const O = { x: 10, y: 20 };
  const srcOf = (c: { a: unknown[] }) => (c.a[0] as HTMLImageElement).src;
  const imageAt = (calls: { m: string; a: unknown[] }[], url: string) => calls.filter((c) => c.m === 'drawImage' && srcOf(c) === url);
  const bar = (d: HudDesign, k: number) => childRects(d, 'ownHealth', O, k).find((r) => r.name === 'Health')!;
  const hurt = { ...DEFAULT_PREVIEW, survivor: 'hurt' as const };
  afterEach(() => { _setProbe('Q1', null); _setProbe('Q3', null); _setCanvasFactory(null); });

  it('draws Hurt as 40 health: the number in orange on your panel and on a teammate card, the scratches tinted orange', () => {
    const own = recCtx();
    drawPanel(own.ctx, design({}), 'ownHealth', O, 1, { state: hurt });
    expect(own.calls.find((c) => c.m === 'fillText' && c.a[0] === '40')!.fill).toBe('rgba(216,146,12,1)');
    const team = recCtx();
    drawPanel(team.ctx, design({ children: { teamColumn: { HealthNumber: { on: true } } } }), 'teamColumn', O, 1, { card: 1, state: 'hurt' });
    expect(team.calls.find((c) => c.m === 'fillText' && c.a[0] === '40')!.fill).toBe('rgba(216,146,12,1)');
    const scratch = recCtx();
    _setCanvasFactory(() => ({ width: 1, height: 1, getContext: () => scratch.ctx }) as unknown as HTMLCanvasElement);
    drawPanel(recCtx().ctx, design({}), 'ownHealth', O, 1, { state: hurt });
    const multiplies = scratch.calls.filter((c) => c.m === 'fillRect' && c.op === 'multiply');
    expect(multiplies.length).toBeGreaterThanOrEqual(2);
    for (const m of multiplies) expect(m.fill).toBe('rgb(216,146,12)');
  });

  /**
   * The bar the game's way (slice 2.F Task X9). Each tinted texture is made
   * on a scratch canvas: this records every scratch canvas, which texture it
   * was made from and the multiply colour, so a draw of that canvas can be
   * read back as "texture X tinted Y at rect Z".
   */
  function tintRig() {
    const made = new Map<unknown, { src: string; fill: string }>();
    _setCanvasFactory(() => {
      const rec = recCtx();
      const c = { width: 1, height: 1, getContext: () => rec.ctx } as unknown as HTMLCanvasElement;
      const entry = { src: '', fill: '' };
      made.set(c, entry);
      const draw = rec.ctx.drawImage.bind(rec.ctx);
      const fillRect = rec.ctx.fillRect.bind(rec.ctx);
      (rec.ctx as unknown as { drawImage: (...a: unknown[]) => void }).drawImage = (...a: unknown[]) => {
        if (!entry.src) entry.src = srcOf({ a });
        (draw as (...x: unknown[]) => void)(...a);
      };
      (rec.ctx as unknown as { fillRect: (...a: unknown[]) => void }).fillRect = (...a: unknown[]) => {
        if (rec.ctx.globalCompositeOperation === 'multiply') entry.fill = String(rec.ctx.fillStyle);
        (fillRect as (...x: unknown[]) => void)(...a);
      };
      return c;
    });
    /** Every draw of `url`, tinted or not: [fill colour ('' untinted), x, y, w, h]. */
    const draws = (calls: { m: string; a: unknown[] }[], url: string) =>
      calls.filter((c) => c.m === 'drawImage').flatMap((c) => {
        const t = made.get(c.a[0]);
        if (t) return t.src === url ? [[t.fill, ...c.a.slice(1)]] : [];
        return srcOf(c) === url ? [['', ...c.a.slice(1)]] : [];
      });
    return { draws };
  }
  const OUTLINE = artUrl('vgui/hud/s_healthbar_outline')!;
  const WHITE = artUrl('vgui/healthbar_white')!;
  const GREY = artUrl('vgui/healthbar_grey')!;
  const GREEN = 'rgb(10,177,50)', ORANGE = 'rgb(216,146,12)', RED = 'rgb(161,25,25)';
  const cardBar = (d: HudDesign, k: number) => childRects(d, 'teamColumn', O, k).find((r) => r.name === 'Health')!;

  it('draws a healthy bar the game\'s way: tinted outline at the rect, tinted white fill inset 2 units, no empty part', () => {
    // /home/volence/l4d/hud/probe-phase2/b13/compare/stock-own.png and stock-card1.png: an outline frame,
    // the fill 4 px in at 1080p (2 units), shaded top to bottom. Sampled at x 1800 in
    // b13/b13-stock/survivor-full/full-1.png the fill runs 3,177,46 (top) to 1,125,30 (bottom);
    // healthbar_white (255 to 183) times healthRgb's 10,177,50 gives 10,177,50 to 7,127,36: within 7 per channel.
    const { draws } = tintRig();
    for (const [panel, r] of [['ownHealth', bar(design({}), 2)], ['teamColumn', cardBar(design({}), 2)]] as const) {
      const { ctx, calls } = recCtx();
      drawPanel(ctx, design({}), panel, O, 2, { card: panel === 'teamColumn' ? 1 : undefined });
      expect(draws(calls, OUTLINE), panel).toEqual([[GREEN, r.x, r.y, r.w, r.h]]);
      expect(draws(calls, WHITE), panel).toEqual([[GREEN, r.x + 4, r.y + 4, r.w - 8, r.h - 8]]);
      expect(draws(calls, GREY), panel).toEqual([]);
    }
  });

  it('draws a hurt bar 40 percent orange from the left and the empty rest in untinted healthbar_grey (probe S-hurt)', () => {
    // Deliberately rewritten from plumbing Task 15's "Hurt bar" test (X9).
    // /home/volence/l4d/hud/probe-phase2/b1v3/shots/crops/own-hurt.png: an orange outline, the orange shaded
    // fill (game 216,146,4 top to 155,102,2 bottom; predicted 216,146,12 to 153,104,9) and the rest a dark
    // shaded grey (44 to 38), the plain healthbar_grey (49 to 33).
    const { draws } = tintRig();
    for (const [panel, r] of [['ownHealth', bar(design({}), 2)], ['teamColumn', cardBar(design({}), 2)]] as const) {
      const { ctx, calls } = recCtx();
      drawPanel(ctx, design({}), panel, O, 2, { state: hurt, card: panel === 'teamColumn' ? 1 : undefined });
      const w = r.w - 8;
      expect(draws(calls, OUTLINE), panel).toEqual([[ORANGE, r.x, r.y, r.w, r.h]]);
      expect(draws(calls, WHITE), panel).toEqual([[ORANGE, r.x + 4, r.y + 4, w * 0.4, r.h - 8]]);
      expect(draws(calls, GREY), panel).toEqual([['', r.x + 4 + w * 0.4, r.y + 4, w * 0.6, r.h - 8]]);
    }
  });

  it('draws a down bar full in the incap colour', () => {
    const { draws } = tintRig();
    const r = bar(design({}), 1);
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({}), 'ownHealth', O, 1, { state: 'down' });
    expect(draws(calls, OUTLINE)).toEqual([[RED, r.x, r.y, r.w, r.h]]);
    expect(draws(calls, WHITE)).toEqual([[RED, r.x + 2, r.y + 2, r.w - 4, r.h - 4]]);
    expect(draws(calls, GREY)).toEqual([]);
  });

  it('draws a down bar at the down picture\'s x, where the game puts it (client.dll 1023f5df..1023f6da), y kept', () => {
    // Launch R, parity/x12-incap-own.png: once the down picture shows, the game moves Health to its x.
    const { draws } = tintRig();
    const d = design({ children: { ownHealth: { Incapacitated: { x: 4 } } } });
    const r = bar(d, 2);
    const pic = childRects(d, 'ownHealth', O, 2).find((c) => c.name === 'Incapacitated')!;
    const down = recCtx();
    drawPanel(down.ctx, d, 'ownHealth', O, 2, { state: 'down' });
    expect(draws(down.calls, OUTLINE)).toEqual([[RED, pic.x, r.y, r.w, r.h]]);
    const healthy = recCtx();
    drawPanel(healthy.ctx, d, 'ownHealth', O, 2);
    expect(draws(healthy.calls, OUTLINE)).toEqual([[GREEN, r.x, r.y, r.w, r.h]]);
  });

  it('insets by the file inset while gate Q3 is open, and by the stock 2 units while it is closed', () => {
    // Deliberately rewritten from plumbing Task 15's "Gated inset" test (X9): the outline is stock, drawn always.
    // /home/volence/l4d/hud/probe-phase2/b1v2 (inset 3): 6 px at 1080p.
    const { draws } = tintRig();
    const d = design({ children: { ownHealth: { Health: { keys: { inset: '3' } } } } });
    const r = bar(d, 2);
    _setProbe('Q3', true);
    const open = recCtx();
    drawPanel(open.ctx, d, 'ownHealth', O, 2);
    expect(draws(open.calls, OUTLINE)).toEqual([[GREEN, r.x, r.y, r.w, r.h]]);
    expect(draws(open.calls, WHITE)).toEqual([[GREEN, r.x + 6, r.y + 6, r.w - 12, r.h - 12]]);
    _setProbe('Q3', false);
    const closed = recCtx();
    drawPanel(closed.ctx, d, 'ownHealth', O, 2);
    expect(draws(closed.calls, OUTLINE)).toEqual([[GREEN, r.x, r.y, r.w, r.h]]);
    expect(draws(closed.calls, WHITE)).toEqual([[GREEN, r.x + 4, r.y + 4, r.w - 8, r.h - 8]]);
    // And a stored inset never reaches the tree while the gate is closed.
    const loaded = validateDesign(JSON.parse(JSON.stringify(d)));
    expect(loaded.children?.ownHealth?.Health?.keys?.inset).toBeUndefined();
  });

  it('never draws the flat healthbar_green, _orange or _red textures', () => {
    for (const state of ['healthy', 'hurt', 'down'] as const) {
      for (const panel of ['ownHealth', 'teamColumn'] as const) {
        const { ctx, calls } = recCtx();
        drawPanel(ctx, design({}), panel, O, 1, { state, card: panel === 'teamColumn' ? 1 : undefined });
        const srcs = calls.filter((c) => c.m === 'drawImage').map(srcOf);
        for (const art of ['vgui/healthbar_green', 'vgui/healthbar_orange', 'vgui/healthbar_red']) expect(srcs, `${state} ${panel}`).not.toContain(artUrl(art));
      }
    }
  });

  it('draws you down: your incap art, no portrait, 299 in the incap red', () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({}), 'ownHealth', O, 1, { state: 'down' });
    expect(imageAt(calls, artUrl('vgui/s_panel_namvet_incap')!)).toHaveLength(1);
    expect(imageAt(calls, artUrl('vgui/s_panel_namvet')!)).toHaveLength(0);
    expect(calls.find((c) => c.m === 'fillText' && c.a[0] === '299')!.fill).toBe('rgba(161,25,25,1)');
  });

  it('draws the crouch icon at its rect only while crouched', () => {
    const d = design({});
    const r = childRects(d, 'ownHealth', O, 1).find((c) => c.name === 'DuckingIcon')!;
    const up = recCtx();
    drawPanel(up.ctx, d, 'ownHealth', O, 1, { state: DEFAULT_PREVIEW });
    expect(imageAt(up.calls, artUrl('vgui/hud/crouch_survivor')!)).toHaveLength(0);
    const down = recCtx();
    drawPanel(down.ctx, d, 'ownHealth', O, 1, { state: { ...DEFAULT_PREVIEW, crouched: true } });
    const icon = imageAt(down.calls, artUrl('vgui/hud/crouch_survivor')!);
    expect(icon).toHaveLength(1);
    expect(icon[0].a[1]).toBe(r.x);
    expect(icon[0].a[2]).toBe(r.y);
  });

  it('tints the fill with monochrome_color while gate Q1 is open, and with the health colour while it is closed', () => {
    // Deliberately rewritten from plumbing Task 15's "Gated bar" test (X9): the fill is healthbar_white
    // tinted, inset 2 units, in either case. Probe Q1 (b1 own-a, own-c) showed the colour tints the shaded texture.
    const { draws } = tintRig();
    const d = design({ children: { ownHealth: { Health: { keys: { monochrome_color: '255 0 255 255' } } } } });
    const r = bar(d, 1);
    _setProbe('Q1', true);
    for (const [state, f] of [[DEFAULT_PREVIEW, 1], [hurt, 0.4]] as const) {
      const { ctx, calls } = recCtx();
      drawPanel(ctx, d, 'ownHealth', O, 1, { state });
      expect(draws(calls, WHITE)).toEqual([['rgb(255,0,255)', r.x + 2, r.y + 2, (r.w - 4) * f, r.h - 4]]);
    }
    _setProbe('Q1', false);
    const { ctx, calls } = recCtx();
    drawPanel(ctx, d, 'ownHealth', O, 1);
    expect(draws(calls, WHITE)).toEqual([[GREEN, r.x + 2, r.y + 2, r.w - 4, r.h - 4]]);
  });

  it('tints the crouch icon by its colour while crouched (probe Q8, slice 2.F G5)', () => {
    // /home/volence/l4d/hud/probe-phase2/b1v2/shots/crops/ownbig-b.png: the file's magenta drawColor held.
    const { draws } = tintRig();
    const d = validateDesign({ v: 1, children: { ownHealth: { DuckingIcon: { color: '255 0 255 255' } } } });
    const { ctx, calls } = recCtx();
    drawPanel(ctx, d, 'ownHealth', O, 1, { state: { ...DEFAULT_PREVIEW, crouched: true } });
    expect(draws(calls, artUrl('vgui/hud/crouch_survivor')!).map((c) => c[0])).toEqual(['rgb(255,0,255)']);
  });

  describe('the panel colour (probe Q1: monochrome_color recolours the whole panel)', () => {
    // /home/volence/l4d/hud/probe-phase2/RESULTS.md Q1: monochrome_color recolours the own bar fill, its
    // outline, the HealthNumber, the HealthIcon cross and the scratches, in every health state, tinting the
    // shaded texture; on teammate cards the bar and the number, down card included.
    // Shots: b1/shots/crops/own-a.png, own-c.png; b1v3/shots/crops/cards-hurt.png.
    const MAGENTA = 'rgb(255,0,255)';
    const TOP = artUrl('vgui/hud/detail_scratches_top_1')!;
    const BOTTOM = artUrl('vgui/hud/detail_scratches_bottom_1')!;
    const ownMono = design({ children: { ownHealth: { Health: { keys: { monochrome_color: '255 0 255 255' } } } } });
    const text = (calls: { m: string; a: unknown[]; fill: string }[], s: string) => calls.find((c) => c.m === 'fillText' && c.a[0] === s);

    it('draws the fill, outline, number, cross and both scratches in it, Healthy, Hurt and Down', () => {
      // Deliberately replaces plumbing Task 15's flat-fill Gated bar test (X10).
      const { draws } = tintRig();
      _setProbe('Q1', true);
      for (const [state, number] of [['healthy', '100'], ['hurt', '40'], ['down', '299']] as const) {
        const { ctx, calls } = recCtx();
        drawPanel(ctx, ownMono, 'ownHealth', O, 1, { state });
        for (const url of [OUTLINE, WHITE, TOP, BOTTOM]) {
          const got = draws(calls, url);
          expect(got.length, `${state} ${url}`).toBe(1);
          expect(got[0][0], `${state} ${url}`).toBe(MAGENTA);
        }
        expect(text(calls, number)!.fill, state).toBe('rgba(255,0,255,1)');   // the colour changes, the value does not
        expect(text(calls, ',')!.fill, state).toBe('rgba(255,0,255,1)');      // the cross is "," in the ToolBox face
      }
    });

    it('resolves a scheme colour name, as every other colour read does (review L2)', () => {
      // An imported file can say "Orange" (clientscheme.res: 255 176 0 255); parseColour alone read it as white.
      _setProbe('Q1', true);
      const named = design({ children: { ownHealth: { Health: { keys: { monochrome_color: 'Orange' } } } } });
      expect(panelColour(named, 'ownHealth')).toEqual([255, 176, 0]);
      expect(panelColour(ownMono, 'ownHealth')).toEqual([255, 0, 255]);
    });

    it('draws a teammate card\'s bar and number in it, the down card too, and leaves the name alone', () => {
      const { draws } = tintRig();
      _setProbe('Q1', true);
      const d = design({ children: { teamColumn: { HealthNumber: { on: true }, Health: { keys: { monochrome_color: '0 255 255 255' } } } } });
      const plain = recCtx();
      drawPanel(plain.ctx, design({}), 'teamColumn', O, 1, { card: 0 });
      for (const [state, number] of [['healthy', '100'], ['down', '299']] as const) {
        const { ctx, calls } = recCtx();
        drawPanel(ctx, d, 'teamColumn', O, 1, { card: 0, state });
        expect(draws(calls, OUTLINE).map((c) => c[0]), state).toEqual(['rgb(0,255,255)']);
        expect(draws(calls, WHITE).map((c) => c[0]), state).toEqual(['rgb(0,255,255)']);
        expect(text(calls, number)!.fill, state).toBe('rgba(0,255,255,1)');
        expect(text(calls, 'Francis')!.fill, state).toBe(text(plain.calls, 'Francis')!.fill);
      }
    });

    it('is dropped on load and not drawn while gate Q1 is closed', () => {
      const { draws } = tintRig();
      _setProbe('Q1', false);
      expect(validateDesign(JSON.parse(JSON.stringify(ownMono))).children?.ownHealth?.Health?.keys?.monochrome_color).toBeUndefined();
      const { ctx, calls } = recCtx();
      drawPanel(ctx, ownMono, 'ownHealth', O, 1, { state: hurt });
      expect(draws(calls, WHITE)[0][0]).toBe(ORANGE);
      expect(text(calls, '40')!.fill).toBe('rgba(216,146,12,1)');
    });

    describe('Q4: a file drawColor on the top scratch changes nothing', () => {
      // /home/volence/l4d/hud/probe-phase2/b1v2/shots/crops/ownbig-a.png, ownbig-c.png: the file's
      // drawColor on HealthbarTextureTop is ignored; code tints it by health, or by the panel colour.
      const ID = 'a'.repeat(64);
      afterEach(() => { unregisterImport(ID); _resetImportedArt(); });
      const withTint = (children?: HudDesign['children']) => {
        const own = baseFile('stock', 'resource/ui/hud/localplayerpanel.res')
          .replace(/("HealthbarTextureTop"\s*\{)/, '$1\r\n\t\t"drawColor"\t"255 255 0 255"');
        registerImport(ID, sampleHud({ 'resource/ui/hud/localplayerpanel.res': own }));
        return validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'q4' }, crosshair: 'none', children });
      };
      it('tints it by health without a panel colour, and by the panel colour with one', () => {
        const { draws } = tintRig();
        _setProbe('Q1', true);
        const a = recCtx();
        drawPanel(a.ctx, withTint(), 'ownHealth', O, 1);
        expect(draws(a.calls, TOP).map((c) => c[0])).toEqual([GREEN]);
        const b = recCtx();
        drawPanel(b.ctx, withTint({ ownHealth: { Health: { keys: { monochrome_color: '255 0 255 255' } } } }), 'ownHealth', O, 1);
        expect(draws(b.calls, TOP).map((c) => c[0])).toEqual([MAGENTA]);
      });
    });
  });
});

describe('Down and Dead cards over a custom splatter (slice 2.F X13)', () => {
  // /home/volence/l4d/hud/test-splatter-2026-09-24/runs/A/crop-dead-incap-game-vs-preview.png, pixel table
  // from /home/volence/l4d/hud/probe-2f/x13_table.py: on the dead card the cyan stripe is 0,168,168 in game
  // (hurt-settled.png at 130,1000; 235,1020; 130,1040) and 0,99,99 in the preview (A-image-preview-dead.png),
  // magenta 168,0,168 against 99,0,99. s_panel_dead's dark part is black at alpha 156 (the VTF and the
  // exported PNG agree texel for texel), which blended in gamma space gives 255 * (1 - 156/255) = 99, the
  // preview; blended in linear light, (0.388)^(1/2.2) * 255 = 166, the game (168).
  const png = 'iVBORw0KGgo=';
  const d = design({ elements: { teamColumn: { fit: true } }, splatters: { splatTeam: { kind: 'image' } }, images: { splatTeam: { w: 512, h: 256, png } } });
  const O = { x: 10, y: 20 };
  const PIC = `data:image/png;base64,${png}`;

  it('draws the splatter stand-in in Down and Dead at the same rect and alpha as Healthy, as the game does', () => {
    const at = (state: SurvivorState) => {
      const { ctx, calls } = recCtx();
      drawPanel(ctx, d, 'teamColumn', O, 2, { card: 0, state });
      return calls.filter((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === PIC).map((c) => [...c.a.slice(1), c.alpha]);
    };
    const healthy = at('healthy');
    expect(healthy).toHaveLength(1);
    expect(at('down')).toEqual(healthy);
    expect(at('dead')).toEqual(healthy);
  });

  it('maps an alpha so that a gamma-space blend of black lands where the game\'s linear-light blend does', () => {
    // The dead art's texel: black at 156 over the 255 stripe channel lands on 166, within 10 of the game's 168.
    const a = linearOverAlpha(156);
    expect(Math.round(255 * (1 - a / 255))).toBeGreaterThanOrEqual(158);
    expect(Math.round(255 * (1 - a / 255))).toBeLessThanOrEqual(178);
    expect(linearOverAlpha(0)).toBe(0);
    expect(linearOverAlpha(255)).toBe(255);
  });

  it('draws the dead art through a copy whose alpha is remapped that way, where pixels can be read', () => {
    // A scratch canvas that keeps pixels: the remap reads the art, rewrites each alpha, and draws the copy.
    const pixels = new Uint8ClampedArray([0, 0, 0, 156, 0, 0, 0, 0, 200, 200, 200, 255, 0, 0, 0, 80]);
    const made: { data?: Uint8ClampedArray }[] = [];
    _setCanvasFactory((w, h) => {
      const rec: { data?: Uint8ClampedArray } = {};
      made.push(rec);
      const ctx = {
        drawImage: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray(pixels), width: w, height: h }),
        putImageData: (img: { data: Uint8ClampedArray }) => { rec.data = img.data; },
      };
      return { width: w, height: h, getContext: () => ctx, rec } as unknown as HTMLCanvasElement;
    });
    try {
      const { ctx, calls } = recCtx();
      drawPanel(ctx, d, 'teamColumn', O, 2, { card: 0, state: 'dead' });
      const dead = childRects(d, 'teamColumn', O, 2).find((r) => r.name === 'Dead')!;
      const hit = calls.find((c) => c.m === 'drawImage' && c.a[1] === dead.x && c.a[2] === dead.y && c.a[3] === dead.w)!;
      const copy = (hit.a[0] as { rec?: { data?: Uint8ClampedArray } }).rec?.data;
      expect(copy).toBeDefined();
      expect([copy![3], copy![7], copy![11], copy![15]]).toEqual([linearOverAlpha(156), 0, 255, linearOverAlpha(80)]);
      expect([...copy!.slice(8, 11)]).toEqual([200, 200, 200]);            // colour untouched
    } finally { _setCanvasFactory(null); }
  });

  it('falls back to the art itself where pixels cannot be read', () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, d, 'teamColumn', O, 2, { card: 0, state: 'dead' });
    expect(calls.some((c) => c.m === 'drawImage' && (c.a[0] as HTMLImageElement).src === artUrl('vgui/s_panel_dead'))).toBe(true);
  });
});

describe('what a typed key control shows (review M2: the value the preview draws)', () => {
  const health = TEAM_PANEL.children.find((c) => c.name === 'Health')!;
  const inset = health.keys!.find((k) => k.key === 'inset')!;
  const mono = health.keys!.find((k) => k.key === 'monochrome_color')!;
  it('shows the stock inset of 2 when neither the design nor the file sets one, as drawBar draws it', () => {
    expect(shownKey(DEFAULT_DESIGN, inset, undefined)).toBe('2');
    expect(shownKey(DEFAULT_DESIGN, inset, '1')).toBe('1');
  });
  it('shows no colour for an unset Panel colour: the game colours the panel by health', () => {
    expect(shownKey(DEFAULT_DESIGN, mono, undefined)).toBeUndefined();
    expect(shownKey(DEFAULT_DESIGN, mono, '10 20 30 255')).toBe('10 20 30 255');
  });
  it('resolves a scheme colour name, as the preview does', () => {
    // clientscheme.res: "Orange" "255 176 0 255".
    expect(shownKey(DEFAULT_DESIGN, mono, 'Orange')).toBe('255 176 0 255');
  });
});
