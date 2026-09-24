import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { buildHud, buildTrees, elementRect } from './build';
import { drawHud } from './mock';
import { DEFAULT_DESIGN, validateDesign, validKeys, type HudDesign } from './design';
import { elementById } from './elements';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { baseFile } from './base';
import { PROBES, _setProbe } from './probes';
import { _setImageFactory, _resetAssetCache } from './render';
import { decodeVTF } from '../vpk/read';

/**
 * The kill / incap notices (plan tasks K1, K2). Probe answers,
 * /home/volence/l4d/hud/probe-phase2-rest/RESULTS.md:
 * - K1: label_textalign east on HudPZDamageRecord puts the notice at the
 *   panel's right edge (r1/shots/crops/notices-ijkl.png).
 * - K2: only recordlabel0 is ever used, and its fgcolor_override is
 *   honoured (same crop); the colour goes on all five rows (decision 2).
 * - K2' (gate K5): row 0's font was never seen, since R4's notice never fired.
 */
const PZ = 'resource/ui/hud/pzdamagerecordpanel.res';
const LAYOUT = 'scripts/hudlayout.res';
const ROWS = [0, 1, 2, 3, 4].map((i) => `recordlabel${i}`);
const text = (files: { path: string; data: Uint8Array }[], path: string) => {
  const f = files.find((x) => x.path === path);
  return f ? new TextDecoder('latin1').decode(f.data) : undefined;
};
const tree = (files: { path: string; data: Uint8Array }[], path: string) =>
  parseKv(text(files, path) ?? baseFile('stock', path))[0].value as KvNode[];
const plain = (p: Partial<HudDesign> = {}): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), elements: {}, ...p });

afterEach(() => { _setProbe('K5', null); });

describe('kill notice alignment and colour (plan task K1)', () => {
  it('offers label_textalign as a choice of three, ungated', () => {
    const el = elementById('killNotices')!;
    const k = el.keys?.find((x) => x.key === 'label_textalign');
    expect(k).toMatchObject({ type: 'enum', label: 'Alignment' });
    expect(k!.options!.map((o) => o.value)).toEqual(['west', 'center', 'east']);
    expect(k!.gate).toBeUndefined();
  });

  it('keeps a known alignment and drops anything else', () => {
    const defs = elementById('killNotices')!.keys;
    expect(validKeys(defs, { label_textalign: 'east' })).toEqual({ label_textalign: 'east' });
    expect(validKeys(defs, { label_textalign: 'EAST' })).toEqual({ label_textalign: 'east' });
    expect(validKeys(defs, { label_textalign: 'north' })).toBeUndefined();
    expect(validKeys(defs, { label_textalign: 3 })).toBeUndefined();
  });

  it('writes the alignment on HudPZDamageRecord over the stock west', () => {
    const d = validateDesign({ v: 1, elements: { killNotices: { keys: { label_textalign: 'east' } } } });
    const files = buildHud(d);
    const block = kvFind(tree(files, LAYOUT), ['HudPZDamageRecord'])!;
    expect(kvGet(block, 'label_textalign')).toBe('east');
    // One line at the block's own level, the split-screen sub-blocks' left alone.
    expect((block.value as KvNode[]).filter((n) => n.key === 'label_textalign')).toHaveLength(1);
  });

  it('writes one colour as fgcolor_override on all five rows (decision 2)', () => {
    const d = validateDesign({ v: 1, elements: { killNotices: { color: '0 255 255 255' } } });
    const nodes = tree(buildHud(d), PZ);
    for (const row of ROWS) expect(kvGet(kvFind(nodes, [row])!, 'fgcolor_override'), row).toBe('0 255 255 255');
  });

  it('ships no notice file while the notices keep the game colour', () => {
    expect(text(buildHud(plain({ elements: { killNotices: { x: 40 } } })), PZ)).toBeUndefined();
  });

  it('holds the text size behind gate K5, closed: dropped on load, never written', () => {
    expect(PROBES.K5.passed).toBe(false);
    const d = validateDesign({ v: 1, elements: { killNotices: { fontSize: 20 } } });
    expect(d.elements.killNotices?.fontSize).toBeUndefined();
    // A design that slipped one past validation still builds nothing for it.
    expect(text(buildHud(plain({ elements: { killNotices: { fontSize: 20 } } })), PZ)).toBeUndefined();
  });

  it('with K5 open, points every row at a HudEd_ copy of its font at the size', () => {
    _setProbe('K5', true);
    const d = validateDesign({ v: 1, elements: { killNotices: { fontSize: 20 } } });
    expect(d.elements.killNotices?.fontSize).toBe(20);
    const files = buildHud(d);
    const nodes = tree(files, PZ);
    for (const row of ROWS) expect(kvGet(kvFind(nodes, [row])!, 'font'), row).toBe('HudEd_Default_t20');
    const copy = kvFind(tree(files, 'resource/clientscheme.res'), ['Fonts', 'HudEd_Default_t20', '1'])!;
    expect(kvGet(copy, 'tall')).toBe('20');
  });
});

describe('the kill notice preview follows the edits', () => {
  beforeEach(() => { _resetAssetCache(); });
  /** Every fillText at 1920 x 1080, with the fill and alignment current at the time. */
  function calls(design: HudDesign) {
    _setImageFactory((url) => ({ src: url, complete: true, naturalWidth: 128, naturalHeight: 128, onload: null, onerror: null }) as unknown as HTMLImageElement);
    const out: { m: string; a: unknown[]; fill: string; align: string }[] = [];
    const t: Record<string | symbol, unknown> = {
      fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1, lineWidth: 1,
      canvas: { width: 1920, height: 1080, getContext: () => null },
      measureText: (s: string) => ({ width: s.length * 10 }),
    };
    for (const m of ['clearRect', 'fillRect', 'strokeRect', 'fillText', 'drawImage', 'putImageData', 'beginPath', 'rect', 'clip', 'arc', 'stroke',
      'fill', 'save', 'restore', 'setLineDash', 'moveTo', 'lineTo', 'closePath', 'roundRect']) t[m] = () => {};
    const ctx = new Proxy(t, {
      get: (o, k) => (typeof o[k] === 'function'
        ? (...a: unknown[]) => { out.push({ m: String(k), a, fill: String(o.fillStyle), align: String(o.textAlign) }); return (o[k] as (...x: unknown[]) => unknown)(...a); }
        : o[k]),
      set: (o, k, v) => { o[k] = v; return true; },
    }) as unknown as CanvasRenderingContext2D;
    drawHud(ctx, 1920, 1080, design, 'survivor', null);
    _setImageFactory(null);
    return out;
  }

  it('draws the sample notice right-aligned at the panel\'s right edge in the colour (r1 notices-ijkl.png)', () => {
    const d = validateDesign({ v: 1, elements: { killNotices: { color: '0 255 255 255', keys: { label_textalign: 'east' } } } });
    const t = calls(d).find((c) => c.m === 'fillText' && c.a[0] === 'Hunter incapacitated Francis')!;
    expect(t.align).toBe('right');
    expect(t.fill).toBe('rgba(0,255,255,1)');
    const r = elementRect(d, 'killNotices', d.aspect);
    const row = kvFind(buildTrees(d)(PZ), ['recordlabel0'])!;
    const xpos = parseFloat(kvGet(row, 'xpos')!);
    expect(t.a[1] as number).toBeCloseTo((r.x + xpos + (r.w - 40)) * 2.25, 6);   // wide f40
  });
});

describe('the kill notice box (plan task K2)', () => {
  const BOX = 'materials/vgui/hud/hudeditor/noticebg.vtf';
  it('keeps a flat box with its colour or none, on the kill notices only', () => {
    const d = validateDesign({ v: 1, elements: {
      killNotices: { noticeBox: { kind: 'flat', color: '0 0 255 200' } },
      chat: { noticeBox: { kind: 'none' } },
    } });
    expect(d.elements.killNotices?.noticeBox).toEqual({ kind: 'flat', color: '0 0 255 200' });
    expect(d.elements.chat).toBeUndefined();
    expect(validateDesign({ v: 1, elements: { killNotices: { noticeBox: { kind: 'none', color: '1 2 3 4' } } } }).elements.killNotices?.noticeBox).toEqual({ kind: 'none' });
    expect(validateDesign({ v: 1, elements: { killNotices: { noticeBox: { kind: 'image' } } } }).elements.killNotices).toBeUndefined();
  });

  it('points label4background at a generated flat texture in the colour (r1 K4: its image is honoured)', () => {
    const files = buildHud(validateDesign({ v: 1, elements: { killNotices: { noticeBox: { kind: 'flat', color: '0 0 255 200' } } } }));
    const bg = kvFind(tree(files, PZ), ['label4background'])!;
    expect(kvGet(bg, 'image')).toBe('../vgui/hud/hudeditor/noticebg');
    const vtf = decodeVTF(files.find((f) => f.path === BOX)!.data);
    expect([vtf.w, vtf.h]).toEqual([32, 32]);
    expect([...vtf.rgba.slice(0, 4)]).toEqual([0, 0, 255, 200]);
    expect(text(files, 'materials/vgui/hud/hudeditor/noticebg.vmt')).toContain('$basetexture "vgui/hud/hudeditor/noticebg"');
  });

  it('gives None a clear texture, since code shows and places the box itself', () => {
    const files = buildHud(validateDesign({ v: 1, elements: { killNotices: { noticeBox: { kind: 'none' } } } }));
    expect(kvGet(kvFind(tree(files, PZ), ['label4background'])!, 'image')).toBe('../vgui/hud/hudeditor/noticebg');
    const vtf = decodeVTF(files.find((f) => f.path === BOX)!.data);
    expect(vtf.rgba.every((v, i) => i % 4 !== 3 || v === 0)).toBe(true);
  });

  it('a flat box with no colour of its own is the default dark box', () => {
    const files = buildHud(validateDesign({ v: 1, elements: { killNotices: { noticeBox: { kind: 'flat' } } } }));
    expect([...decodeVTF(files.find((f) => f.path === BOX)!.data).rgba.slice(0, 4)]).toEqual([0, 0, 0, 160]);
  });
});

describe('the kill notice box in the preview', () => {
  beforeEach(() => { _resetAssetCache(); });
  function calls(design: HudDesign) {
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
    drawHud(ctx, 1920, 1080, design, 'survivor', null);
    _setImageFactory(null);
    return out;
  }
  const NOTICE = 'Hunter incapacitated Francis';

  it('fills the box behind row 0 in the flat colour, where the stock art would be', () => {
    const d = validateDesign({ v: 1, elements: { killNotices: { noticeBox: { kind: 'flat', color: '0 0 255 200' } } } });
    const all = calls(d);
    const fill = all.find((c) => c.m === 'fillRect' && c.fill === `rgba(0,0,255,${200 / 255})`);
    expect(fill).toBeDefined();
    // The same rect the stock nine-slice takes: 11 units either side of the text, the file's 25 tall centred on the 15-unit row.
    const [x, y, w, h] = fill!.a as number[];
    expect(x).toBeCloseTo(45 - 11 * 2.25, 6);
    expect(w).toBeCloseTo(NOTICE.length * 10 + 22 * 2.25, 6);
    expect(y).toBeCloseTo((170 - 5) * 2.25, 6);
    expect(h).toBeCloseTo(25 * 2.25, 6);
    const txt = all.find((c) => c.m === 'fillText' && c.a[0] === NOTICE)!;
    expect(all.indexOf(fill!)).toBeLessThan(all.indexOf(txt));
    expect(all.some((c) => c.m === 'drawImage' && String((c.a[0] as HTMLImageElement).src).includes('outlinegrey'))).toBe(false);
  });

  it('draws no box at all for None', () => {
    const d = validateDesign({ v: 1, elements: { killNotices: { noticeBox: { kind: 'none' } } } });
    const all = calls(d);
    expect(all.some((c) => c.m === 'drawImage' && String((c.a[0] as HTMLImageElement).src).includes('outlinegrey'))).toBe(false);
    const r = elementRect(d, 'killNotices', d.aspect);
    // No fill inside the notice panel (the only fills there would be the box).
    expect(all.filter((c) => c.m === 'fillRect' && (c.a[1] as number) >= r.y * 2.25 && (c.a[1] as number) < (r.y + r.h) * 2.25
      && (c.a[0] as number) < (r.x + r.w) * 2.25)).toEqual([]);
    expect(all.some((c) => c.m === 'fillText' && c.a[0] === NOTICE)).toBe(true);
  });
});
