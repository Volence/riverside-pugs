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

/**
 * Assembles a minimal but structurally valid sfnt: the 12-byte header, a
 * table directory entry per table (offset and length computed from where
 * each table's bytes land) and the table bytes themselves, in the order
 * given. Lets a test hand ttf.ts's readFont a font whose 'name' or 'VDMX'
 * table is real but hostile, without needing a real TrueType file.
 */
export function buildSfnt(tables: Record<string, Uint8Array>): Uint8Array {
  const entries = Object.entries(tables);
  const dirSize = 12 + 16 * entries.length;
  let at = dirSize;
  const offsets = entries.map(([, data]) => { const o = at; at += data.length; return o; });
  const out = new Uint8Array(at);
  const dv = new DataView(out.buffer);
  out[0] = 0; out[1] = 1; out[2] = 0; out[3] = 0;              // sfnt version 1.0: isSfnt's TrueType marker
  dv.setUint16(4, entries.length);
  entries.forEach(([tag, data], i) => {
    const dirAt = 12 + 16 * i;
    out.set(latin1(tag.padEnd(4).slice(0, 4)), dirAt);
    dv.setUint32(dirAt + 8, offsets[i]);
    dv.setUint32(dirAt + 12, data.length);
    out.set(data, offsets[i]);
  });
  return out;
}

/** A minimal head table: only the unitsPerEm field readFont reads (offset 18). */
export function headTable(unitsPerEm = 2048): Uint8Array {
  const t = new Uint8Array(20);
  new DataView(t.buffer).setUint16(18, unitsPerEm);
  return t;
}

/** A minimal hhea table: readFont's ascender/descender fallback for a font with no OS/2. */
export function hheaTable(ascent = 800, descent = -200): Uint8Array {
  const t = new Uint8Array(8);
  const dv = new DataView(t.buffer);
  dv.setInt16(4, ascent); dv.setInt16(6, descent);
  return t;
}

/**
 * Six ways an imported HUD's named font file can be broken: plain garbage, a
 * real TTF cut short, a 'name' or 'VDMX' table whose own offset points past
 * itself, and a 'name' or 'VDMX' table whose record count claims more room
 * than the table holds. ttf.test.ts holds readFont to never reading past a
 * table for each of these; fonts.ts/render.ts tests only need the upload
 * path to never throw and to fall back to the default face.
 */
export type HostileFontKind = 'garbage' | 'truncated' | 'nameOffset' | 'vdmxOffset' | 'nameCount' | 'vdmxCount';

export function hostileFont(kind: HostileFontKind, realTtf: Uint8Array): Uint8Array {
  switch (kind) {
    case 'garbage': return Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff);
    case 'truncated': return realTtf.slice(0, Math.floor(realTtf.length / 2));
    case 'nameOffset': {
      // format 0, count 1, storageOffset 18 (right after the one record), then a
      // platform-3 name-id-1 record whose (offset, length) point 1000 bytes past
      // the table's own end (18 bytes total).
      const name = new Uint8Array([0, 0, 0, 1, 0, 18, 0, 3, 0, 1, 4, 9, 0, 1, 0, 10, 3, 232]);
      return buildSfnt({ head: headTable(), hhea: hheaTable(), name });
    }
    case 'vdmxOffset': {
      // version 0, numRecs 1, numRatios 1, one 1:1 ratio record (x=1, 0<=1<=2),
      // then a group offset of 9999: past the table's own end (12 bytes total).
      const vdmx = new Uint8Array([0, 0, 0, 1, 0, 1, 0, 1, 0, 2, 39, 15]);
      return buildSfnt({ head: headTable(), hhea: hheaTable(), VDMX: vdmx });
    }
    case 'nameCount': {
      // format 0, count 65535, storageOffset 6: no room in the table for any record.
      const name = new Uint8Array([0, 0, 0xff, 0xff, 0, 6]);
      return buildSfnt({ head: headTable(), hhea: hheaTable(), name });
    }
    case 'vdmxCount': {
      // version 0, numRecs 1, numRatios 65535: no room in the table for a single ratio record.
      const vdmx = new Uint8Array([0, 0, 0, 1, 0xff, 0xff]);
      return buildSfnt({ head: headTable(), hhea: hheaTable(), VDMX: vdmx });
    }
  }
}

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

/**
 * happy-dom has no 2D context. A canvas factory whose canvases take
 * putImageData and keep the pixels, so a test can see which decoded texture
 * a drawImage call was handed.
 */
export function fakeCanvas() {
  const made: { w: number; h: number; pixels?: Uint8ClampedArray }[] = [];
  const factory = (w: number, h: number) => {
    const rec: { w: number; h: number; pixels?: Uint8ClampedArray } = { w, h };
    made.push(rec);
    const ctx = {
      createImageData: (cw: number, ch: number) => ({ data: new Uint8ClampedArray(cw * ch * 4) }),
      putImageData: (img: { data: Uint8ClampedArray }) => { rec.pixels = img.data; },
      drawImage: () => {}, fillRect: () => {}, globalCompositeOperation: 'source-over', fillStyle: '',
    };
    return { width: w, height: h, getContext: () => ctx, rec } as unknown as HTMLCanvasElement;
  };
  return { factory, made };
}
