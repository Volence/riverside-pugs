/**
 * Tests only: a small hand-made HUD, built from the stock files the way a
 * HUD author builds one. hudlayout.res gains a comment and an extra panel
 * (so a rewrite through writeKv would change its bytes), the teammate card
 * is stock with a comment, mod_textures.txt gains one entry, and there is a
 * texture with its material, a panel file the editor does not model and a
 * sound. `over` replaces a file, adds one, or (null) removes one.
 */
import { baseFile } from './base';
import { parseKv, writeKv, type KvNode } from './kv';

export const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
export const MARKER_PANEL = 'HudImpMarker';

const vtf2x2 = (): Uint8Array => {
  // encodeVTF's own layout, inlined so this file needs nothing from ../vpk: 80-byte 7.2 header, BGRA8888.
  const out = new Uint8Array(80 + 16);
  const dv = new DataView(out.buffer);
  out.set([0x56, 0x54, 0x46, 0x00]);
  dv.setUint32(4, 7, true); dv.setUint32(8, 2, true); dv.setUint32(12, 80, true);
  dv.setUint16(16, 2, true); dv.setUint16(18, 2, true); dv.setUint16(24, 1, true);
  dv.setUint32(52, 12, true); out[56] = 1; dv.setUint32(57, 0xffffffff, true); dv.setUint16(63, 1, true);
  out.set([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 128], 80);   // BGRA: red, green, blue, half-clear white
  return out;
};

export function sampleHud(over: Record<string, string | Uint8Array | null> = {}): Map<string, Uint8Array> {
  const layout = baseFile('stock', 'scripts/hudlayout.res')
    .replace(/\}\s*$/, `\t"${MARKER_PANEL}"\r\n\t{\r\n\t\t"fieldName" "${MARKER_PANEL}"\r\n\t\t"xpos" "5"\r\n\t}\r\n}\r\n`);
  const modtex = baseFile('stock', 'scripts/mod_textures.txt')
    .replace(/TextureData\s*\{/, (m) => `${m}\r\n\t\t"hudimp_extra"\r\n\t\t{\r\n\t\t\t"file"\t\t"vgui/hud/myart"\r\n\t\t\t"x" "0" "y" "0" "width" "2" "height" "2"\r\n\t\t}`);
  const files: Record<string, string | Uint8Array> = {
    'scripts/hudlayout.res': `// edgehud\r\n${layout}`,
    'resource/ui/hud/teammatepanel.res': `// edgehud card\r\n${baseFile('stock', 'resource/ui/hud/teammatepanel.res')}`,
    'scripts/mod_textures.txt': modtex,
    'materials/vgui/hud/myart.vtf': vtf2x2(),
    'materials/vgui/hud/myart.vmt': '"UnlitGeneric"\r\n{\r\n\t"$baseTexture" "vgui/hud/myart"\r\n\t"$translucent" 1\r\n\t"$vertexcolor" 1\r\n}\r\n',
    'resource/ui/edgepanel.res': '"x" { "y" "1" }',
    'sound/ui/edge.wav': new Uint8Array([82, 73, 70, 70, 1, 2, 3]),
  };
  for (const [path, v] of Object.entries(over)) { if (v === null) delete files[path]; else files[path] = v; }
  return new Map(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? latin1(v) : v]));
}

export const asList = (files: Map<string, Uint8Array>) => [...files].map(([path, data]) => ({ path, data }));

/** A .res file's text without one top-level block of its root: a HUD that lacks or renamed a panel. */
export function dropBlock(text: string, name: string): string {
  const t = parseKv(text);
  t[0].value = (t[0].value as KvNode[]).filter((n) => n.key.toLowerCase() !== name.toLowerCase());
  return writeKv(t);
}

/**
 * A canvas context that records every method call with the font and
 * composite operation current at the time. `canvas` has no size, so
 * render.ts's paintAdditive takes its 'lighter' fallback.
 */
export function recordingCtx() {
  const calls: { m: string; a: unknown[]; font: string; gco: string }[] = [];
  const state: Record<string, unknown> = {
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
    globalCompositeOperation: 'source-over', lineWidth: 1, canvas: {},
  };
  const ctx = new Proxy(state, {
    get: (t, k) => (typeof k === 'string' && k in t ? t[k] : (...a: unknown[]) => {
      calls.push({ m: String(k), a, font: String(t.font), gco: String(t.globalCompositeOperation) });
      return k === 'measureText' ? { width: 10 } : undefined;
    }),
    set: (t, k, v) => { t[k as string] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}
