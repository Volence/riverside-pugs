# HUD Editor: Importing a Whole HUD, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A player imports an existing HUD (a `.vpk` addon or a `.zip` of a HUD folder) as a third preset, edits it in the editor as the game would show it, and downloads that HUD plus their edits.

**Architecture:** The upload is read in the browser (VPK reader already exists; a new zip reader uses `DecompressionStream('deflate-raw')`), its HUD root found, and its canonical file list hashed with SHA-256 into an id. The files live in IndexedDB (`hudStore`) and, while the page is open, in a synchronous in-memory registry in `web/src/hud/base/index.ts`. Everything that used to take a `Preset` to read base files now takes a `BaseKey` (`'stock' | 'modern' | 'imported:<id>'`), so `baseFile` layers the upload over stock whole-file, and every preset-keyed cache keys on the import too. The download starts from the upload's files, lays the edited and generated ones over them (an imported file the passes did not change goes back byte for byte), and reports which upload files a generated one replaced. The preview reads the upload's fonts through a small runtime TrueType reader and its textures through `.vmt` then `.vtf` then `decodeVTF`.

**Tech Stack:** TypeScript, Preact, Vite, vitest (project `web`, happy-dom; `// @vitest-environment node` where a test reads files with `fileURLToPath`), Web Crypto (`crypto.subtle.digest`), `DecompressionStream`, IndexedDB, canvas 2D, FontFace. No new npm dependencies: `fake-indexeddb` is not installed, so `hudStore` takes an injectable backend and tests use the in-memory one.

**Spec:** `docs/superpowers/specs/2026-09-23-hud-editor-hud-upload-design.md`. Read it first. The engine facts behind the passes are in `docs/superpowers/specs/2026-09-21-hud-editor-design.md` and the header comments of `web/src/hud/build.ts`.

## Global Constraints

- FIRST RULE: never run `git stash` in any form.
- Work only in the worktree `/home/volence/l4d/pug/.claude/worktrees/hud-editor` (branch `worktree-hud-editor`). Never touch the main checkout or `master`. No push, no deploy. The vite dev server on `:5199` stays running; do not stop or restart it.
- All commands run from the worktree root. Tests: `npx vitest run --project web <path>`. Types: `npm run typecheck`. Build: `npm run build`.
- Never use em dashes anywhere: code, comments, UI copy, commit messages, this plan's follow-ups.
- Match the surrounding comment style: explanatory block comments that say why, as in `web/src/hud/build.ts`.
- Preview equals file: the canvas draws from the generator's own trees (`buildTrees`) and nothing else decides a position.
- Valve's stock art (`web/src/hud/art/`) stays preview-only: nothing `build.ts` reaches may import it (`art.test.ts` walks those imports and must keep passing). A player's imported files are theirs and do go into their download.
- Downloads of non-imported designs stay byte-identical: `web/src/hud/download.golden.test.ts` must pass unchanged, with its hashes untouched.
- TDD: write the test, run it and capture the RED output in the task report, then implement, then GREEN.
- Small plain-English commits, one per task at least (for example "Read zip files in the browser, for importing a HUD").
- No new npm dependencies.
- When a step appends tests to an existing test file and lists imports, merge those imports into the file's existing import block (one import per module). Where a code block says "the existing body, unchanged", keep those lines exactly as they are.
- Final chain, run at the end of the last task and reported with real output: `npm test && npm run typecheck && npm run build && bash scripts/check-hud-vpk.sh && HUD_SAMPLE=b bash scripts/check-hud-vpk.sh && HUD_SAMPLE=w bash scripts/check-hud-vpk.sh`

## Decisions this plan locks in

These settle what the spec leaves open. Every task follows them.

- **Paths:** every imported path is lower case with forward slashes, the way `readVPK` already returns them and the way the game looks files up.
- **Base keys:** `type BaseKey = 'stock' | 'modern' | \`imported:${string}\``. `baseOf(design)` gives a design's key. A key for an import that is not in the registry makes `baseFile` throw `MissingImportError`; it never falls back to stock, so no cache is ever filled from the wrong files. Because an id is a content hash, a cache entry for a key stays valid for ever.
- **Text encodings:** an imported text file is read as Latin-1 (byte for byte), after stripping a UTF-8 byte order mark, or as UTF-16LE when it starts with `FF FE`. An edited file is written back in the encoding it came in, mark included.
- **Unchanged means untouched:** an imported file the passes parsed but whose `writeKv` output equals `writeKv(parseKv(original))` goes into the download as the original bytes.
- **Crosshair on import:** the upload's `materials/vgui/hud/altcrosshair.vtf` becomes `xhairArt` with crosshair `'bundle'`. With no texture but an `xHair` element in its `hudlayout.res`, a design whose crosshair is `'none'` becomes `'addon'`, so layoutPass keeps the HUD's own element. Otherwise the design's crosshair choice stands. A bundled crosshair regenerates `altcrosshair.vtf`/`.vmt` in the download, and the download note lists them as replaced.
- **Fonts on an imported design:** always `'preset'` (the Font select is disabled). Roboto's `CustomFontFiles` entries 7 and 8 would otherwise overwrite the upload's own.
- **Edits when switching onto an import:** the existing "keep or reset" question is asked only when the design has layout edits. A design with none starts on the import with `elements: {}` and `children: {}` (not the default fitted teammates), so the HUD shows as its author made it.
- **Import-time checks, in order:** over 50 MB (the upload's own size, then the unpacked sizes); not a VPK or zip, or a VPK split across side archives, or a corrupt archive ("Could not read this file as a VPK or zip"); no `scripts/hudlayout.res`; and one more line the spec does not list: a file the editor parses (any `BASE_PATHS` entry except `scripts/hudanimations.txt`) that KeyValues cannot read gives "This HUD's <path> could not be read (<reason>)". Without it a broken file would throw inside the canvas draw.
- **Zip root:** the shallowest folder holding `scripts/hudlayout.res`, then the alphabetically first. A zip with no loose HUD but a `.vpk` inside (the editor's own Advanced download, `riversidehud/pak01_dir.vpk`) imports that VPK. Every `gameinfo.txt`, at any depth, is dropped.
- **Name:** the HUD root's folder name, else the upload's file name without `.vpk`/`.zip`/`_dir`, through `safeName`.
- **Missing import:** the page draws only the backdrop, shows the banner above the canvas, empties the Layers and side panels, disables the Styles panel, Aspect, Font and Download, and ignores canvas and keyboard edits. Undo, Redo and the Preset select stay live. While the store is still being read the banner says "Loading the imported HUD 'name'..." instead.
- **Storage failure:** if IndexedDB is missing or refuses, the import still works for this page session and the status line says it is kept only until the page closes.
- **Icon cells:** a cell is looked up in `scripts/mod_textures.txt` first, then `scripts/hud_textures.txt`. Only cells with a `file` the upload carries are drawn from the upload; font-glyph cells keep the preview's art.
- **Scheme borders:** the preview draws no scheme borders today, so imported textures reach ImagePanels and the weapon selection's box and icon art only.

## File Structure

```
web/src/vpk/unzip.ts                  NEW  readZip(bytes, maxBytes), ZipTooBig: stored and deflated entries
web/src/vpk/unzip.test.ts             NEW
web/src/vpk/fixtures.ts               + zipOf(): a zip with deflated or flagged entries, tests only
web/src/vpk/index.ts                  encodeVPK handles a file with no extension (Task 4)
web/src/vpk/vpk.test.ts               + that case
web/src/hud/text.ts                   NEW  decodeText / encodeText: Latin-1, UTF-8 with BOM, UTF-16LE
web/src/hud/text.test.ts              NEW
web/src/hud/upload.ts                 NEW  readHudUpload(name, bytes), hudId(files), IMPORT_ERRORS, MAX_HUD_BYTES
web/src/hud/upload.test.ts            NEW
web/src/hud/importFixtures.ts         NEW  tests only: sampleHud, latin1, MARKER_PANEL, dropBlock, recordingCtx, fakeCanvas
web/src/hud/base/index.ts             Preset gains 'imported'; BaseKey, baseOf, the registry, MissingImportError
web/src/hud/design.ts                 HudDesign.imported, ImportedRef, validateDesign, caches keyed by BaseKey
web/src/hud/build.ts                  Work(key), pass-through download, BuildReport, baseTree, baseHasElement, importedHasXhair
web/src/hud/imported.test.ts          NEW  the layer, validation, caches (Task 3), degrading (Task 5), xHair (Task 6)
web/src/hud/imported.build.test.ts    NEW  download round trip and edits landing in the upload's files
web/src/hud/elements.ts               mockSize typed to stock and modern only
web/src/hud/edit.ts                   baseTeam(baseOf(..)); withImport, withPreset, hasLayoutEdits
web/src/hud/selection.ts              baseTeam(baseOf(..)); visibleElements(side, design)
web/src/hud/mock.ts                   visibleElements(side, design) filters what the base lacks
web/src/hud/hudStore.ts               NEW  HudStore: get, put, list, delete; memoryStore, indexedDbStore, hudStore()
web/src/hud/hudStore.test.ts          NEW
web/src/crosshair/texture.ts          vtfArt split out of uploadArt; importedCrosshair(files)
web/src/hud/ttf.ts                    NEW  decodeVfont, readFont (head, hhea, OS/2, VDMX, name)
web/src/hud/ttf.test.ts               NEW  against the baked Trade Gothic metrics
web/src/hud/fonts.ts                  runtime faces from an import: importedFace, aliases, FontFace from bytes
web/src/hud/importArt.ts              NEW  importedMaterial(key, material, canvas): .vmt -> .vtf -> canvas
web/src/hud/render.ts                 setFont uses importedFace; drawImageChild draws imported textures; scratchCanvas
web/src/hud/weapons.ts                box art and icon cells from the upload; iconCell
web/src/hud/sample.vpkcheck.test.ts   + HUD_SAMPLE=i, an imported HUD for the Python reader
web/src/routes/hud/Toolbar.tsx        Preset select lists imports, Import a HUD..., Remove an imported HUD..., locked
web/src/routes/Hud.tsx                store wiring, import, switching, remove, banner, locked, download note
web/src/routes/hud/ContextPanel.tsx   baseHasChild(baseOf(design), ..)
web/src/routes/hud/LayersPanel.tsx    visibleElements(side, design)
web/src/routes/Hud.test.tsx           + "Importing a HUD" tests
web/src/styles/app.css                + .hud__fieldset, .hud__removerow
```

---

### Task 1: Read zip files in the browser

**Files:**
- Create: `web/src/vpk/unzip.ts`, `web/src/vpk/unzip.test.ts`
- Modify: `web/src/vpk/fixtures.ts` (add `zipOf`)

**Interfaces:**
- Produces:
  - `readZip(bytes: Uint8Array, maxBytes: number): Promise<Map<string, Uint8Array>>`: every file entry by its name as stored (backslashes turned into slashes, case kept), directory entries skipped. Throws `Error('Could not read this file as a VPK or zip')` for anything it cannot read, and `ZipTooBig` when the declared unpacked sizes add up past `maxBytes`, before inflating anything.
  - `class ZipTooBig extends Error`.
  - `zipOf(files: { path: string; data: Uint8Array; deflate?: boolean; flags?: number }[]): Promise<Uint8Array<ArrayBuffer>>` in `web/src/vpk/fixtures.ts`, tests only.

- [ ] **Step 1: Add the test fixture** to `web/src/vpk/fixtures.ts`. Add the import at the top and the function at the end:

```ts
import { crc32 } from './index';
```

```ts
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/**
 * Tests only: a zip whose entries may be deflated (method 8) or carry extra
 * flag bits (bit 0 is "encrypted"), which encodeZip never writes. Same
 * layout as encodeZip otherwise: local headers, central directory, end record.
 */
export async function zipOf(files: { path: string; data: Uint8Array; deflate?: boolean; flags?: number }[]): Promise<Uint8Array<ArrayBuffer>> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const body = f.deflate ? await deflate(f.data) : f.data;
    const method = f.deflate ? 8 : 0;
    const flags = 0x0800 | (f.flags ?? 0);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, flags, true); l.setUint16(8, method, true);
    l.setUint32(14, crc32(f.data), true); l.setUint32(18, body.length, true); l.setUint32(22, f.data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, flags, true);
    c.setUint16(10, method, true); c.setUint32(16, crc32(f.data), true); c.setUint32(20, body.length, true);
    c.setUint32(24, f.data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
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

- [ ] **Step 2: Write the failing tests** in `web/src/vpk/unzip.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { readZip, ZipTooBig } from './unzip';
import { encodeZip } from './zip';
import { zipOf } from './fixtures';

const enc = new TextEncoder();
const NOT_ZIP = 'Could not read this file as a VPK or zip';

describe('readZip', () => {
  it('reads the stored entries encodeZip writes', async () => {
    const files = [{ path: 'riversidehud/pak01_dir.vpk', data: new Uint8Array([1, 2, 3]) }, { path: 'README.txt', data: enc.encode('hi') }];
    const got = await readZip(encodeZip(files), 1000);
    expect([...got.keys()]).toEqual(['riversidehud/pak01_dir.vpk', 'README.txt']);
    expect(got.get('README.txt')).toEqual(enc.encode('hi'));
  });

  it('inflates deflated entries, turns backslashes into slashes and skips folders', async () => {
    const text = enc.encode('"Resource/HudLayout.res" { }'.repeat(20));
    const zip = await zipOf([
      { path: 'EdgeHUD/', data: new Uint8Array(0) },
      { path: 'EdgeHUD\\scripts\\HudLayout.res', data: text, deflate: true },
    ]);
    const got = await readZip(zip, 10_000);
    expect([...got.keys()]).toEqual(['EdgeHUD/scripts/HudLayout.res']);
    expect(got.get('EdgeHUD/scripts/HudLayout.res')).toEqual(text);
  });

  it('finds the end record behind a zip comment', async () => {
    const zip = encodeZip([{ path: 'a.txt', data: enc.encode('a') }]);
    const out = new Uint8Array(zip.length + 5);
    out.set(zip);
    new DataView(out.buffer).setUint16(zip.length - 22 + 20, 5, true);
    out.set(enc.encode('hello'), zip.length);
    expect((await readZip(out, 100)).get('a.txt')).toEqual(enc.encode('a'));
  });

  it('refuses what it cannot read in one sentence', async () => {
    await expect(readZip(enc.encode('hello, not a zip'), 100)).rejects.toThrow(NOT_ZIP);
    await expect(readZip(await zipOf([{ path: 'a.txt', data: enc.encode('a'), flags: 1 }]), 100)).rejects.toThrow(NOT_ZIP);
    const broken = await zipOf([{ path: 'a.txt', data: enc.encode('aaaaaaaaaa'), deflate: true }]);
    broken[30 + 'a.txt'.length] = 0xff;            // BFINAL 1, BTYPE 11: a reserved block type
    await expect(readZip(broken, 100)).rejects.toThrow(NOT_ZIP);
  });

  it('stops on the declared sizes, before inflating anything, when they pass the cap', async () => {
    const zip = await zipOf([{ path: 'a.txt', data: new Uint8Array(10), deflate: true }]);
    await expect(readZip(zip, 3)).rejects.toBeInstanceOf(ZipTooBig);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run --project web web/src/vpk/unzip.test.ts`
Expected: FAIL, `Failed to resolve import "./unzip"`. Capture this output for the report.

- [ ] **Step 4: Write `web/src/vpk/unzip.ts`**

```ts
/**
 * A zip reader, for Import a HUD: a player's HUD often comes as a zip of its
 * folder rather than as a .vpk. zip.ts only writes (and only stores); real
 * zips are deflated, which the browser's own DecompressionStream inflates,
 * so no inflate code lives here.
 *
 * The bytes come from a file a player picked, so every read is bounds
 * checked and anything unexpected (zip64, encryption, a method other than
 * store or deflate, a size that does not match) fails with one sentence.
 * The declared unpacked sizes are added up and checked against the cap
 * before anything is inflated, so a zip that claims to be huge costs nothing.
 */
const NOT_ZIP = 'Could not read this file as a VPK or zip';

/** The declared unpacked sizes passed the caller's cap. */
export class ZipTooBig extends Error {}

async function inflate(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function readZip(bytes: Uint8Array, maxBytes: number): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (): never => { throw new Error(NOT_ZIP); };
  // The end record is 22 bytes plus a comment of up to 65535; its signature is found searching back.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail();
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff || cdOffset + cdSize > eocd) fail();   // zip64: never a HUD
  const entries: { name: string; method: number; csize: number; usize: number; local: number }[] = [];
  let total = 0;
  let o = cdOffset;
  for (let n = 0; n < count; n++) {
    if (o + 46 > eocd || dv.getUint32(o, true) !== 0x02014b50) fail();
    const flags = dv.getUint16(o + 8, true);
    const method = dv.getUint16(o + 10, true);
    const csize = dv.getUint32(o + 20, true);
    const usize = dv.getUint32(o + 24, true);
    const nameLen = dv.getUint16(o + 28, true);
    const skip = nameLen + dv.getUint16(o + 30, true) + dv.getUint16(o + 32, true);
    const local = dv.getUint32(o + 42, true);
    if (o + 46 + skip > eocd) fail();
    // Bit 11 says the name is UTF-8; without it, it is the old DOS code page, read here as Latin-1.
    const name = new TextDecoder(flags & 0x0800 ? 'utf-8' : 'latin1').decode(bytes.subarray(o + 46, o + 46 + nameLen)).replace(/\\/g, '/');
    o += 46 + skip;
    if (name.endsWith('/')) continue;
    if (flags & 1) fail();                                   // encrypted
    if (method !== 0 && method !== 8) fail();
    total += usize;
    if (total > maxBytes) throw new ZipTooBig();
    entries.push({ name, method, csize, usize, local });
  }
  const out = new Map<string, Uint8Array>();
  for (const e of entries) {
    if (e.local + 30 > bytes.length || dv.getUint32(e.local, true) !== 0x04034b50) fail();
    const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
    if (start + e.csize > bytes.length) fail();
    const packed = bytes.subarray(start, start + e.csize);
    const data = e.method === 0 ? packed.slice() : await inflate(packed).catch(fail);
    if (data.length !== e.usize) fail();
    out.set(e.name, data);
  }
  return out;
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run --project web web/src/vpk/`
Expected: PASS, every file in the folder (the existing VPK, zip and read tests included).

- [ ] **Step 6: Commit**

```bash
git add web/src/vpk/unzip.ts web/src/vpk/unzip.test.ts web/src/vpk/fixtures.ts
git commit -m "Read zip files in the browser, for importing a HUD"
```

---

### Task 2: Read an upload into a HUD, and name it by its contents

**Files:**
- Create: `web/src/hud/text.ts`, `web/src/hud/text.test.ts`, `web/src/hud/upload.ts`, `web/src/hud/upload.test.ts`, `web/src/hud/importFixtures.ts`

**Interfaces:**
- Consumes: `readZip`, `ZipTooBig` (Task 1); `readVPK` from `web/src/vpk/read.ts`; `BASE_PATHS`, `baseFile` from `web/src/hud/base`; `parseKv` from `web/src/hud/kv.ts`; `safeName` from `web/src/hud/design.ts`.
- Produces:
  - `type TextEncoding = 'latin1' | 'utf8bom' | 'utf16le'`; `decodeText(bytes: Uint8Array): { text: string; encoding: TextEncoding }`; `encodeText(text: string, encoding: TextEncoding): Uint8Array` in `web/src/hud/text.ts`.
  - In `web/src/hud/upload.ts`: `MAX_HUD_BYTES = 50 * 1024 * 1024`; `IMPORT_ERRORS = { notHud, tooBig, unreadable }` (the spec's three sentences); `interface HudUpload { name: string; files: Map<string, Uint8Array>; dropped: string[] }`; `readHudUpload(fileName: string, bytes: Uint8Array): Promise<HudUpload>`; `hudId(files: ReadonlyMap<string, Uint8Array>): Promise<string>` (64 lower-case hex characters).
  - In `web/src/hud/importFixtures.ts` (tests only): `latin1(s: string): Uint8Array`; `MARKER_PANEL = 'HudImpMarker'`; `sampleHud(over?: Record<string, string | Uint8Array | null>): Map<string, Uint8Array>`; `asList(files: Map<string, Uint8Array>): { path: string; data: Uint8Array }[]`.

- [ ] **Step 1: Write the failing tests** in `web/src/hud/text.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { decodeText, encodeText } from './text';

describe('text files as the game stores them', () => {
  it('round-trips every byte of a file with no byte order mark, 0x80 to 0x9f included', () => {
    const b = Uint8Array.from({ length: 256 }, (_, i) => i);
    const { text, encoding } = decodeText(b);
    expect(encoding).toBe('latin1');
    expect(text.length).toBe(256);
    expect(encodeText(text, encoding)).toEqual(b);
  });

  it('strips a UTF-8 byte order mark for reading and puts it back on writing', () => {
    const b = Uint8Array.from([0xef, 0xbb, 0xbf, 0x22, 0x61, 0x22]);
    expect(decodeText(b)).toEqual({ text: '"a"', encoding: 'utf8bom' });
    expect(encodeText('"a"', 'utf8bom')).toEqual(b);
  });

  it('reads and writes a UTF-16 file with its byte order mark', () => {
    const b = Uint8Array.from([0xff, 0xfe, 0x22, 0, 0x61, 0, 0x22, 0]);
    expect(decodeText(b)).toEqual({ text: '"a"', encoding: 'utf16le' });
    expect(encodeText('"a"', 'utf16le')).toEqual(b);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project web web/src/hud/text.test.ts`
Expected: FAIL, `Failed to resolve import "./text"`.

- [ ] **Step 3: Write `web/src/hud/text.ts`**

```ts
/**
 * An imported HUD's text files, as bytes in and bytes out.
 *
 * The editor reads a .res file as text and, when it did not change it,
 * ships the upload's own bytes; when it did, it writes the text back in the
 * encoding the file came in. Latin-1 is read by hand, not with
 * TextDecoder('latin1'), which is really windows-1252 and would turn bytes
 * 0x80 to 0x9f into other characters: read this way, any 8-bit file
 * (UTF-8 included) round-trips byte for byte. A UTF-8 byte order mark is
 * taken off so KeyValues does not read it as a key; a UTF-16 file (Valve's
 * tools write some) is decoded properly.
 */
export type TextEncoding = 'latin1' | 'utf8bom' | 'utf16le';

function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncoding } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: latin1(bytes.subarray(3)), encoding: 'utf8bom' };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf16le' };
  return { text: latin1(bytes), encoding: 'latin1' };
}

export function encodeText(text: string, encoding: TextEncoding): Uint8Array {
  if (encoding === 'utf16le') {
    const out = new Uint8Array(2 + text.length * 2);
    out[0] = 0xff; out[1] = 0xfe;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[2 + i * 2] = c & 0xff; out[3 + i * 2] = c >> 8; }
    return out;
  }
  const body = Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
  if (encoding === 'latin1') return body;
  const out = new Uint8Array(3 + body.length);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}
```

Run: `npx vitest run --project web web/src/hud/text.test.ts`. Expected: PASS.

- [ ] **Step 4: Write the test fixture** `web/src/hud/importFixtures.ts`

```ts
/**
 * Tests only: a small hand-made HUD, built from the stock files the way a
 * HUD author builds one. hudlayout.res gains a comment and an extra panel
 * (so a rewrite through writeKv would change its bytes), the teammate card
 * is stock with a comment, mod_textures.txt gains one entry, and there is a
 * texture with its material, a panel file the editor does not model and a
 * sound. `over` replaces a file, adds one, or (null) removes one.
 */
import { baseFile } from './base';

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
```

- [ ] **Step 5: Write the failing tests** in `web/src/hud/upload.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { readHudUpload, hudId, IMPORT_ERRORS, MAX_HUD_BYTES } from './upload';
import { encodeVPK } from '../vpk';
import { encodeZip } from '../vpk/zip';
import { handMade, zipOf } from '../vpk/fixtures';
import { sampleHud, asList, latin1 } from './importFixtures';

const vpkOf = (files: Map<string, Uint8Array>) => encodeVPK(asList(files));
const under = (folder: string, files: Map<string, Uint8Array>, deflate = true) =>
  asList(files).map((f) => ({ path: folder + f.path.replace('scripts/hudlayout.res', 'scripts/HudLayout.res'), data: f.data, deflate }));

describe('readHudUpload', () => {
  it('takes a .vpk whole: its root is the HUD root', async () => {
    const files = sampleHud();
    const got = await readHudUpload('edgehud.vpk', vpkOf(files));
    expect(got.name).toBe('edgehud');
    expect(got.files).toEqual(files);
    expect(got.dropped).toEqual([]);
  });

  it('finds the HUD folder nested inside a zip, lower-casing every path, and is named after it', async () => {
    const files = sampleHud();
    const got = await readHudUpload('download (3).zip', await zipOf(under('Edge HUD v2/EdgeHUD/', files)));
    expect(got.name).toBe('edgehud');
    expect([...got.files.keys()].sort()).toEqual([...files.keys()].sort());
    expect(got.files.get('scripts/hudlayout.res')).toEqual(files.get('scripts/hudlayout.res'));
  });

  it('drops gameinfo.txt wherever it is and every file outside the HUD root, and says which', async () => {
    const zip = await zipOf([
      ...under('edgehud/', sampleHud()),
      { path: 'gameinfo.txt', data: latin1('"GameInfo" {}') },
      { path: 'edgehud/gameinfo.txt', data: latin1('"GameInfo" {}') },
      { path: 'README.txt', data: latin1('read me') },
    ]);
    const got = await readHudUpload('edgehud.zip', zip);
    expect(got.dropped).toEqual(['README.txt', 'edgehud/gameinfo.txt', 'gameinfo.txt']);
    expect(got.files.has('gameinfo.txt')).toBe(false);
    expect(got.files.has('readme.txt')).toBe(false);
  });

  it("imports the VPK inside a zip that has no loose HUD, like the editor's own Advanced download", async () => {
    const files = sampleHud();
    const zip = encodeZip([{ path: 'riversidehud/pak01_dir.vpk', data: vpkOf(files) }, { path: 'README.txt', data: latin1('x') }]);
    const got = await readHudUpload('my_hud.zip', zip);
    expect(got.files).toEqual(files);
    expect(got.name).toBe('my_hud');
    expect(got.dropped).toEqual(['README.txt']);
  });

  it('says a file without scripts/hudlayout.res is not a HUD', async () => {
    const vpk = encodeVPK([{ path: 'materials/vgui/hud/x.vtf', data: new Uint8Array(4) }]);
    await expect(readHudUpload('x.vpk', vpk)).rejects.toThrow(IMPORT_ERRORS.notHud);
    await expect(readHudUpload('x.zip', await zipOf([{ path: 'hud/readme.txt', data: latin1('x') }]))).rejects.toThrow(IMPORT_ERRORS.notHud);
  });

  it('says a HUD over 50 MB is too big, by its own size or by the sizes a zip declares', async () => {
    await expect(readHudUpload('big.vpk', new Uint8Array(MAX_HUD_BYTES + 1))).rejects.toThrow(IMPORT_ERRORS.tooBig);
    const zip = await zipOf([{ path: 'scripts/hudlayout.res', data: latin1('"x" {}') }]);
    const dv = new DataView(zip.buffer);
    const cd = dv.getUint32(zip.length - 22 + 16, true);
    dv.setUint32(cd + 24, MAX_HUD_BYTES + 1, true);          // the central directory's unpacked size
    await expect(readHudUpload('big.zip', zip)).rejects.toThrow(IMPORT_ERRORS.tooBig);
  });

  it('says it could not read anything that is not a whole VPK or zip', async () => {
    await expect(readHudUpload('notes.txt', latin1('hello'))).rejects.toThrow(IMPORT_ERRORS.unreadable);
    await expect(readHudUpload('broken.vpk', new Uint8Array([0x34, 0x12, 0xaa, 0x55, 9, 0, 0, 0, 0, 0, 0, 0]))).rejects.toThrow(IMPORT_ERRORS.unreadable);
    const split = handMade([{ path: 'scripts/hudlayout.res', archive: 0, offset: 0, length: 10, preload: new Uint8Array(0) }]);
    await expect(readHudUpload('hud_dir.vpk', split)).rejects.toThrow(IMPORT_ERRORS.unreadable);
  });

  it('names a file the editor parses that KeyValues cannot read', async () => {
    const files = sampleHud({ 'scripts/hudlayout.res': '"Resource/HudLayout.res"\r\n{\r\n' });
    await expect(readHudUpload('bad.vpk', vpkOf(files))).rejects.toThrow(/^This HUD's scripts\/hudlayout\.res could not be read \(/);
  });
});

describe('hudId', () => {
  it('is the same for the same files, however they arrived, and differs when one byte does', async () => {
    const files = sampleHud();
    const a = await hudId((await readHudUpload('a.vpk', vpkOf(files))).files);
    const b = await hudId((await readHudUpload('b.zip', await zipOf(under('x/', files)))).files);
    const reversed = await hudId(new Map([...files].reverse()));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(reversed).toBe(a);
    const changed = sampleHud({ 'sound/ui/edge.wav': new Uint8Array([82, 73, 70, 70, 1, 2, 4]) });
    expect(await hudId(changed)).not.toBe(a);
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `npx vitest run --project web web/src/hud/upload.test.ts`
Expected: FAIL, `Failed to resolve import "./upload"`.

- [ ] **Step 7: Write `web/src/hud/upload.ts`**

```ts
/**
 * Import a HUD: a player's .vpk addon, or a .zip of a HUD folder, read into
 * the HUD's own files.
 *
 * The HUD root is what the game mounts: a .vpk's root, or in a zip the
 * folder that holds scripts/hudlayout.res, however deep (the shallowest
 * wins). Paths are lower case with forward slashes, as the game looks them
 * up and as readVPK already gives them. gameinfo.txt is never a HUD file
 * and shipping one in an addon could break the game, so it is dropped
 * wherever it is, along with everything outside the root; `dropped` names
 * them so the page can say so.
 *
 * Every file the editor parses is parsed here once, so a HUD whose files
 * KeyValues cannot read is refused with the file's name rather than failing
 * later inside the canvas draw.
 */
import { readVPK } from '../vpk/read';
import { readZip, ZipTooBig } from '../vpk/unzip';
import { parseKv } from './kv';
import { BASE_PATHS } from './base';
import { decodeText } from './text';
import { safeName } from './design';

export const MAX_HUD_BYTES = 50 * 1024 * 1024;
export const IMPORT_ERRORS = {
  notHud: 'This file has no scripts/hudlayout.res, so it is not a HUD',
  tooBig: 'This HUD is over 50 MB',
  unreadable: 'Could not read this file as a VPK or zip',
} as const;

export interface HudUpload { name: string; files: Map<string, Uint8Array>; dropped: string[] }

const LAYOUT = 'scripts/hudlayout.res';
const isVpk = (b: Uint8Array) => b.length >= 4 && b[0] === 0x34 && b[1] === 0x12 && b[2] === 0xaa && b[3] === 0x55;
const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b;
const fail = (why: string): never => { throw new Error(why); };
const total = (m: Map<string, Uint8Array>) => [...m.values()].reduce((n, d) => n + d.length, 0);

/** A single-file VPK's files, or the unreadable sentence: a split addon's _dir.vpk is missing most of its data. */
function vpkFiles(bytes: Uint8Array): Map<string, Uint8Array> {
  const split = new Set<string>();
  let files: Map<string, Uint8Array>;
  try { files = readVPK(bytes, split); } catch { return fail(IMPORT_ERRORS.unreadable); }
  if (split.size) fail(IMPORT_ERRORS.unreadable);
  if (total(files) > MAX_HUD_BYTES) fail(IMPORT_ERRORS.tooBig);
  return files;
}

/** The HUD root among lower-cased paths: '' for the top, 'a/b/' for a folder, null when none holds the layout. */
function hudRoot(paths: string[]): string | null {
  const roots = paths.filter((p) => p === LAYOUT || p.endsWith(`/${LAYOUT}`))
    .map((p) => p.slice(0, p.length - LAYOUT.length))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  return roots[0] ?? null;
}

const nameOf = (fileName: string, root: string) => {
  const folder = root.replace(/\/$/, '').split('/').pop();
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.(vpk|zip)$/i, '').replace(/_dir$/i, '');
  return safeName(folder || base);
};

/** Refuse a HUD whose files the editor parses cannot be read, naming the file. */
function checkParses(files: Map<string, Uint8Array>) {
  for (const path of BASE_PATHS) {
    const data = files.get(path);
    if (!data || path === 'scripts/hudanimations.txt') continue;           // hudanimations.txt is not KeyValues
    try { parseKv(decodeText(data).text); }
    catch (e) { fail(`This HUD's ${path} could not be read (${(e as Error).message})`); }
  }
}

export async function readHudUpload(fileName: string, bytes: Uint8Array): Promise<HudUpload> {
  if (bytes.length > MAX_HUD_BYTES) fail(IMPORT_ERRORS.tooBig);
  let entries: Map<string, Uint8Array>;
  const original = new Map<string, string>();                  // lower-cased path -> the name as the zip spells it
  if (isVpk(bytes)) entries = vpkFiles(bytes);
  else if (isZip(bytes)) {
    let raw: Map<string, Uint8Array>;
    try { raw = await readZip(bytes, MAX_HUD_BYTES); }
    catch (e) { return fail(e instanceof ZipTooBig ? IMPORT_ERRORS.tooBig : IMPORT_ERRORS.unreadable); }
    entries = new Map();
    for (const [name, data] of raw) { const p = name.toLowerCase(); entries.set(p, data); original.set(p, name); }
  } else return fail(IMPORT_ERRORS.unreadable);

  const root = hudRoot([...entries.keys()]);
  if (root === null && original.size) {
    // No loose HUD in the zip: a VPK inside it that holds one, shallowest
    // first. That is a gameinfo-mounted folder's pak01_dir.vpk (the editor's
    // own Advanced download), whose root is the archive root, so the name
    // comes from the upload's file name.
    const vpks = [...entries.keys()].filter((p) => p.endsWith('.vpk')).sort((a, b) => a.split('/').length - b.split('/').length);
    for (const p of vpks) {
      let inner: Map<string, Uint8Array>;
      try { inner = vpkFiles(entries.get(p)!); } catch { continue; }
      if (!inner.has(LAYOUT)) continue;
      const dropped = [...original].filter(([q]) => q !== p).map(([, name]) => name);
      return finish(nameOf(fileName, ''), inner, dropped);
    }
  }
  if (root === null) return fail(IMPORT_ERRORS.notHud);
  const files = new Map<string, Uint8Array>();
  const dropped: string[] = [];
  for (const [p, data] of entries) {
    const inRoot = p.startsWith(root);
    const rel = inRoot ? p.slice(root.length) : p;
    if (!inRoot || rel === 'gameinfo.txt' || rel.endsWith('/gameinfo.txt')) { dropped.push(original.get(p) ?? p); continue; }
    files.set(rel, data);
  }
  return finish(nameOf(fileName, root), files, dropped.sort());
}

function finish(name: string, files: Map<string, Uint8Array>, dropped: string[]): HudUpload {
  for (const p of [...files.keys()]) if (p === 'gameinfo.txt' || p.endsWith('/gameinfo.txt')) { files.delete(p); dropped.push(p); }
  checkParses(files);
  return { name, files, dropped: dropped.sort() };
}

/**
 * The HUD's identity: SHA-256 of its canonical file list, every path in
 * sorted order followed by its length and its bytes. The same HUD imported
 * twice, from a .vpk or a zip, is one id, so it is one stored entry, and a
 * design that names an id can never open against different files.
 */
export async function hudId(files: ReadonlyMap<string, Uint8Array>): Promise<string> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const path of [...files.keys()].sort()) {
    const data = files.get(path)!;
    parts.push(enc.encode(`${path}\0${data.length}\0`), data);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `npx vitest run --project web web/src/hud/upload.test.ts web/src/hud/text.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/src/hud/text.ts web/src/hud/text.test.ts web/src/hud/upload.ts web/src/hud/upload.test.ts web/src/hud/importFixtures.ts
git commit -m "Read an uploaded HUD from a VPK or zip and name it by its contents"
```

---

### Task 3: The imported layer: base files, the design and every cache keyed on the import

**Files:**
- Modify: `web/src/hud/base/index.ts` (whole file), `web/src/hud/design.ts:10,148,287-350,379-420,455-480`, `web/src/hud/build.ts` (Work, chatBaseSize, baseRect, fitPass, cardWork, baseHasChild, teamLayout, baseFontTall, buildHud, buildTrees, elementRect), `web/src/hud/elements.ts:34`, `web/src/hud/edit.ts:251,300,376,422`, `web/src/hud/selection.ts:400`, `web/src/routes/hud/ContextPanel.tsx:464`
- Test: `web/src/hud/imported.test.ts` (new)

**Interfaces:**
- Consumes: `decodeText` (Task 2); `sampleHud`, `MARKER_PANEL` (Task 2 fixtures).
- Produces (all in `web/src/hud/base/index.ts` unless said):
  - `type Preset = 'stock' | 'modern' | 'imported'`
  - `type BaseKey = 'stock' | 'modern' | \`imported:${string}\``
  - `class MissingImportError extends Error { readonly id: string }`
  - `registerImport(id: string, files: ReadonlyMap<string, Uint8Array>): void`, `unregisterImport(id: string): void`, `hasImport(id: string): boolean`
  - `importedFiles(key: BaseKey): ReadonlyMap<string, Uint8Array> | null` (null for stock and modern; throws `MissingImportError` for an unregistered import)
  - `baseOf(d: { preset: Preset; imported?: { id: string } }): BaseKey`
  - `baseFile(key: BaseKey, path: string): string`, `presetOverrides(key: BaseKey, path: string): boolean`
  - In `design.ts`: `interface ImportedRef { id: string; name: string }`; `HudDesign.imported?: ImportedRef`; `baseTeam(key: BaseKey)`, `baseContent(key: BaseKey)`.
  - In `build.ts`: `baseHasChild(key: BaseKey, name: string)`; `Work` is constructed with a `BaseKey`.

- [ ] **Step 1: Write the failing tests** in `web/src/hud/imported.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { baseFile, baseOf, registerImport, unregisterImport, hasImport, MissingImportError } from './base';
import { baseTeam, validateDesign, decodeShare, encodeShare } from './design';
import { buildTrees, baseHasChild } from './build';
import { parseKv, writeKv, kvFind, kvSet, type KvNode } from './kv';
import { sampleHud, latin1, MARKER_PANEL } from './importFixtures';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
afterEach(() => { unregisterImport(A); unregisterImport(B); });

const TEAM = 'resource/ui/hud/teamdisplayhud.res';
/** The stock team file with TeamPlayer2 moved down: a column, not a row. */
const columnTeam = () => {
  const t = parseKv(baseFile('stock', TEAM));
  kvSet(kvFind(t[0].value as KvNode[], ['TeamPlayer2'])!, 'ypos', '99');
  return writeKv(t);
};

describe('the imported layer', () => {
  it("reads the upload's copy of a file, whatever case the editor asks in, and the stock file where the upload has none", () => {
    registerImport(A, sampleHud());
    expect(baseFile(`imported:${A}`, 'scripts/hudlayout.res')).toContain(MARKER_PANEL);
    expect(baseFile(`imported:${A}`, 'Scripts/HudLayout.res')).toContain(MARKER_PANEL);
    expect(baseFile(`imported:${A}`, 'resource/ui/basechat.res')).toBe(baseFile('stock', 'resource/ui/basechat.res'));
  });

  it('fails with MissingImportError, never with stock, when the HUD is not loaded in this browser', () => {
    expect(hasImport(A)).toBe(false);
    expect(() => baseFile(`imported:${A}`, 'scripts/hudlayout.res')).toThrow(MissingImportError);
  });

  it('strips a UTF-8 byte order mark before the editor parses a file', () => {
    const text = baseFile('stock', TEAM);
    registerImport(A, sampleHud({ [TEAM]: new Uint8Array([0xef, 0xbb, 0xbf, ...latin1(text)]) }));
    expect(baseFile(`imported:${A}`, TEAM)).toBe(text);
  });

  it('keys the base team on the import, so two imports never share it', () => {
    registerImport(A, sampleHud());
    registerImport(B, sampleHud({ [TEAM]: columnTeam() }));
    expect(baseTeam(`imported:${A}`).dir).toBe('row');
    expect(baseTeam(`imported:${B}`).dir).toBe('column');
    expect(baseTeam('stock').dir).toBe('row');
  });

  it("asks the import's own card file whether a child is there", () => {
    registerImport(A, sampleHud({ 'resource/ui/hud/teammatepanel.res': baseFile('modern', 'resource/ui/hud/teammatepanel.res') }));
    expect(baseHasChild('stock', 'HealthNumber')).toBe(false);
    expect(baseHasChild(`imported:${A}`, 'HealthNumber')).toBe(true);
  });

  it("builds an imported design's trees from the upload, and a stock design's from stock", () => {
    registerImport(A, sampleHud());
    const d = validateDesign({ v: 1, preset: 'imported', imported: { id: A, name: 'edgehud' }, crosshair: 'none' });
    expect(baseOf(d)).toBe(`imported:${A}`);
    expect(kvFind(buildTrees(d)('scripts/hudlayout.res'), [MARKER_PANEL])).toBeDefined();
    expect(kvFind(buildTrees(validateDesign({ v: 1, preset: 'stock' }))('scripts/hudlayout.res'), [MARKER_PANEL])).toBeUndefined();
  });
});

describe('validateDesign on an imported design', () => {
  it('keeps the HUD reference with a safe name, and the HUD keeps its own fonts', () => {
    const d = validateDesign({ v: 1, preset: 'imported', imported: { id: A, name: 'edge<hud>' }, font: 'roboto' });
    expect(d.preset).toBe('imported');
    expect(d.imported).toEqual({ id: A, name: 'edgehud' });
    expect(d.font).toBe('preset');
  });

  it('turns an imported design with no usable reference into Stock, and drops a reference from any other preset', () => {
    expect(validateDesign({ v: 1, preset: 'imported', imported: { id: 'nope', name: 'x' } }).preset).toBe('stock');
    expect(validateDesign({ v: 1, preset: 'imported', imported: { id: A.toUpperCase(), name: 'x' } }).preset).toBe('stock');
    expect(validateDesign({ v: 1, preset: 'imported' }).imported).toBeUndefined();
    expect(validateDesign({ v: 1, preset: 'modern', imported: { id: A, name: 'x' } }).imported).toBeUndefined();
  });

  it('validates a design whose HUD is not loaded without touching its files, dropping the legacy spacing', () => {
    const d = validateDesign({ v: 1, preset: 'imported', imported: { id: A, name: 'e' }, elements: { teamColumn: { spacing: 140, scale: 1.2 } } });
    expect(d.elements.teamColumn).toEqual({ scale: 1.2 });
  });

  it('carries the reference, not the files, through a share link', async () => {
    const d = validateDesign({ v: 1, preset: 'imported', imported: { id: A, name: 'edgehud' } });
    const back = await decodeShare(await encodeShare(d));
    expect(back?.preset).toBe('imported');
    expect(back?.imported).toEqual({ id: A, name: 'edgehud' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project web web/src/hud/imported.test.ts`
Expected: FAIL: `registerImport` is not exported from `./base` (a TypeError on the first call), and the validateDesign tests fail on `preset` being `'stock'`.

- [ ] **Step 3: Rewrite `web/src/hud/base/index.ts`**

```ts
/**
 * The HUD files every build starts from.
 *
 * `stock` is the game's own files, untouched. `modern` holds only the files the
 * Modern HUD overrides and falls back to stock for the rest, which is exactly
 * how the game resolves them when the Modern HUD is mounted. An imported HUD
 * is the same kind of layer: the player's upload, falling back to stock
 * whole-file where the upload has no copy, because that is how the game
 * resolves an addon's files. It is never merged key by key.
 *
 * Everything that reads a base file takes a BaseKey rather than a Preset:
 * the preset alone cannot tell two imports apart, and every cache of a
 * parsed base file is keyed by it. An import's id is the SHA-256 of its
 * files (upload.ts's hudId), so what a key names never changes and a cache
 * entry for it stays valid for ever.
 *
 * The imported files live in a synchronous in-memory registry, filled by
 * the page from IndexedDB before it first draws, so baseFile stays
 * synchronous. An import that is not in the registry throws
 * MissingImportError: falling back to stock would draw the wrong HUD and
 * cache it under the import's key.
 */
import { decodeText } from '../text';

export type Preset = 'stock' | 'modern' | 'imported';
export type BaseKey = 'stock' | 'modern' | `imported:${string}`;

const RAW = import.meta.glob('./{stock,modern}/**/*.{res,txt}', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const at = (preset: 'stock' | 'modern', path: string) => RAW[`./${preset}/${path}`];

export const BASE_PATHS: string[] = Object.keys(RAW)
  .filter((k) => k.startsWith('./stock/'))
  .map((k) => k.slice('./stock/'.length))
  .sort();

export class MissingImportError extends Error {
  constructor(readonly id: string) { super(`The imported HUD ${id.slice(0, 12)} is not loaded in this browser`); }
}

const IMPORTS = new Map<string, ReadonlyMap<string, Uint8Array>>();
/** Paths are lower case with forward slashes, as upload.ts gives them. */
export function registerImport(id: string, files: ReadonlyMap<string, Uint8Array>): void { IMPORTS.set(id, files); }
export function unregisterImport(id: string): void { IMPORTS.delete(id); }
export function hasImport(id: string): boolean { return IMPORTS.has(id); }

/** The upload's files for an imported key, null for Stock and Modern. */
export function importedFiles(key: BaseKey): ReadonlyMap<string, Uint8Array> | null {
  if (!key.startsWith('imported:')) return null;
  const id = key.slice('imported:'.length);
  const files = IMPORTS.get(id);
  if (!files) throw new MissingImportError(id);
  return files;
}

/** A design's base key. validateDesign never lets an imported design through without its reference. */
export function baseOf(d: { preset: Preset; imported?: { id: string } }): BaseKey {
  if (d.preset !== 'imported') return d.preset;
  if (!d.imported) throw new Error('An imported design has no imported HUD');
  return `imported:${d.imported.id}`;
}

export function baseFile(key: BaseKey, path: string): string {
  const layer = importedFiles(key);
  if (layer) {
    const own = layer.get(path.toLowerCase());
    return own ? decodeText(own).text : baseFile('stock', path);
  }
  const text = at(key as 'stock' | 'modern', path) ?? at('stock', path);
  if (text === undefined) throw new Error(`No base HUD file ${path}`);
  return text;
}

/**
 * True when Modern ships its own copy, so a build must include the file even
 * if nothing else touches it. An import's own files reach the download
 * through buildHud's pass-through instead, byte for byte.
 */
export function presetOverrides(key: BaseKey, path: string): boolean {
  return key === 'modern' && at('modern', path) !== undefined;
}
```

- [ ] **Step 4: `web/src/hud/design.ts`**

Change the import on line 10 to:

```ts
import { baseFile, baseOf, type Preset, type BaseKey } from './base';
```

Above `export interface HudDesign`, add:

```ts
/**
 * The imported HUD a design is built on: its content hash (upload.ts's
 * hudId) and the name the upload gave it. The files themselves are never in
 * the design, so a share link or an exported file carries only this, and
 * opens on another browser with the missing-import banner until the same
 * HUD is imported there.
 */
export interface ImportedRef { id: string; name: string }
```

In `HudDesign`, after `preset: Preset;` add:

```ts
  /** Only with preset 'imported': which import. validateDesign drops it anywhere else. */
  imported?: ImportedRef;
```

Replace `BASE_TEAMS`, `baseTeam`, `BASE_CONTENT` and `baseContent` so they take and key on a `BaseKey` (bodies otherwise unchanged):

```ts
const BASE_TEAMS = new Map<BaseKey, BaseTeam>();
export function baseTeam(key: BaseKey): BaseTeam {
  const hit = BASE_TEAMS.get(key);
  if (hit) return hit;
  const tree = parseKv(baseFile(key, TEAM_FILE))[0].value as KvNode[];
  // ...the existing body, unchanged...
  BASE_TEAMS.set(key, out);
  return out;
}
```

```ts
const BASE_CONTENT = new Map<BaseKey, Box | null>();
/** The base's own card, fitted with no inside edits: stock 121 x 36, Modern 113 x 26. */
export function baseContent(key: BaseKey): Box | null {
  if (!BASE_CONTENT.has(key)) {
    BASE_CONTENT.set(key, contentBox(parseKv(baseFile(key, TEAM_PANEL.file))[0].value as KvNode[]));
  }
  return BASE_CONTENT.get(key)!;
}
```

`teamFields(raw, out, preset: Preset)` becomes `teamFields(raw, out, key: BaseKey)`; its `baseTeam(preset)` and `baseContent(preset)` become `baseTeam(key)` and `baseContent(key)`, and the spacing migration is skipped on an import. Replace its `if (out.gap === undefined && typeof raw.spacing === 'number' ...)` condition with:

```ts
  // `spacing` is from before designs had `gap`, long before imports existed,
  // so an imported design never carries it: it is dropped rather than
  // migrated, which also keeps validation off the import's files, which may
  // not be loaded yet.
  if (!key.startsWith('imported:') && out.gap === undefined && typeof raw.spacing === 'number' && Number.isFinite(raw.spacing)) {
```

`element(id, raw, preset: Preset)` becomes `element(id, raw, key: BaseKey)` and passes `key` to `teamFields`.

Add below `safeName`:

```ts
/** A stored reference, or nothing: an id is exactly hudId's 64 lower-case hex characters. */
function importedRef(v: unknown): ImportedRef | undefined {
  if (!isObj(v) || typeof v.id !== 'string' || !/^[0-9a-f]{64}$/.test(v.id) || typeof v.name !== 'string') return undefined;
  return { id: v.id, name: safeName(v.name) };
}
```

In `validateDesign`, replace the `d.preset = ...` and `d.font = ...` lines with:

```ts
  d.preset = oneOf(raw.preset, ['stock', 'modern', 'imported'] as const, 'stock');
  if (d.preset === 'imported') {
    const ref = importedRef(raw.imported);
    if (ref) d.imported = ref; else d.preset = 'stock';
  }
  d.aspect = oneOf(raw.aspect, ['16:9', '16:10', '4:3'] as const, '16:9');
  // An imported HUD brings its own fonts: Roboto's CustomFontFiles entries
  // would overwrite the upload's own entries 7 and 8.
  d.font = d.preset === 'imported' ? 'preset' : oneOf(raw.font, ['preset', 'roboto'] as const, 'preset');
```

(remove the old `d.aspect` line so it appears once), and in the elements loop use `const e = element(id, v, baseOf(d));`.

- [ ] **Step 5: `web/src/hud/build.ts`**

- Line 11: `import { baseFile, baseOf, importedFiles, presetOverrides, BASE_PATHS, type BaseKey } from './base';` (`importedFiles` is used from Task 4 on; if the typechecker flags it unused now, add it in Task 4 instead).
- `class Work`: `constructor(readonly key: BaseKey) {}`; every `this.preset` becomes `this.key`.
- `chatBaseSize(preset: Preset, W)` becomes `chatBaseSize(key: BaseKey, W)`, reading `baseFile(key, BASECHAT)`.
- `baseRect(panel, el, preset: Preset, aspect)` becomes:

```ts
function baseRect(panel: KvNode, el: HudElement, key: BaseKey, aspect: Aspect) {
  const W = screenW(aspect);
  const chat = el.id === 'chat' ? chatBaseSize(key, W) : undefined;
  // mockSize is measured on the two built-in presets; an import is sized by its own file.
  const mock = key === 'stock' || key === 'modern' ? el.mockSize?.[key] : undefined;
  const w = chat?.w ?? mock?.w ?? parseSize(kvGet(panel, 'wide') ?? '0', W);
  const h = chat?.h ?? mock?.h ?? parseSize(kvGet(panel, 'tall') ?? '0', SCREEN_H);
  return { x: parsePos(kvGet(panel, 'xpos') ?? '0', W), y: parsePos(kvGet(panel, 'ypos') ?? '0', SCREEN_H), w, h };
}
```

- `layoutPass`: `baseRect(panel, el, work.key, design.aspect)`.
- `fitPass`: `let size = baseTeam(baseOf(design)).card;`
- `cardWork`: `const work = new Work(baseOf(design));`
- `baseHasChild`:

```ts
/** Whether the base's own card file has this child: an addable child it lacks shows as a checkbox. */
export function baseHasChild(key: BaseKey, name: string): boolean {
  return kvFind(parseKv(baseFile(key, CARD))[0].value as KvNode[], [name]) !== undefined;
}
```

- `teamLayout`: `const layoutPanel = () => kvFind(parseKv(baseFile(baseOf(design), LAYOUT))[0].value as KvNode[], [el.key]);` and `const base = baseTeam(baseOf(design));`
- `BASE_SCHEMES` becomes `new Map<BaseKey, KvNode[]>()`, `baseFontTall(key: BaseKey, font)` reads `baseFile(key, SCHEME)`, and `weaponsPass` calls `baseFontTall(work.key, ...)`.
- `buildHud`, `buildTrees`: `new Work(baseOf(design))`. `elementRect`: `const work = new Work(baseOf(design));` and `baseRect(panel, el, baseOf(design), design.aspect)`.

- [ ] **Step 6: The other callers**

- `web/src/hud/elements.ts:34`: `mockSize?: Partial<Record<'stock' | 'modern', { w: number; h: number }>>;` and drop the now-unused `import type { Preset } from './base';`.
- `web/src/hud/edit.ts` lines 251, 300, 376, 422: `baseTeam(design.preset)` becomes `baseTeam(baseOf(design))`; add `import { baseOf } from './base';`.
- `web/src/hud/selection.ts:400`: the same, with the same import.
- `web/src/routes/hud/ContextPanel.tsx:464`: `!baseHasChild(baseOf(design), name)`; add `import { baseOf } from '../../hud/base';`.

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run --project web web/src/hud/ && npm run typecheck`
Expected: PASS, including `download.golden.test.ts` with its hashes untouched and `art.test.ts`'s boundary walk (build.ts now reaches `text.ts`, which imports nothing).

- [ ] **Step 8: Commit**

```bash
git add web/src/hud web/src/routes/hud/ContextPanel.tsx
git commit -m "Treat an imported HUD as a layer over stock, keyed by its content hash"
```

---

### Task 4: Download an imported HUD: its own files, byte for byte, plus the edits

**Files:**
- Modify: `web/src/hud/build.ts` (`Work.files`, `buildHud`, `packHud`), `web/src/vpk/index.ts` (`encodeVPK`), `web/src/hud/sample.vpkcheck.test.ts`
- Test: `web/src/hud/imported.build.test.ts` (new), `web/src/vpk/vpk.test.ts`

**Interfaces:**
- Consumes: `importedFiles`, `baseOf`, `registerImport` (Task 3); `decodeText`, `encodeText` (Task 2); `sampleHud`, `MARKER_PANEL`, `latin1` (Task 2 fixtures).
- Produces:
  - `interface BuildReport { replaced: string[] }` in `build.ts`.
  - `buildHud(design: HudDesign, assets?: BuildAssets, report?: BuildReport): VpkFile[]`
  - `packHud(design: HudDesign, assets?: BuildAssets, report?: BuildReport): { filename: string; mime: string; bytes: Uint8Array }`
  - `report.replaced`: sorted upload paths a generated file replaced (a font copy, a generated texture, the crosshair).

- [ ] **Step 1: Write the failing tests** in `web/src/hud/imported.build.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { buildHud, packHud, CLEAR_TEXTURE, type BuildReport } from './build';
import { validateDesign, type HudDesign } from './design';
import { registerImport, unregisterImport } from './base';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { decodeText } from './text';
import { readVPK } from '../vpk/read';
import { parsePos, screenW, SCREEN_H } from './units';
import { sampleHud, latin1, MARKER_PANEL } from './importFixtures';

const ID = 'c'.repeat(64);
afterEach(() => unregisterImport(ID));

/** An imported design on `files`, with the game's own crosshair so layoutPass adds no xHair. */
const imported = (files: Map<string, Uint8Array>, extra: Record<string, unknown> = {}): HudDesign => {
  registerImport(ID, files);
  return validateDesign({ v: 1, name: 'edgehud', preset: 'imported', imported: { id: ID, name: 'edgehud' }, crosshair: 'none', ...extra });
};
const byPath = (files: { path: string; data: Uint8Array }[]) => new Map(files.map((f) => [f.path, f.data]));
const root = (m: Map<string, Uint8Array>, path: string) => parseKv(decodeText(m.get(path)!).text)[0].value as KvNode[];

describe('downloading an imported HUD', () => {
  it('gives the upload back byte for byte when nothing is edited, plus the addoninfo.txt the editor writes', () => {
    const files = sampleHud();
    const out = byPath(buildHud(imported(files)));
    expect([...out.keys()].sort()).toEqual([...files.keys(), 'addoninfo.txt'].sort());
    for (const [path, data] of files) expect(out.get(path), path).toEqual(data);
    expect(decodeText(out.get('addoninfo.txt')!).text).toContain('"edgehud"');
  });

  it("keeps the upload's own addoninfo.txt as it is", () => {
    const info = latin1('"AddonInfo" { addontitle "Edge" }');
    const out = byPath(buildHud(imported(sampleHud({ 'addoninfo.txt': info }))));
    expect(out.get('addoninfo.txt')).toEqual(info);
  });

  it('passes the files the editor does not know through unchanged', () => {
    const files = sampleHud();
    const out = byPath(buildHud(imported(files, { elements: { ownHealth: { x: 20, y: 300 } } })));
    for (const p of ['sound/ui/edge.wav', 'resource/ui/edgepanel.res', 'materials/vgui/hud/myart.vtf', 'materials/vgui/hud/myart.vmt']) {
      expect(out.get(p), p).toEqual(files.get(p));
    }
  });

  it("lands a moved element in the upload's hudlayout.res, keeping the upload's own panels", () => {
    const out = byPath(buildHud(imported(sampleHud(), { elements: { ownHealth: { x: 20, y: 300 } } })));
    const panel = (key: string) => kvFind(root(out, 'scripts/hudlayout.res'), [key])!;
    // The anchor token depends on the panel's size, so the test reads the position back through it.
    expect(parsePos(kvGet(panel('CHudLocalPlayerDisplay'), 'xpos')!, screenW('16:9'))).toBe(20);
    expect(parsePos(kvGet(panel('CHudLocalPlayerDisplay'), 'ypos')!, SCREEN_H)).toBe(300);
    expect(kvGet(panel(MARKER_PANEL), 'xpos')).toBe('5');
  });

  it("lands a teammate child edit in the upload's card file", () => {
    const out = byPath(buildHud(imported(sampleHud(), { children: { teamColumn: { Name: { x: 30 } } } })));
    expect(kvGet(kvFind(root(out, 'resource/ui/hud/teammatepanel.res'), ['Name'])!, 'xpos')).toBe('30');
  });

  it("styles the weapons in the upload's mod_textures.txt, and reports an upload file a generated one replaced", () => {
    const report: BuildReport = { replaced: [] };
    const out = byPath(buildHud(imported(sampleHud(), { weapons: { boxActive: { kind: 'hidden' } } }), {}, report));
    const cells = kvFind(root(out, 'scripts/mod_textures.txt'), ['TextureData'])!.value as KvNode[];
    expect(kvFind(cells, ['hudimp_extra'])).toBeDefined();
    expect(kvGet(kvFind(cells, ['rounded_background_glow'])!, 'file')).toBe(CLEAR_TEXTURE);
    expect(report.replaced).toEqual([]);

    unregisterImport(ID);
    const theirs = new Uint8Array([1, 2, 3]);
    const again: BuildReport = { replaced: [] };
    const out2 = byPath(buildHud(imported(sampleHud({ [`materials/${CLEAR_TEXTURE}.vtf`]: theirs }), { weapons: { boxActive: { kind: 'hidden' } } }), {}, again));
    expect(again.replaced).toEqual([`materials/${CLEAR_TEXTURE}.vtf`]);
    expect(out2.get(`materials/${CLEAR_TEXTURE}.vtf`)).not.toEqual(theirs);
  });

  it('writes an edited file back in the encoding it came in', () => {
    const card = decodeText(sampleHud().get('resource/ui/hud/teammatepanel.res')!).text;
    const files = sampleHud({ 'resource/ui/hud/teammatepanel.res': new Uint8Array([0xef, 0xbb, 0xbf, ...latin1(card)]) });
    const out = byPath(buildHud(imported(files, { children: { teamColumn: { Name: { x: 30 } } } })));
    const data = out.get('resource/ui/hud/teammatepanel.res')!;
    expect([...data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(kvGet(kvFind(root(out, 'resource/ui/hud/teammatepanel.res'), ['Name'])!, 'xpos')).toBe('30');
  });

  it('packs the same files into the VPK', () => {
    const d = imported(sampleHud());
    const vpk = readVPK(packHud(d).bytes);
    expect(new Map([...vpk])).toEqual(byPath(buildHud(d)));
  });
});
```

Add to `web/src/vpk/vpk.test.ts`, inside its existing top-level `describe`, and import `readVPK` from `./read` if the file does not already:

```ts
  it('packs a file with no extension under a blank extension, as Valve does, and reads it back', () => {
    const got = readVPK(encodeVPK([{ path: 'docs/LICENSE', data: new Uint8Array([7]) }, { path: 'README', data: new Uint8Array([8]) }]));
    expect(got.get('docs/license')).toEqual(new Uint8Array([7]));
    expect(got.get('readme')).toEqual(new Uint8Array([8]));
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project web web/src/hud/imported.build.test.ts web/src/vpk/vpk.test.ts`
Expected: FAIL. The round trip is missing every upload file the passes never touched (only `scripts/hudlayout.res` and `addoninfo.txt` come back, and hudlayout.res has lost its comment), and the VPK test reads `docs/licens.license`.

- [ ] **Step 3: `encodeVPK` in `web/src/vpk/index.ts`**

Replace the three lines that split `base` into name and extension with:

```ts
    // A file with no extension is stored under a blank one, which the format
    // writes as a single space (readVPK reads it back the same way). An
    // imported HUD can carry one, a LICENSE say, and it passes through.
    const dot = base.lastIndexOf('.');
    const name = dot < 0 ? base : base.slice(0, dot);
    const ext = dot < 0 ? ' ' : base.slice(dot + 1);
```

- [ ] **Step 4: `Work.files` and `buildHud` in `web/src/hud/build.ts`**

Add `import { decodeText, encodeText } from './text';`. Replace `Work.files()` with:

```ts
  /**
   * The files this build touched. For an imported HUD, a file the passes
   * parsed but left as they found it goes back as the upload's own bytes:
   * writeKv would drop its comments and reformat it, and a HUD author's file
   * should reach the game exactly as they wrote it unless an edit is in it.
   * "Left as found" is measured by writing both trees the same way. An
   * edited file is written back in the encoding it came in.
   */
  files(): VpkFile[] {
    const out: VpkFile[] = [];
    const layer = importedFiles(this.key);
    const paths = new Set([...this.trees.keys(), ...this.texts.keys(), ...BASE_PATHS.filter((p) => presetOverrides(this.key, p))]);
    for (const path of [...paths].sort()) {
      const own = layer?.get(path);
      const write = (text: string) => (own ? encodeText(text, decodeText(own).encoding) : enc(text));
      if (this.texts.has(path) || path === ANIMS) { out.push({ path, data: write(this.text(path)) }); continue; }
      this.tree(path);
      const now = writeKv(this.trees.get(path)!);
      if (own && now === writeKv(parseKv(baseFile(this.key, path)))) { out.push({ path, data: own }); continue; }
      out.push({ path, data: write(now) });
    }
    return out;
  }
```

Above `buildHud`, add:

```ts
/** What a download did beyond the design: the upload files a generated file replaced, for the download note. */
export interface BuildReport { replaced: string[] }
```

Replace `buildHud`'s signature and its `return` line:

```ts
export function buildHud(design: HudDesign, assets: BuildAssets = {}, report?: BuildReport): VpkFile[] {
  const key = baseOf(design);
  const work = new Work(key);
  // ...the passes, unchanged...
  const edited = work.files();
  const layer = importedFiles(key);
  if (!layer) return [...edited, ...extra, { path: 'addoninfo.txt', data: enc(addonInfo(design.name)) }];
  // An imported HUD: every file of the upload, then the edited files over
  // them, then the generated ones (a font copy, a texture, the crosshair),
  // which replace an upload file at the same path and are reported. The
  // upload's own addoninfo.txt is kept; one without gets the editor's.
  const out = new Map<string, Uint8Array>(layer);
  for (const f of edited) out.set(f.path, f.data);
  const replaced = new Set<string>();
  for (const f of extra) { if (layer.has(f.path)) replaced.add(f.path); out.set(f.path, f.data); }
  if (!out.has('addoninfo.txt')) out.set('addoninfo.txt', enc(addonInfo(design.name)));
  if (report) report.replaced = [...replaced].sort();
  return [...out.keys()].sort().map((path) => ({ path, data: out.get(path)! }));
}
```

(`const work = new Work(baseOf(design));` from Task 3 becomes the two lines above.) Then `packHud`:

```ts
export function packHud(design: HudDesign, assets: BuildAssets = {}, report?: BuildReport) {
  const vpk = encodeVPK(buildHud(design, assets, report));
```

(the rest of `packHud` unchanged).

- [ ] **Step 5: An imported sample for the Python reader** in `web/src/hud/sample.vpkcheck.test.ts`

Add to the header comment's list:

```ts
//   i: an imported HUD (importFixtures.ts's sampleHud) with the health panel
//      moved, so the reader also sees pass-through files and the upload's
//      own hudlayout.res with an edit in it.
```

Add imports `import { registerImport } from './base';` and `import { sampleHud } from './importFixtures';`, and before the final `const d = validateDesign(SAMPLE_A);`:

```ts
  if (sample === 'i') {
    const id = 'f'.repeat(64);
    registerImport(id, sampleHud());
    const d = validateDesign({ v: 1, preset: 'imported', imported: { id, name: 'edgehud' }, crosshair: 'none', elements: { ownHealth: { x: 8, y: 400 } } });
    writeFileSync(process.env.HUD_VPK_OUT, packHud(d).bytes);
    return;
  }
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run --project web web/src/hud/ web/src/vpk/ && npm run typecheck && HUD_SAMPLE=i bash scripts/check-hud-vpk.sh`
Expected: PASS (golden hashes unchanged), and the script prints `8 files ok`: the seven sample files (the edited `scripts/hudlayout.res` among them) plus the editor's `addoninfo.txt`.

- [ ] **Step 7: Commit**

```bash
git add web/src/hud/build.ts web/src/hud/imported.build.test.ts web/src/hud/sample.vpkcheck.test.ts web/src/vpk/index.ts web/src/vpk/vpk.test.ts
git commit -m "Download an imported HUD as its own files plus the edits, untouched files byte for byte"
```

---

### Task 5: An imported HUD that lacks a panel or a child still edits, with those controls gone

**Files:**
- Modify: `web/src/hud/build.ts` (`Work`, `layoutPass`, `chatWindow`, `childPass`, `teamPass`, `scalePass`, `stylePass`, `weaponsPass`; new `baseTree`, `baseHasElement`), `web/src/hud/mock.ts` (`visibleElements`, `hitTest`, `drawHud`), `web/src/hud/selection.ts` (four calls), `web/src/routes/hud/LayersPanel.tsx:82`, `web/src/routes/Hud.tsx:730`, `web/src/hud/mock.test.ts:44-45`, `web/src/hud/importFixtures.ts`
- Test: `web/src/hud/imported.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces:
  - `baseTree(key: BaseKey, path: string): KvNode[]` in `build.ts`: the base file's root children, parsed once per key and path.
  - `baseHasElement(key: BaseKey, el: HudElement): boolean` in `build.ts`.
  - `visibleElements(side: Side, design: HudDesign): HudElement[]` in `mock.ts` (the `design` parameter is new and required).
  - In `importFixtures.ts`: `dropBlock(text: string, name: string): string` and `recordingCtx(): { ctx: CanvasRenderingContext2D; calls: { m: string; a: unknown[]; font: string; gco: string }[] }`.

- [ ] **Step 1: Add the fixtures** to `web/src/hud/importFixtures.ts`

```ts
import { parseKv, writeKv, type KvNode } from './kv';

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
```

- [ ] **Step 2: Write the failing tests**, appended to `web/src/hud/imported.test.ts`

```ts
import { buildHud, cardChild, baseHasElement } from './build';
import { drawHud, visibleElements } from './mock';
import { elementById } from './elements';
import { decodeText } from './text';
import { dropBlock, recordingCtx } from './importFixtures';

describe('an imported HUD that lacks a panel or a child', () => {
  const lacking = () => sampleHud({
    'scripts/hudlayout.res': dropBlock(decodeText(sampleHud().get('scripts/hudlayout.res')!).text, 'HudPZDamageRecord'),
    'resource/ui/hud/teammatepanel.res': dropBlock(baseFile('stock', 'resource/ui/hud/teammatepanel.res'), 'Items'),
  });
  const design = (extra: Record<string, unknown> = {}) => {
    registerImport(A, lacking());
    return validateDesign({ v: 1, preset: 'imported', imported: { id: A, name: 'e' }, crosshair: 'none', ...extra });
  };

  it('offers no element the layout lacks, and still offers it on stock', () => {
    const d = design();
    expect(visibleElements('survivor', d).map((e) => e.id)).not.toContain('killNotices');
    expect(visibleElements('survivor', validateDesign({ v: 1, preset: 'stock' })).map((e) => e.id)).toContain('killNotices');
    expect(baseHasElement(`imported:${A}`, elementById('killNotices')!)).toBe(false);
  });

  it('offers no teammate child the card file lacks', () => {
    expect(cardChild(design(), 'Items')).toBeNull();
    expect(cardChild(design(), 'Name')).not.toBeNull();
  });

  it('drops the teammates when the team file lacks a card', () => {
    registerImport(B, sampleHud({ [TEAM]: dropBlock(baseFile('stock', TEAM), 'TeamPlayer4') }));
    expect(baseHasElement(`imported:${B}`, elementById('teamColumn')!)).toBe(false);
  });

  it('builds a design that still carries edits for them, leaving them out, without throwing', () => {
    const d = design({ elements: { killNotices: { visible: false, x: 40 } }, children: { teamColumn: { Items: { x: 40 } } } });
    const out = new Map(buildHud(d).map((f) => [f.path, f.data]));
    const tree = (p: string) => parseKv(decodeText(out.get(p)!).text)[0].value as KvNode[];
    expect(kvFind(tree('scripts/hudlayout.res'), ['HudPZDamageRecord'])).toBeUndefined();
    // Nothing landed in the card file, so it goes out as the upload had it.
    expect(out.get('resource/ui/hud/teammatepanel.res')).toEqual(lacking().get('resource/ui/hud/teammatepanel.res'));
  });

  it('draws both sides without throwing', () => {
    const d = design();
    const { ctx } = recordingCtx();
    expect(() => drawHud(ctx, 853, 480, d, 'survivor', null)).not.toThrow();
    expect(() => drawHud(ctx, 853, 480, d, 'infected', null)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run --project web web/src/hud/imported.test.ts`
Expected: FAIL: `baseHasElement` is not exported, and the build test throws `scripts/hudlayout.res: no panel HudPZDamageRecord`.

- [ ] **Step 4: `web/src/hud/build.ts`**

In `Work`, add below `panel()`:

```ts
  /** Whether this build is on an imported HUD. */
  get imported(): boolean { return this.key.startsWith('imported:'); }
  /**
   * A panel an edit lands on, when the base has it. An imported HUD may lack
   * or rename a panel the editor models (the spec's "When the upload lacks an
   * expected piece"): its controls are hidden and a stored edit for it has
   * nothing to land on, so it is skipped. Stock and Modern have every panel,
   * so there a missing one is still a bug and fails loudly, as panel() does.
   */
  optional(path: string, keys: string[]): KvNode | undefined {
    const p = kvFind(this.tree(path), keys);
    if (!p && !this.imported) throw new Error(`${path}: no panel ${keys.join('/')}`);
    return p;
  }
```

Add near `baseHasChild`:

```ts
const BASE_TREES = new Map<string, KvNode[]>();
/** A base file's root children, parsed once per base key and path: the file as the base has it, before any edit. */
export function baseTree(key: BaseKey, path: string): KvNode[] {
  const id = `${key}|${path}`;
  let t = BASE_TREES.get(id);
  if (!t) { t = parseKv(baseFile(key, path))[0].value as KvNode[]; BASE_TREES.set(id, t); }
  return t;
}

/**
 * Whether the base has what the editor needs to offer an element: its
 * hudlayout.res panel and, for the survivor team, all four TeamPlayerN
 * cards. Always true on Stock and Modern. The crosshair is always offered:
 * layoutPass adds its panel whenever the design has one.
 */
export function baseHasElement(key: BaseKey, el: HudElement): boolean {
  if (el.id === 'xhair') return true;
  if (!kvFind(baseTree(key, LAYOUT), [el.key])) return false;
  if (!el.team?.file) return true;
  const team = baseTree(key, el.team.file);
  return [1, 2, 3, 4].every((n) => kvFind(team, [`TeamPlayer${n}`]) !== undefined);
}
```

Then in the passes. An element the base lacks is skipped whole (its panel, its container, its team cards and its child files), and every other named panel an edit lands on goes through `work.optional`. On Stock and Modern `baseHasElement` is always true, so nothing changes there:

- `layoutPass`: the element loop starts `if (!o || el.id === 'xhair' || !baseHasElement(work.key, el)) continue;` (then `work.panel` as before). `if (design.hideGameCrosshair) { const c = work.optional(LAYOUT, ['HudCrosshair']); if (c) kvSet(c, 'never_draw', '1'); }`. The chat hide becomes `if (chat?.visible === false && baseHasElement(work.key, elementById('chat')!)) { hardHide(work.panel(LAYOUT, ['HudChat'])); for (const name of ['HudChat', 'HudChatHistory']) { const p = work.optional(BASECHAT, [name]); if (p) hardHide(p); } }`, and the kill feed hide `if (killNotices?.visible === false && baseHasElement(work.key, elementById('killNotices')!)) hardHide(work.panel(LAYOUT, ['HudPZDamageRecord']));`.
- `chatWindow`: `const chat = work.optional(BASECHAT, ['HudChat']); if (!chat) return;`.
- `childPass`: the addable `at < 0` line becomes `if (at < 0) { if (work.imported) continue; throw new Error(\`${panel.file}: no ${def.addable.after} to add ${name} after\`); }`, and `if (!block) throw ...` becomes `if (!block) { if (work.imported) continue; throw new Error(\`${panel.file}: no child ${name}\`); }`.
- `teamPass`: the loop starts `if (!el.team || !teamWrites(el, o) || !baseHasElement(work.key, el)) continue;`.
- `scalePass`: the loop starts `if (el.resize !== 'scale' || k === undefined || k === 1 || !baseHasElement(work.key, el)) continue;`.
- `stylePass`: `for (const t of slot.targets) { const p = work.optional(t.file, t.path); if (p) kvSet(p, t.key, \`hud/hudeditor/${slot.id.toLowerCase()}\`); }`.
- `weaponsPass`: `const panel = work.optional(LAYOUT, ['HudWeaponSelection']); if (!panel) return;`, and in the repoint loop `if (!e) { if (work.imported) continue; throw new Error(\`${MODTEX}: no ${entry}\`); }`.

- [ ] **Step 5: `visibleElements` and its callers**

`web/src/hud/mock.ts`:

```ts
import { baseOf } from './base';
import { baseHasElement } from './build';   // add to the existing './build' import

/**
 * The elements the side shows, for this design: an imported HUD that lacks
 * or renamed an element's panel does not offer it, so no control, outline or
 * hit test reaches a panel the file does not have. Stock and Modern offer
 * every one.
 */
export function visibleElements(side: Side, design: HudDesign): HudElement[] {
  const key = baseOf(design);
  return ELEMENTS.filter((e) => (e.side === side || e.side === 'both') && baseHasElement(key, e));
}
```

Pass `design` at every call: `mock.ts` (`hitTest`, `drawHud`), `selection.ts` (the calls at lines 206, 218, 260 inside `sanitize`, and 413), `LayersPanel.tsx:82` (`visibleElements(side, design)`), `Hud.tsx:730` (`visibleElements(side, design)`), and `mock.test.ts:44-45` (`visibleElements('survivor', DEFAULT_DESIGN)`, same for infected; import `DEFAULT_DESIGN` there if it is not already).

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run --project web && npm run typecheck`
Expected: PASS, the whole web project (golden hashes unchanged).

- [ ] **Step 7: Commit**

```bash
git add web/src/hud web/src/routes
git commit -m "Hide the controls for panels and children an imported HUD lacks, and build without them"
```

---

### Task 6: Keep imports in this browser, and move a design onto one

**Files:**
- Create: `web/src/hud/hudStore.ts`, `web/src/hud/hudStore.test.ts`
- Modify: `web/src/hud/edit.ts` (add `withImport`, `withPreset`, `hasLayoutEdits`), `web/src/hud/build.ts` (add `importedHasXhair`), `web/src/crosshair/texture.ts` (split `vtfArt` out of `uploadArt`, add `importedCrosshair`)
- Test: `web/src/hud/edit.test.ts`, `web/src/hud/imported.test.ts`, `web/src/crosshair/texture.test.ts`

**Interfaces:**
- Consumes: `ImportedRef` (Task 3), `baseTree` (Task 5), `XHAIR_TEXTURE`, `CrosshairArt`.
- Produces:
  - In `hudStore.ts`: `interface StoredHud { id: string; name: string; files: Map<string, Uint8Array>; bytes: number; added: number }`; `type HudMeta = Omit<StoredHud, 'files'>`; `interface HudStore { get(id: string): Promise<StoredHud | undefined>; put(hud: StoredHud): Promise<void>; list(): Promise<HudMeta[]>; delete(id: string): Promise<void> }`; `memoryStore(): HudStore`; `indexedDbStore(idb?: IDBFactory): HudStore`; `hudStore(): HudStore`; `_setHudStore(s: HudStore | null): void`.
  - In `edit.ts`: `hasLayoutEdits(d: HudDesign): boolean`; `withImport(d: HudDesign, ref: ImportedRef, o: { art: CrosshairArt | null; hasXhair: boolean; reset: boolean }): HudDesign`; `withPreset(d: HudDesign, preset: 'stock' | 'modern', reset: boolean): HudDesign`.
  - In `build.ts`: `importedHasXhair(key: BaseKey): boolean`.
  - In `crosshair/texture.ts`: `importedCrosshair(files: ReadonlyMap<string, Uint8Array>): CrosshairArt | null`.

- [ ] **Step 1: Write the failing tests**

`web/src/hud/hudStore.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { memoryStore, indexedDbStore, type StoredHud } from './hudStore';

const hud = (id: string, added: number): StoredHud => ({
  id, name: `hud ${id}`, files: new Map([['scripts/hudlayout.res', new Uint8Array([1, 2, 3])]]), bytes: 3, added,
});

describe('the imported HUD store', () => {
  it('gives back the files it was given, and a copy, not the same object', async () => {
    const s = memoryStore();
    const h = hud('a', 1);
    await s.put(h);
    const got = await s.get('a');
    expect(got).toEqual(h);
    got!.files.set('x', new Uint8Array(1));
    expect((await s.get('a'))!.files.has('x')).toBe(false);
    expect(await s.get('nope')).toBeUndefined();
  });

  it('keeps one entry per id, lists them oldest first without their files, and deletes', async () => {
    const s = memoryStore();
    await s.put(hud('b', 2)); await s.put(hud('a', 1)); await s.put({ ...hud('a', 1), name: 'renamed' });
    expect(await s.list()).toEqual([{ id: 'a', name: 'renamed', bytes: 3, added: 1 }, { id: 'b', name: 'hud b', bytes: 3, added: 2 }]);
    await s.delete('a');
    expect((await s.list()).map((m) => m.id)).toEqual(['b']);
  });

  it('passes on the reason when IndexedDB will not open', async () => {
    const failing = { open: () => { const r: Record<string, unknown> = {}; queueMicrotask(() => { r.error = new Error('blocked'); (r.onerror as () => void)?.(); }); return r; } } as unknown as IDBFactory;
    await expect(indexedDbStore(failing).list()).rejects.toThrow('blocked');
  });
});
```

Append to `web/src/hud/edit.test.ts` (add the imports it lacks: `withImport, withPreset, hasLayoutEdits` from `./edit`, `DEFAULT_DESIGN` from `./design`, `type CrosshairArt` from `../crosshair/model`):

```ts
describe('moving a design onto an imported HUD and off it', () => {
  const ref = { id: 'e'.repeat(64), name: 'edgehud' };
  const art: CrosshairArt = { kind: 'image', png: 'data:image/png;base64,UE5H', w: 128, h: 128 };
  const none = { art: null, hasXhair: false, reset: false };

  it('starts a design with no layout edits with none, so the HUD shows as its author made it', () => {
    const d = withImport(structuredClone(DEFAULT_DESIGN), ref, none);
    expect(d).toMatchObject({ preset: 'imported', imported: ref, font: 'preset', elements: {}, children: {} });
    expect(hasLayoutEdits(d)).toBe(false);
  });

  it('keeps the edits a player keeps, and drops them on reset', () => {
    const edited = { ...structuredClone(DEFAULT_DESIGN), elements: { chat: { x: 8, y: 8 } } };
    expect(hasLayoutEdits(edited)).toBe(true);
    expect(withImport(edited, ref, none).elements).toEqual({ chat: { x: 8, y: 8 } });
    expect(withImport(edited, ref, { ...none, reset: true }).elements).toEqual({});
  });

  it("takes the upload's crosshair texture as a bundled image crosshair", () => {
    const d = withImport(structuredClone(DEFAULT_DESIGN), ref, { ...none, art });
    expect(d.crosshair).toBe('bundle');
    expect(d.xhairArt).toEqual(art);
  });

  it("keeps the HUD's own xHair element, as an addon crosshair, when it has no texture and none was chosen", () => {
    expect(withImport(structuredClone(DEFAULT_DESIGN), ref, { ...none, hasXhair: true }).crosshair).toBe('addon');
    const bundled = { ...structuredClone(DEFAULT_DESIGN), crosshair: 'bundle' as const, xhairArt: art };
    expect(withImport(bundled, ref, { ...none, hasXhair: true }).crosshair).toBe('bundle');
  });

  it('moves back to Stock without the import, with the default teammates when it had no edits', () => {
    const on = withImport(structuredClone(DEFAULT_DESIGN), ref, none);
    const back = withPreset(on, 'stock', false);
    expect(back.preset).toBe('stock');
    expect('imported' in back).toBe(false);
    expect(back.elements).toEqual(DEFAULT_DESIGN.elements);
    const edited = withPreset({ ...on, elements: { chat: { x: 8 } } }, 'modern', false);
    expect(edited.elements).toEqual({ chat: { x: 8 } });
    expect(withPreset({ ...on, elements: { chat: { x: 8 } } }, 'modern', true).elements).toEqual(DEFAULT_DESIGN.elements);
  });
});
```

Append to `web/src/hud/imported.test.ts` (import `importedHasXhair` from `./build`):

```ts
describe('importedHasXhair', () => {
  it("says whether the upload's own layout has an xHair element", () => {
    registerImport(A, sampleHud());
    const withX = decodeText(sampleHud().get('scripts/hudlayout.res')!).text.replace(/\}\s*$/, '\t"xHair"\r\n\t{\r\n\t\t"fieldName" "xHair"\r\n\t}\r\n}\r\n');
    registerImport(B, sampleHud({ 'scripts/hudlayout.res': withX }));
    expect(importedHasXhair(`imported:${A}`)).toBe(false);
    expect(importedHasXhair(`imported:${B}`)).toBe(true);
  });
});
```

Append to `web/src/crosshair/texture.test.ts` (import `importedCrosshair` from `./texture`):

```ts
describe('importedCrosshair', () => {
  it("takes an imported HUD's own altcrosshair texture, fitted like an uploaded one", () => {
    stubCanvas();
    const rgba = new Uint8ClampedArray(64 * 32 * 4).map((_, i) => i & 0xff);
    expect(importedCrosshair(new Map([[XHAIR_TEXTURE, encodeVTF(64, 32, rgba)]]))).toEqual({ kind: 'image', png: `${PNG_PREFIX}UE5H`, w: TEX, h: TEX });
  });

  it('gives nothing when the HUD has no crosshair texture or it will not decode', () => {
    stubCanvas();
    expect(importedCrosshair(new Map())).toBeNull();
    expect(importedCrosshair(new Map([[XHAIR_TEXTURE, new Uint8Array(10)]]))).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project web web/src/hud/hudStore.test.ts web/src/hud/edit.test.ts web/src/hud/imported.test.ts web/src/crosshair/texture.test.ts`
Expected: FAIL, `./hudStore` does not resolve and `withImport`, `importedHasXhair`, `importedCrosshair` are not exported.

- [ ] **Step 3: Write `web/src/hud/hudStore.ts`**

```ts
/**
 * The HUDs a player imported, kept in this browser.
 *
 * An import is up to 50 MB of files, far past what localStorage holds, so it
 * lives in IndexedDB, one record per id (upload.ts's hudId): importing the
 * same HUD twice overwrites one record. The design itself stores only the
 * id and name. The page reads the design's import from here into base's
 * in-memory registry before it first draws.
 *
 * The backend is injectable: tests, and a browser without IndexedDB (happy-dom,
 * or a private window that refuses it), use memoryStore, which keeps imports
 * for as long as the page is open. No fake-indexeddb dependency is needed.
 */
export interface StoredHud { id: string; name: string; files: Map<string, Uint8Array>; bytes: number; added: number }
export type HudMeta = Omit<StoredHud, 'files'>;
export interface HudStore {
  get(id: string): Promise<StoredHud | undefined>;
  put(hud: StoredHud): Promise<void>;
  /** Every import, oldest first, without its files. */
  list(): Promise<HudMeta[]>;
  delete(id: string): Promise<void>;
}

const meta = ({ id, name, bytes, added }: StoredHud): HudMeta => ({ id, name, bytes, added });
const byAdded = (a: HudMeta, b: HudMeta) => a.added - b.added || (a.id < b.id ? -1 : 1);

export function memoryStore(): HudStore {
  const rows = new Map<string, StoredHud>();
  return {
    async get(id) { const r = rows.get(id); return r && structuredClone(r); },
    async put(h) { rows.set(h.id, structuredClone(h)); },
    async list() { return [...rows.values()].map(meta).sort(byAdded); },
    async delete(id) { rows.delete(id); },
  };
}

const DB = 'hud-editor';
const STORE = 'imports';

export function indexedDbStore(idb: IDBFactory = indexedDB): HudStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => (db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: 'id' }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { db = null; reject(r.error ?? new Error('This browser would not open its storage')); };
  }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const store = (await open()).transaction(STORE, mode).objectStore(STORE);
    return new Promise<T>((resolve, reject) => {
      const q = fn(store);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error ?? new Error('This browser would not store the HUD'));
    });
  };
  return {
    get: (id) => run('readonly', (s) => s.get(id)) as Promise<StoredHud | undefined>,
    put: async (h) => { await run('readwrite', (s) => s.put(h)); },
    list: async () => ((await run('readonly', (s) => s.getAll())) as StoredHud[]).map(meta).sort(byAdded),
    delete: async (id) => { await run('readwrite', (s) => s.delete(id)); },
  };
}

let current: HudStore | null = null;
/** The page's store: IndexedDB where the browser has it, memory otherwise. */
export function hudStore(): HudStore {
  return (current ??= typeof indexedDB === 'undefined' ? memoryStore() : indexedDbStore());
}
/** Test seam: use this store, or (null) go back to the default. */
export function _setHudStore(s: HudStore | null): void { current = s; }
```

- [ ] **Step 4: `withImport`, `withPreset`, `hasLayoutEdits`** in `web/src/hud/edit.ts` (add `type ImportedRef` to the `./design` import and `type CrosshairArt` from `../crosshair/model` if missing):

```ts
/**
 * Whether switching this design's base should ask "keep or reset" first. On
 * an imported HUD, a design with no edits has none at all (withImport starts
 * it that way); on Stock and Modern it is elementsTouched, whose default is
 * the fitted teammates.
 */
export function hasLayoutEdits(d: HudDesign): boolean {
  const children = Object.keys(d.children).length > 0;
  return d.preset === 'imported' ? Object.keys(d.elements).length > 0 || children : elementsTouched(d) || children;
}

/**
 * A design moved onto an imported HUD: Import a HUD, or picking an import in
 * the Preset select. Edits the player keeps come along; a design with none,
 * or a reset, starts with none, so the HUD shows exactly as its author made
 * it (not even the default fitted teammates). Fonts are the HUD's own. The
 * crosshair: the upload's own altcrosshair texture becomes a bundled image
 * crosshair (`art`); with no texture but an xHair element in its layout
 * (`hasXhair`), a design on the game's crosshair becomes 'addon', so
 * layoutPass keeps the HUD's element instead of removing it; otherwise the
 * player's own choice stands.
 */
export function withImport(d: HudDesign, ref: ImportedRef, o: { art: CrosshairArt | null; hasXhair: boolean; reset: boolean }): HudDesign {
  const keep = !o.reset && hasLayoutEdits(d);
  const out: HudDesign = {
    ...d, preset: 'imported', imported: { ...ref }, font: 'preset',
    elements: keep ? d.elements : {}, children: keep ? d.children : {},
  };
  if (o.art) { out.crosshair = 'bundle'; out.xhairArt = structuredClone(o.art); }
  else if (o.hasXhair && d.crosshair === 'none') out.crosshair = 'addon';
  return out;
}

/** A design moved to Stock or Modern: no import, and the default teammates back when it had no edits or the player reset. */
export function withPreset(d: HudDesign, preset: 'stock' | 'modern', reset: boolean): HudDesign {
  const { imported: _dropped, ...rest } = d;
  const fresh = reset || (d.preset === 'imported' && !hasLayoutEdits(d));
  return { ...rest, preset, ...(fresh ? { elements: structuredClone(DEFAULT_DESIGN.elements), children: {} } : {}) };
}
```

- [ ] **Step 5: `importedHasXhair`** in `web/src/hud/build.ts`, below `baseHasElement`:

```ts
/** Whether an imported HUD's own hudlayout.res has an xHair element: a HUD made to show a crosshair addon's texture. */
export function importedHasXhair(key: BaseKey): boolean {
  return kvFind(baseTree(key, LAYOUT), ['xHair']) !== undefined;
}
```

- [ ] **Step 6: `importedCrosshair`** in `web/src/crosshair/texture.ts`. Replace the body of `uploadArt`'s VPK branch and its tail with two helpers it shares:

```ts
/** A crosshair drawn from `source` (w x h), fitted into the TEX square, aspect kept and centred, as the build would fit it. */
function fitted(source: CanvasImageSource, w: number, h: number): CrosshairArt {
  const { c, ctx } = canvas(TEX, TEX);
  drawArt(ctx, TEX / 2, TEX / 2, TEX, { kind: 'image', png: '', w, h }, source);
  return { kind: 'image', png: c.toDataURL('image/png'), w: TEX, h: TEX };
}

/** An altcrosshair texture's pixels as crosshair art. */
function vtfArt(tex: Uint8Array): CrosshairArt {
  const vtf = decodeVTF(tex);
  const { c, ctx } = canvas(vtf.w, vtf.h);
  const data = ctx.createImageData(vtf.w, vtf.h);
  data.data.set(vtf.rgba);
  ctx.putImageData(data, 0, 0);
  return fitted(c, vtf.w, vtf.h);
}

/**
 * An imported HUD's own crosshair texture (spec, "Crosshair"), as the
 * design's crosshair, exactly as uploading that texture on the crosshair
 * control would make it. Null when the HUD has none or it will not decode:
 * the import then keeps the design's own crosshair choice.
 */
export function importedCrosshair(files: ReadonlyMap<string, Uint8Array>): CrosshairArt | null {
  const tex = files.get(XHAIR_TEXTURE);
  if (!tex) return null;
  try { return vtfArt(tex); } catch { return null; }
}
```

and `uploadArt` becomes:

```ts
export async function uploadArt(file: File): Promise<CrosshairArt> {
  if (file.size > MAX_UPLOAD) throw new Error('That file is over 4 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isVpk(bytes) || /\.vpk$/i.test(file.name)) {
    const split = new Set<string>();
    const tex = readVPK(bytes, split).get(XHAIR_TEXTURE);
    if (!tex && split.has(XHAIR_TEXTURE)) {
      throw new Error('This addon is split across several files (..._dir.vpk plus _000.vpk); the site needs a single-file .vpk.');
    }
    if (!tex) throw new Error('No crosshair found in this file.');
    return vtfArt(tex);
  }
  const bmp = await createImageBitmap(file).catch(() => {
    throw new Error('That is not a crosshair: pick a crosshair addon (.vpk) or an image.');
  });
  return fitted(bmp, bmp.width, bmp.height);
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run --project web web/src/hud/ web/src/crosshair/ && npm run typecheck`
Expected: PASS, the existing `uploadArt` tests included.

- [ ] **Step 8: Commit**

```bash
git add web/src/hud/hudStore.ts web/src/hud/hudStore.test.ts web/src/hud/edit.ts web/src/hud/edit.test.ts web/src/hud/build.ts web/src/hud/imported.test.ts web/src/crosshair/texture.ts web/src/crosshair/texture.test.ts
git commit -m "Keep imported HUDs in this browser, and move a design onto one with its crosshair"
```

---

### Task 7: The page: Import a HUD, switching and removing, and the missing-import banner

**Files:**
- Modify: `web/src/routes/hud/Toolbar.tsx` (whole component), `web/src/routes/Hud.tsx` (state, mount effect, draw and sanitize effects, `changePreset`, new `importHud` and `removeImport`, `download`, handlers, JSX), `web/src/styles/app.css`
- Test: `web/src/routes/Hud.test.tsx`

**Interfaces:**
- Consumes: `readHudUpload`, `hudId`, `IMPORT_ERRORS` (Task 2); `registerImport`, `unregisterImport`, `hasImport`, `baseOf` (Task 3); `BuildReport`, `packHud` (Task 4); `hudStore`, `memoryStore`, `_setHudStore`, `HudMeta` (Task 6); `withImport`, `withPreset`, `hasLayoutEdits`, `importedHasXhair`, `importedCrosshair` (Task 6).
- Produces:
  - `type PresetChoice = 'stock' | 'modern' | { id: string }` exported from `Toolbar.tsx`.
  - Toolbar props: `imports: { id: string; name: string }[]`, `locked: boolean`, `onPreset: (p: PresetChoice) => void`, `onImportFile: (f: File) => void`, `onRemoveImport: (id: string) => void`.
  - The page's labels: the hidden file input "Import a HUD file"; the remove picker "Imported HUD to remove"; the banner "This design was made on the imported HUD 'NAME'. Import it again to edit or download it."

- [ ] **Step 1: Write the failing tests**, a new `describe` at the end of `web/src/routes/Hud.test.tsx` (add imports: `readVPK` from `../vpk/read`; `memoryStore, _setHudStore` from `../hud/hudStore`; `unregisterImport` from `../hud/base`; `hudId` from `../hud/upload`; `sampleHud, asList` from `../hud/importFixtures`)

```tsx
describe('Importing a HUD', () => {
  const files = sampleHud();
  const vpkFile = () => new File([encodeVPK(asList(files))], 'edgehud.vpk');
  let id = '';
  beforeEach(async () => { _setHudStore(memoryStore()); id = await hudId(files); });
  afterEach(() => { _setHudStore(null); unregisterImport(id); });
  const preset = () => screen.getByRole('combobox', { name: /preset/i }) as HTMLSelectElement;
  const importFile = (f: File) => fireEvent.change(screen.getByLabelText('Import a HUD file'), { target: { files: [f] } });
  const BANNER = "This design was made on the imported HUD 'edgehud'. Import it again to edit or download it.";

  it('imports a .vpk from the Preset select and switches the design to it', async () => {
    render(<Hud />);
    expect(screen.getByRole('option', { name: 'Import a HUD...' })).toBeTruthy();
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
    expect(preset().value).toBe(`imported:${id}`);
    expect(screen.getByRole('option', { name: 'Imported: edgehud' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Teammates' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Kill / incap notices' })).toBeTruthy();
  });

  it('says in one line why a file is not a HUD, and leaves the design as it was', async () => {
    render(<Hud />);
    importFile(new File([encodeVPK([{ path: 'materials/x.vtf', data: new Uint8Array(4) }])], 'x.vpk'));
    await screen.findByText('This file has no scripts/hudlayout.res, so it is not a HUD');
    expect(preset().value).toBe('stock');
  });

  it("downloads the imported HUD with the upload's own files in it", async () => {
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blobs.push(b as Blob); return 'blob:hud'; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    const got = readVPK(new Uint8Array(await blobs[0].arrayBuffer()));
    expect(got.get('sound/ui/edge.wav')).toEqual(files.get('sound/ui/edge.wav'));
  });

  it('opens a design whose HUD is not in this browser read-only, with Download off, until the HUD is imported again', async () => {
    localStorage.setItem('hud', JSON.stringify({ v: 1, name: 'mine', preset: 'imported', imported: { id, name: 'edgehud' } }));
    render(<Hud />);
    await screen.findByText(BANNER);
    expect((screen.getByRole('button', { name: /download/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Teammates' })).toBeNull();
    expect(preset().value).toBe(`imported:${id}`);
    importFile(vpkFile());
    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull());
    expect((screen.getByRole('button', { name: /download/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Teammates' })).toBeTruthy();
  });

  it('removes an imported HUD from this browser, and a design on it then shows the banner', async () => {
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
    fireEvent.change(preset(), { target: { value: 'remove' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Imported HUD to remove' }), { target: { value: id } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByText(BANNER);
    expect(screen.queryByRole('option', { name: 'Imported: edgehud' })).toBeNull();
  });

  it('switches back to Stock and onto an import again from the Preset select', async () => {
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText('Imported edgehud.');
    fireEvent.change(preset(), { target: { value: 'stock' } });
    await waitFor(() => expect(preset().value).toBe('stock'));
    fireEvent.change(preset(), { target: { value: `imported:${id}` } });
    await waitFor(() => expect(preset().value).toBe(`imported:${id}`));
  });

  it('still imports when this browser will not store it, and says it lasts only while the page is open', async () => {
    _setHudStore({ ...memoryStore(), put: () => Promise.reject(new Error('quota')) });
    render(<Hud />);
    importFile(vpkFile());
    await screen.findByText(/kept only until this page closes/);
    expect(preset().value).toBe(`imported:${id}`);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project web web/src/routes/Hud.test.tsx -t "Importing a HUD"`
Expected: FAIL, no option "Import a HUD..." and no element labelled "Import a HUD file".

- [ ] **Step 3: Rewrite the preset and download parts of `web/src/routes/hud/Toolbar.tsx`**

Replace `import type { Preset } from '../../hud/base';` with `import { useRef, useState } from 'preact/hooks';`. Add:

```tsx
/** What the Preset select can switch to: a built-in preset, or one of this browser's imports. */
export type PresetChoice = 'stock' | 'modern' | { id: string };

const presetValue = (d: HudDesign) => (d.preset === 'imported' && d.imported ? `imported:${d.imported.id}` : d.preset);
```

In `ToolbarProps`, replace `onPreset: (p: Preset) => void;` with `onPreset: (p: PresetChoice) => void;` and add:

```tsx
  /** This browser's imports, for the Preset select. */
  imports: { id: string; name: string }[];
  /** The design's imported HUD is not loaded: only the Preset select and history stay live. */
  locked: boolean;
  onImportFile: (f: File) => void;
  onRemoveImport: (id: string) => void;
```

At the top of `Toolbar`, add:

```tsx
  const fileRef = useRef<HTMLInputElement>(null);
  // The import picked in the remove row while it is open; null while it is closed.
  const [removing, setRemoving] = useState<string | null>(null);
  const value = presetValue(design);
  // A design on an import this browser does not have still shows which one.
  const unlisted = design.preset === 'imported' && design.imported && !p.imports.some((m) => m.id === design.imported!.id);
  /**
   * Import a HUD... and Remove an imported HUD... are actions, not presets:
   * the select goes straight back to the design's own value, and only
   * picking Stock, Modern or an import changes the design.
   */
  const onSelect = (e: Event) => {
    const el = e.target as HTMLSelectElement;
    const v = el.value;
    el.value = value;
    if (v === 'import') fileRef.current?.click();
    else if (v === 'remove') setRemoving(p.imports[0]?.id ?? null);
    else if (v === 'stock' || v === 'modern') p.onPreset(v);
    else if (v.startsWith('imported:')) p.onPreset({ id: v.slice('imported:'.length) });
  };
```

Replace the Preset `<label>` with:

```tsx
      <label>
        Preset{' '}
        <select value={value} onChange={onSelect}>
          <option value="stock">Stock</option>
          <option value="modern">Modern</option>
          {p.imports.map((m) => <option key={m.id} value={`imported:${m.id}`}>{`Imported: ${m.name}`}</option>)}
          {unlisted && <option value={value}>{`Imported: ${design.imported!.name} (not in this browser)`}</option>}
          <option value="import">Import a HUD...</option>
          {p.imports.length > 0 && <option value="remove">Remove an imported HUD...</option>}
        </select>
      </label>
      <input
        ref={fileRef} type="file" accept=".vpk,.zip" aria-label="Import a HUD file" style={{ display: 'none' }}
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          const f = input.files?.[0];
          input.value = '';
          if (f) p.onImportFile(f);
        }}
      />
      {removing !== null && (
        <span class="hud__removerow">
          <select aria-label="Imported HUD to remove" value={removing} onChange={(e) => setRemoving((e.target as HTMLSelectElement).value)}>
            {p.imports.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button type="button" class="btn btn--ghost btn--sm" onClick={() => { p.onRemoveImport(removing); setRemoving(null); }}>Remove</button>
          <button type="button" class="btn btn--ghost btn--sm" onClick={() => setRemoving(null)}>Cancel</button>
        </span>
      )}
```

Add `disabled={p.locked}` to the Aspect `<select>`. The Font select becomes `disabled={design.preset !== 'stock' || p.locked}`, and after the Modern note add `{design.preset === 'imported' && <span class="muted hud__note">An imported HUD uses its own fonts.</span>}`. The Download button gets `disabled={p.locked}`.

- [ ] **Step 4: `web/src/routes/Hud.tsx`**

Imports: add

```tsx
import { importedCrosshair } from '../crosshair/texture';     // beside artPixels
import { readHudUpload, hudId } from '../hud/upload';
import { hudStore, type HudMeta } from '../hud/hudStore';
import { registerImport, unregisterImport, hasImport } from '../hud/base';
import { withImport, withPreset, hasLayoutEdits } from '../hud/edit';  // add to the existing '../hud/edit' import
import { importedHasXhair, type BuildReport } from '../hud/build';    // add to the existing '../hud/build' import
import { Toolbar, type PresetChoice } from './hud/Toolbar';
```

and remove `import type { Preset } from '../hud/base';` and `elementsTouched` from the edit import if nothing else uses it.

After the `design` state and `apply`, add:

```tsx
  // This browser's imports, for the Preset select, and whether the store has
  // been read yet. `importTick` re-renders when the in-memory registry
  // changes, since hasImport is not state.
  const [imports, setImports] = useState<HudMeta[]>([]);
  const [importsRead, setImportsRead] = useState(false);
  const [, setImportTick] = useState(0);
  const imp = design.preset === 'imported' ? design.imported : undefined;
  // The design's imported HUD is not loaded (yet, or at all in this browser):
  // nothing reads its files, so nothing draws, edits or downloads.
  const locked = imp !== undefined && !hasImport(imp.id);
  const banner = !locked ? '' : importsRead
    ? `This design was made on the imported HUD '${imp!.name}'. Import it again to edit or download it.`
    : `Loading the imported HUD '${imp!.name}'...`;
```

Mount effect, next to the other mount effects:

```tsx
  // Mount only: list this browser's imports, and load the design's own into
  // the registry before anything reads it. A browser without IndexedDB
  // leaves every import missing, which the banner says.
  useEffect(() => {
    let live = true;
    (async () => {
      const store = hudStore();
      try {
        const list = await store.list();
        if (live) setImports(list);
        const d = current.current;
        if (d.preset === 'imported' && d.imported && !hasImport(d.imported.id)) {
          const hud = await store.get(d.imported.id);
          if (hud) registerImport(hud.id, hud.files);
        }
      } catch { /* no storage: nothing to load */ }
      if (live) { setImportsRead(true); setImportTick((t) => t + 1); }
    })();
    return () => { live = false; };
  }, []);
```

In the draw effect, right after `drawBackdrop(ctx, w, h, backdrop, shot.current, shotSize);` add `if (locked) return;`, and add `locked` to its dependency list. Replace the sanitize effect with:

```tsx
  useEffect(() => { setSel((s) => (locked ? NONE : sanitize(design, side, s))); }, [design, side, locked]);
```

Add `if (locked) return;` as the first line of `onPointerDown`, `onContextMenu` and `onKeyDown`.

Replace `changePreset` with:

```tsx
  /** Switching base asks whether to keep the layout edits, only when there are some. */
  const askReset = (d: HudDesign) => (hasLayoutEdits(d)
    ? confirm({
      title: 'Switching preset keeps your moves and inside edits, but they were placed for the other layout. Reset them as well?',
      confirmLabel: 'Reset', cancelLabel: 'Keep',
    })
    : Promise.resolve(false));

  const changePreset = async (choice: PresetChoice) => {
    const cur = current.current;
    if (typeof choice === 'string') {
      if (choice === cur.preset) return;
      const reset = await askReset(cur);
      edit((d) => withPreset(d, choice, reset));
    } else {
      if (cur.preset === 'imported' && cur.imported?.id === choice.id) return;
      const meta = imports.find((m) => m.id === choice.id);
      if (!meta) return;
      if (!hasImport(choice.id)) {
        const hud = await hudStore().get(choice.id).catch(() => undefined);
        if (!hud) { setStatus('That imported HUD is no longer in this browser.'); return; }
        registerImport(hud.id, hud.files);
      }
      const reset = await askReset(cur);
      edit((d) => withImport(d, { id: choice.id, name: meta.name }, { art: null, hasXhair: importedHasXhair(`imported:${choice.id}`), reset }));
    }
    dropPicks();
  };

  /**
   * Import a HUD: read it, name it by its contents, keep it in this browser
   * and in the registry, then move the design onto it. Every failure is one
   * line on the status and leaves the design as it was. Importing the HUD a
   * design already names (the missing-import banner's own advice) only loads
   * it: the design is already on it.
   */
  const importHud = async (file: File) => {
    try {
      const upload = await readHudUpload(file.name, new Uint8Array(await file.arrayBuffer()));
      const id = await hudId(upload.files);
      registerImport(id, upload.files);
      const bytes = [...upload.files.values()].reduce((n, d) => n + d.length, 0);
      let kept = true;
      try {
        await hudStore().put({ id, name: upload.name, files: upload.files, bytes, added: Date.now() });
        setImports(await hudStore().list());
      } catch {
        kept = false;
        setImports((l) => (l.some((m) => m.id === id) ? l : [...l, { id, name: upload.name, bytes, added: Date.now() }]));
      }
      setImportTick((t) => t + 1);
      const cur = current.current;
      const again = cur.preset === 'imported' && cur.imported?.id === id;
      if (!again) {
        const reset = await askReset(cur);
        const art = importedCrosshair(upload.files);
        edit((d) => withImport(d, { id, name: upload.name }, { art, hasXhair: importedHasXhair(`imported:${id}`), reset }));
        dropPicks();
      }
      const n = upload.dropped.length;
      const left = n ? ` Left out: ${upload.dropped.slice(0, 3).join(', ')}${n > 3 ? ` and ${n - 3} more` : ''}.` : '';
      const lasting = kept ? '' : ' This browser could not store it, so it is kept only until this page closes.';
      setStatus(`${again ? `Imported ${upload.name} again; this design can be edited and downloaded.` : `Imported ${upload.name}.`}${left}${lasting}`);
    } catch (err) {
      setStatus((err as Error).message);
    }
  };

  /** Remove an imported HUD from this browser. A design on it keeps its data and shows the banner. */
  const removeImport = async (id: string) => {
    const name = imports.find((m) => m.id === id)?.name ?? 'that HUD';
    await hudStore().delete(id).catch(() => {});
    unregisterImport(id);
    setImports((l) => l.filter((m) => m.id !== id));
    setImportTick((t) => t + 1);
    setStatus(`Removed ${name} from this browser.`);
  };
```

In `download`, add `if (locked) return;` as its first line, and replace its `packHud` line and its success status with:

```tsx
      const report: BuildReport = { replaced: [] };
      const p = packHud(validateDesign({ ...design, name: safeName(design.name) }), assets, report);
```

```tsx
      setStatus(`Saved ${p.filename}.${report.replaced.length ? ` The editor's own copies replaced these files from your HUD: ${report.replaced.join(', ')}.` : ''}`);
```

JSX:

- The `<Toolbar>` gets `imports={imports} locked={locked} onImportFile={(f) => { void importHud(f); }} onRemoveImport={(id) => { void removeImport(id); }}` (its `onPreset` stays `(p) => { void changePreset(p); }`).
- Right after `<Toolbar ... />`: `{banner && <p class="hud__warn" role="status">{banner}</p>}`.
- `<LayersPanel .../>` and `<ContextPanel .../>` render only when `!locked` (`{!locked && <LayersPanel ... />}`, same for ContextPanel).
- In the Styles panel, wrap everything after `<h3>Styles</h3>` in `<fieldset class="hud__fieldset" disabled={locked}> ... </fieldset>`.
- The fit note becomes `{!locked && teamLayout(design, elementById('teamColumn')!).fitEmpty && (...)}`.

- [ ] **Step 5: CSS** in `web/src/styles/app.css`, after `.hud__warn`:

```css
/* The Styles panel is one fieldset so a missing import can switch it all off; it draws nothing of its own. */
.hud__fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
/* Remove an imported HUD: a picker and two buttons beside the Preset select. */
.hud__removerow { display: inline-flex; align-items: center; gap: var(--sp-2); }
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run --project web web/src/routes/ && npm run typecheck`
Expected: PASS, the whole route folder (the existing "drops a picked child when the preset changes" test still switches to Modern through the same select).

- [ ] **Step 7: Commit**

```bash
git add web/src/routes web/src/styles/app.css
git commit -m "Import a HUD from the Preset select, switch between imports, and lock a design whose HUD is missing"
```

---

### Task 8: Draw an imported HUD's own fonts in the preview

**Files:**
- Create: `web/src/hud/ttf.ts`, `web/src/hud/ttf.test.ts`
- Modify: `web/src/hud/fonts.ts` (runtime faces), `web/src/hud/render.ts` (`setFont`)
- Test: `web/src/hud/fonts.test.ts`, `web/src/hud/render.test.ts`

**Interfaces:**
- Consumes: `importedFiles`, `baseFile`, `baseOf`, `BaseKey` (Task 3); `sampleHud`, `latin1` (fixtures).
- Produces:
  - In `ttf.ts`: `interface FaceMetrics { unitsPerEm: number; winAscent: number; winDescent: number; vdmx?: number[] }`; `interface FontInfo { names: string[]; weight: number; metrics: FaceMetrics }`; `isVfont(b: Uint8Array): boolean`; `decodeVfont(data: Uint8Array): Uint8Array`; `readFont(ttf: Uint8Array): FontInfo`.
  - In `fonts.ts`: `importedFace(key: BaseKey, face: string): string | undefined` (the alias the preview registered, `HudImp_<first 12 of id>_<name with non-alphanumerics as _>`); `_resetImportFaces(): void`. `fontCell`, `cssFamily`, `canvasFont`, `loadFace` accept an alias as a face.

- [ ] **Step 1: Write the failing tests**

`web/src/hud/ttf.test.ts`:

```ts
// @vitest-environment node
//
// Node, not happy-dom: this reads the exported fonts off disk with node:fs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFont, decodeVfont, isVfont } from './ttf';
import { FONT_FILES, FONT_METRICS } from './art/index';

const here = fileURLToPath(new URL('.', import.meta.url));
const font = (face: string) => new Uint8Array(readFileSync(`${here}art/${FONT_FILES[face]}`));

/** The vfont encoding export-hud-art.py decodes, run forwards: XOR against a running key, then salt, its length and the marker. */
function toVfont(ttf: Uint8Array, salt: number[]): Uint8Array {
  let key = 167;
  for (const b of salt) key ^= (b + 167) & 0xff;
  const body = new Uint8Array(ttf.length);
  for (let i = 0; i < ttf.length; i++) { body[i] = ttf[i] ^ key; key = (body[i] + 167) & 0xff; }
  return new Uint8Array([...body, ...salt, salt.length + 1, ...new TextEncoder().encode('VFONT1')]);
}

describe('readFont', () => {
  for (const face of ['Trade Gothic', 'Trade Gothic Bold', 'ToolBox']) {
    it(`reads ${face} exactly as export-hud-art.py baked it`, () => {
      const info = readFont(font(face));
      expect(info.metrics).toEqual(FONT_METRICS[face]);
      expect(info.names).toContain(face);
    });
  }

  it('refuses a file that is not a font', () => {
    expect(() => readFont(new Uint8Array(40))).toThrow(/not a TrueType font/);
  });
});

describe('decodeVfont', () => {
  it('decodes a .vfont back to the TrueType file it hides', () => {
    const ttf = font('Trade Gothic');
    const v = toVfont(ttf, [9, 200, 31]);
    expect(isVfont(v)).toBe(true);
    expect(isVfont(ttf)).toBe(false);
    expect(decodeVfont(v)).toEqual(ttf);
  });
});
```

Append to `web/src/hud/render.test.ts` (imports: `registerImport, unregisterImport, baseFile` from `./base`; `validateDesign` from `./design`; `setFont` from `./render` if not imported; `_resetImportFaces` from `./fonts`; `sampleHud` from `./importFixtures`; `readFileSync` from `node:fs`; `join` from `node:path`):

```ts
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
});
```

Append to `web/src/hud/fonts.test.ts`, inside the `loadFace` describe (it already stubs FontFace), with imports `registerImport, unregisterImport, baseFile` from `./base`, `importedFace, _resetImportFaces` from `./fonts`, `sampleHud` from `./importFixtures`, `readFileSync` and `join`:

```ts
  it("registers an imported face from the upload's own bytes, once", () => {
    setUp();
    const ID = '8'.repeat(64);
    const scheme = baseFile('stock', 'resource/clientscheme.res').replace(/CustomFontFiles\s*\{/, (m) => `${m}\r\n\t\t"9"\t\t"resource/MyHud.ttf"`);
    registerImport(ID, sampleHud({ 'resource/clientscheme.res': scheme, 'resource/myhud.ttf': new Uint8Array(readFileSync(join(__dirname, 'art/font-trade-gothic.ttf'))) }));
    try {
      const alias = importedFace(`imported:${ID}`, 'trade gothic')!;
      expect(alias).toBe(`HudImp_${'8'.repeat(12)}_Trade_Gothic`);
      loadFace(alias); loadFace(alias);
      expect(add).toHaveBeenCalledTimes(1);
      expect(made[0].family).toBe(alias);
      expect(made[0].source).toBeInstanceOf(ArrayBuffer);
    } finally { unregisterImport(ID); _resetImportFaces(); }
  });
```

(`made` records `source` as the constructor's second argument, which is an `ArrayBuffer` for an imported face.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project web web/src/hud/ttf.test.ts web/src/hud/render.test.ts web/src/hud/fonts.test.ts`
Expected: FAIL, `./ttf` does not resolve and `importedFace` is not exported.

- [ ] **Step 3: Write `web/src/hud/ttf.ts`**

```ts
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

function vdmxRows(dv: DataView, o: number): number[] | undefined {
  const ratios = dv.getUint16(o + 4);
  for (let i = 0; i < ratios; i++) {
    const r = o + 6 + 4 * i;
    const x = dv.getUint8(r + 1), y0 = dv.getUint8(r + 2), y1 = dv.getUint8(r + 3);
    if ((x === 0 && y0 === 0 && y1 === 0) || (x === 1 && y0 <= 1 && 1 <= y1)) {
      const group = o + dv.getUint16(o + 6 + 4 * ratios + 2 * i);
      const n = dv.getUint16(group);
      const rows: number[] = [];
      for (let j = 0; j < n; j++) { const e = group + 4 + 6 * j; rows.push(dv.getUint16(e), dv.getInt16(e + 2), dv.getInt16(e + 4)); }
      return rows;
    }
  }
  return undefined;
}

function names(ttf: Uint8Array, dv: DataView, t: { off: number } | undefined): string[] {
  if (!t) return [];
  const count = dv.getUint16(t.off + 2), strings = t.off + dv.getUint16(t.off + 4);
  const out: string[] = [];
  for (const want of [1, 4]) {
    for (let i = 0; i < count; i++) {
      const r = t.off + 6 + 12 * i;
      if (dv.getUint16(r) !== 3 || dv.getUint16(r + 6) !== want) continue;
      const len = dv.getUint16(r + 8), at = strings + dv.getUint16(r + 10);
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
  const rows = vdmx ? vdmxRows(dv, vdmx.off) : undefined;
  if (rows) metrics.vdmx = rows;
  return { names: names(ttf, dv, tables.get('name')), weight, metrics };
}
```

- [ ] **Step 4: Runtime faces in `web/src/hud/fonts.ts`**

Add imports:

```ts
import { baseFile, importedFiles, type BaseKey } from './base';
import { parseKv, kvFind, pcApplies } from './kv';
import { decodeVfont, isVfont, readFont } from './ttf';
```

Below `known()`, add:

```ts
/**
 * Faces an imported HUD carries (spec, "Fonts"): the .ttf, .otf or .vfont
 * files its schemes' CustomFontFiles name, read at runtime by ttf.ts. Each
 * is registered under an alias that holds the import's id, so two imports
 * with a face of the same name never share it, and fontCell sizes it from
 * its own metrics by the same VDMX-first rule as the stock faces.
 */
const EXTRA_METRICS = new Map<string, FontMetrics>();
const EXTRA_FILES = new Map<string, { data: ArrayBuffer; weight: string }[]>();
const IMPORT_FACES = new Map<BaseKey, Map<string, string>>();

/** The alias for a scheme face on an imported HUD, when the upload carries that face. */
export function importedFace(key: BaseKey, face: string): string | undefined {
  if (!key.startsWith('imported:')) return undefined;
  let faces = IMPORT_FACES.get(key);
  if (!faces) { faces = readImportFaces(key); IMPORT_FACES.set(key, faces); }
  return faces.get(face.trim().toLowerCase());
}

function readImportFaces(key: BaseKey): Map<string, string> {
  const out = new Map<string, string>();
  const files = importedFiles(key)!;
  const tag = key.slice('imported:'.length, 'imported:'.length + 12);
  const paths = new Set<string>();
  for (const scheme of ['resource/clientscheme.res', 'resource/chatscheme.res']) {
    const root = parseKv(baseFile(key, scheme))[0];
    const list = root && typeof root.value !== 'string' ? kvFind(root.value, ['CustomFontFiles']) : undefined;
    if (!list || typeof list.value === 'string') continue;
    for (const n of list.value) {
      // "1" "resource/x.ttf", or the block form "1" { "font" "resource/x.ttf" ... }.
      const v = typeof n.value === 'string' ? (pcApplies(n.cond) ? n.value : undefined)
        : n.value.find((c) => c.key.toLowerCase() === 'font' && typeof c.value === 'string')?.value as string | undefined;
      if (v) paths.add(v.replace(/\\/g, '/').toLowerCase());
    }
  }
  for (const path of [...paths].sort()) {
    const raw = files.get(path);
    if (!raw) continue;                                        // a stock face, or one the upload lacks: the fallback as today
    let ttf: Uint8Array;
    let info: ReturnType<typeof readFont>;
    try { ttf = isVfont(raw) ? decodeVfont(raw) : raw; info = readFont(ttf); }
    catch { console.warn(`HUD preview: could not read the font ${path} in the imported HUD`); continue; }
    for (const name of info.names) {
      const lower = name.toLowerCase();
      const alias = out.get(lower) ?? `HudImp_${tag}_${name.replace(/[^A-Za-z0-9]/g, '_')}`;
      out.set(lower, alias);
      if (!EXTRA_METRICS.has(alias)) EXTRA_METRICS.set(alias, info.metrics);
      EXTRA_FILES.set(alias, [...(EXTRA_FILES.get(alias) ?? []), { data: ttf.slice().buffer, weight: String(cssWeight(info.weight)) }]);
    }
  }
  return out;
}

/** Tests only: forget every imported face. */
export function _resetImportFaces(): void { IMPORT_FACES.clear(); EXTRA_METRICS.clear(); EXTRA_FILES.clear(); }
```

Then make the rest of the module accept an alias:

- `fontCell`: `const m: FontMetrics = EXTRA_METRICS.get(face) ?? FONT_METRICS[known(face) ?? FALLBACK];`
- `cssFamily`: first line `if (EXTRA_METRICS.has(face)) return \`"${face}", ${FALLBACK_STACK}\`;`
- `FILES`' entry type becomes `{ url?: string; data?: ArrayBuffer; weight: string }[]`.
- `loadFace`: resolve with `const name = EXTRA_FILES.has(face) ? face : known(face); const files = name ? EXTRA_FILES.get(name) ?? FILES[name] : undefined;` and build each FontFace as `new FontFace(name, f.data ?? \`url(${f.url})\`, { weight: f.weight })`, keeping only entries with `f.data || f.url`.

- [ ] **Step 5: `setFont` in `web/src/hud/render.ts`**

Add `import { baseOf } from './base';` and `importedFace` to the `./fonts` import. In `setFont`, after `const f = fontFace(design, name);`:

```ts
  // An imported HUD's own face, when the upload carries it, under the alias
  // fonts.ts registered it as; otherwise the face as named, as before.
  const face = design.preset === 'imported' ? importedFace(baseOf(design), f.face) ?? f.face : f.face;
```

and use `face` in place of `f.face` in its `loadFace`, `canvasFont` and `fontCell` calls.

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run --project web web/src/hud/ && npm run typecheck`
Expected: PASS, `art.test.ts` included (fonts.ts is preview-only and build.ts still does not reach it).

- [ ] **Step 7: Commit**

```bash
git add web/src/hud/ttf.ts web/src/hud/ttf.test.ts web/src/hud/fonts.ts web/src/hud/fonts.test.ts web/src/hud/render.ts web/src/hud/render.test.ts
git commit -m "Draw an imported HUD's labels in its own fonts, sized as the game sizes them"
```

---

### Task 9: Draw an imported HUD's own textures and icons, then verify everything

**Files:**
- Create: `web/src/hud/importArt.ts`
- Modify: `web/src/hud/render.ts` (`tinted`, `drawImageChild`, new `scratchCanvas`, `_resetAssetCache`), `web/src/hud/weapons.ts` (`drawNineSlice`, `drawWeapons`, new `iconCell`), `web/src/hud/importFixtures.ts` (`fakeCanvas`)
- Test: `web/src/hud/render.test.ts`, `web/src/hud/weapons.test.ts`

**Interfaces:**
- Consumes: `importedFiles`, `baseOf` (Task 3); `decodeText` (Task 2); `decodeVTF`; `buildTrees`; fixtures.
- Produces:
  - In `importArt.ts`: `interface ImportedArt { src: CanvasImageSource; w: number; h: number; additive: boolean }`; `type ImportedMaterial = ImportedArt | { stock: string; additive: boolean } | null`; `importedMaterial(key: BaseKey, material: string, canvas: (w: number, h: number) => HTMLCanvasElement | null): ImportedMaterial`; `_resetImportedArt(): void`.
  - In `render.ts`: `scratchCanvas(w: number, h: number): HTMLCanvasElement | null`; `tinted(img: CanvasImageSource, key: string, r: number, g: number, b: number, w?: number, h?: number): CanvasImageSource`.
  - In `weapons.ts`: `iconCell(design: HudDesign, entry: string): { file: string; x: number; y: number; w: number; h: number } | undefined`.
  - In `importFixtures.ts`: `fakeCanvas(): { factory: (w: number, h: number) => HTMLCanvasElement; made: { w: number; h: number; pixels?: Uint8ClampedArray }[] }`.

- [ ] **Step 1: Add the canvas fixture** to `web/src/hud/importFixtures.ts`

```ts
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
```

- [ ] **Step 2: Write the failing tests**

Append to `web/src/hud/render.test.ts` (imports: `drawPanel, _setCanvasFactory, _resetAssetCache` from `./render`; `_resetImportedArt` from `./importArt`; `fakeCanvas, recordingCtx` from `./importFixtures`):

```ts
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
    expect(drawnFrom(calls).some((s) => s.rec)).toBe(false);
  });
});
```

Append to `web/src/hud/weapons.test.ts` (imports: `registerImport, unregisterImport` from `./base`; `validateDesign` from `./design`; `drawWeapons, iconCell` from `./weapons`; `_setCanvasFactory` from `./render`; `_resetImportedArt` from `./importArt`; `sampleHud, fakeCanvas, recordingCtx` from `./importFixtures`; `decodeText` from `./text`; `encodeVTF` from `../vpk`):

```ts
describe("an imported HUD's own weapon art", () => {
  const ID = '6'.repeat(64);
  afterEach(() => { unregisterImport(ID); _setCanvasFactory(null); _resetImportedArt(); });
  const modtex = () => decodeText(sampleHud().get('scripts/mod_textures.txt')!).text;
  const cell = (name: string, file: string) => `"${name}"\r\n\t\t{\r\n\t\t\t"file" "${file}"\r\n\t\t\t"x" "0" "y" "0" "width" "2" "height" "2"\r\n\t\t}`;
  const design = (over: Record<string, string | Uint8Array>) => {
    registerImport(ID, sampleHud(over));
    return validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'e' }, crosshair: 'none' });
  };
  const own = (calls: { m: string; a: unknown[] }[]) => calls.filter((c) => c.m === 'drawImage' && (c.a[0] as { rec?: unknown }).rec);

  it("cuts a weapon icon from the upload's texture where its mod_textures.txt cell points", () => {
    _setCanvasFactory(fakeCanvas().factory);
    const d = design({ 'scripts/mod_textures.txt': modtex().replace(/"icon_equip_pumpshotgun"\s*\{[^}]*\}/, cell('icon_equip_pumpshotgun', 'vgui/hud/myart')) });
    expect(iconCell(d, 'icon_equip_pumpshotgun')).toEqual({ file: 'vgui/hud/myart', x: 0, y: 0, w: 2, h: 2 });
    const { ctx, calls } = recordingCtx();
    drawWeapons(ctx, d, { x: 0, y: 0 }, 1, 200);
    expect(own(calls)[0]?.a.slice(1, 5)).toEqual([0, 0, 2, 2]);
  });

  it('finds a cell in hud_textures.txt when mod_textures.txt has none by that name', () => {
    const hudtex = '"sprites/640_hud"\r\n{\r\n\tTextureData\r\n\t{\r\n\t\t' + cell('icon_equip_pumpshotgun', 'vgui/hud/myart') + '\r\n\t}\r\n}\r\n';
    const d = design({
      'scripts/mod_textures.txt': modtex().replace(/"icon_equip_pumpshotgun"\s*\{[^}]*\}/, ''),
      'scripts/hud_textures.txt': hudtex,
    });
    expect(iconCell(d, 'icon_equip_pumpshotgun')?.file).toBe('vgui/hud/myart');
  });

  it("nine-slices a weapon box from the upload's own box texture", () => {
    _setCanvasFactory(fakeCanvas().factory);
    const box = encodeVTF(64, 64, new Uint8ClampedArray(64 * 64 * 4).fill(200));
    const d = design({
      'materials/vgui/hud/mybox.vtf': box,
      'materials/vgui/hud/mybox.vmt': '"UnlitGeneric" { "$baseTexture" "vgui/hud/mybox" }',
      'scripts/mod_textures.txt': modtex().replace(/"rounded_background_glow"\s*\{[^}]*\}/, cell('rounded_background_glow', 'vgui/hud/mybox')),
    });
    const { ctx, calls } = recordingCtx();
    drawWeapons(ctx, d, { x: 0, y: 0 }, 1, 200);
    expect(own(calls).length).toBeGreaterThanOrEqual(9);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run --project web web/src/hud/render.test.ts web/src/hud/weapons.test.ts`
Expected: FAIL, `./importArt` does not resolve and `iconCell` is not exported.

- [ ] **Step 4: Write `web/src/hud/importArt.ts`**

```ts
/**
 * An imported HUD's own textures, for the preview (spec, "Textures").
 *
 * A panel names a material; the game reads materials/<name>.vmt, follows
 * its $baseTexture to a .vtf and draws that. The preview does the same
 * against the upload: the .vmt, its $baseTexture, the .vtf decoded by
 * decodeVTF (DXT included, mip 0), put into a canvas once and cached by
 * base key and material, so two imports never share one. $additive 1 is
 * reported so the caller can add it onto the scene the way the game does.
 *
 * null: the upload has no such material, so the stock art is right. `stock`:
 * the upload's .vmt points at a texture it does not carry, which the game
 * then takes from pak01, so the caller draws that stock texture.
 * Preview only: build.ts never imports this.
 */
import { importedFiles, type BaseKey } from './base';
import { parseKv, kvGet } from './kv';
import { decodeText } from './text';
import { decodeVTF } from '../vpk/read';

export interface ImportedArt { src: CanvasImageSource; w: number; h: number; additive: boolean }
export type ImportedMaterial = ImportedArt | { stock: string; additive: boolean } | null;

const CACHE = new Map<string, ImportedMaterial>();
const tex = (m: string) => m.trim().replace(/\\/g, '/').toLowerCase().replace(/^materials\//, '').replace(/\.(vtf|vmt)$/, '');

export function importedMaterial(key: BaseKey, material: string, canvas: (w: number, h: number) => HTMLCanvasElement | null): ImportedMaterial {
  const files = importedFiles(key);
  if (!files) return null;
  const id = `${key}|${material}`;
  if (CACHE.has(id)) return CACHE.get(id)!;
  const out = read(files, tex(material), canvas);
  CACHE.set(id, out);
  return out;
}

function read(files: ReadonlyMap<string, Uint8Array>, material: string, canvas: (w: number, h: number) => HTMLCanvasElement | null): ImportedMaterial {
  const vmt = files.get(`materials/${material}.vmt`);
  if (!vmt) return null;
  let base = material;
  let additive = false;
  try {
    const root = parseKv(decodeText(vmt).text)[0];
    if (root && typeof root.value !== 'string') {
      base = tex(kvGet(root, '$baseTexture') ?? material);
      additive = (kvGet(root, '$additive') ?? '0').trim() === '1';
    }
  } catch { return null; }
  const vtf = files.get(`materials/${base}.vtf`);
  if (!vtf) return { stock: base, additive };
  try {
    const { w, h, rgba } = decodeVTF(vtf);
    const c = canvas(w, h);
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return null;
    const img = ctx.createImageData(w, h);
    img.data.set(rgba);
    ctx.putImageData(img, 0, 0);
    return { src: c, w, h, additive };
  } catch {
    console.warn(`HUD preview: could not read materials/${base}.vtf in the imported HUD`);
    return null;
  }
}

/** Tests only: forget every decoded texture. */
export function _resetImportedArt(): void { CACHE.clear(); }
```

- [ ] **Step 5: `web/src/hud/render.ts`**

- Add `import { baseOf } from './base';` (if Task 8 has not already) and `import { importedMaterial, type ImportedArt } from './importArt';`.
- Below `_setCanvasFactory`, add:

```ts
/** A scratch canvas from the same factory tests replace: importArt.ts decodes an imported texture into one. */
export function scratchCanvas(w: number, h: number): HTMLCanvasElement | null { return canvasFactory(w, h); }
```

- `tinted` takes any image source and its size (the cache key is whatever names the source: a stock material, or an import's key and material):

```ts
export function tinted(img: CanvasImageSource, key: string, r: number, g: number, b: number,
  w = (img as HTMLImageElement).naturalWidth, h = (img as HTMLImageElement).naturalHeight): CanvasImageSource {
  const id = `${key}|${r},${g},${b}`;
  const cached = tints.get(id);
  if (cached) return cached;
  const c = canvasFactory(w, h);
  const t = c?.getContext('2d');
  if (!c || !t) return img;
  t.drawImage(img, 0, 0, w, h);
  t.globalCompositeOperation = 'multiply';
  t.fillStyle = `rgb(${r},${g},${b})`;
  t.fillRect(0, 0, w, h);
  t.globalCompositeOperation = 'destination-in';
  t.drawImage(img, 0, 0, w, h);
  t.globalCompositeOperation = 'source-over';
  tints.set(id, c);
  return c;
}
```

- In `drawImageChild`, split the texture drawing out of the `if (image)` branch so both sources share it, and look in the upload first:

```ts
/** A texture drawn as an ImagePanel draws it: tinted by drawColor (or the health colour), stretched or unscaled, added when the material is additive. */
function drawTexture(ctx: CanvasRenderingContext2D, n: KvNode, r: ChildRect, k: number, opts: DrawOpts,
  src0: CanvasImageSource, w: number, h: number, key: string, additive: boolean) {
  let [tr, tg, tb, ta] = parseColour(kvGet(n, 'drawColor') ?? '255 255 255 255');
  if (HEALTH_TINT_CHILDREN.has(n.key.toLowerCase())) [tr, tg, tb] = sampleHealthRgb(opts);   // game code's colour, over the file's
  const src = tr < 255 || tg < 255 || tb < 255 ? tinted(src0, key, tr, tg, tb, w, h) : src0;
  const dest = (kvGet(n, 'scaleImage') ?? '0') !== '0' ? r : { ...r, w: w * k, h: h * k };   // unscaled: texture pixels are HUD units
  const paint = (c: CanvasRenderingContext2D) => c.drawImage(src, dest.x, dest.y, dest.w, dest.h);
  ctx.save();
  ctx.globalAlpha *= ta / 255;
  if (additive) paintAdditive(ctx, dest, paint); else paint(ctx);
  ctx.restore();
}
```

  and the `if (image)` branch becomes:

```ts
  if (image) {
    const material = normaliseMaterial(image);
    if (material.startsWith('vgui/hud/hudeditor/')) {
      drawSlotStyle(ctx, design, material.slice('vgui/hud/hudeditor/'.length), r);   // false: an upload; the game shows it, we cannot yet
      return;
    }
    // An imported HUD's own material first; the stock art where it has none.
    const key = baseOf(design);
    const own = design.preset === 'imported' ? importedMaterial(key, material, canvasFactory) : null;
    if (own && 'src' in own) { drawTexture(ctx, n, r, k, opts, own.src, own.w, own.h, `${key}|${material}`, own.additive); return; }
    const stock = own && 'stock' in own ? own.stock : material;
    const img = artImage(stock, opts.onAsset);
    if (!img) { if (missing.has(stock)) hatch(ctx, r); return; }   // loading: draw nothing yet; missing: say so
    drawTexture(ctx, n, r, k, opts, img, img.naturalWidth, img.naturalHeight, stock, own !== null && own.additive);
    return;
  }
```

  (`ImportedArt` is imported for the type only; drop it from the import if unused.) The stock path draws exactly as before: same tint, same alpha, same rectangles, `additive` false.
- `drawItems`' `tinted(img, name, cr, cg, cb)` call is unchanged (its defaults read `naturalWidth`/`naturalHeight`).
- `_resetAssetCache` also calls `_resetImportedArt()` (import it from `./importArt`).

- [ ] **Step 6: `web/src/hud/weapons.ts`**

- Imports: `import { baseOf } from './base';`, `import { importedMaterial } from './importArt';`, and `scratchCanvas` from `./render`.
- `drawNineSlice(ctx, img: CanvasImageSource, tw: number, th: number, x, y, w, h, corner)`: take the texture size as parameters instead of reading `img.naturalWidth`/`naturalHeight`; the existing call passes `box.naturalWidth, box.naturalHeight`.
- Add:

```ts
/**
 * A mod_textures.txt (then hud_textures.txt) cell the paint asks for by
 * name: the material it cuts from and its rect in texels. The weapon
 * selection looks names up in the game's icon dictionary, which both files
 * fill; mod_textures.txt is the one probe B showed the paint reads, so it
 * wins. A glyph cell (font and character, no file) has no rect and is left
 * to the preview's own art.
 */
export function iconCell(design: HudDesign, entry: string): { file: string; x: number; y: number; w: number; h: number } | undefined {
  for (const path of ['scripts/mod_textures.txt', 'scripts/hud_textures.txt']) {
    const cells = kvFind(buildTrees(design)(path), ['TextureData']);
    const e = cells && typeof cells.value !== 'string' ? kvFind(cells.value, [entry]) : undefined;
    const file = e && kvGet(e, 'file');
    if (!e || !file) continue;
    const n = (k: string) => parseFloat(kvGet(e, k) ?? '0') || 0;
    return { file: file.toLowerCase(), x: n('x'), y: n('y'), w: n('width'), h: n('height') };
  }
  return undefined;
}
```

- In `drawWeapons`, before the loop, `const key = design.preset === 'imported' ? baseOf(design) : null;`. The box: `const ownBox = key && s.art ? importedMaterial(key, s.art, scratchCanvas) : null;` and, ahead of the `else if (box)` branch, `else if (ownBox && 'src' in ownBox) { ctx.save(); ctx.globalAlpha *= BOX_ALPHA; drawNineSlice(ctx, ownBox.src, ownBox.w, ownBox.h, frame.x, frame.y, frame.w, frame.h, s.corner * k); ctx.restore(); }`. The icon, ahead of the stock `artImage` path:

```ts
    // An imported HUD that repoints an icon's cell at its own texture shows its own art.
    const cellOf = key && !s.icon.hidden ? iconCell(design, s.icon.name.replace('icon/equip/', 'icon_equip_')) : undefined;
    const ownIcon = cellOf ? importedMaterial(key!, cellOf.file, scratchCanvas) : null;
    if (cellOf && ownIcon && 'src' in ownIcon) {
      ctx.save();
      let src: CanvasImageSource = ownIcon.src;
      if (s.icon.tint) {
        const [r, g, b, a] = rgbaOf(design, s.icon.tint);
        if (r < 255 || g < 255 || b < 255) src = tinted(ownIcon.src, `${key}|${cellOf.file}`, r, g, b, ownIcon.w, ownIcon.h);
        ctx.globalAlpha *= a / 255;
      }
      ctx.drawImage(src, cellOf.x, cellOf.y, cellOf.w, cellOf.h, icon.x, icon.y, icon.w, icon.h);
      ctx.restore();
    } else {
      // ...the existing stock icon drawing, unchanged...
    }
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run --project web web/src/hud/ && npm run typecheck`
Expected: PASS, `art.test.ts`'s boundary walk included (importArt.ts is reached from render.ts, never from build.ts).

- [ ] **Step 8: Commit**

```bash
git add web/src/hud/importArt.ts web/src/hud/render.ts web/src/hud/render.test.ts web/src/hud/weapons.ts web/src/hud/weapons.test.ts web/src/hud/importFixtures.ts
git commit -m "Draw an imported HUD's own textures and weapon icons in the preview"
```

- [ ] **Step 9: The whole chain**

Run: `npm test && npm run typecheck && npm run build && bash scripts/check-hud-vpk.sh && HUD_SAMPLE=b bash scripts/check-hud-vpk.sh && HUD_SAMPLE=w bash scripts/check-hud-vpk.sh`
Then: `HUD_SAMPLE=i bash scripts/check-hud-vpk.sh`
Expected: all PASS; report the real output. The known pre-existing noise (ECONNREFUSED on port 3000 from replay-viewer tests) is not this plan's.

- [ ] **Step 10: No em dashes**

Run: `git diff 1c6ac05 --name-only | xargs grep -lP '\x{2014}' || echo none`
Expected: `none`.

- [ ] **Step 11: Hand-off. Stop here.** Do not merge, push or deploy, and leave the vite server on `:5199` running. Write down for the owner exactly what to check on `http://localhost:5199/hud` (spec, "Owner check"):
  1. Preset, Import a HUD..., pick `/home/volence/l4d/hud/test-hud-2026-09-23/my_hud.vpk.orig`: the status says "Imported my_hud." (or the name it derives), the select shows "Imported: ...", and the preview matches the game screenshots of that HUD, fonts and textures included.
  2. Import one community HUD (a `.zip` of its folder): same comparison.
  3. Make an edit (move the health panel), Download, install the `.vpk` in `left4dead/addons/`, and check in game: campaign Expert, map 2, `sv_cheats 1; z_difficulty impossible; map l4d_hospital02_subway`.
  4. Reload the page: the imported design reopens without the banner. Preset, Remove an imported HUD..., remove it: the banner appears and Download is disabled; import it again: both clear.
