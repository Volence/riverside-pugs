import { describe, it, expect, afterEach } from 'vitest';
import { buildHud } from './build';
import { drawHud } from './mock';
import { DEFAULT_DESIGN, validateDesign, type HudDesign } from './design';
import { parseKv, kvFind, kvGet, pcApplies, type KvNode } from './kv';
import { baseFile } from './base';
import { PROBES, _setProbe } from './probes';
import { canvasFont } from './fonts';

/**
 * The chat's text size (plan task C1). Probe answers,
 * /home/volence/l4d/hud/probe-phase2-rest/RESULTS.md:
 * - C1: HudChatHistory's `font` key is ignored (r1/shots/crops/chat-h.png),
 *   but ChatFont itself in chatscheme.res sets the size
 *   (r4/shots/crops/chat-d.png), so the size is written into ChatFont.
 * - C2 (gate): the open chat's box colour was never seen.
 */
const CHATSCHEME = 'resource/chatscheme.res';
const BASECHAT = 'resource/ui/basechat.res';
const text = (files: { path: string; data: Uint8Array }[], path: string) => {
  const f = files.find((x) => x.path === path);
  return f ? new TextDecoder('latin1').decode(f.data) : undefined;
};
const tree = (files: { path: string; data: Uint8Array }[], path: string, preset: 'stock' | 'modern' = 'stock') =>
  parseKv(text(files, path) ?? baseFile(preset, path))[0].value as KvNode[];
/** Each size range's tall as the PC reads it, and the console's where the range has one. */
function talls(nodes: KvNode[]): { pc: string[]; x360: string[] } {
  const font = kvFind(nodes, ['Fonts', 'ChatFont'])!;
  const pc: string[] = [], x360: string[] = [];
  for (const range of font.value as KvNode[]) {
    for (const n of range.value as KvNode[]) {
      if (n.key.toLowerCase() !== 'tall') continue;
      if (pcApplies(n.cond)) pc.push(n.value as string); else if (/X360/.test(n.cond ?? '')) x360.push(n.value as string);
    }
  }
  return { pc, x360 };
}

afterEach(() => { _setProbe('C2', null); });

describe('the chat text size (plan task C1)', () => {
  it('keeps a size on the chat, clamped like every text size', () => {
    expect(validateDesign({ v: 1, elements: { chat: { fontSize: 24 } } }).elements.chat).toEqual({ fontSize: 24 });
    expect(validateDesign({ v: 1, elements: { chat: { fontSize: 200 } } }).elements.chat).toEqual({ fontSize: 64 });
  });

  it('writes every size range of ChatFont, scaled from the 480-line range (stock 12 at 480 to 599)', () => {
    const d = validateDesign({ v: 1, elements: { chat: { fontSize: 24 } } });
    const t = talls(tree(buildHud(d), CHATSCHEME));
    // Stock 12, 14, 14, 20, 24 times 24 / 12; the console's own lines stay as they were.
    expect(t.pc).toEqual(['24', '28', '28', '40', '48']);
    expect(t.x360).toEqual(['14', '18']);
  });

  it('scales Modern\'s own ranges the same way', () => {
    const d = validateDesign({ v: 1, preset: 'modern', elements: { chat: { fontSize: 22 } } });
    // Modern 11, 13, 14, 17, 20 times 22 / 11.
    expect(talls(tree(buildHud(d, { fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } }), CHATSCHEME, 'modern')).pc)
      .toEqual(['22', '26', '28', '34', '40']);
  });

  it('never points HudChatHistory at another font (the game ignores its font key)', () => {
    const files = buildHud(validateDesign({ v: 1, elements: { chat: { fontSize: 24 } } }));
    expect(text(files, BASECHAT)).toBeUndefined();
    expect(kvFind(tree(files, CHATSCHEME), ['Fonts'])!.value as KvNode[]).toHaveLength(
      (kvFind(parseKv(baseFile('stock', CHATSCHEME))[0].value as KvNode[], ['Fonts'])!.value as KvNode[]).length);
  });

  it('ships no chat scheme for a chat that only moved', () => {
    expect(text(buildHud(validateDesign({ v: 1, elements: { chat: { x: 30 } } })), CHATSCHEME)).toBeUndefined();
  });

  it('draws the preview\'s chat lines at the size (1080 lines: the 1024 to 1199 range)', () => {
    const d = validateDesign({ v: 1, elements: { chat: { fontSize: 24 } } });
    const fonts: string[] = [];
    const t: Record<string | symbol, unknown> = {
      fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1, lineWidth: 1,
      canvas: { width: 1920, height: 1080, getContext: () => null },
      measureText: (s: string) => ({ width: s.length * 10 }),
    };
    for (const m of ['clearRect', 'fillRect', 'strokeRect', 'drawImage', 'putImageData', 'beginPath', 'rect', 'clip', 'arc', 'stroke',
      'fill', 'save', 'restore', 'setLineDash', 'moveTo', 'lineTo', 'closePath', 'roundRect']) t[m] = () => {};
    t.fillText = (s: string) => { if (s === 'Zoey : ') fonts.push(String(t.font)); };
    drawHud(t as unknown as CanvasRenderingContext2D, 1920, 1080, d, 'survivor', null);
    expect(fonts[0]).toBe(canvasFont('Tahoma', 700, 40));
  });
});

describe('the open chat\'s box colour, behind gate C2', () => {
  it('is closed, and a stored colour is dropped and never written', () => {
    expect(PROBES.C2.passed).toBe(false);
    expect(validateDesign({ v: 1, elements: { chat: { bg: '0 0 160 160' } } }).elements.chat).toBeUndefined();
    const plain: HudDesign = { ...structuredClone(DEFAULT_DESIGN), elements: { chat: { bg: '0 0 160 160' } } };
    expect(text(buildHud(plain), BASECHAT)).toBeUndefined();
  });

  it('with C2 open, writes basechat.res HudChat bgcolor_override', () => {
    _setProbe('C2', true);
    const d = validateDesign({ v: 1, elements: { chat: { bg: '0 0 160 160' } } });
    expect(d.elements.chat?.bg).toBe('0 0 160 160');
    const chat = kvFind(tree(buildHud(d), BASECHAT), ['HudChat'])!;
    expect(kvGet(chat, 'bgcolor_override')).toBe('0 0 160 160');
  });
});
