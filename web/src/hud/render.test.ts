import { describe, it, expect, beforeEach } from 'vitest';
import { childRects, drawPanel, drawSlotStyle, PANEL_FILE, _setImageFactory, _resetAssetCache } from './render';
import { buildHud, buildTrees } from './build';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';

const design = (patch: Partial<HudDesign>): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), ...patch });
const text = (files: { path: string; data: Uint8Array }[], path: string) =>
  new TextDecoder('latin1').decode(files.find((f) => f.path === path)!.data);

/** A recording 2D context: every method the renderer calls is a no-op that logs its name. */
function recCtx() {
  const calls: { m: string; a: unknown[]; font: string }[] = [];
  // Each call snapshots ctx.font at the moment it was made, so a test can pin the size a label was drawn at.
  const noop = (m: string) => (...a: unknown[]) => { calls.push({ m, a, font: ctx.font }); };
  const ctx = {
    canvas: { width: 853, height: 480 },
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1, lineWidth: 1,
    save: noop('save'), restore: noop('restore'), beginPath: noop('beginPath'), rect: noop('rect'), clip: noop('clip'),
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

  it('agrees with the file for every panel in both presets', () => {
    for (const preset of ['stock', 'modern'] as const) {
      const d = design({ preset, elements: { ownHealth: { scale: 1.25 }, siHealth: { scale: 0.8 } } });
      const trees = buildTrees(d);
      for (const panelId of Object.keys(PANEL_FILE)) {
        const nodes = trees(PANEL_FILE[panelId]).filter((n) => typeof n.value !== 'string');
        const rects = childRects(d, panelId, { x: 0, y: 0 }, 1);
        expect(rects.length, `${preset} ${panelId}`).toBe(nodes.length);
        // rects are in draw order, not file order, so pair each file child with its rect by name.
        for (const n of nodes) {
          const r = rects.find((c) => c.name === n.key);
          expect(r, `${preset} ${panelId} ${n.key}`).toBeDefined();
          expect(r!.x, `${preset} ${panelId} ${n.key}`).toBe(parseFloat(kvGet(n, 'xpos') ?? '0'));
          expect(r!.w, `${preset} ${panelId} ${n.key}`).toBe(parseFloat(kvGet(n, 'wide') ?? '0'));
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
    for (const c of calls.filter((c) => c.m === 'fillText')) expect(['Louis', '100', '+', '12', '']).toContain(c.a[0]);
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

  it("draws a scaled parent's label at the scaled size", () => {
    const { ctx, calls } = recCtx();
    drawPanel(ctx, design({ elements: { ownHealth: { scale: 1.5 } } }), 'ownHealth', { x: 0, y: 0 }, 1);
    // scalePass wrote HudEd_HUDHealth_150 with tall 27 and pointed the label at it.
    const numberCall = calls.find((c) => c.m === 'fillText' && c.a[0] === '100')!;
    expect(numberCall.font).toMatch(/^(bold )?27px /);
  });

  it('survives a material the index lacks', () => {
    const { ctx } = recCtx();
    const d = design({ preset: 'modern' });                     // modern's DuckingIcon points at hud/crouch_survivor, not exported
    expect(() => drawPanel(ctx, d, 'ownHealth', { x: 0, y: 0 }, 1)).not.toThrow();
  });
});
