# HUD Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/hud` page on riversidepug.com where a player drags Left 4 Dead HUD elements around a canvas and downloads the result as a working VPK.

**Architecture:** Everything runs in the browser. Real stock and Modern HUD `.res` files ship as text assets; a KeyValues parser loads them, a generator changes only the values the player's design overrides, and the existing VPK writer packs the result. One element registry drives the canvas, the side panel and the generator.

**Tech Stack:** TypeScript, Preact, preact-iso, Vite, vitest (happy-dom project `web`), canvas 2D. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-hud-editor-design.md`. Read it first; this plan argues from it.

## Global Constraints

- Work only in the worktree `/home/volence/l4d/pug/.claude/worktrees/hud-editor` (branch `worktree-hud-editor`). Never touch the main checkout or `master`. Nothing is deployed.
- All commands run from the worktree root. Tests: `npx vitest run --project web <path>`. Types: `npm run typecheck`.
- No server code, no database, no new npm dependencies.
- VPK output is **version 1** only. L4D1 rejects v2.
- No build ever emits `materials/vgui/hud/altcrosshair.vtf` or `.vmt`.
- In normal mode no file under `materials/` may use a name that exists in the game's `pak01`. Every texture goes under `materials/vgui/hud/hudeditor/`. All paths inside a VPK are lower case.
- Colours are always written raw, `"255 255 255 255"`. Never a scheme colour name.
- Never use em dashes anywhere: code, comments, UI copy, commit messages.
- Match the surrounding code: explanatory block comments that say why, as in `web/src/crosshair/vpk.ts`.
- HUD units: 480 tall; width `Math.round(480 * ratio)`, so 853 at 16:9, 768 at 16:10, 640 at 4:3.
- Source HUD files live outside the repo at `/home/volence/l4d/hud/stock` and `/home/volence/l4d/hud/src`. They are CRLF ASCII.
- Commit after every task with a plain-English message. Do not push.

## File Structure

```
web/src/vpk/index.ts            crc32, encodeVTF, encodeVPK, VpkFile (moved), re-exports encodeZip
web/src/vpk/zip.ts              store-only zip writer
web/src/vpk/vpk.test.ts         moved encoder tests
web/src/vpk/zip.test.ts
web/src/crosshair/vpk.ts        keeps buildVPK only, imports from ../vpk
web/src/hud/kv.ts               KeyValues parse / write / find / get / set
web/src/hud/units.ts            aspect, anchors, token scaling
web/src/hud/base/index.ts       baseFile(preset, path), BASE_PATHS
web/src/hud/base/stock/**       39 stock files, copied verbatim
web/src/hud/base/modern/**      the Modern HUD's overridden text files
web/src/hud/base/fonts/*.ttf    Roboto Condensed Regular + Bold
web/src/hud/design.ts           HudDesign, defaults, validate, storage, share link
web/src/hud/elements.ts         the element registry (data only)
web/src/hud/slots.ts            style slots: which .res image keys and stock names a style feeds
web/src/hud/textures.ts         pure pixel generators -> RGBA
web/src/hud/build.ts            buildHud(design, assets) -> VpkFile[]; packHud -> bytes + filename
web/src/hud/mock.ts             canvas mock of each element
web/src/hud/*.test.ts           one test file per module above
web/src/routes/Hud.tsx          the page
web/src/styles/app.css          `.hud__*` rules appended
web/src/main.tsx                lazy /hud route
web/src/components/Nav.tsx      nav entry
scripts/check-hud-vpk.sh        builds a sample VPK and reads it back with the Python vpk reader
```

---

### Task 0: Phase 0 in-game test VPK (gate)

This task produces a throwaway addon and a question for the owner. It blocks only Task 9's mode decisions; Tasks 1 to 8 can proceed while waiting.

**Files:**
- Create: `/home/volence/l4d/hud/tools/phase0/build_phase0.py` (outside the repo, throwaway)
- Output: `/home/volence/l4d/hud/tools/phase0/hudeditor_phase0.vpk`

**Interfaces:**
- Produces: five yes/no answers, recorded in the spec under "Phase 0 results".

- [ ] **Step 1: Write the builder**

```python
#!/usr/bin/env python3
"""Throwaway: five loud HUD changes in one addon VPK, one per open question in the spec."""
import io, os, re, shutil, tempfile, vpk
from PIL import Image
from srctools.vtf import VTF, ImageFormats, VTFFlags

HUD = os.path.expanduser('~/l4d/hud')
STOCK = os.path.join(HUD, 'stock')
OUT = os.path.join(HUD, 'tools/phase0/hudeditor_phase0.vpk')
VMT = 'UnlitGeneric\n{\n\t$basetexture "%s"\n\t$translucent 1\n\t$vertexcolor 1\n\t$vertexalpha 1\n\t$ignorez 1\n\t$nomip 1\n}\n'

def read(rel): return open(os.path.join(STOCK, rel), encoding='latin-1', newline='').read()

def tex(root, name, rgba, size=(32, 32)):
    v = VTF(size[0], size[1], fmt=ImageFormats.BGRA8888)
    v.flags = VTFFlags.CLAMP_S | VTFFlags.CLAMP_T | VTFFlags.NO_MIP | VTFFlags.NO_LOD | VTFFlags.A_EIGHTBIT
    v.get().copy_from(Image.new('RGBA', size, rgba).tobytes(), ImageFormats.RGBA8888)
    p = os.path.join(root, 'materials', name + '.vtf')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'wb') as f: v.save(f)
    open(p[:-4] + '.vmt', 'w').write(VMT % name)

def put(root, rel, text):
    p = os.path.join(root, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w', encoding='latin-1', newline='').write(text)

root = tempfile.mkdtemp()
# 1. panel internals: health number pushed to the panel's top-left, huge
lp = read('resource/ui/hud/localplayerpanel.res')
lp = re.sub(r'("fieldName"\s+"Health"\s.*?"xpos"\s+")[^"]*(")', r'\g<1>0\2', lp, count=1, flags=re.S)
put(root, 'resource/ui/hud/localplayerpanel.res', lp)
# 2. scheme + bundled ttf: every Trade Gothic face becomes Roboto Condensed
cs = read('resource/clientscheme.res').replace('Trade Gothic Bold', 'Roboto Condensed').replace('Trade Gothic', 'Roboto Condensed')
cs = cs.replace('"5"\t\t"resource/HALFLIFE2.vfont"', '"5"\t\t"resource/HALFLIFE2.vfont"\r\n\t\t"7"\t\t"resource/RobotoCondensed-Regular.ttf"\r\n\t\t"8"\t\t"resource/RobotoCondensed-Bold.ttf"')
put(root, 'resource/clientscheme.res', cs)
for f in ('RobotoCondensed-Regular.ttf', 'RobotoCondensed-Bold.ttf'):
    shutil.copy(os.path.join(HUD, 'src/resource', f), os.path.join(root, 'resource', f))
# 3. a .res image pointed at a new texture: teammate panel backgrounds go magenta
td = read('resource/ui/hud/teamdisplayhud.res').replace('../vgui/s_panel_background', 'hud/hudeditor/phase0_bg')
put(root, 'resource/ui/hud/teamdisplayhud.res', td)
tex(root, 'vgui/hud/hudeditor/phase0_bg', (255, 0, 255, 200))
# 4. xHair element, no texture shipped
hl = open(os.path.expanduser('~/l4d/pug/web/src/crosshair/hudlayout.res'), encoding='latin-1', newline='').read()
put(root, 'scripts/hudlayout.res', hl)
# 5. mod_textures.txt: weapon boxes pointed at new cyan textures
mt_path = os.path.expanduser('~/.steam/steam/steamapps/common/left 4 dead/left4dead/scripts/mod_textures.txt')
mt = open(mt_path, encoding='latin-1', newline='').read()
mt = mt.replace('vgui/hud/scalablepanel_bgmidgrey_glow', 'vgui/hud/hudeditor/phase0_box').replace('vgui/hud/ScalablePanel_bgMidGrey_glow', 'vgui/hud/hudeditor/phase0_box')
put(root, 'scripts/mod_textures.txt', mt)
tex(root, 'vgui/hud/hudeditor/phase0_box', (0, 255, 255, 220))
put(root, 'addoninfo.txt', '"AddonInfo"\n{\n\taddonSteamAppID\t\t500\n\taddontitle\t\t"HUD editor phase 0"\n\taddonversion\t\t1.0\n}\n')

pak = vpk.new(root); pak.version = 1; pak.save(OUT)
for n in sorted(vpk.open(OUT)): print('  ', n)
```

- [ ] **Step 2: Build it**

Run: `/home/volence/l4d/hud/.venv/bin/python /home/volence/l4d/hud/tools/phase0/build_phase0.py`
Expected: a listing of 12 paths, including `scripts/mod_textures.txt` and two `hudeditor/phase0_*.vtf`. If `mod_textures.txt` is missing from the game folder the script raises; then print `grep -il scalablepanel` over the game's `scripts/` folder, find the file that names the weapon box texture, and use that instead. If step 1's regex changed nothing (compare `lp` before and after), open the stock file, find the label that shows `%HealthNumber%`, and target its real `fieldName`.

- [ ] **Step 3: Hand to the owner. STOP here for this task.**

Give the owner these instructions in the final message of the turn, not between tool calls:

1. Close the game. In `left4dead/gameinfo.txt` comment out the `Game modernhud` line.
2. Copy `hudeditor_phase0.vpk` into `left4dead/addons/`. Move the two crosshair VPKs out of `addons/` for now.
3. Start a single player campaign, pick up a second weapon, and take one screenshot with teammates visible.
4. Report: (1) did the health number move, (2) did the text font change, (3) are teammate panel backgrounds magenta, (4) what is drawn at screen centre: nothing, the stock crosshair only, or a pink and black square, (5) is the active weapon box cyan.
5. Undo: delete the VPK, put the crosshair VPKs back, uncomment `Game modernhud`.

- [ ] **Step 4: Record the answers**

Append a "Phase 0 results" section to the spec with the five answers and the date, and commit it. Task 9 reads that section.

---

### Task 1: Shared encoders and a zip writer

**Files:**
- Create: `web/src/vpk/index.ts`, `web/src/vpk/zip.ts`, `web/src/vpk/zip.test.ts`
- Move: `web/src/crosshair/vpk.test.ts` encoder tests to `web/src/vpk/vpk.test.ts` (keep the `buildVPK` tests where they are)
- Modify: `web/src/crosshair/vpk.ts`

**Interfaces:**
- Produces: `crc32(bytes: Uint8Array): number`, `encodeVTF(width, height, rgba: Uint8ClampedArray): Uint8Array`, `encodeVPK(files: VpkFile[]): Uint8Array<ArrayBuffer>`, `interface VpkFile { path: string; data: Uint8Array }`, `encodeZip(files: VpkFile[]): Uint8Array<ArrayBuffer>`, all exported from `web/src/vpk/index.ts`.

- [ ] **Step 1: Move the encoders.** Cut `CRC_TABLE`, `crc32`, `encodeVTF`, `VpkFile` and `encodeVPK` (with their comments) from `web/src/crosshair/vpk.ts` into `web/src/vpk/index.ts`. In `crosshair/vpk.ts` keep the file header comment, `VMT`, `addonInfo`, `buildVPK`, and add:

```ts
import { encodeVPK, encodeVTF } from '../vpk';
export { crc32, encodeVTF, encodeVPK, type VpkFile } from '../vpk';
const enc = new TextEncoder();
```

The re-export keeps every existing import of `../crosshair/vpk` working.

- [ ] **Step 2: Move the tests.** Move the `crc32`, `encodeVTF` and `encodeVPK` describe blocks into `web/src/vpk/vpk.test.ts` importing from `'./index'`. Leave the `buildVPK` block in `crosshair/vpk.test.ts`.

Run: `npx vitest run --project web web/src/vpk web/src/crosshair`
Expected: PASS, same test count as before the move.

- [ ] **Step 3: Write the failing zip test** in `web/src/vpk/zip.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { crc32 } from './index';
import { encodeZip } from './zip';

const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);
const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint16(o, true);
const enc = new TextEncoder();

describe('encodeZip', () => {
  const a = enc.encode('hello');
  const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  const zip = encodeZip([{ path: 'riversidehud/pak01_dir.vpk', data: b }, { path: 'README.txt', data: a }]);

  it('starts with a local file header and stores data uncompressed', () => {
    expect(u32(zip, 0)).toBe(0x04034b50);
    expect(u16(zip, 8)).toBe(0);                       // method: store
    expect(u32(zip, 14)).toBe(crc32(b));
    expect(u32(zip, 18)).toBe(b.length);               // compressed size
    expect(u32(zip, 22)).toBe(b.length);               // uncompressed size
    const nameLen = u16(zip, 26);
    expect(new TextDecoder().decode(zip.slice(30, 30 + nameLen))).toBe('riversidehud/pak01_dir.vpk');
    expect([...zip.slice(30 + nameLen, 30 + nameLen + b.length)]).toEqual([...b]);
  });

  it('ends with an end-of-central-directory record counting both entries', () => {
    const eocd = zip.length - 22;
    expect(u32(zip, eocd)).toBe(0x06054b50);
    expect(u16(zip, eocd + 8)).toBe(2);
    expect(u16(zip, eocd + 10)).toBe(2);
    const cdOffset = u32(zip, eocd + 16);
    expect(u32(zip, cdOffset)).toBe(0x02014b50);
  });

  it('records each local header offset in the central directory', () => {
    const eocd = zip.length - 22;
    let o = u32(zip, eocd + 16);
    const offsets: number[] = [];
    for (let i = 0; i < 2; i++) {
      offsets.push(u32(zip, o + 42));
      o += 46 + u16(zip, o + 28) + u16(zip, o + 30) + u16(zip, o + 32);
    }
    expect(offsets[0]).toBe(0);
    expect(u32(zip, offsets[1])).toBe(0x04034b50);
  });
});
```

Run: `npx vitest run --project web web/src/vpk/zip.test.ts`. Expected: FAIL, cannot resolve `./zip`.

- [ ] **Step 4: Implement `web/src/vpk/zip.ts`**

```ts
/**
 * A store-only zip writer.
 *
 * The advanced HUD download is a folder (riversidehud/pak01_dir.vpk) plus a
 * README, and a browser cannot hand someone a folder. Nothing here compresses:
 * the payload is a VPK of already-dense textures and fonts, and "stored" keeps
 * this to one header layout with no deflate implementation to get wrong.
 */
import { crc32, type VpkFile } from './index';

const enc = new TextEncoder();
/** 1980-01-01 00:00, the zip epoch. A fixed date keeps the output reproducible. */
const DOS_TIME = 0, DOS_DATE = 0x21;

export function encodeZip(files: VpkFile[]): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);                      // version needed
    l.setUint16(6, 0x0800, true);                  // names are UTF-8
    l.setUint16(8, 0, true);                       // method: store
    l.setUint16(10, DOS_TIME, true);
    l.setUint16(12, DOS_DATE, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, f.data.length, true);
    l.setUint32(22, f.data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, DOS_TIME, true);
    c.setUint16(14, DOS_DATE, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, f.data.length, true);
    c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);                 // local header offset
    central.set(name, 46);

    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(offset + cdSize + 22);
  let o = 0;
  for (const p of locals) { out.set(p, o); o += p.length; }
  for (const p of centrals) { out.set(p, o); o += p.length; }
  const e = new DataView(out.buffer);
  e.setUint32(o, 0x06054b50, true);
  e.setUint16(o + 8, files.length, true);
  e.setUint16(o + 10, files.length, true);
  e.setUint32(o + 12, cdSize, true);
  e.setUint32(o + 16, offset, true);
  return out;
}
```

Add `export { encodeZip } from './zip';` to `web/src/vpk/index.ts`.

- [ ] **Step 5: Verify.** Run: `npx vitest run --project web web/src/vpk web/src/crosshair && npm run typecheck`. Expected: all PASS, no type errors.

- [ ] **Step 6: Commit.** `git add web/src/vpk web/src/crosshair && git commit -m "Move the VTF and VPK encoders to a shared module and add a store-only zip writer"`

---

### Task 2: Base HUD files and the KeyValues parser

**Files:**
- Create: `web/src/hud/base/stock/**`, `web/src/hud/base/modern/**`, `web/src/hud/base/fonts/*.ttf`, `web/src/hud/base/index.ts`, `web/src/hud/kv.ts`, `web/src/hud/kv.test.ts`

**Interfaces:**
- Produces:
  - `interface KvNode { key: string; value: string | KvNode[]; cond?: string }`
  - `parseKv(text: string): KvNode[]` (throws `Error('KeyValues: <reason> at line N')`)
  - `writeKv(nodes: KvNode[]): string` (CRLF, tab indented, every key and value quoted)
  - `kvFind(nodes: KvNode[], path: string[]): KvNode | undefined` (case-insensitive, first match, returns block or leaf)
  - `kvGet(block: KvNode, key: string): string | undefined`
  - `kvSet(block: KvNode, key: string, value: string): void` (replaces the first case-insensitive match among direct children, else appends)
  - `type Preset = 'stock' | 'modern'`
  - `baseFile(preset: Preset, path: string): string` (modern falls back to stock; throws on an unknown path)
  - `BASE_PATHS: string[]` (every stock path, lower case, forward slashes)

- [ ] **Step 1: Copy the assets**

```bash
B=web/src/hud/base; mkdir -p $B/stock $B/modern $B/fonts
(cd /home/volence/l4d/hud/stock && find scripts resource -type f \( -name '*.res' -o -name '*.txt' \)) | while read f; do
  lc=$(echo "$f" | tr 'A-Z' 'a-z'); mkdir -p "$B/stock/$(dirname "$lc")"; cp "/home/volence/l4d/hud/stock/$f" "$B/stock/$lc"; done
(cd /home/volence/l4d/hud/src && find scripts resource -type f \( -name '*.res' -o -name '*.txt' \)) | while read f; do
  lc=$(echo "$f" | tr 'A-Z' 'a-z'); mkdir -p "$B/modern/$(dirname "$lc")"; cp "/home/volence/l4d/hud/src/$f" "$B/modern/$lc"; done
cp /home/volence/l4d/hud/src/resource/RobotoCondensed-*.ttf $B/fonts/
find $B -type f | wc -l
```

Expected: 66 files (39 stock, 25 modern, 2 fonts). The stock `hudlayout_crosshair_verde.res` sits outside `scripts/` and `resource/` and is not copied.

- [ ] **Step 2: Write `web/src/hud/base/index.ts`**

```ts
/**
 * The HUD files every build starts from.
 *
 * `stock` is the game's own files, untouched. `modern` holds only the files the
 * Modern HUD overrides and falls back to stock for the rest, which is exactly
 * how the game resolves them when the Modern HUD is mounted.
 */
export type Preset = 'stock' | 'modern';

const RAW = import.meta.glob('./{stock,modern}/**/*.{res,txt}', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const at = (preset: Preset, path: string) => RAW[`./${preset}/${path}`];

export const BASE_PATHS: string[] = Object.keys(RAW)
  .filter((k) => k.startsWith('./stock/'))
  .map((k) => k.slice('./stock/'.length))
  .sort();

export function baseFile(preset: Preset, path: string): string {
  const text = at(preset, path) ?? at('stock', path);
  if (text === undefined) throw new Error(`No base HUD file ${path}`);
  return text;
}

/** True when the preset ships its own copy, so a build must include the file even if nothing else touches it. */
export function presetOverrides(preset: Preset, path: string): boolean {
  return preset !== 'stock' && at(preset, path) !== undefined;
}
```

- [ ] **Step 3: Write the failing tests** in `web/src/hud/kv.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseKv, writeKv, kvFind, kvGet, kvSet } from './kv';
import { BASE_PATHS, baseFile } from './base';

describe('parseKv', () => {
  it('reads quoted and bare tokens, nesting and comments', () => {
    const t = parseKv('"Root"\r\n{\r\n\tPanel // a comment\r\n\t{\r\n\t\t"xpos"\t"r125"\r\n\t\twide 150\r\n\t}\r\n}\r\n');
    expect(t).toEqual([{ key: 'Root', value: [{ key: 'Panel', value: [
      { key: 'xpos', value: 'r125' }, { key: 'wide', value: '150' },
    ] }] }]);
  });

  it('keeps conditionals on values and on blocks', () => {
    const t = parseKv('A { "6" "resource/marlett.ttf" [$OSX]\n B [$X360] { k v } }');
    const a = t[0].value as ReturnType<typeof parseKv>;
    expect(a[0]).toEqual({ key: '6', value: 'resource/marlett.ttf', cond: '[$OSX]' });
    expect(a[1]).toEqual({ key: 'B', cond: '[$X360]', value: [{ key: 'k', value: 'v' }] });
  });

  it('keeps duplicate keys, in order', () => {
    const a = parseKv('A { k 1 k 2 }')[0].value as { key: string; value: string }[];
    expect(a.map((n) => n.value)).toEqual(['1', '2']);
  });

  it('names the line of an unclosed block', () => {
    expect(() => parseKv('A {\n k v\n')).toThrow(/line/);
  });
});

describe('round trip', () => {
  // The generator rewrites every file it touches, so anything the parser
  // drops is silently missing from the player's HUD. hudanimations.txt is not
  // KeyValues (it is a list of `event` scripts) and is patched as text instead.
  const files = BASE_PATHS.filter((p) => p !== 'scripts/hudanimations.txt');
  for (const preset of ['stock', 'modern'] as const) {
    for (const path of files) {
      it(`${preset} ${path}`, () => {
        const first = parseKv(baseFile(preset, path));
        expect(first.length).toBeGreaterThan(0);
        expect(parseKv(writeKv(first))).toEqual(first);
      });
    }
  }
});

describe('kvFind, kvGet, kvSet', () => {
  const tree = () => parseKv('"Resource/HudLayout.res" { CHudTeamDisplay { "xpos" "0" "Wide" "f0" } }');
  it('finds case-insensitively', () => {
    const t = tree();
    const panel = kvFind(t[0].value as never, ['chudteamdisplay'])!;
    expect(kvGet(panel, 'wide')).toBe('f0');
  });
  it('replaces in place and appends when absent', () => {
    const t = tree();
    const panel = kvFind(t[0].value as never, ['CHudTeamDisplay'])!;
    kvSet(panel, 'XPOS', '8');
    kvSet(panel, 'visible', '0');
    expect(writeKv(t)).toContain('"xpos"\t\t"8"');
    expect((panel.value as unknown[]).length).toBe(3);
  });
});
```

Run: `npx vitest run --project web web/src/hud/kv.test.ts`. Expected: FAIL, cannot resolve `./kv`.

- [ ] **Step 4: Implement `web/src/hud/kv.ts`**

```ts
/**
 * Valve KeyValues, as far as HUD .res files use it.
 *
 * The generator never writes a HUD file from scratch. It parses the real file,
 * changes a handful of values and writes the tree back, so everything the
 * editor does not understand reaches the game exactly as the base HUD had it.
 * That only holds if nothing is lost here: key order and duplicate keys are
 * kept (both occur in stock files and the game reads them positionally), and
 * platform conditionals like [$X360] ride along on the node they follow.
 * Comments are dropped; the game ignores them.
 */
export interface KvNode { key: string; value: string | KvNode[]; cond?: string }

type Tok = { t: 'str' | 'cond' | '{' | '}'; v: string; line: number };

function lex(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '{' || c === '}') { out.push({ t: c, v: c, line }); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') { if (text[j] === '\n') line++; j++; }
      out.push({ t: 'str', v: text.slice(i + 1, j), line });
      i = j + 1; continue;
    }
    if (c === '[') {
      let j = i;
      while (j < n && text[j] !== ']' && text[j] !== '\n') j++;
      out.push({ t: 'cond', v: text.slice(i, j + 1), line });
      i = j + 1; continue;
    }
    let j = i;
    while (j < n && !' \t\r\n{}"'.includes(text[j])) j++;
    out.push({ t: 'str', v: text.slice(i, j), line });
    i = j;
  }
  return out;
}

export function parseKv(text: string): KvNode[] {
  const toks = lex(text);
  let p = 0;
  const fail = (why: string, line: number): never => { throw new Error(`KeyValues: ${why} at line ${line}`); };

  function block(depth: number): KvNode[] {
    const nodes: KvNode[] = [];
    for (;;) {
      const k = toks[p];
      if (!k) { if (depth > 0) fail('unclosed block', toks[toks.length - 1]?.line ?? 1); return nodes; }
      if (k.t === '}') { if (depth === 0) fail('stray }', k.line); p++; return nodes; }
      if (k.t !== 'str') fail(`expected a key, found ${k.v}`, k.line);
      p++;
      const node: KvNode = { key: k.v, value: '' };
      let next = toks[p];
      if (next?.t === 'cond' && toks[p + 1]?.t === '{') { node.cond = next.v; p++; next = toks[p]; }
      if (!next) fail(`key ${k.v} has no value`, k.line);
      if (next.t === '{') { p++; node.value = block(depth + 1); }
      else if (next.t === 'str') {
        p++; node.value = next.v;
        if (toks[p]?.t === 'cond') { node.cond = toks[p].v; p++; }
      } else fail(`key ${k.v} has no value`, k.line);
      nodes.push(node);
    }
  }
  return block(0);
}

export function writeKv(nodes: KvNode[], depth = 0): string {
  const pad = '\t'.repeat(depth);
  let out = '';
  for (const n of nodes) {
    const cond = n.cond ? ` ${n.cond}` : '';
    if (typeof n.value === 'string') out += `${pad}"${n.key}"\t\t"${n.value}"${cond}\r\n`;
    else out += `${pad}"${n.key}"${cond}\r\n${pad}{\r\n${writeKv(n.value, depth + 1)}${pad}}\r\n`;
  }
  return out;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function kvFind(nodes: KvNode[], path: string[]): KvNode | undefined {
  let level = nodes;
  let hit: KvNode | undefined;
  for (const part of path) {
    hit = level.find((n) => same(n.key, part));
    if (!hit) return undefined;
    level = typeof hit.value === 'string' ? [] : hit.value;
  }
  return hit;
}

export function kvGet(block: KvNode, key: string): string | undefined {
  if (typeof block.value === 'string') return undefined;
  const n = block.value.find((c) => same(c.key, key) && typeof c.value === 'string');
  return n ? (n.value as string) : undefined;
}

export function kvSet(block: KvNode, key: string, value: string): void {
  if (typeof block.value === 'string') throw new Error(`KeyValues: ${block.key} is not a block`);
  const n = block.value.find((c) => same(c.key, key) && typeof c.value === 'string');
  if (n) n.value = value; else block.value.push({ key, value });
}
```

- [ ] **Step 5: Run the tests.** Run: `npx vitest run --project web web/src/hud/kv.test.ts`. Expected: PASS, about 70 cases (62 of them the round trip). If a specific stock file fails to round-trip, print that file's offending lines (`sed -n` around the reported line) and extend the lexer for the real construct found there; do not skip the file.

- [ ] **Step 6: Commit.** `git add web/src/hud && git commit -m "Add the base HUD files and a KeyValues parser that round-trips every one of them"`

---

### Task 3: Units and anchors

**Files:**
- Create: `web/src/hud/units.ts`, `web/src/hud/units.test.ts`

**Interfaces:**
- Produces:
  - `type Aspect = '16:9' | '16:10' | '4:3'`, `const SCREEN_H = 480`, `screenW(a: Aspect): number`
  - `parsePos(token: string, extent: number): number` (left or top edge in units)
  - `parseSize(token: string, extent: number): number` (`"f0"` is `extent - 0`)
  - `formatPos(pos: number, size: number, extent: number): string`
  - `scaleToken(token: string, k: number): string` (multiplies the number, keeps an `r`, `c` or `f` prefix)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { screenW, parsePos, parseSize, formatPos, scaleToken } from './units';

describe('screenW', () => {
  it('is 480 units tall at every aspect', () => {
    expect(screenW('4:3')).toBe(640);
    expect(screenW('16:10')).toBe(768);
    expect(screenW('16:9')).toBe(853);
  });
});

describe('parsePos', () => {
  it('reads plain, right and centre anchors', () => {
    expect(parsePos('10', 853)).toBe(10);
    expect(parsePos('r125', 853)).toBe(728);
    expect(parsePos('c-13', 480)).toBe(227);
    expect(parsePos('c10', 480)).toBe(250);
  });
});

describe('parseSize', () => {
  it('reads f as fill minus', () => {
    expect(parseSize('f0', 853)).toBe(853);
    expect(parseSize('150', 853)).toBe(150);
  });
});

describe('formatPos', () => {
  it('anchors by which third the centre sits in', () => {
    expect(formatPos(8, 120, 853)).toBe('8');
    expect(formatPos(400, 53, 853)).toBe('c-26');     // middle third; Math.round(-26.5) is -26
    expect(formatPos(728, 150, 853)).toBe('r125');
  });

  it('round-trips through parsePos', () => {
    for (const [pos, size] of [[8, 120], [400, 53], [728, 150], [0, 853]] as const) {
      // Half of 853 is not a whole unit, so a centre anchor can land half a unit off.
      expect(Math.abs(parsePos(formatPos(pos, size, 853), 853) - pos)).toBeLessThanOrEqual(0.5);
    }
  });

  it('keeps an element the same distance from its anchored edge at another aspect', () => {
    const token = formatPos(728, 150, 853);            // placed at 16:9, 125 from the right
    expect(640 - parsePos(token, 640)).toBe(125);
  });
});

describe('scaleToken', () => {
  it('multiplies the number and keeps the anchor', () => {
    expect(scaleToken('40', 1.5)).toBe('60');
    expect(scaleToken('r10', 2)).toBe('r20');
    expect(scaleToken('c-13', 2)).toBe('c-26');
    expect(scaleToken('f0', 2)).toBe('f0');
  });
  it('leaves anything it does not understand alone', () => {
    expect(scaleToken('', 2)).toBe('');
    expect(scaleToken('abc', 2)).toBe('abc');
  });
});
```

Run: `npx vitest run --project web web/src/hud/units.test.ts`. Expected: FAIL, cannot resolve `./units`.

- [ ] **Step 2: Implement `web/src/hud/units.ts`**

```ts
/**
 * HUD coordinates.
 *
 * VGUI lays the HUD out on a grid 480 units tall whose width follows the
 * aspect ratio, and a position may be measured from the left (`"10"`), from
 * the right (`"r125"`: left edge 125 units in from the right) or from the
 * centre (`"c-13"`). The preview and the generator both go through these
 * functions, which is what stops the canvas disagreeing with the file.
 */
export type Aspect = '16:9' | '16:10' | '4:3';
export const SCREEN_H = 480;
const RATIO: Record<Aspect, number> = { '16:9': 16 / 9, '16:10': 16 / 10, '4:3': 4 / 3 };
export const screenW = (a: Aspect): number => Math.round(SCREEN_H * RATIO[a]);

const TOKEN = /^([rcf]?)(-?\d+(?:\.\d+)?)$/i;

export function parsePos(token: string, extent: number): number {
  const m = TOKEN.exec(token.trim());
  if (!m) return 0;
  const n = parseFloat(m[2]);
  const a = m[1].toLowerCase();
  if (a === 'r') return extent - n;
  if (a === 'c') return extent / 2 + n;
  return n;
}

export function parseSize(token: string, extent: number): number {
  const m = TOKEN.exec(token.trim());
  if (!m) return 0;
  const n = parseFloat(m[2]);
  return m[1].toLowerCase() === 'f' ? extent - n : n;
}

/** The anchor follows the element's centre: left third plain, middle third centre, right third right. */
export function formatPos(pos: number, size: number, extent: number): string {
  const centre = pos + size / 2;
  if (centre < extent / 3) return String(Math.round(pos));
  if (centre < (extent * 2) / 3) return `c${Math.round(pos - extent / 2)}`;
  return `r${Math.round(extent - pos)}`;
}

export function scaleToken(token: string, k: number): string {
  const m = TOKEN.exec(token.trim());
  if (!m) return token;
  if (m[1].toLowerCase() === 'f') return token;
  return `${m[1]}${Math.round(parseFloat(m[2]) * k)}`;
}
```

- [ ] **Step 3: Verify and commit.** Run: `npx vitest run --project web web/src/hud/units.test.ts`. Expected: PASS. `git add web/src/hud/units* && git commit -m "Add HUD unit and anchor maths shared by the preview and the generator"`

---

### Task 4: The design object, validation, storage and share links

**Files:**
- Create: `web/src/hud/design.ts`, `web/src/hud/design.test.ts`

**Interfaces:**
- Consumes: `Preset` from `./base`, `Aspect` from `./units`.
- Produces:
  - `interface HudDesign`, `ElementOverride`, `StyleOverride`, `UploadedImage` (below)
  - `DEFAULT_DESIGN: HudDesign`
  - `validateDesign(raw: unknown): HudDesign` (never throws; returns defaults for anything unusable)
  - `loadDesign(): HudDesign`, `saveDesign(d: HudDesign): void` (localStorage key `hud`, guarded)
  - `encodeShare(d: HudDesign): Promise<string>` (base64url, images stripped), `decodeShare(s: string): Promise<HudDesign | null>`
  - `safeName(name: string): string`

- [ ] **Step 1: Write the failing tests**

```ts
// @vitest-environment node
// CompressionStream is a Node and browser global; happy-dom does not provide it.
import { describe, it, expect } from 'vitest';
import { DEFAULT_DESIGN, validateDesign, encodeShare, decodeShare, safeName } from './design';

describe('validateDesign', () => {
  it('returns the defaults for junk', () => {
    expect(validateDesign(null)).toEqual(DEFAULT_DESIGN);
    expect(validateDesign('x')).toEqual(DEFAULT_DESIGN);
    expect(validateDesign({ v: 99 })).toEqual(DEFAULT_DESIGN);
  });

  it('clamps numbers and drops unknown keys', () => {
    const d = validateDesign({
      v: 1, preset: 'modern', evil: 1,
      elements: { teamColumn: { x: 99999, y: -99999, scale: 50, junk: true, dir: 'column', spacing: 9999 } },
    });
    expect(d.preset).toBe('modern');
    expect((d as unknown as Record<string, unknown>).evil).toBeUndefined();
    expect(d.elements.teamColumn).toEqual({ x: 1000, y: -200, scale: 2, dir: 'column', spacing: 400 });
  });

  it('rejects colours that are not four bytes', () => {
    const d = validateDesign({ v: 1, elements: { chat: { color: '255 0 0 255', bg: '999 0 0 0' } } });
    expect(d.elements.chat).toEqual({ color: '255 0 0 255' });
  });

  it('drops oversize images', () => {
    const d = validateDesign({ v: 1, images: {
      ok: { w: 64, h: 64, png: 'AAAA' },
      wide: { w: 4096, h: 64, png: 'AAAA' },
      heavy: { w: 64, h: 64, png: 'A'.repeat(1_500_000) },
    } });
    expect(Object.keys(d.images)).toEqual(['ok']);
  });
});

describe('safeName', () => {
  it('keeps a file-safe subset and never returns empty', () => {
    expect(safeName('my "cool" hud!!')).toBe('my cool hud');
    expect(safeName('///')).toBe('my_hud');
  });
});

describe('share links', () => {
  it('round-trips a design without its images', async () => {
    const d = validateDesign({ v: 1, preset: 'modern', elements: { chat: { x: 134, y: 320 } },
      images: { panelBg: { w: 8, h: 8, png: 'AAAA' } } });
    const s = await encodeShare(d);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = await decodeShare(s);
    expect(back).toEqual({ ...d, images: {} });
  });

  it('returns null for a damaged link', async () => {
    expect(await decodeShare('not-a-design')).toBeNull();
  });
});
```

Run: `npx vitest run --project web web/src/hud/design.test.ts`. Expected: FAIL, cannot resolve `./design`.

- [ ] **Step 2: Implement `web/src/hud/design.ts`**

```ts
/**
 * A player's HUD design: a preset plus the few things they changed.
 *
 * Designs arrive from three places (localStorage, a share link someone pasted
 * in Discord, a .json file) and all three are untrusted, so everything goes
 * through validateDesign, which rebuilds the object field by field rather than
 * trusting its shape. It never throws: a bad field is dropped, a bad design
 * becomes the defaults.
 */
import type { Preset } from './base';
import type { Aspect } from './units';

export interface ElementOverride {
  visible?: boolean;
  x?: number; y?: number;
  w?: number; h?: number;
  scale?: number;
  dir?: 'row' | 'column';
  spacing?: number;
  color?: string; bg?: string;
  fontSize?: number;
}
export interface StyleOverride { kind: 'stock' | 'flat' | 'rounded' | 'image'; color?: string }
export interface UploadedImage { w: number; h: number; png: string }
export interface HudDesign {
  v: 1;
  name: string;
  preset: Preset;
  advanced: boolean;
  aspect: Aspect;
  font: 'preset' | 'roboto';
  xhair: boolean;
  elements: Record<string, ElementOverride>;
  styles: Record<string, StyleOverride>;
  images: Record<string, UploadedImage>;
}

export const DEFAULT_DESIGN: HudDesign = {
  v: 1, name: 'my_hud', preset: 'stock', advanced: false, aspect: '16:9', font: 'preset',
  xhair: true, elements: {}, styles: {}, images: {},
};

const MAX_IMAGE_SIDE = 512;
const MAX_IMAGE_B64 = 1_400_000;          // about 1 MB decoded
const ID = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const COLOUR = /^(\d{1,3}) (\d{1,3}) (\d{1,3}) (\d{1,3})$/;

const RANGES = {
  x: [-200, 1000], y: [-200, 680], w: [4, 853], h: [4, 480],
  scale: [0.5, 2], spacing: [0, 400], fontSize: [6, 64],
} as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);
const colour = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const m = COLOUR.exec(v);
  return m && m.slice(1).every((n) => +n <= 255) ? v : undefined;
};

export function safeName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_ -]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || 'my_hud';
}

function element(raw: unknown): ElementOverride {
  const out: ElementOverride = {};
  if (!isObj(raw)) return out;
  if (typeof raw.visible === 'boolean') out.visible = raw.visible;
  for (const k of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(RANGES[k][1], Math.max(RANGES[k][0], v));
  }
  if (raw.dir === 'row' || raw.dir === 'column') out.dir = raw.dir;
  const c = colour(raw.color); if (c) out.color = c;
  const b = colour(raw.bg); if (b) out.bg = b;
  return out;
}

export function validateDesign(raw: unknown): HudDesign {
  if (!isObj(raw) || raw.v !== 1) return structuredClone(DEFAULT_DESIGN);
  const d: HudDesign = structuredClone(DEFAULT_DESIGN);
  if (typeof raw.name === 'string') d.name = safeName(raw.name);
  d.preset = oneOf(raw.preset, ['stock', 'modern'] as const, 'stock');
  d.aspect = oneOf(raw.aspect, ['16:9', '16:10', '4:3'] as const, '16:9');
  d.font = oneOf(raw.font, ['preset', 'roboto'] as const, 'preset');
  d.advanced = raw.advanced === true;
  d.xhair = raw.xhair !== false;
  if (isObj(raw.elements)) for (const [id, v] of Object.entries(raw.elements)) {
    if (!ID.test(id)) continue;
    const e = element(v);
    if (Object.keys(e).length) d.elements[id] = e;
  }
  if (isObj(raw.styles)) for (const [id, v] of Object.entries(raw.styles)) {
    if (!ID.test(id) || !isObj(v)) continue;
    const s: StyleOverride = { kind: oneOf(v.kind, ['stock', 'flat', 'rounded', 'image'] as const, 'stock') };
    const c = colour(v.color); if (c) s.color = c;
    d.styles[id] = s;
  }
  if (isObj(raw.images)) for (const [id, v] of Object.entries(raw.images)) {
    if (!ID.test(id) || !isObj(v)) continue;
    const { w, h, png } = v;
    if (typeof w !== 'number' || typeof h !== 'number' || typeof png !== 'string') continue;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) continue;
    if (w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE || png.length > MAX_IMAGE_B64) continue;
    if (!/^[A-Za-z0-9+/=]+$/.test(png)) continue;
    d.images[id] = { w, h, png };
  }
  return d;
}

const KEY = 'hud';
export function loadDesign(): HudDesign {
  try { const raw = localStorage.getItem(KEY); return validateDesign(raw ? JSON.parse(raw) : null); }
  catch { return structuredClone(DEFAULT_DESIGN); }
}
export function saveDesign(d: HudDesign): void {
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* a convenience, not worth surfacing */ }
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const toUrl = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromUrl = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** Images never go in a link: one upload is bigger than any chat client will carry. */
export async function encodeShare(d: HudDesign): Promise<string> {
  const json = JSON.stringify({ ...d, images: {} });
  return toUrl(await pipe(new TextEncoder().encode(json), new CompressionStream('deflate-raw')));
}
export async function decodeShare(s: string): Promise<HudDesign | null> {
  try {
    const bytes = await pipe(fromUrl(s), new DecompressionStream('deflate-raw'));
    const raw = JSON.parse(new TextDecoder().decode(bytes));
    return isObj(raw) && raw.v === 1 ? validateDesign(raw) : null;
  } catch { return null; }
}
```

`xhair` is the "I use a custom crosshair addon" switch from the spec's Phase 0 outcome 4. It defaults on; Task 9 decides whether the page shows it.

- [ ] **Step 3: Verify and commit.** Run: `npx vitest run --project web web/src/hud/design.test.ts && npm run typecheck`. Expected: PASS. If `String.fromCharCode(...b)` overflows the stack on a large design in a later task, replace it with a chunked loop; the test here is small. `git add web/src/hud/design* && git commit -m "Add the HUD design object with field-by-field validation and share links"`

---

### Task 5: The element registry and style slots

**Files:**
- Create: `web/src/hud/elements.ts`, `web/src/hud/slots.ts`, `web/src/hud/elements.test.ts`

**Interfaces:**
- Consumes: `kvFind`, `parseKv` (tests only), `baseFile`, `Preset`.
- Produces:

```ts
export type Prop = 'visible' | 'color' | 'bg' | 'fontSize';
export interface HudElement {
  id: string; label: string;
  side: 'survivor' | 'infected' | 'both';
  /** The hudlayout.res panel that places it. */
  key: string;
  move: boolean;
  resize: 'free' | 'scale' | 'none';
  /** resource/ui files whose contents scale with it. */
  children: string[];
  /** Team displays: how teammate panels are laid out. */
  team?: { file: string | null; dirs: ('row' | 'column')[]; spacingKey?: string };
  /** Size used for hit-testing and the mock when the container is bigger than what it shows. */
  mockSize?: Partial<Record<Preset, { w: number; h: number }>>;
  /** Elements the game places itself (move: false): where the preview draws them, as position tokens. */
  mockPos?: { x: string; y: string };
  props: Prop[];
}
export const ELEMENTS: HudElement[];
export const elementById: (id: string) => HudElement | undefined;

export interface StyleSlot {
  id: string; label: string;
  advancedOnly: boolean;
  size: { w: number; h: number };
  /** .res image keys to point at the new texture: file, path to the panel, key. */
  targets: { file: string; path: string[]; key: string }[];
  /** Advanced mode: stock material names (no extension, lower case) to overwrite as well. */
  stockNames: string[];
  defaultColor: string;
}
export const SLOTS: StyleSlot[];
```

- [ ] **Step 1: Write the failing test.** It pins every registry entry to the real files, so a typo in a key fails here and not in a player's game.

```ts
import { describe, it, expect } from 'vitest';
import { ELEMENTS, elementById } from './elements';
import { SLOTS } from './slots';
import { parseKv, kvFind, type KvNode } from './kv';
import { baseFile, BASE_PATHS } from './base';

const root = (preset: 'stock' | 'modern', file: string) => parseKv(baseFile(preset, file))[0].value as KvNode[];

describe('ELEMENTS', () => {
  it('has unique ids and the thirteen first-version elements', () => {
    const ids = ELEMENTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['abilityRing', 'chat', 'ghostPanel', 'infectedRow', 'killFeed', 'ownHealth',
      'progressBar', 'siHealth', 'tankPanel', 'targetId', 'teamColumn', 'weaponSelection', 'xhair'].sort());
  });

  for (const preset of ['stock', 'modern'] as const) {
    it(`every key exists in ${preset} hudlayout.res`, () => {
      const layout = root(preset, 'scripts/hudlayout.res');
      for (const e of ELEMENTS) {
        if (e.id === 'xhair') continue;            // added by the generator, absent from stock
        expect(kvFind(layout, [e.key]), e.id).toBeDefined();
      }
    });
  }

  it('names only child files that exist', () => {
    for (const e of ELEMENTS) for (const f of [...e.children, ...(e.team?.file ? [e.team.file] : [])]) {
      expect(BASE_PATHS, `${e.id}: ${f}`).toContain(f);
    }
  });

  it('cannot move the two full-screen containers', () => {
    expect(elementById('killFeed')!.move).toBe(false);
    expect(elementById('targetId')!.move).toBe(false);
  });
});

describe('SLOTS', () => {
  it('points every target at a real image key in the stock file', () => {
    for (const s of SLOTS) for (const t of s.targets) {
      const panel = kvFind(root('stock', t.file), t.path);
      expect(panel, `${s.id}: ${t.file} ${t.path.join('/')}`).toBeDefined();
    }
  });
  it('gives stock names only to advanced-only slots or slots with no targets', () => {
    for (const s of SLOTS) if (s.stockNames.length && s.targets.length === 0) expect(s.advancedOnly).toBe(true);
  });
});
```

Run: `npx vitest run --project web web/src/hud/elements.test.ts`. Expected: FAIL, cannot resolve `./elements`.

- [ ] **Step 2: Implement `web/src/hud/elements.ts`.** Write the interface from the Interfaces block above with a header comment explaining that this one table drives the canvas, the side panel and the generator, then:

```ts
const SI_HEALTH = ['boomerhealth', 'hunterhealth', 'smokerhealth', 'tankhealth', 'zombiehealthleft_large', 'zombiehealthleft_small']
  .map((n) => `resource/ui/hud/${n}.res`);

export const ELEMENTS: HudElement[] = [
  { id: 'ownHealth', label: 'Your health', side: 'survivor', key: 'CHudLocalPlayerDisplay', move: true, resize: 'scale',
    children: ['resource/ui/hud/localplayerdisplay.res', 'resource/ui/hud/localplayerpanel.res'],
    mockSize: { stock: { w: 125, h: 91 } }, props: ['visible'] },
  { id: 'teamColumn', label: 'Teammates', side: 'survivor', key: 'CHudTeamDisplay', move: true, resize: 'scale',
    children: ['resource/ui/hud/teammatepanel.res'],
    team: { file: 'resource/ui/hud/teamdisplayhud.res', dirs: ['row', 'column'] },
    mockSize: { stock: { w: 430, h: 75 }, modern: { w: 120, h: 100 } }, props: ['visible'] },
  { id: 'weaponSelection', label: 'Weapons', side: 'survivor', key: 'HudWeaponSelection', move: true, resize: 'none',
    children: [], props: ['visible'] },
  { id: 'chat', label: 'Chat', side: 'both', key: 'HudChat', move: true, resize: 'free', children: [], props: ['visible'] },
  { id: 'killFeed', label: 'Kill feed', side: 'both', key: 'HudDeathNotice', move: false, resize: 'none', children: [],
    mockSize: { stock: { w: 200, h: 60 }, modern: { w: 200, h: 60 } }, mockPos: { x: 'r204', y: '4' }, props: ['visible'] },
  { id: 'targetId', label: 'Player name under crosshair', side: 'both', key: 'TargetID', move: false, resize: 'none',
    children: [], mockSize: { stock: { w: 160, h: 16 }, modern: { w: 160, h: 16 } }, mockPos: { x: 'c-80', y: 'c30' },
    props: ['visible'] },
  { id: 'progressBar', label: 'Use / revive bar', side: 'both', key: 'HudProgressBar', move: true, resize: 'none',
    children: [], mockSize: { stock: { w: 228, h: 24 }, modern: { w: 228, h: 24 } }, props: ['visible'] },
  { id: 'xhair', label: 'Custom crosshair', side: 'both', key: 'xHair', move: false, resize: 'none', children: [], props: [] },
  { id: 'infectedRow', label: 'Infected teammates', side: 'infected', key: 'CHudZombieTeamDisplay', move: true, resize: 'scale',
    children: ['resource/ui/hud/zombieteamdisplayplayer.res'],
    team: { file: null, dirs: ['row'], spacingKey: 'HorizPanelSpacing' },
    mockSize: { stock: { w: 430, h: 75 }, modern: { w: 380, h: 31 } }, props: ['visible'] },
  { id: 'siHealth', label: 'Your infected health', side: 'infected', key: 'HudZombieHealth', move: true, resize: 'scale',
    children: SI_HEALTH, props: ['visible'] },
  { id: 'abilityRing', label: 'Ability timer', side: 'infected', key: 'HudAbilityTimer', move: true, resize: 'none',
    children: [], props: ['visible'] },
  { id: 'ghostPanel', label: 'Spawn / ghost panel', side: 'infected', key: 'HudGhostPanel', move: true, resize: 'none',
    children: [], props: ['visible'] },
  { id: 'tankPanel', label: 'Tank frustration', side: 'infected', key: 'HudFrustrationMeter', move: true, resize: 'none',
    children: [], props: ['visible'] },
];
export const elementById = (id: string) => ELEMENTS.find((e) => e.id === id);
```

`HudZombieHealth` and `HudAbilityTimer` are educated guesses at two panel names. Confirm them before running the test: the Modern HUD moved those two panels to `r158 r42` (150 x 34) and `r64 r104` (56 x 56), so run `grep -n -B8 '"r158"' web/src/hud/base/modern/scripts/hudlayout.res` and `grep -n -B8 '"r64"' ...` and use the panel names found there. The test in step 1 then holds them to both files.

- [ ] **Step 3: Implement `web/src/hud/slots.ts`**

```ts
/**
 * Style slots: one texture the player can restyle, and everywhere it has to be wired in.
 *
 * In normal mode a texture gets a new name and the .res `image` keys in
 * `targets` are pointed at it, because an addon cannot replace a texture that
 * ships in pak01. `stockNames` are the pak01 names themselves; they are only
 * written in advanced mode, where the VPK mounts ahead of pak01. A slot with
 * no targets (the health bar fills, which game code names directly) has no
 * normal-mode route at all, so it must be advancedOnly.
 */
const team = (n: number) => ({ file: 'resource/ui/hud/teamdisplayhud.res', path: [`TeamPlayer${n}`], key: 'image' });

export const SLOTS: StyleSlot[] = [
  { id: 'panelBg', label: 'Survivor panel background', advancedOnly: false, size: { w: 32, h: 32 },
    targets: [team(1), team(2), team(3), team(4)], stockNames: [], defaultColor: '0 0 0 140' },
  { id: 'weaponBoxActive', label: 'Active weapon box', advancedOnly: true, size: { w: 32, h: 32 },
    targets: [], stockNames: ['vgui/hud/scalablepanel_bgmidgrey_glow'], defaultColor: '40 40 40 215' },
  { id: 'weaponBoxInactive', label: 'Other weapon boxes', advancedOnly: true, size: { w: 32, h: 32 },
    targets: [], stockNames: ['vgui/hud/scalablepanel_bgmidgrey'], defaultColor: '0 0 0 130' },
  { id: 'barGreen', label: 'Health bar: healthy', advancedOnly: true, size: { w: 256, h: 16 },
    targets: [], stockNames: ['vgui/healthbar_green'], defaultColor: '80 200 80 255' },
  { id: 'barOrange', label: 'Health bar: hurt', advancedOnly: true, size: { w: 256, h: 16 },
    targets: [], stockNames: ['vgui/healthbar_orange'], defaultColor: '230 150 40 255' },
  { id: 'barRed', label: 'Health bar: critical', advancedOnly: true, size: { w: 256, h: 16 },
    targets: [], stockNames: ['vgui/healthbar_red'], defaultColor: '210 40 40 255' },
  { id: 'barWhite', label: 'Health bar: temporary', advancedOnly: true, size: { w: 256, h: 16 },
    targets: [], stockNames: ['vgui/healthbar_white'], defaultColor: '235 235 235 255' },
  { id: 'incapPanel', label: 'Incapacitated panel', advancedOnly: true, size: { w: 256, h: 256 },
    targets: [], stockNames: ['biker', 'manager', 'namvet', 'teenangst'].map((c) => `vgui/s_panel_${c}_incap`),
    defaultColor: '95 22 22 205' },
  { id: 'deadPanel', label: 'Dead panel', advancedOnly: true, size: { w: 256, h: 256 },
    targets: [], stockNames: ['vgui/s_panel_dead'], defaultColor: '70 70 70 190' },
];
```

Put the `StyleSlot` interface above it. Task 9 may flip `weaponBox*` to normal mode if Phase 0 question 5 passed.

- [ ] **Step 4: Verify and commit.** Run: `npx vitest run --project web web/src/hud/elements.test.ts`. Expected: PASS. If a `targets` path fails, open the stock file and correct the path to the real panel name. `git add web/src/hud && git commit -m "Add the HUD element registry and style slots, pinned to the real files by test"`

---

### Task 6: Texture generators

**Files:**
- Create: `web/src/hud/textures.ts`, `web/src/hud/textures.test.ts`

**Interfaces:**
- Produces:
  - `parseColour(c: string): [number, number, number, number]`
  - `flatTexture(w: number, h: number, colour: string): Uint8ClampedArray` (RGBA)
  - `roundedTexture(w: number, h: number, colour: string, radius: number): Uint8ClampedArray` (alpha falls to 0 outside the corner arcs, one pixel of antialias)
  - `vmtFor(materialName: string): string`

Pure arrays, no canvas, so they run under vitest. Decoding an uploaded PNG needs a DOM and lives in the page (Task 12).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { parseColour, flatTexture, roundedTexture, vmtFor } from './textures';

const px = (t: Uint8ClampedArray, w: number, x: number, y: number) => [...t.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];

describe('textures', () => {
  it('parses a colour string', () => { expect(parseColour('40 40 40 215')).toEqual([40, 40, 40, 215]); });

  it('fills a flat texture', () => {
    const t = flatTexture(4, 2, '10 20 30 40');
    expect(t.length).toBe(32);
    expect(px(t, 4, 3, 1)).toEqual([10, 20, 30, 40]);
  });

  it('rounds the corners and leaves the middle solid', () => {
    const t = roundedTexture(32, 32, '0 0 0 200', 8);
    expect(px(t, 32, 0, 0)[3]).toBe(0);
    expect(px(t, 32, 31, 31)[3]).toBe(0);
    expect(px(t, 32, 16, 16)).toEqual([0, 0, 0, 200]);
    expect(px(t, 32, 16, 0)[3]).toBe(200);
  });

  it('writes a lower-case UnlitGeneric material', () => {
    const v = vmtFor('vgui/hud/hudeditor/panelbg');
    expect(v).toContain('$basetexture "vgui/hud/hudeditor/panelbg"');
    expect(v).toContain('$translucent 1');
  });
});
```

- [ ] **Step 2: Implement**

```ts
/** Pixel generators for HUD art. Plain arrays in, RGBA out, so they need no canvas and no DOM. */
export function parseColour(c: string): [number, number, number, number] {
  const p = c.split(' ').map((n) => Math.min(255, Math.max(0, parseInt(n, 10) || 0)));
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 255];
}

export function flatTexture(w: number, h: number, colour: string): Uint8ClampedArray {
  const [r, g, b, a] = parseColour(colour);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a; }
  return out;
}

/** Coverage of pixel (x, y) by a rounded rectangle, 0 to 1, with a one pixel soft edge. */
function coverage(x: number, y: number, w: number, h: number, r: number): number {
  const cx = Math.min(Math.max(x + 0.5, r), w - r);
  const cy = Math.min(Math.max(y + 0.5, r), h - r);
  const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  return Math.min(1, Math.max(0, r - d + 0.5));
}

export function roundedTexture(w: number, h: number, colour: string, radius: number): Uint8ClampedArray {
  const out = flatTexture(w, h, colour);
  const a = parseColour(colour)[3];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(y * w + x) * 4 + 3] = Math.round(a * coverage(x, y, w, h, radius));
  return out;
}

export function vmtFor(materialName: string): string {
  return `UnlitGeneric\n{\n\t$basetexture "${materialName.toLowerCase()}"\n\t$translucent 1\n\t$vertexcolor 1\n\t$vertexalpha 1\n\t$ignorez 1\n\t$no_fullbright 1\n\t$nomip 1\n}\n`;
}
```

- [ ] **Step 3: Verify and commit.** Run: `npx vitest run --project web web/src/hud/textures.test.ts`. Expected: PASS. `git add web/src/hud/textures* && git commit -m "Add flat and rounded HUD texture generators"`

---

### Task 7: The generator, layout pass

**Files:**
- Create: `web/src/hud/build.ts`, `web/src/hud/build.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 6.
- Produces:

```ts
export interface BuildAssets { fonts?: { regular: Uint8Array; bold: Uint8Array }; images?: Record<string, Uint8ClampedArray> }
export function buildHud(design: HudDesign, assets?: BuildAssets): VpkFile[];
/** Where an element sits at an aspect, after the design is applied. Shared with the preview. */
export function elementRect(design: HudDesign, id: string, aspect: Aspect): { x: number; y: number; w: number; h: number; visible: boolean };
```

`assets.images` holds uploaded images already decoded to RGBA at their slot size, keyed by slot id; the page decodes them (Task 12).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { buildHud, elementRect } from './build';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { baseFile } from './base';

const text = (files: { path: string; data: Uint8Array }[], path: string) => {
  const f = files.find((x) => x.path === path);
  return f ? new TextDecoder('latin1').decode(f.data) : undefined;
};
const layoutOf = (files: { path: string; data: Uint8Array }[]) =>
  parseKv(text(files, 'scripts/hudlayout.res')!)[0].value as KvNode[];
const design = (patch: Partial<HudDesign>): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), ...patch });

describe('buildHud, layout', () => {
  it('ships stock hudlayout plus the xHair element for an empty design', () => {
    const files = buildHud(design({}));
    const got = layoutOf(files);
    const stock = parseKv(baseFile('stock', 'scripts/hudlayout.res'))[0].value as KvNode[];
    expect(got.filter((n) => n.key !== 'xHair')).toEqual(stock);
    const x = kvFind(got, ['xHair'])!;
    expect(kvGet(x, 'image')).toBe('hud/altcrosshair');
    expect(kvGet(x, 'xpos')).toBe('c-13');
    expect(files.map((f) => f.path)).toContain('addoninfo.txt');
  });

  it('leaves xHair out when the player has no crosshair addon', () => {
    expect(kvFind(layoutOf(buildHud(design({ xhair: false }))), ['xHair'])).toBeUndefined();
  });

  it('does not duplicate xHair on the modern preset, which already has it', () => {
    const got = layoutOf(buildHud(design({ preset: 'modern' })));
    expect(got.filter((n) => n.key.toLowerCase() === 'xhair').length).toBe(1);
  });

  it('moves one element and nothing else', () => {
    const got = layoutOf(buildHud(design({ elements: { ownHealth: { x: 8, y: 400 } } })));
    const p = kvFind(got, ['CHudLocalPlayerDisplay'])!;
    expect(kvGet(p, 'xpos')).toBe('8');
    expect(kvGet(p, 'ypos')).toBe('r80');
    expect(kvGet(p, 'wide')).toBe('150');
    const other = kvFind(got, ['HudWeaponSelection'])!;
    expect(kvGet(other, 'xpos')).toBe('r98');
  });

  it('hides an element', () => {
    const got = layoutOf(buildHud(design({ elements: { killFeed: { visible: false } } })));
    expect(kvGet(kvFind(got, ['HudDeathNotice'])!, 'visible')).toBe('0');
  });

  it('ignores a move on an element that cannot move', () => {
    const got = layoutOf(buildHud(design({ elements: { targetId: { x: 5, y: 5 } } })));
    expect(kvGet(kvFind(got, ['TargetID'])!, 'xpos')).toBe('c-320');
  });

  it('free-resizes chat and rewrites the three chat animations', () => {
    const files = buildHud(design({ elements: { chat: { x: 134, y: 320, w: 280, h: 100 } } }));
    const c = kvFind(layoutOf(files), ['HudChat'])!;
    expect(kvGet(c, 'xpos')).toBe('134');
    expect(kvGet(c, 'ypos')).toBe('r160');
    expect(kvGet(c, 'wide')).toBe('280');
    const anim = text(files, 'scripts/hudanimations.txt')!;
    const hits = anim.match(/Animate\s+HudChat\s+Position\s+"134 r160"/g) ?? [];
    expect(hits.length).toBe(3);
  });

  it('does not ship hudanimations when chat has not moved', () => {
    expect(text(buildHud(design({})), 'scripts/hudanimations.txt')).toBeUndefined();
  });

  it('ships every file the modern preset overrides even when nothing is edited', () => {
    const paths = buildHud(design({ preset: 'modern' })).map((f) => f.path);
    expect(paths).toContain('resource/ui/hud/teammatepanel.res');
    expect(paths).toContain('scripts/hudanimations.txt');
  });

  it('never ships a crosshair image', () => {
    for (const preset of ['stock', 'modern'] as const) {
      expect(buildHud(design({ preset })).some((f) => f.path.includes('altcrosshair'))).toBe(false);
    }
  });
});

describe('elementRect', () => {
  it('reads the base position at the asked aspect', () => {
    expect(elementRect(design({}), 'ownHealth', '16:9')).toMatchObject({ x: 728, y: 389, visible: true });
    expect(elementRect(design({}), 'ownHealth', '4:3')).toMatchObject({ x: 515, y: 389 });
  });
  it('re-projects a moved element through its anchor', () => {
    const d = design({ aspect: '16:9', elements: { ownHealth: { x: 728, y: 389 } } });
    expect(elementRect(d, 'ownHealth', '4:3').x).toBe(515);
  });
});
```

Run: `npx vitest run --project web web/src/hud/build.test.ts`. Expected: FAIL, cannot resolve `./build`.

- [ ] **Step 2: Implement the layout pass in `web/src/hud/build.ts`.** Structure it as a small working set of parsed files that later tasks add passes to:

```ts
/**
 * HudDesign in, addon files out.
 *
 * Every file is a real base file with a few values changed. `Work` parses a
 * file the first time a pass asks for it and remembers that it was touched;
 * at the end only touched files, plus the files the preset itself overrides,
 * are written. An untouched stock file is never shipped, because the game
 * already has it and shipping it would only widen what this addon can break.
 */
import { encodeVPK, type VpkFile } from '../vpk';
import { baseFile, presetOverrides, BASE_PATHS, type Preset } from './base';
import { parseKv, writeKv, kvFind, kvGet, kvSet, type KvNode } from './kv';
import { parsePos, parseSize, formatPos, screenW, SCREEN_H, type Aspect } from './units';
import { ELEMENTS, elementById, type HudElement } from './elements';
import type { HudDesign, ElementOverride } from './design';

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);   // latin-1, as the game reads it
const LAYOUT = 'scripts/hudlayout.res';
const ANIMS = 'scripts/hudanimations.txt';

class Work {
  private trees = new Map<string, KvNode[]>();
  private texts = new Map<string, string>();
  constructor(readonly preset: Preset) {}
  /** The children of the file's single root block. */
  tree(path: string): KvNode[] {
    let t = this.trees.get(path);
    if (!t) {
      try { t = parseKv(baseFile(this.preset, path)); }
      catch (e) { throw new Error(`${path}: ${(e as Error).message}`); }
      this.trees.set(path, t);
    }
    const root = t[0];
    if (!root || typeof root.value === 'string') throw new Error(`${path}: no root block`);
    return root.value;
  }
  panel(path: string, keys: string[]): KvNode {
    const p = kvFind(this.tree(path), keys);
    if (!p) throw new Error(`${path}: no panel ${keys.join('/')}`);
    return p;
  }
  text(path: string): string { return this.texts.get(path) ?? baseFile(this.preset, path); }
  setText(path: string, s: string) { this.texts.set(path, s); }
  files(): VpkFile[] {
    const out: VpkFile[] = [];
    const paths = new Set([...this.trees.keys(), ...this.texts.keys(), ...BASE_PATHS.filter((p) => presetOverrides(this.preset, p))]);
    for (const path of [...paths].sort()) {
      if (this.texts.has(path) || path === ANIMS) { out.push({ path, data: enc(this.text(path)) }); continue; }
      this.tree(path);
      out.push({ path, data: enc(writeKv(this.trees.get(path)!)) });
    }
    return out;
  }
}
```

Then the pass and the two exports:

```ts
const XHAIR: KvNode = { key: 'xHair', value: [
  ['ControlName', 'ImagePanel'], ['fieldName', 'xHair'], ['xpos', 'c-13'], ['ypos', 'c-13'], ['zpos', '-2'],
  ['wide', '26'], ['tall', '26'], ['visible', '1'], ['enabled', '1'], ['image', 'hud/altcrosshair'], ['scaleImage', '1'],
].map(([key, value]) => ({ key, value })) };

function baseRect(panel: KvNode, el: HudElement, preset: Preset, aspect: Aspect) {
  const W = screenW(aspect);
  const w = el.mockSize?.[preset]?.w ?? parseSize(kvGet(panel, 'wide') ?? '0', W);
  const h = el.mockSize?.[preset]?.h ?? parseSize(kvGet(panel, 'tall') ?? '0', SCREEN_H);
  return { x: parsePos(kvGet(panel, 'xpos') ?? '0', W), y: parsePos(kvGet(panel, 'ypos') ?? '0', SCREEN_H), w, h };
}

/** The tokens an override produces. The anchor comes from where the element sat at the aspect it was placed at. */
function placed(o: ElementOverride, base: { x: number; y: number; w: number; h: number }, el: HudElement, designAspect: Aspect) {
  const w = el.resize === 'free' && o.w !== undefined ? o.w : base.w;
  const h = el.resize === 'free' && o.h !== undefined ? o.h : base.h;
  const x = o.x ?? base.x, y = o.y ?? base.y;
  return { xpos: formatPos(x, w, screenW(designAspect)), ypos: formatPos(y, h, SCREEN_H), w, h };
}

function layoutPass(work: Work, design: HudDesign) {
  const layout = work.tree(LAYOUT);
  const has = kvFind(layout, ['xHair']);
  if (design.xhair && !has) layout.unshift(structuredClone(XHAIR));
  if (!design.xhair && has) layout.splice(layout.indexOf(has), 1);

  for (const el of ELEMENTS) {
    const o = design.elements[el.id];
    if (!o || el.id === 'xhair') continue;
    const panel = work.panel(LAYOUT, [el.key]);
    if (o.visible !== undefined) kvSet(panel, 'visible', o.visible ? '1' : '0');
    const moved = el.move && (o.x !== undefined || o.y !== undefined);
    const sized = el.resize === 'free' && (o.w !== undefined || o.h !== undefined);
    if (!moved && !sized) continue;
    const p = placed(o, baseRect(panel, el, work.preset, design.aspect), el, design.aspect);
    if (moved) { kvSet(panel, 'xpos', p.xpos); kvSet(panel, 'ypos', p.ypos); }
    if (sized) { kvSet(panel, 'wide', String(Math.round(p.w))); kvSet(panel, 'tall', String(Math.round(p.h))); }
    if (el.id === 'chat' && moved) {
      // Three animation events hard-code the chat position and would snap a moved chat box back.
      work.setText(ANIMS, work.text(ANIMS).replace(/(Animate\s+HudChat\s+Position\s+")[^"]*(")/g, `$1${p.xpos} ${p.ypos}$2`));
    }
  }
}

function addonInfo(name: string): string {
  return `"AddonInfo"\n{\n\taddonSteamAppID\t\t500\n\taddontitle\t\t"${name.replace(/"/g, '')}"\n\taddonversion\t\t1.0\n\taddontagline\t\t"Custom HUD (riversidepug.com)"\n\taddonauthor\t\t"HUD editor"\n\taddonDescription\t\t"Custom HUD layout."\n}\n`;
}

export function buildHud(design: HudDesign, assets: BuildAssets = {}): VpkFile[] {
  const work = new Work(design.preset);
  layoutPass(work, design);
  return [...work.files(), { path: 'addoninfo.txt', data: enc(addonInfo(design.name)) }];
}

export function elementRect(design: HudDesign, id: string, aspect: Aspect) {
  const el = elementById(id);
  if (!el) throw new Error(`No HUD element ${id}`);
  const work = new Work(design.preset);
  const o = design.elements[id] ?? {};
  if (id === 'xhair') return { x: screenW(aspect) / 2 - 13, y: SCREEN_H / 2 - 13, w: 26, h: 26, visible: design.xhair };
  const panel = work.panel(LAYOUT, [el.key]);
  const base = baseRect(panel, el, design.preset, design.aspect);
  const p = placed(o, base, el, design.aspect);
  const k = el.resize === 'scale' ? o.scale ?? 1 : 1;
  const visible = o.visible ?? (kvGet(panel, 'visible') ?? '1') !== '0';
  const moved = el.move && (o.x !== undefined || o.y !== undefined);
  const xTok = el.mockPos?.x ?? (moved ? p.xpos : kvGet(panel, 'xpos') ?? '0');
  const yTok = el.mockPos?.y ?? (moved ? p.ypos : kvGet(panel, 'ypos') ?? '0');
  return { x: parsePos(xTok, screenW(aspect)), y: parsePos(yTok, SCREEN_H), w: p.w * k, h: p.h * k, visible };
}
```

`layoutPass` and `elementRect` deliberately share `baseRect`, mock size included, so the anchor the file gets is the
anchor the preview showed. That matters most for the two team displays: their containers are `f0` wide, so by their
own size they would always anchor to the centre, which is wrong for a row the player parked bottom-left. Add this
test and keep it passing:

```ts
it('anchors a team display by what it shows, not by its full-width container', () => {
  const got = layoutOf(buildHud(design({ elements: { teamColumn: { x: 8, y: 332 } } })));
  expect(kvGet(kvFind(got, ['CHudTeamDisplay'])!, 'xpos')).toBe('8');
});
```

- [ ] **Step 3: Run the tests.** Run: `npx vitest run --project web web/src/hud/build.test.ts`. Expected: PASS. The `ypos` expectation `r80` for `ownHealth` comes from `480 - 400`; if the stock `HudChat` block is not named `HudChat`, find it with `grep -n -B3 '"275"' web/src/hud/base/stock/scripts/hudlayout.res` and fix the registry key, not the test.

- [ ] **Step 4: Commit.** `git add web/src/hud/build* && git commit -m "Generate hudlayout moves, visibility, free resize and the chat animation fix from a design"`

---

### Task 8: The generator, scale, team layout and fonts

**Files:**
- Modify: `web/src/hud/build.ts`, `web/src/hud/build.test.ts`

**Interfaces:**
- Consumes: `scaleToken` from `./units`.
- Produces: no new exports. `buildHud` now honours `scale`, `dir`, `spacing` and `design.font`, and uses `assets.fonts`.

- [ ] **Step 1: Write the failing tests** (append to `build.test.ts`)

```ts
describe('buildHud, scale', () => {
  const scheme = (files: { path: string; data: Uint8Array }[]) =>
    parseKv(text(files, 'resource/clientscheme.res')!)[0].value as KvNode[];

  it('multiplies the container and every child, and points children at scaled fonts', () => {
    const files = buildHud(design({ elements: { teamColumn: { scale: 1.5 } } }));
    const stockPanel = parseKv(baseFile('stock', 'resource/ui/hud/teammatepanel.res'))[0].value as KvNode[];
    const gotPanel = parseKv(text(files, 'resource/ui/hud/teammatepanel.res')!)[0].value as KvNode[];
    const named = stockPanel.find((n) => typeof n.value !== 'string' && kvGet(n, 'font') === 'PlayerDisplayName')!;
    const after = kvFind(gotPanel, [named.key])!;
    expect(kvGet(after, 'wide')).toBe(String(Math.round(parseFloat(kvGet(named, 'wide')!) * 1.5)));
    expect(kvGet(after, 'font')).toBe('HudEd_PlayerDisplayName_150');

    const fonts = kvFind(scheme(files), ['Fonts'])!;
    const stockFont = kvFind(parseKv(baseFile('stock', 'resource/clientscheme.res'))[0].value as KvNode[], ['Fonts', 'PlayerDisplayName', '1'])!;
    const scaled = kvFind(fonts.value as KvNode[], ['HudEd_PlayerDisplayName_150', '1'])!;
    expect(kvGet(scaled, 'tall')).toBe(String(Math.round(parseFloat(kvGet(stockFont, 'tall')!) * 1.5)));
    expect(kvGet(scaled, 'name')).toBe(kvGet(stockFont, 'name'));
  });

  it('writes nothing extra at scale 1', () => {
    const paths = buildHud(design({ elements: { teamColumn: { scale: 1 } } })).map((f) => f.path);
    expect(paths).not.toContain('resource/clientscheme.res');
  });

  it('scales all six infected health files together', () => {
    const paths = buildHud(design({ elements: { siHealth: { scale: 1.2 } } })).map((f) => f.path);
    for (const n of ['boomerhealth', 'hunterhealth', 'smokerhealth', 'tankhealth', 'zombiehealthleft_large', 'zombiehealthleft_small']) {
      expect(paths).toContain(`resource/ui/hud/${n}.res`);
    }
  });
});

describe('buildHud, team layout', () => {
  const team = (files: { path: string; data: Uint8Array }[]) =>
    parseKv(text(files, 'resource/ui/hud/teamdisplayhud.res')!)[0].value as KvNode[];

  it('stacks the survivor team as a column', () => {
    const t = team(buildHud(design({ elements: { teamColumn: { dir: 'column', spacing: 34 } } })));
    expect([1, 2, 3, 4].map((n) => [kvGet(kvFind(t, [`TeamPlayer${n}`])!, 'xpos'), kvGet(kvFind(t, [`TeamPlayer${n}`])!, 'ypos')]))
      .toEqual([['0', '0'], ['0', '34'], ['0', '68'], ['0', '102']]);
  });

  it('lays it out as a row', () => {
    const t = team(buildHud(design({ elements: { teamColumn: { dir: 'row', spacing: 140 } } })));
    expect(kvGet(kvFind(t, ['TeamPlayer3'])!, 'xpos')).toBe('280');
    expect(kvGet(kvFind(t, ['TeamPlayer3'])!, 'ypos')).toBe('0');
  });

  it('grows the container so a column is not clipped', () => {
    const got = layoutOf(buildHud(design({ elements: { teamColumn: { dir: 'column', spacing: 40 } } })));
    expect(parseFloat(kvGet(kvFind(got, ['CHudTeamDisplay'])!, 'tall')!)).toBeGreaterThanOrEqual(4 * 40);
  });

  it('sets infected spacing in hudlayout', () => {
    const got = layoutOf(buildHud(design({ elements: { infectedRow: { spacing: 124 } } })));
    expect(kvGet(kvFind(got, ['CHudZombieTeamDisplay'])!, 'HorizPanelSpacing')).toBe('124');
  });
});

describe('buildHud, fonts', () => {
  const ttf = { regular: new Uint8Array([1, 2, 3]), bold: new Uint8Array([4, 5, 6]) };

  it('switches every Trade Gothic face to Roboto and ships both files', () => {
    const files = buildHud(design({ font: 'roboto' }), { fonts: ttf });
    const s = text(files, 'resource/clientscheme.res')!;
    expect(s).not.toMatch(/Trade Gothic/);
    expect(s).toMatch(/Roboto Condensed/);
    expect(s).toMatch(/resource\/robotocondensed-regular\.ttf/i);
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(
      ['resource/robotocondensed-regular.ttf', 'resource/robotocondensed-bold.ttf']));
  });

  it('ships the fonts for the modern preset, whose scheme already names them', () => {
    const paths = buildHud(design({ preset: 'modern' }), { fonts: ttf }).map((f) => f.path);
    expect(paths).toContain('resource/robotocondensed-bold.ttf');
  });

  it('fails clearly when Roboto is needed and was not loaded', () => {
    expect(() => buildHud(design({ font: 'roboto' }))).toThrow(/font/i);
  });
});
```

Run them. Expected: FAIL (features missing).

- [ ] **Step 2: Implement the three passes** in `build.ts` and call them from `buildHud` after `layoutPass`, in this order: `teamPass`, `scalePass`, `fontPass`.

```ts
const SCHEME = 'resource/clientscheme.res';
const POSITIONAL = ['xpos', 'ypos', 'wide', 'tall'];

function teamPass(work: Work, design: HudDesign) {
  for (const el of ELEMENTS) {
    const o = design.elements[el.id];
    if (!el.team || !o) continue;
    if (el.team.spacingKey && o.spacing !== undefined) {
      kvSet(work.panel(LAYOUT, [el.key]), el.team.spacingKey, String(Math.round(o.spacing)));
    }
    if (!el.team.file || (o.dir === undefined && o.spacing === undefined)) continue;
    const first = work.panel(el.team.file, ['TeamPlayer1']);
    const pw = parseFloat(kvGet(first, 'wide') ?? '150'), ph = parseFloat(kvGet(first, 'tall') ?? '150');
    const second = work.panel(el.team.file, ['TeamPlayer2']);
    const wasRow = (kvGet(second, 'ypos') ?? '0') === (kvGet(first, 'ypos') ?? '0');
    const dir = o.dir ?? (wasRow ? 'row' : 'column');
    const gap = Math.round(o.spacing ?? (dir === 'row' ? 140 : 45));
    for (let n = 1; n <= 4; n++) {
      const p = work.panel(el.team.file, [`TeamPlayer${n}`]);
      kvSet(p, 'xpos', String(dir === 'row' ? gap * (n - 1) : 0));
      kvSet(p, 'ypos', String(dir === 'row' ? 0 : gap * (n - 1)));
    }
    // The container clips its children, so it has to cover the last panel.
    const container = work.panel(LAYOUT, [el.key]);
    if (dir === 'column') {
      kvSet(container, 'tall', String(Math.round(gap * 3 + ph)));
      if ((kvGet(container, 'wide') ?? '').toLowerCase().startsWith('f')) kvSet(container, 'wide', String(Math.round(pw)));
    } else {
      kvSet(container, 'wide', String(Math.round(gap * 3 + pw)));
    }
  }
}

/** Scale every positioned value in a block, recursively, and collect the fonts it uses. */
function scaleBlock(nodes: KvNode[], k: number, fonts: Set<string>, tag: string) {
  for (const n of nodes) {
    if (typeof n.value !== 'string') { scaleBlock(n.value, k, fonts, tag); continue; }
    const key = n.key.toLowerCase();
    if (POSITIONAL.includes(key)) n.value = scaleToken(n.value, k);
    else if (key === 'font') { fonts.add(n.value); n.value = `HudEd_${n.value}_${tag}`; }
  }
}

function scalePass(work: Work, design: HudDesign) {
  for (const el of ELEMENTS) {
    const k = design.elements[el.id]?.scale;
    if (el.resize !== 'scale' || k === undefined || k === 1) continue;
    const tag = String(Math.round(k * 100));
    const fonts = new Set<string>();
    const container = work.panel(LAYOUT, [el.key]);
    for (const key of ['wide', 'tall']) { const v = kvGet(container, key); if (v !== undefined) kvSet(container, key, scaleToken(v, k)); }
    for (const file of [...el.children, ...(el.team?.file ? [el.team.file] : [])]) scaleBlock(work.tree(file), k, fonts, tag);
    if (el.team?.spacingKey) {
      const v = kvGet(container, el.team.spacingKey);
      if (v !== undefined) kvSet(container, el.team.spacingKey, scaleToken(v, k));
    }
    const schemeFonts = work.panel(SCHEME, ['Fonts']);
    for (const name of fonts) {
      const src = kvFind(schemeFonts.value as KvNode[], [name]);
      if (!src) continue;                            // an icon font the scheme defines elsewhere: leave the child on it
      const copy = structuredClone(src);
      copy.key = `HudEd_${name}_${tag}`;
      for (const size of copy.value as KvNode[]) {
        if (typeof size.value === 'string') continue;
        const tall = kvGet(size, 'tall');
        if (tall !== undefined) kvSet(size, 'tall', String(Math.round(parseFloat(tall) * k)));
      }
      (schemeFonts.value as KvNode[]).push(copy);
    }
  }
}
```

A font the scheme does not define must not be renamed, or the child loses its font. Fix `scaleBlock` accordingly: collect first, then rename only fonts that `schemeFonts` has. The cleanest shape is two walks: `scaleBlock` scales positions and returns the font leaf nodes; `scalePass` renames a leaf only after the scheme lookup succeeds. Write it that way.

```ts
function fontPass(work: Work, design: HudDesign, assets: BuildAssets, out: VpkFile[]) {
  const wantsRoboto = design.font === 'roboto' || design.preset === 'modern';
  if (!wantsRoboto) return;
  if (!assets.fonts) throw new Error('The Roboto Condensed font files were not loaded');
  if (design.font === 'roboto' && design.preset === 'stock') {
    const rename = (nodes: KvNode[]) => { for (const n of nodes) {
      if (typeof n.value !== 'string') rename(n.value);
      else if (n.key.toLowerCase() === 'name' && /^Trade Gothic( Bold)?$/i.test(n.value)) n.value = 'Roboto Condensed';
    } };
    rename(work.tree(SCHEME));
    const custom = work.panel(SCHEME, ['CustomFontFiles']);
    kvSet(custom, '7', 'resource/robotocondensed-regular.ttf');
    kvSet(custom, '8', 'resource/robotocondensed-bold.ttf');
  }
  out.push({ path: 'resource/robotocondensed-regular.ttf', data: assets.fonts.regular },
           { path: 'resource/robotocondensed-bold.ttf', data: assets.fonts.bold });
}
```

`buildHud` becomes:

```ts
export function buildHud(design: HudDesign, assets: BuildAssets = {}): VpkFile[] {
  const work = new Work(design.preset);
  const extra: VpkFile[] = [];
  layoutPass(work, design);
  teamPass(work, design);
  scalePass(work, design);
  fontPass(work, design, assets, extra);
  return [...work.files(), ...extra, { path: 'addoninfo.txt', data: enc(addonInfo(design.name)) }];
}
```

The modern preset's `clientscheme.res` names the fonts as `resource/RobotoCondensed-Regular.ttf` with capitals. VPK lookups from an addon are case-sensitive, so in `fontPass`, for the modern preset too, set entries `7` and `8` to the lower-case paths.

The Task 7 tests call `buildHud(design({ preset: 'modern' }))` with no assets and will now throw. Update those three modern-preset tests to pass `{ fonts: { regular: new Uint8Array(1), bold: new Uint8Array(1) } }`.

- [ ] **Step 3: Verify and commit.** Run: `npx vitest run --project web web/src/hud && npm run typecheck`. Expected: PASS. `git add web/src/hud && git commit -m "Generate scaled panels with their own font entries, team row or column layout, and the Roboto option"`

---

### Task 9: The generator, styles, advanced mode and packaging

**Files:**
- Modify: `web/src/hud/build.ts`, `web/src/hud/build.test.ts`, `web/src/hud/slots.ts` (only if Phase 0 question 5 passed)
- Create: `scripts/check-hud-vpk.sh`

**Interfaces:**
- Produces: `packHud(design: HudDesign, assets?: BuildAssets): { filename: string; mime: string; bytes: Uint8Array<ArrayBuffer> }`

**Before starting, read the "Phase 0 results" section of the spec.** Apply it:
- Question 1, 2 or 3 failed: stop and tell the owner; the affected passes (`scalePass` children, `fontPass`, `stylePass` targets) must run only when `design.advanced` is true, and the plan needs the owner's say-so on that change.
- Question 4 drew a pink square: keep `design.xhair` and show its checkbox on the page (Task 12). Drew nothing or only the stock crosshair: the checkbox is hidden and `xhair` stays true.
- Question 5 passed: in `slots.ts` set `weaponBoxActive` and `weaponBoxInactive` to `advancedOnly: false` and give `stylePass` the `mod_textures.txt` route described in step 2. Failed or unanswered: leave them advanced only.

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { encodeVPK } from '../vpk';
import { packHud } from './build';

describe('buildHud, styles', () => {
  const fonts = { regular: new Uint8Array(1), bold: new Uint8Array(1) };

  it('writes a new texture and points the panels at it', () => {
    const files = buildHud(design({ styles: { panelBg: { kind: 'flat', color: '0 0 0 140' } } }));
    const paths = files.map((f) => f.path);
    expect(paths).toContain('materials/vgui/hud/hudeditor/panelbg.vtf');
    expect(paths).toContain('materials/vgui/hud/hudeditor/panelbg.vmt');
    const t = parseKv(text(files, 'resource/ui/hud/teamdisplayhud.res')!)[0].value as KvNode[];
    expect(kvGet(kvFind(t, ['TeamPlayer2'])!, 'image')).toBe('hud/hudeditor/panelbg');
  });

  it('uses an uploaded image when the slot asks for one', () => {
    const rgba = new Uint8ClampedArray(32 * 32 * 4).fill(7);
    const files = buildHud(design({ styles: { panelBg: { kind: 'image' } } }), { images: { panelBg: rgba } });
    const vtf = files.find((f) => f.path.endsWith('panelbg.vtf'))!;
    expect(vtf.data.length).toBe(80 + 32 * 32 * 4);
    expect(vtf.data[80]).toBe(7);
  });

  it('never writes a stock texture name in normal mode', () => {
    const files = buildHud(design({ styles: { barGreen: { kind: 'flat', color: '0 255 0 255' } } }));
    expect(files.some((f) => f.path.startsWith('materials/') && !f.path.startsWith('materials/vgui/hud/hudeditor/'))).toBe(false);
  });

  it('writes stock names in advanced mode', () => {
    const files = buildHud(design({ advanced: true, styles: { barGreen: { kind: 'flat', color: '0 255 0 255' } } }));
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(
      ['materials/vgui/healthbar_green.vtf', 'materials/vgui/healthbar_green.vmt']));
  });

  it('keeps every path lower case', () => {
    const files = buildHud(design({ preset: 'modern', advanced: true,
      styles: { incapPanel: { kind: 'flat' }, panelBg: { kind: 'rounded' } } }), { fonts });
    for (const f of files) expect(f.path).toBe(f.path.toLowerCase());
  });
});

describe('packHud', () => {
  it('gives normal mode a VPK v1 named after the design', () => {
    const p = packHud(design({ name: 'night hud' }));
    expect(p.filename).toBe('night hud.vpk');
    const dv = new DataView(p.bytes.buffer);
    expect(dv.getUint32(0, true)).toBe(0x55AA1234);
    expect(dv.getUint32(4, true)).toBe(1);
  });

  it('gives advanced mode a zip holding the mount folder and a README', () => {
    const p = packHud(design({ name: 'night hud', advanced: true }));
    expect(p.filename).toBe('night hud.zip');
    const s = new TextDecoder('latin1').decode(p.bytes);
    expect(s).toContain('riversidehud/pak01_dir.vpk');
    expect(s).toContain('README.txt');
    expect(s).toContain('Game\triversidehud');
  });
});
```

- [ ] **Step 2: Implement `stylePass` and `packHud`**

```ts
import { encodeVTF, encodeZip } from '../vpk';
import { SLOTS } from './slots';
import { flatTexture, roundedTexture, vmtFor } from './textures';

function stylePass(work: Work, design: HudDesign, assets: BuildAssets, out: VpkFile[]) {
  for (const slot of SLOTS) {
    const s = design.styles[slot.id];
    if (!s || s.kind === 'stock') continue;
    if (slot.advancedOnly && !design.advanced) continue;
    const { w, h } = slot.size;
    const colour = s.color ?? slot.defaultColor;
    const rgba = s.kind === 'image' ? assets.images?.[slot.id]
      : s.kind === 'rounded' ? roundedTexture(w, h, colour, Math.round(Math.min(w, h) / 4))
      : flatTexture(w, h, colour);
    if (!rgba) continue;                             // an image slot whose upload is missing falls back to stock
    const vtf = encodeVTF(w, h, rgba);
    const names = [`vgui/hud/hudeditor/${slot.id.toLowerCase()}`, ...(design.advanced ? slot.stockNames : [])];
    for (const name of names) {
      out.push({ path: `materials/${name}.vtf`, data: vtf }, { path: `materials/${name}.vmt`, data: enc(vmtFor(name)) });
    }
    for (const t of slot.targets) kvSet(work.panel(t.file, t.path), t.key, `hud/hudeditor/${slot.id.toLowerCase()}`);
  }
}
```

Call it in `buildHud` after `fontPass`. If Phase 0 question 5 passed, add the `mod_textures.txt` route: copy the game's `scripts/mod_textures.txt` into `web/src/hud/base/stock/scripts/mod_textures.txt` (lower-case name, and add it to the round-trip test by virtue of `BASE_PATHS`), give `StyleSlot` an optional `modTextures?: string[]` (the entry names `rounded_background_glow` and `rounded_background_noborder`), and in `stylePass` set each entry's `file` key to `vgui/hud/hudeditor/<slot>`.

```ts
const README = (name: string) => `${name}: advanced install\r\n\r\n`
  + `1. Close the game.\r\n`
  + `2. Copy the "riversidehud" folder from this zip into your game folder, next to "left4dead":\r\n`
  + `   ...\\steamapps\\common\\left 4 dead\\riversidehud\\pak01_dir.vpk\r\n`
  + `3. Open ...\\left 4 dead\\left4dead\\gameinfo.txt in Notepad. Find the line "SearchPaths" and the "{" under it.\r\n`
  + `   Add this as the first line inside the braces:\r\n\r\n`
  + `\t\t\tGame\triversidehud\r\n\r\n`
  + `4. Save and start the game.\r\n\r\n`
  + `A rebuilt HUD only shows after a game restart.\r\n`
  + `To uninstall, remove that line and the folder. Steam's "verify integrity of game files" also undoes the edit.\r\n`
  + `Custom HUDs are allowed on the Riverside servers.\r\n`;

export function packHud(design: HudDesign, assets: BuildAssets = {}) {
  const vpk = encodeVPK(buildHud(design, assets));
  if (!design.advanced) return { filename: `${design.name}.vpk`, mime: 'application/octet-stream', bytes: vpk };
  const zip = encodeZip([
    { path: 'riversidehud/pak01_dir.vpk', data: vpk },
    { path: 'README.txt', data: enc(README(design.name)) },
  ]);
  return { filename: `${design.name}.zip`, mime: 'application/zip', bytes: zip };
}
```

`addoninfo.txt` is harmless inside a `gameinfo.txt` mount and is left in.

- [ ] **Step 3: Write `scripts/check-hud-vpk.sh`**, a check outside vitest that a second implementation can read what we wrote:

```bash
#!/usr/bin/env bash
# Build a sample HUD VPK with the real generator and read it back with the Python vpk reader.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)/sample.vpk"
HUD_VPK_OUT="$OUT" npx vitest run --project web web/src/hud/sample.vpkcheck.ts >/dev/null
/home/volence/l4d/hud/.venv/bin/python - "$OUT" <<'PY'
import sys, vpk
pak = vpk.open(sys.argv[1])
names = sorted(pak)
assert pak.version == 1, pak.version
assert 'scripts/hudlayout.res' in names, names
for n in names: pak[n].read()          # every CRC is verified on read
print(len(names), 'files ok')
PY
```

and `web/src/hud/sample.vpkcheck.ts` (named so the normal `*.test.ts` glob skips it; the script passes the path explicitly):

```ts
// @vitest-environment node
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { packHud } from './build';
import { validateDesign } from './design';

it('writes a sample VPK for the Python reader', () => {
  const d = validateDesign({ v: 1, preset: 'stock', elements: { ownHealth: { x: 8, y: 400 }, teamColumn: { scale: 1.25, dir: 'column', spacing: 36 } },
    styles: { panelBg: { kind: 'rounded', color: '0 0 0 150' } } });
  writeFileSync(process.env.HUD_VPK_OUT!, packHud(d).bytes);
});
```

If vitest refuses the file because it does not match the project `include`, run it as `npx vitest run --project web --dir web/src/hud sample.vpkcheck.ts` or rename it `sample.vpkcheck.test.ts` and guard its body with `if (!process.env.HUD_VPK_OUT) return;`. Pick whichever works and leave the working form in the script.

- [ ] **Step 4: Verify and commit.** Run: `npx vitest run --project web web/src/hud && npm run typecheck && bash scripts/check-hud-vpk.sh`. Expected: tests PASS and `N files ok`. `git add web/src/hud scripts/check-hud-vpk.sh && git commit -m "Generate restyled textures, add advanced mode, and pack the HUD as a VPK or a mount zip"`

---

### Task 10: The mock renderer

**Files:**
- Create: `web/src/hud/mock.ts`, `web/src/hud/mock.test.ts`

**Interfaces:**
- Consumes: `elementRect`, `ELEMENTS`, `screenW`, `SCREEN_H`.
- Produces:
  - `type Side = 'survivor' | 'infected'`
  - `visibleElements(side: Side): HudElement[]` (elements whose side is that side or `both`)
  - `drawHud(ctx: CanvasRenderingContext2D, pxW: number, pxH: number, design: HudDesign, side: Side, selectedId: string | null): void`
  - `hitTest(design: HudDesign, side: Side, ux: number, uy: number): string | null` (topmost element under a point given in HUD units; smallest area wins, so a small element inside a big one is selectable)

- [ ] **Step 1: Write the failing tests** for the two pure functions

```ts
import { describe, it, expect } from 'vitest';
import { visibleElements, hitTest } from './mock';
import { DEFAULT_DESIGN } from './design';

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
```

- [ ] **Step 2: Implement.** `hitTest` and `visibleElements` exactly as specified. `drawHud` scales by `pxH / 480`, then for each visible element of the side calls a per-id painter with the element's rect in pixels. Each painter draws a believable stand-in from plain shapes and text, not game art:

| id | what the painter draws |
|---|---|
| `ownHealth` | dark panel, a portrait square at the left, a health bar three quarters full in green, "100" in bold at the right |
| `teamColumn` | three teammate panels, laid out by the design's `dir` and `spacing` (defaults read the same way `teamPass` does), each with a small portrait, a name ("Francis", "Louis", "Zoey") and a bar |
| `weaponSelection` | five stacked slot boxes, the second highlighted |
| `chat` | two lines of sample chat on a faint background filling the rect |
| `killFeed` | two right-aligned kill lines at the top right of the screen |
| `targetId` | a name centred under the crosshair |
| `progressBar` | a half-filled bar |
| `xhair` | a dashed 26 unit square at centre with the player's saved crosshair drawn inside via `drawCrosshair` from `../crosshair/draw`, reading its state from localStorage key `xhair` (guarded) |
| `infectedRow` | three cards, spaced by the design's `spacing` |
| `siHealth` | a card with a bar and "250" |
| `abilityRing` | a ring, three quarters swept |
| `ghostPanel` | a wide translucent box with two lines of spawn text |
| `tankPanel` | a bar labelled "Frustration" |

Panel backgrounds use the `panelBg` style's colour when its kind is `flat` or `rounded` (rounded corners drawn with `roundRect`), so restyling shows in the preview. A hidden element is drawn at 25% opacity with a dashed outline when it is the selected one, and not at all otherwise, so it can still be found and unhidden from the element list. The selected element gets a 2 px outline in the site's accent colour and, for `free` resize, a handle square at its bottom-right corner.

- [ ] **Step 3: Verify and commit.** Run: `npx vitest run --project web web/src/hud/mock.test.ts && npm run typecheck`. `git add web/src/hud/mock* && git commit -m "Add the HUD preview renderer and hit testing"`

---

### Task 11: The page, canvas interaction

**Files:**
- Create: `web/src/routes/Hud.tsx`, `web/src/routes/Hud.test.tsx`
- Modify: `web/src/main.tsx`, `web/src/components/Nav.tsx`, `web/src/components/Nav.test.tsx`, `web/src/styles/app.css`

**Interfaces:**
- Consumes: `loadDesign`, `saveDesign`, `drawHud`, `hitTest`, `visibleElements`, `elementRect`, `screenW`.
- Produces: `export default function Hud()` plus these pure helpers exported for test:
  - `toUnits(e: { clientX: number; clientY: number }, rect: DOMRect): { ux: number; uy: number }` using `480 / rect.height`
  - `snap(v: number, size: number, extent: number): number` (snaps the near edge to 0, the far edge to `extent`, and the centre to `extent / 2`, each within 4 units)
  - `nudge(design: HudDesign, id: string, dx: number, dy: number): HudDesign`

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, it, expect } from 'vitest';
import { snap, nudge, toUnits } from './Hud';
import { DEFAULT_DESIGN } from '../hud/design';

describe('snap', () => {
  it('snaps edges and centre, and otherwise leaves the value alone', () => {
    expect(snap(3, 100, 853)).toBe(0);
    expect(snap(750, 100, 853)).toBe(753);
    expect(snap(375, 100, 853)).toBe(376.5);
    expect(snap(200, 100, 853)).toBe(200);
  });
});

describe('nudge', () => {
  it('starts from the base position the first time', () => {
    const d = nudge(DEFAULT_DESIGN, 'ownHealth', -10, 0);
    expect(d.elements.ownHealth).toEqual({ x: 718, y: 389 });
  });
  it('does nothing to an element that cannot move', () => {
    expect(nudge(DEFAULT_DESIGN, 'killFeed', 5, 5)).toBe(DEFAULT_DESIGN);
  });
});

describe('toUnits', () => {
  it('converts a pointer position to HUD units', () => {
    const rect = { left: 100, top: 50, width: 1706, height: 960 } as DOMRect;
    expect(toUnits({ clientX: 100 + 853, clientY: 50 + 480 }, rect)).toEqual({ ux: 426.5, uy: 240 });
  });
});
```

- [ ] **Step 2: Implement the page shell.** Follow `web/src/routes/Crosshair.tsx` for structure, the `Panel`, `PageHeader`, `Slider` and `Field` patterns, and the single draw effect. State: `design` (from `loadDesign`), `side`, `selected`, `backdrop`. One `useEffect` on `[design, side, selected, backdrop]` sizes the canvas backing store to its CSS box at the design's aspect, draws the backdrop with `drawBackdrop` from `../crosshair/draw`, then `drawHud`. A second effect calls `saveDesign(design)`.

Pointer handling on the canvas (`onPointerDown/Move/Up`, with `setPointerCapture`):
- down: `hitTest`; select the hit; if it can move, remember `{ id, startUx, startUy, startRect }`; if the pointer is within 6 units of a `free` element's bottom-right corner, start a resize instead.
- move while dragging: new `x = snap(startRect.x + dux, w, screenW(aspect))`, same for `y` against 480; clamp so at least 8 units of the element stay on screen; write `design.elements[id] = { ...old, x, y }`. Resizing writes `w`, `h` (minimum 20).
- up: release. A down on empty space deselects.

Keyboard on the canvas (`tabIndex={0}`): arrows call `nudge` by 1, Shift by 10; Escape deselects; Tab and Shift+Tab cycle `visibleElements(side)` so the editor is usable without a mouse.

The side panel for the selected element renders only what its registry entry allows: a Visible checkbox; X and Y number inputs when `move`; W and H when `resize === 'free'`; a Scale slider (0.5 to 2, step 0.05) when `resize === 'scale'`; Row/Column and Spacing when `team` is set (Column offered only if `team.dirs` has it); and a "Reset this element" button that deletes its override. Elements with `move: false` show one line: "The game places this one. It can be hidden but not moved." Below the canvas, an element list (buttons, one per visible element, hidden ones struck through) selects an element, which is the only way to reach one that is hidden or off screen.

- [ ] **Step 3: Route, nav and lazy loading.** In `web/src/main.tsx` add, beside the other imports:

```tsx
import { lazy } from 'preact-iso';
// The HUD editor carries ~170 KB of base HUD files, so it stays out of the main bundle.
const Hud = lazy(() => import('./routes/Hud'));
```

and `<Route path="/hud" component={Hud} />` after the crosshair route. In `Nav.tsx` add `['/hud', 'HUD'],` after the Crosshair entry, and update `Nav.test.tsx` for the new link count or list if it asserts one.

- [ ] **Step 4: CSS.** Append `.hud__*` rules to `web/src/styles/app.css` next to the `.xh__*` block, reusing its variables: a two-column grid (canvas left, 320 px side panel right) that stacks under 900 px; the canvas `width: 100%` with `aspect-ratio` set inline from the design's aspect; `touch-action: none` on the canvas so dragging works on touch screens; the element list as wrapping pills.

- [ ] **Step 5: Verify.** Run: `npx vitest run --project web web/src/routes/Hud.test.tsx web/src/components && npm run typecheck && npm run build`. Expected: PASS, and the build output lists a separate chunk for `Hud`. Then `npm run dev:web`, open `http://localhost:5173/hud`, and confirm by hand: drag the health panel to the bottom left and it snaps to the edge; arrow keys move it; the Infected toggle swaps the element set; reloading the page keeps the layout.

- [ ] **Step 6: Commit.** `git add web/src && git commit -m "Add the HUD editor page: drag, resize, nudge and per-element controls on a live preview"`

---

### Task 12: The page, presets, styles, uploads, sharing and download

**Files:**
- Modify: `web/src/routes/Hud.tsx`, `web/src/routes/Hud.test.tsx`, `web/src/styles/app.css`

**Interfaces:**
- Consumes: `packHud`, `BuildAssets`, `SLOTS`, `encodeShare`, `decodeShare`, `validateDesign`, `safeName`.
- Produces (exported for test): `decodeUpload(file: Blob, w: number, h: number): Promise<{ rgba: Uint8ClampedArray; png: string }>`, `assetsFor(design: HudDesign): Promise<BuildAssets>`.

- [ ] **Step 1: Top bar controls.** Preset (Stock / Modern), Side, Aspect, Backdrop, Font (Preset default / Roboto Condensed, disabled with a note on Modern, which already uses it). Changing the preset when `design.elements` is non-empty asks through the site's `confirm()` from `../components/Confirm` ("Switching preset keeps your moves but they were placed for the other layout. Reset them as well?") with Keep and Reset.

- [ ] **Step 2: Styles panel.** One row per `SLOTS` entry that is not `advancedOnly`, or all of them when `design.advanced`. Each row: a kind select (Stock, Flat, Rounded, Image), a colour input plus an opacity slider writing `'r g b a'`, and for Image a file input. The Advanced mode button sits above the advanced rows with this copy: "Advanced mode also restyles the health bar colours, the incapacitated and dead panels and the weapon boxes. The game only allows that from a folder you add to gameinfo.txt, so the download becomes a zip with instructions."

- [ ] **Step 3: Uploads.**

```ts
/** Decode any image the browser can read, fit it to the slot, and keep a PNG copy for the saved design. */
export async function decodeUpload(file: Blob, w: number, h: number) {
  if (file.size > 4_000_000) throw new Error('That image is over 4 MB.');
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('That file is not an image the browser can read.'); });
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const png = c.toDataURL('image/png').split(',')[1];
  if (png.length > 1_400_000) throw new Error('That image is too detailed to store. Try a smaller one.');
  return { rgba: ctx.getImageData(0, 0, w, h).data, png };
}
```

On success store `design.images[slot.id] = { w, h, png }` and `design.styles[slot.id] = { kind: 'image' }`. On failure show the message beside the input and leave the previous image alone. `assetsFor(design)` rebuilds `BuildAssets.images` from the stored PNGs (load into an `Image`, draw to a canvas at the slot size, read the pixels) and, when `design.font === 'roboto' || design.preset === 'modern'`, fetches the two fonts:

```ts
import regularUrl from '../hud/base/fonts/RobotoCondensed-Regular.ttf?url';
import boldUrl from '../hud/base/fonts/RobotoCondensed-Bold.ttf?url';
const bytes = async (u: string) => new Uint8Array(await (await fetch(u)).arrayBuffer());
```

- [ ] **Step 4: Download.** Copy the crosshair page's Blob download. The handler: `const assets = await assetsFor(design); const p = packHud({ ...design, name: safeName(name) }, assets);` then a Blob of `p.bytes` with `p.mime`, an object URL, a temporary `<a download={p.filename}>`, click, revoke. Wrap it in try/catch and show the error's message in the status line: the generator's errors name the file and panel, which is what a bug report needs. Under the button, the install copy:
  - normal: "Put the file in `left4dead/addons/` and restart the game. It works alongside a crosshair from the Crosshair page. Custom HUDs are allowed on the Riverside servers."
  - advanced: "Unzip it and follow README.txt. It works alongside a crosshair addon."
  - Show the "I use a custom crosshair addon" checkbox (bound to `design.xhair`) only if Phase 0 question 4 drew a pink square.

- [ ] **Step 5: Sharing.** "Copy share link": `location.origin + '/hud#d=' + await encodeShare(design)` to the clipboard; if `Object.keys(design.images).length`, the status line says "Copied. Uploaded images are not in a link; use Export to share those." "Export" downloads `JSON.stringify(design)` as `<name>.hud.json`; "Import" reads a file and runs `validateDesign(JSON.parse(text))` inside try/catch ("That file is not a HUD design."). On mount, if `location.hash` starts with `#d=`: `decodeShare`; null shows "That link is damaged."; otherwise, if a saved design with any overrides exists, ask through `confirm()` before replacing it; then clear the hash with `history.replaceState`.

- [ ] **Step 6: Tests.** Add to `Hud.test.tsx`: rendering `<Hud />` shows the preset select and the download button; clicking Advanced mode reveals a row labelled "Health bar: healthy" and changes the button text to mention a zip; with `location.hash = '#d=garbage'` the page shows "That link is damaged."; importing `'{"v":1,"preset":"modern"}'` selects the Modern preset. Use `@testing-library/preact` as the existing route tests do (check `web/src/routes/HelpConsistency.test.tsx` for the local pattern).

- [ ] **Step 7: Verify and commit.** Run: `npx vitest run --project web && npm run typecheck && npm run build`. By hand in `npm run dev:web`: download a normal VPK and run `/home/volence/l4d/hud/.venv/bin/vpk -l <file>`; download an advanced zip and `unzip -l <file>`; copy a share link, open it in a private window, confirm the layout matches. `git add web/src && git commit -m "Add presets, styles, image uploads, share links and the VPK and zip downloads to the HUD editor"`

---

### Task 13: Final verification and hand-off

- [ ] **Step 1: Full suite.** Run: `npm test && npm run typecheck && npm run build && bash scripts/check-hud-vpk.sh`. Everything must pass; report real output.
- [ ] **Step 2: Screenshots.** Add `/hud` to the page list in `scripts/shoot-pages.mjs` and run `npm run shoot`. Read the desktop and phone-width shots; fix any overflow or overlap in the side panel.
- [ ] **Step 3: No em dashes.** Run: `git diff master --name-only | xargs grep -lP '\x{2014}' || echo none`. Expected: `none`.
- [ ] **Step 4: Owner's in-game pass.** Build three samples from the dev page and give them to the owner with exact steps, in the final message: (a) stock preset, health panel moved bottom-left, team as a column at scale 1.25, chat moved, rounded panel backgrounds, normal VPK; (b) Modern preset untouched, normal VPK, to compare against the owner's own Modern HUD; (c) sample (a) in advanced mode with a recoloured health bar. Ask for a survivor screenshot of each, plus one infected screenshot of (b). Things to look for: chat stays put after a death and after a special infected intro (the `r160` inside an animation string was never confirmed); scaled text is the right size; no pink and black squares.
- [ ] **Step 5: Stop.** Do not merge or deploy. Report what passed, what the screenshots showed, and that merging to master and `deploy-web.sh` wait for the owner's go-ahead.
