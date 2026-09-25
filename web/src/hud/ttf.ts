/**
 * Just enough of a TrueType file to size text the way the game does, at
 * runtime, for a font an imported HUD carries.
 *
 * The stock faces' numbers are baked into art/index.ts by
 * scripts/export-hud-art.py (font_metrics, font_names, decode_vfont); this
 * is the same reading in TypeScript, so a player's own face goes through
 * fonts.ts's fontCell exactly as Trade Gothic does: head's unitsPerEm,
 * OS/2's usWinAscent and usWinDescent (hhea's ascender and descender when a
 * font has no OS/2), OS/2's weight class, the VDMX rows of its 1:1 ratio
 * group, and the Windows family (name id 1) and full (id 4) names, which
 * are the names GDI matches a scheme's "name" against. ttf.test.ts holds it
 * to the baked numbers.
 */
export interface FaceMetrics { unitsPerEm: number; winAscent: number; winDescent: number; vdmx?: number[] }
export interface FontInfo { names: string[]; weight: number; metrics: FaceMetrics }

const MAGIC = [0x56, 0x46, 0x4f, 0x4e, 0x54, 0x31];            // "VFONT1"
const bad = (): never => { throw new Error('not a TrueType font'); };
const isSfnt = (b: Uint8Array) => b.length >= 12 && (
  (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0)
  || String.fromCharCode(b[0], b[1], b[2], b[3]) === 'OTTO' || String.fromCharCode(b[0], b[1], b[2], b[3]) === 'true');

export function isVfont(b: Uint8Array): boolean {
  return b.length > 7 && MAGIC.every((c, i) => b[b.length - 6 + i] === c);
}

/**
 * A .vfont is a TrueType file with every byte XORed against a running key,
 * then a salt, the salt's length and "VFONT1" appended. The key starts at
 * 167 folded with all but the last salt byte (the length itself), and after
 * each byte becomes that encoded byte plus 167: export-hud-art.py's
 * decode_vfont, the public reading of the format (ValveResourceFormat's
 * ValveFont.cs).
 */
export function decodeVfont(data: Uint8Array): Uint8Array {
  if (!isVfont(data)) throw new Error('not a VFONT1 file');
  const saltLen = data[data.length - 7];
  const end = data.length - 6 - saltLen;
  if (end < 12) bad();
  let key = 167;
  for (const b of data.subarray(end, end + saltLen - 1)) key ^= (b + 167) & 0xff;
  const out = new Uint8Array(end);
  for (let i = 0; i < end; i++) { out[i] = data[i] ^ key; key = (data[i] + 167) & 0xff; }
  if (!isSfnt(out)) bad();
  return out;
}

/**
 * A VDMX table's rows for its 1:1 ratio group, bounded to the table's own
 * extent (o..o+len) the way the table-directory loop bounds every table
 * against the buffer. ratios, group and each row count are font-controlled,
 * so each is checked against that extent before it is used to compute the
 * next offset; anything that would read past the table returns undefined
 * (no VDMX row, the fontCell caller's winAscent + winDescent fallback)
 * rather than throwing or reading another table's bytes.
 */
function vdmxRows(dv: DataView, o: number, len: number): number[] | undefined {
  const end = o + len;
  if (o + 6 > end) return undefined;
  const ratios = dv.getUint16(o + 4);
  const ratiosEnd = o + 6 + 4 * ratios;
  const offsetsEnd = ratiosEnd + 2 * ratios;
  if (offsetsEnd > end) return undefined;                     // ratio records or their offset array run past the table
  for (let i = 0; i < ratios; i++) {
    const r = o + 6 + 4 * i;
    const x = dv.getUint8(r + 1), y0 = dv.getUint8(r + 2), y1 = dv.getUint8(r + 3);
    if ((x === 0 && y0 === 0 && y1 === 0) || (x === 1 && y0 <= 1 && 1 <= y1)) {
      const group = o + dv.getUint16(ratiosEnd + 2 * i);
      if (group < o || group + 4 > end) return undefined;      // group header runs outside the table
      const n = dv.getUint16(group);
      const rowsEnd = group + 4 + 6 * n;
      if (rowsEnd > end) return undefined;                     // rows run past the table
      const rows: number[] = [];
      for (let j = 0; j < n; j++) { const e = group + 4 + 6 * j; rows.push(dv.getUint16(e), dv.getInt16(e + 2), dv.getInt16(e + 4)); }
      return rows;
    }
  }
  return undefined;
}

/**
 * A name table's Windows family (1) and full (4) names, bounded to the
 * table's own extent the same way: count and every record's own (len, at)
 * pair are font-controlled, so a record or a string that would run past the
 * table is skipped rather than read out of it (skipping the rest of that
 * platform/id pass, since the record array itself is then out of bounds).
 */
function names(ttf: Uint8Array, dv: DataView, t: { off: number; len: number } | undefined): string[] {
  if (!t) return [];
  const end = t.off + t.len;
  if (t.off + 6 > end) return [];
  const count = dv.getUint16(t.off + 2), strings = t.off + dv.getUint16(t.off + 4);
  const out: string[] = [];
  for (const want of [1, 4]) {
    for (let i = 0; i < count; i++) {
      const r = t.off + 6 + 12 * i;
      if (r + 12 > end) break;                          // the record array itself runs past the table
      if (dv.getUint16(r) !== 3 || dv.getUint16(r + 6) !== want) continue;
      const len = dv.getUint16(r + 8), at = strings + dv.getUint16(r + 10);
      if (at < t.off || at + len > end) continue;        // this record's string runs outside the table
      let s = '';
      for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode((ttf[at + k] << 8) | ttf[at + k + 1]);
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

export function readFont(ttf: Uint8Array): FontInfo {
  if (!isSfnt(ttf)) bad();
  const dv = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  const tables = new Map<string, { off: number; len: number }>();
  const count = dv.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + 16 * i;
    if (at + 16 > ttf.length) bad();
    const off = dv.getUint32(at + 8), len = dv.getUint32(at + 12);
    if (off + len > ttf.length) bad();
    tables.set(String.fromCharCode(...ttf.subarray(at, at + 4)), { off, len });
  }
  const head = tables.get('head') ?? bad();
  const os2 = tables.get('OS/2'), hhea = tables.get('hhea');
  let winAscent: number, winDescent: number, weight = 400;
  if (os2 && os2.len >= 78) {
    weight = dv.getUint16(os2.off + 4);
    winAscent = dv.getUint16(os2.off + 74);
    winDescent = dv.getUint16(os2.off + 76);
  } else if (hhea) {
    winAscent = dv.getInt16(hhea.off + 4);
    winDescent = -dv.getInt16(hhea.off + 6);
  } else return bad();
  const metrics: FaceMetrics = { unitsPerEm: dv.getUint16(head.off + 18), winAscent, winDescent };
  const vdmx = tables.get('VDMX');
  const rows = vdmx ? vdmxRows(dv, vdmx.off, vdmx.len) : undefined;
  if (rows) metrics.vdmx = rows;
  return { names: names(ttf, dv, tables.get('name')), weight, metrics };
}
