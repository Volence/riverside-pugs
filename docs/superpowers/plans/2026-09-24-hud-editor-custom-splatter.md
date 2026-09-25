# HUD Editor: Custom Damage Splatter, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Hand an implementer one or two tasks at a time, in order.

**Goal:** A player picks, for the teammate card splatter and for the own-health panel's top and bottom scratches: the stock art, none, a generated Fade, or their own image. The download ships it and the preview draws exactly those pixels, the way the game draws them.

**Architecture:** A leaf registry (`web/src/hud/splatter.ts`) lists the three splatters. The design stores a `splatters` map (kind, Fade colour, Keep my colours) and uploads in the existing `design.images`. One new build pass, `splatterPass`, runs after `hidePass` in both `buildHud` and `buildTrees`: for the teammate splatter it injects a stand-in ImagePanel `HudEdSplatter` right after `BackgroundImage` (copying its final rect, zpos and drawColor) and writes the stock one's drawColor alpha as 0, because client.dll names `healthbar_bg_N` itself and an addon cannot replace a pak01 texture; for the scratches it repoints the block's `image` key. Textures go to `materials/vgui/hud/hudeditor/<id lower>.vtf` with the existing `encodeVTF` and `vmtFor` (which gains a no-`$vertexcolor` option). `render.ts` draws those materials from the same pixels (Fade) or the same stored PNG (Image) through the existing `drawTexture`, so tint and stretching match the stock art path.

**Tech Stack:** TypeScript, Preact, Vite, vitest (project `web`, happy-dom; `// @vitest-environment node` where a test reads files), canvas 2D. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-hud-editor-custom-splatter-design.md`. Read it first, especially "What the game does" and "Decided overnight". Engine facts behind the passes: `docs/superpowers/specs/2026-09-21-hud-editor-design.md` and the header comments of `web/src/hud/build.ts`. Project history and in-game traps: `/home/volence/.claude/projects/-home-volence-l4d/memory/pug-hud-editor.md`.

**Baseline (recorded 2026-09-24 at 248754a, before this plan):** `npx vitest run` gives **Test Files 259 passed (259), Tests 4179 passed (4179)**. Every task ends with the full suite at or above this count, all passing.

## Global Constraints

- FIRST RULE: never run `git stash` in any form. Never checkout, switch, reset or rebase, never move HEAD. Commit only your own files, by explicit path (`git add <path>`, never `-A` or `.`). If `.git/index.lock` blocks you, wait a few seconds and retry: another agent may be committing in the same worktree.
- Work only in `/home/volence/l4d/pug/.claude/worktrees/hud-editor` (branch `worktree-hud-editor`). No push, no deploy, no ssh, no rcon.
- Commands run from the worktree root. Tests: `npx vitest run --project web <paths>`. Types: `npm run typecheck`. Build: `npm run build`.
- Never use em dashes (or en dashes) anywhere: code, comments, UI copy, commit messages. Use commas, colons or separate sentences.
- Match the surrounding comment style: block comments that say why, as in `web/src/hud/build.ts`.
- Preview equals file: the canvas draws from `buildTrees`; nothing else decides a position. A texture the build ships and the picture the preview draws come from the same pixels.
- Valve's stock art (`web/src/hud/art/`) stays preview-only: nothing `build.ts` reaches may import it (`art.test.ts` must keep passing). `splatter.ts` must not import `render.ts`, `art.ts` or `art/`.
- Downloads of designs without splatters stay byte-identical: `web/src/hud/download.golden.test.ts` passes unchanged, hashes untouched. `vmtFor`'s default output must not change.
- TDD: write the test, run it and capture the RED output in the task report, implement, then GREEN. Then run the whole suite and report the count.
- Small plain-English commits, at least one per task (for example "Draw a custom damage splatter in the preview from the pixels the download ships").
- When a step appends tests to an existing file, merge imports into its existing import block (one import per module).
- The local test server `/home/volence/l4d1-ds` and the owner's game are shared: never kill a srcds or game process you did not start.

## Decisions this plan locks in

- **Ids:** `splatTeam`, `splatTop`, `splatBottom` (they pass design.ts's `ID` regex). Materials `vgui/hud/hudeditor/splatteam`, `splattop`, `splatbottom`; the .res value is `hud/hudeditor/<id lower>` (an ImagePanel prefixes `vgui/`).
- **Sizes:** splatTeam 512 x 256, splatTop and splatBottom 256 x 64 (the stock textures). A stored image must be exactly its splatter's size or validateDesign drops it.
- **Kinds:** `'stock' | 'none' | 'fade' | 'image'`. splatTeam never stores `'none'`: its None is the child hide `children.teamColumn.BackgroundImage.visible === false`. validateDesign turns a stored splatTeam `'none'` into no entry.
- **Active:** a splatter draws custom art when its kind is `'fade'`, or `'image'` with `design.images[id]` present. An image kind with no image is Stock everywhere (a share link).
- **Stand-in:** block name `HudEdSplatter`, keys in this order: `ControlName ImagePanel`, `fieldName HudEdSplatter`, `xpos`, `ypos`, `wide`, `tall`, `zpos` (copied from BackgroundImage after childPass, fitPass and hidePass; zpos default `-1`), `visible 1`, `enabled 1`, `scaleImage 1`, `image hud/hudeditor/splatteam`, `drawColor` (BackgroundImage's own, default `255 255 255 255`). BackgroundImage then gets drawColor `<r g b> 0`. Skipped entirely when BackgroundImage is hidden.
- **Scratches:** `image` set with `pcSet` to `hud/hudeditor/splattop` / `splatbottom`; `'none'` is `hardHide(block)`.
- **Keep my colours:** only on splatTop and splatBottom; writes the `.vmt` without `$vertexcolor 1`; the preview ignores every RGB tint for that block (drawColor and health colour), keeping the alpha.
- **Fade pixels:** `fadeTexture(w, h, colour)`: RGB from the colour, alpha `round(a * (1 - (x + 0.5) / w))` for column x, the same on every row.
- **Missing pixels at download:** `buildHud` throws `"<label>: the image could not be read. Pick it again, or choose Stock."` for an active splatter whose pixels are missing or the wrong length (as crosshairPass does), so a download never points at a texture it does not ship.
- **Preview of the stock teammate splatter:** card N (0-based `opts.card`) draws `vgui/hud/healthbar_bg_<N+1>`, as client.dll does, whatever the file's `image` says.
- **Storage:** uploads in `design.images` (PNG base64, the texture size). `saveDesign` returns `false` when storage refuses, and the page says so.
- **Preset switch:** splatters are kept, like styles.

## File Structure

```
web/src/hud/splatter.ts               NEW  registry, types, material names, splatterActive, fadePixels
web/src/hud/splatter.test.ts          NEW
web/src/hud/textures.ts               + fadeTexture; vmtFor(name, { vertexColor })
web/src/hud/textures.test.ts          + fadeTexture, vmtFor option
web/src/hud/design.ts                 HudDesign.splatters, validateDesign, images for splatter ids, saveDesign returns boolean
web/src/hud/design.test.ts            + splatters validation, share link
web/src/hud/build.ts                  splatterPass (buildHud and buildTrees), splatterProblem, pass-order comment
web/src/hud/splatter.build.test.ts    NEW
web/src/hud/render.ts                 drawSplatter, splatterSource, drawTexture vertexColour option and alpha-0 skip, per-slot stock splatter
web/src/hud/render.test.ts            + "custom splatter" describe
web/src/hud/edit.ts                   splatterKind, patchSplatter, withSplatterImage, resetSplatter; hasOverrides counts splatters
web/src/hud/edit.test.ts              + those
web/src/hud/children.ts               BackgroundImage note
web/src/routes/Hud.tsx                assetSize, assetsFor for splatter images, Splatter panel, upload handler, save warning
web/src/routes/hud/SplatterControls.tsx NEW  SplatterRow, TintStrip
web/src/routes/Hud.assets.test.tsx    + assetSize
web/src/routes/Hud.test.tsx           + "Splatter" tests
web/src/styles/app.css                + .hud__tintstrip
web/src/hud/sample.vpkcheck.test.ts   + HUD_SAMPLE=s
scripts/check-hud-vpk.sh              + sample s assertions (srctools)
```

---

### Task 1: The splatter registry, Fade pixels and the material option

**Files:**
- Create: `web/src/hud/splatter.ts`, `web/src/hud/splatter.test.ts`
- Modify: `web/src/hud/textures.ts`, `web/src/hud/textures.test.ts`

**Interfaces produced:**

```ts
// textures.ts
export function fadeTexture(w: number, h: number, colour: string): Uint8ClampedArray;
export function vmtFor(materialName: string, opts?: { vertexColor?: boolean }): string;

// splatter.ts
export type SplatterId = 'splatTeam' | 'splatTop' | 'splatBottom';
export type SplatterKind = 'stock' | 'none' | 'fade' | 'image';
export interface SplatterStyle { kind: SplatterKind; color?: string; keepColours?: boolean }
export interface SplatterDef {
  id: SplatterId; label: string; file: string; block: string;
  size: { w: number; h: number };
  route: 'standIn' | 'repoint';
  healthTint: boolean;
  defaultColor: string;
  /** The texture's shape, for the upload hint. */
  aspect: string;
}
export const SPLATTERS: readonly SplatterDef[];
export const SPLAT_STAND_IN = 'HudEdSplatter';
export function splatterDef(id: string): SplatterDef | undefined;
export function splatterMaterial(id: SplatterId): string;       // 'vgui/hud/hudeditor/splatteam'
export function splatterImageKey(id: SplatterId): string;       // 'hud/hudeditor/splatteam'
export function splatterForMaterial(material: string): SplatterDef | undefined;
export function splatterActive(d: { splatters?: Partial<Record<SplatterId, SplatterStyle>>; images: Record<string, unknown> }, id: SplatterId): boolean;
export function fadePixels(def: SplatterDef, style: SplatterStyle): Uint8ClampedArray;
```

- [ ] **Step 1: Write the failing tests.** Append to `web/src/hud/textures.test.ts`:

```ts
describe('fadeTexture', () => {
  it('fades the colour from the left edge to clear at the right, the same on every row', () => {
    const px = fadeTexture(4, 2, '10 20 30 200');
    const alpha = (x: number, y: number) => px[(y * 4 + x) * 4 + 3];
    expect([0, 1, 2, 3].map((x) => alpha(x, 0))).toEqual([175, 125, 75, 25]);
    expect([0, 1, 2, 3].map((x) => alpha(x, 1))).toEqual([175, 125, 75, 25]);
    expect([...px.slice(0, 3)]).toEqual([10, 20, 30]);
  });
});

describe('vmtFor', () => {
  it('keeps its default output, which every existing download ships', () => {
    expect(vmtFor('vgui/hud/hudeditor/x')).toBe('UnlitGeneric\n{\n\t$basetexture "vgui/hud/hudeditor/x"\n\t$translucent 1\n\t$vertexcolor 1\n\t$vertexalpha 1\n\t$ignorez 1\n\t$no_fullbright 1\n\t$nomip 1\n}\n');
  });
  it('leaves out $vertexcolor, and only that, when asked', () => {
    const v = vmtFor('vgui/hud/hudeditor/x', { vertexColor: false });
    expect(v).not.toContain('$vertexcolor');
    expect(v).toBe(vmtFor('vgui/hud/hudeditor/x').replace('\t$vertexcolor 1\n', ''));
  });
});
```

Create `web/src/hud/splatter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SPLATTERS, splatterDef, splatterMaterial, splatterImageKey, splatterForMaterial, splatterActive, fadePixels } from './splatter';
import { baseFile } from './base';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { fadeTexture } from './textures';

describe('the splatter registry', () => {
  it('names blocks both presets really have, with the stock image each one shows', () => {
    // The stock image keys pin the registry to the files: a typo here lands in a player's game.
    const stockImage: Record<string, string> = {
      splatTeam: 'hud/healthbar_bg_1',
      splatTop: '../vgui/hud/detail_scratches_top_1',
      splatBottom: '../vgui/hud/detail_scratches_bottom_1',
    };
    for (const def of SPLATTERS) {
      for (const preset of ['stock', 'modern'] as const) {
        const root = parseKv(baseFile(preset, def.file))[0].value as KvNode[];
        expect(kvFind(root, [def.block]), `${preset} ${def.file} ${def.block}`).toBeDefined();
      }
      const stock = kvFind(parseKv(baseFile('stock', def.file))[0].value as KvNode[], [def.block])!;
      expect(kvGet(stock, 'image')).toBe(stockImage[def.id]);
    }
  });

  it('uses the stock texture sizes, powers of two, and new names under hudeditor', () => {
    expect(SPLATTERS.map((d) => [d.id, d.size.w, d.size.h])).toEqual([
      ['splatTeam', 512, 256], ['splatTop', 256, 64], ['splatBottom', 256, 64],
    ]);
    expect(splatterMaterial('splatTeam')).toBe('vgui/hud/hudeditor/splatteam');
    expect(splatterImageKey('splatBottom')).toBe('hud/hudeditor/splatbottom');
    expect(splatterForMaterial('vgui/hud/hudeditor/splattop')?.id).toBe('splatTop');
    expect(splatterForMaterial('vgui/hud/hudeditor/panelbg')).toBeUndefined();
    expect(splatterDef('nope')).toBeUndefined();
  });

  it('marks only the scratches as tinted by health, and only the teammate splatter as a stand-in', () => {
    expect(SPLATTERS.map((d) => [d.id, d.route, d.healthTint])).toEqual([
      ['splatTeam', 'standIn', false], ['splatTop', 'repoint', true], ['splatBottom', 'repoint', true],
    ]);
  });
});

describe('splatterActive', () => {
  const png = { w: 512, h: 256, png: 'AAAA' };
  it('is true for a Fade, and for an Image only with its picture stored', () => {
    expect(splatterActive({ splatters: { splatTeam: { kind: 'fade' } }, images: {} }, 'splatTeam')).toBe(true);
    expect(splatterActive({ splatters: { splatTeam: { kind: 'image' } }, images: {} }, 'splatTeam')).toBe(false);
    expect(splatterActive({ splatters: { splatTeam: { kind: 'image' } }, images: { splatTeam: png } }, 'splatTeam')).toBe(true);
    expect(splatterActive({ splatters: { splatTeam: { kind: 'stock' } }, images: { splatTeam: png } }, 'splatTeam')).toBe(false);
    expect(splatterActive({ images: {} }, 'splatTop')).toBe(false);
  });
});

describe('fadePixels', () => {
  it("is fadeTexture at the splatter's size, in its colour or the default", () => {
    const def = splatterDef('splatTop')!;
    expect(fadePixels(def, { kind: 'fade', color: '1 2 3 4' })).toEqual(fadeTexture(256, 64, '1 2 3 4'));
    expect(fadePixels(def, { kind: 'fade' })).toEqual(fadeTexture(256, 64, def.defaultColor));
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web web/src/hud/textures.test.ts web/src/hud/splatter.test.ts`. Expect RED: `fadeTexture` is not exported, `./splatter` does not exist.

- [ ] **Step 3: Implement `textures.ts`.** Add `fadeTexture` after `roundedTexture`:

```ts
/**
 * The Fade splatter: the colour at its own alpha on the left edge, fading
 * linearly to clear at the right, the same on every row, so it reads as a
 * clean bar behind a card or a health bar whatever height the panel shows.
 */
export function fadeTexture(w: number, h: number, colour: string): Uint8ClampedArray {
  const [r, g, b, a] = parseColour(colour);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let x = 0; x < w; x++) {
    const alpha = Math.round(a * (1 - (x + 0.5) / w));
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = alpha;
    }
  }
  return out;
}
```

Change `vmtFor` to take `opts: { vertexColor?: boolean } = {}` and emit the `\t$vertexcolor 1\n` line only when `opts.vertexColor !== false`, everything else byte for byte as now. Add a comment: without `$vertexcolor` the engine ignores the draw colour's RGB, which is how "Keep my colours" stops client.dll's health tint on the scratches (unproven in game until Task 8).

- [ ] **Step 4: Implement `splatter.ts`.** Header comment: what a splatter is, the three entries, why the teammate one is a stand-in (client.dll sets `hud/healthbar_bg_N` by card slot, so the .res `image` key never wins, and an addon cannot replace a pak01 texture; cite the spec) and why the scratches are repointed (their names come only from `localplayerpanel.res`). It imports only `./textures` (values) and nothing else.

```ts
import { fadeTexture } from './textures';

const TEAM_FILE = 'resource/ui/hud/teammatepanel.res';
const OWN_FILE = 'resource/ui/hud/localplayerpanel.res';

export const SPLATTERS: readonly SplatterDef[] = [
  { id: 'splatTeam', label: 'Teammate card splatter', file: TEAM_FILE, block: 'BackgroundImage',
    size: { w: 512, h: 256 }, route: 'standIn', healthTint: false, defaultColor: '0 0 0 170', aspect: '2:1' },
  { id: 'splatTop', label: 'Your health: top scratches', file: OWN_FILE, block: 'HealthbarTextureTop',
    size: { w: 256, h: 64 }, route: 'repoint', healthTint: true, defaultColor: '255 255 255 255', aspect: '4:1' },
  { id: 'splatBottom', label: 'Your health: bottom scratches', file: OWN_FILE, block: 'HealthbarTextureBottom',
    size: { w: 256, h: 64 }, route: 'repoint', healthTint: true, defaultColor: '255 255 255 255', aspect: '4:1' },
];
export const SPLAT_STAND_IN = 'HudEdSplatter';
export const splatterDef = (id: string) => SPLATTERS.find((s) => s.id === id);
export const splatterMaterial = (id: SplatterId) => `vgui/hud/hudeditor/${id.toLowerCase()}`;
export const splatterImageKey = (id: SplatterId) => `hud/hudeditor/${id.toLowerCase()}`;
export const splatterForMaterial = (material: string) => SPLATTERS.find((s) => splatterMaterial(s.id) === material);

export function splatterActive(d: { splatters?: Partial<Record<SplatterId, SplatterStyle>>; images: Record<string, unknown> }, id: SplatterId): boolean {
  const s = d.splatters?.[id];
  return s?.kind === 'fade' || (s?.kind === 'image' && d.images[id] !== undefined);
}

export function fadePixels(def: SplatterDef, style: SplatterStyle): Uint8ClampedArray {
  return fadeTexture(def.size.w, def.size.h, style.color ?? def.defaultColor);
}
```

- [ ] **Step 5: GREEN**, then the full suite (`npx vitest run`), `npm run typecheck`. Commit `web/src/hud/splatter.ts web/src/hud/splatter.test.ts web/src/hud/textures.ts web/src/hud/textures.test.ts`: "Add the damage splatter registry and a generated Fade texture".

---

### Task 2: Splatters in the design

**Files:**
- Modify: `web/src/hud/design.ts`, `web/src/hud/design.test.ts`, `web/src/hud/edit.ts` (only `hasOverrides`), `web/src/hud/edit.test.ts`

**Interfaces produced:**
- `HudDesign.splatters?: Partial<Record<SplatterId, SplatterStyle>>` with a doc comment (kinds, splatTeam never stores `'none'`, images live in `images` under the same id).
- `saveDesign(d: HudDesign): boolean` (false when localStorage refused).

- [ ] **Step 1: Write the failing tests.** Append to `web/src/hud/design.test.ts` (merge imports; `PNG_OK` is any string matching `/^[A-Za-z0-9+/=]+$/`):

```ts
describe('splatters', () => {
  const PNG_OK = 'iVBORw0KGgo=';
  it('keeps valid splatter styles and drops what does not belong', () => {
    const d = validateDesign({ v: 1, splatters: {
      splatTeam: { kind: 'fade', color: '1 2 3 4', keepColours: true },   // keepColours is for the scratches only
      splatTop: { kind: 'image', keepColours: true },
      splatBottom: { kind: 'none' },
      nope: { kind: 'fade' },
    } });
    expect(d.splatters).toEqual({
      splatTeam: { kind: 'fade', color: '1 2 3 4' },
      splatTop: { kind: 'image', keepColours: true },
      splatBottom: { kind: 'none' },
    });
  });

  it("never stores None for the teammate splatter: that is the child's hide", () => {
    expect(validateDesign({ v: 1, splatters: { splatTeam: { kind: 'none' } } }).splatters).toBeUndefined();
  });

  it('turns an unknown kind into stock and leaves no splatters key when nothing survives', () => {
    expect(validateDesign({ v: 1, splatters: { splatTop: { kind: 'sparkles' } } }).splatters).toEqual({ splatTop: { kind: 'stock' } });
    expect(validateDesign({ v: 1, splatters: 'x' }).splatters).toBeUndefined();
    expect(validateDesign({ v: 1 }).splatters).toBeUndefined();
  });

  it("keeps a splatter image only at its splatter's exact texture size", () => {
    const d = validateDesign({ v: 1, images: {
      splatTeam: { w: 512, h: 256, png: PNG_OK },
      splatTop: { w: 512, h: 256, png: PNG_OK },          // wrong size for a scratch
      splatBottom: { w: 256, h: 64, png: PNG_OK },
    } });
    expect(Object.keys(d.images).sort()).toEqual(['splatBottom', 'splatTeam']);
  });

  it('sends splatter kinds and Fade colours in a share link, and no images', async () => {
    const d = validateDesign({ v: 1, splatters: { splatTeam: { kind: 'image' }, splatTop: { kind: 'fade', color: '9 9 9 99' } },
      images: { splatTeam: { w: 512, h: 256, png: PNG_OK } } });
    const back = (await decodeShare(await encodeShare(d)))!;
    expect(back.splatters).toEqual(d.splatters);
    expect(back.images).toEqual({});
  });
});

describe('saveDesign', () => {
  it('says whether the browser kept the design', () => {
    expect(saveDesign(structuredClone(DEFAULT_DESIGN))).toBe(true);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    try { expect(saveDesign(structuredClone(DEFAULT_DESIGN))).toBe(false); } finally { spy.mockRestore(); }
  });
});
```

Append to `web/src/hud/edit.test.ts` (in or next to the existing `hasOverrides` describe):

```ts
it('counts a splatter as an override, and keeps splatters across a preset switch', () => {
  const d = { ...structuredClone(DEFAULT_DESIGN), splatters: { splatTop: { kind: 'fade' as const } } };
  expect(hasOverrides(d, null)).toBe(true);
  expect(withPreset(d, 'modern', true).splatters).toEqual({ splatTop: { kind: 'fade' } });
});
```

- [ ] **Step 2: Run** `npx vitest run --project web web/src/hud/design.test.ts web/src/hud/edit.test.ts`: RED.

- [ ] **Step 3: Implement.** In `design.ts`:
  - `import { SPLATTERS, splatterDef, type SplatterId, type SplatterStyle } from './splatter';`
  - Add `splatters?` to `HudDesign` (after `weapons`).
  - In `validateDesign`, after the styles loop:

```ts
  if (isObj(raw.splatters)) {
    const out: Partial<Record<SplatterId, SplatterStyle>> = {};
    for (const def of SPLATTERS) {
      const v = raw.splatters[def.id];
      if (!isObj(v)) continue;
      // The teammate splatter's None is the BackgroundImage child's hide, one flag
      // that Layers and Delete already use, so it is never stored here.
      const kind = oneOf(v.kind, ['stock', 'none', 'fade', 'image'] as const, 'stock');
      if (kind === 'none' && def.route === 'standIn') continue;
      const s: SplatterStyle = { kind };
      const c = colour(v.color); if (c) s.color = c;
      if (def.healthTint && v.keepColours === true) s.keepColours = true;
      out[def.id] = s;
    }
    if (Object.keys(out).length) d.splatters = out;
  }
```

  - In the images loop, accept splatter ids: replace the `isSlot(id)` test with `(isSlot(id) || splatterDef(id))`, and for a splatter id also `continue` unless `w === def.size.w && h === def.size.h` (comment: the preview draws the stored PNG and the build encodes it at the texture size, so only that size can be both).
  - `saveDesign` returns `true` after `setItem`, `false` from the catch. Update its comment: the page warns when a design (with its uploads) no longer fits.
  - In `edit.ts` `hasOverrides`, add `|| Object.keys(d.splatters ?? {}).length > 0`.
- [ ] **Step 4: GREEN**, full suite, typecheck. Commit the four files: "Store damage splatter choices in the HUD design".

---

### Task 3: The build pass

**Files:**
- Modify: `web/src/hud/build.ts`
- Create: `web/src/hud/splatter.build.test.ts`

**Interfaces produced:**
- `splatterProblem(design: HudDesign, id: SplatterId): string | null` exported from `build.ts`: why a row cannot be used on this base, or null.
- `splatterPass` (internal), run in `buildHud` and `buildTrees` right after `hidePass`.

- [ ] **Step 1: Write the failing tests** in `web/src/hud/splatter.build.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { buildHud, buildTrees, splatterProblem } from './build';
import { DEFAULT_DESIGN, type HudDesign } from './design';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { decodeVTF } from '../vpk/read';
import { fadeTexture, vmtFor } from './textures';
import { registerImport, unregisterImport, baseFile } from './base';
import { sampleHud, latin1, dropBlock } from './importFixtures';

const CARD = 'resource/ui/hud/teammatepanel.res';
const OWN = 'resource/ui/hud/localplayerpanel.res';
const design = (patch: Partial<HudDesign>): HudDesign => ({ ...structuredClone(DEFAULT_DESIGN), elements: {}, ...patch });
const text = (files: { path: string; data: Uint8Array }[], path: string) => {
  const f = files.find((x) => x.path === path);
  return f ? new TextDecoder('latin1').decode(f.data) : undefined;
};
const tree = (files: { path: string; data: Uint8Array }[], path: string) => parseKv(text(files, path) ?? baseFile('stock', path))[0].value as KvNode[];
const rect = (n: KvNode) => ['xpos', 'ypos', 'wide', 'tall', 'zpos'].map((k) => kvGet(n, k));
const PNG = { w: 512, h: 256, png: 'iVBORw0KGgo=' };
const TEAM_PX = new Uint8ClampedArray(512 * 256 * 4).map((_, i) => (i * 7) & 0xff);
const TOP_PX = new Uint8ClampedArray(256 * 64 * 4).map((_, i) => (i * 13) & 0xff);

describe('splatterPass, the teammate splatter', () => {
  it('injects HudEdSplatter right after BackgroundImage at its rect, and turns the stock one to alpha 0', () => {
    const files = buildHud(design({ splatters: { splatTeam: { kind: 'fade', color: '200 0 0 255' } } }));
    const nodes = tree(files, CARD);
    const i = nodes.findIndex((n) => n.key === 'BackgroundImage');
    const stand = nodes[i + 1];
    expect(stand.key).toBe('HudEdSplatter');
    expect(rect(stand)).toEqual(rect(nodes[i]));
    expect([kvGet(stand, 'ControlName'), kvGet(stand, 'image'), kvGet(stand, 'scaleImage'), kvGet(stand, 'visible')])
      .toEqual(['ImagePanel', 'hud/hudeditor/splatteam', '1', '1']);
    expect(kvGet(stand, 'drawColor')).toBe('255 255 255 255');
    expect(kvGet(nodes[i], 'drawColor')).toBe('255 255 255 0');
  });

  it("follows the player's moves, the fit rule and the team scale, and carries the player's opacity", () => {
    const d = design({ elements: { teamColumn: { fit: true, scale: 2 } },
      children: { teamColumn: { BackgroundImage: { x: 5, y: 6, w: 100, h: 50, color: '255 255 255 120' } } },
      splatters: { splatTeam: { kind: 'fade' } } });
    const nodes = tree(buildHud(d), CARD);
    const bg = kvFind(nodes, ['BackgroundImage'])!;
    const stand = kvFind(nodes, ['HudEdSplatter'])!;
    expect(rect(stand)).toEqual(rect(bg));
    expect(kvGet(stand, 'drawColor')).toBe('255 255 255 120');
    expect(kvGet(bg, 'drawColor')).toBe('255 255 255 0');
  });

  it('ships the texture and its material, the Fade pixels exactly', () => {
    const files = buildHud(design({ splatters: { splatTeam: { kind: 'fade', color: '200 0 0 255' } } }));
    const vtf = decodeVTF(files.find((f) => f.path === 'materials/vgui/hud/hudeditor/splatteam.vtf')!.data);
    expect([vtf.w, vtf.h]).toEqual([512, 256]);
    expect(vtf.rgba).toEqual(fadeTexture(512, 256, '200 0 0 255'));
    expect(text(files, 'materials/vgui/hud/hudeditor/splatteam.vmt')).toBe(vmtFor('vgui/hud/hudeditor/splatteam'));
  });

  it('ships an uploaded picture pixel for pixel', () => {
    const files = buildHud(design({ splatters: { splatTeam: { kind: 'image' } }, images: { splatTeam: PNG } }), { images: { splatTeam: TEAM_PX } });
    expect(decodeVTF(files.find((f) => f.path === 'materials/vgui/hud/hudeditor/splatteam.vtf')!.data).rgba).toEqual(TEAM_PX);
  });

  it('writes nothing for an Image with no stored picture (a share link), or while the splatter is hidden', () => {
    const stock = buildHud(design({}));
    for (const d of [
      design({ splatters: { splatTeam: { kind: 'image' } } }),
      design({ splatters: { splatTeam: { kind: 'fade' } }, children: { teamColumn: { BackgroundImage: { visible: false } } } }),
    ]) {
      const files = buildHud(d);
      expect(kvFind(tree(files, CARD), ['HudEdSplatter'])).toBeUndefined();
      expect(files.some((f) => f.path.includes('splatteam'))).toBe(false);
    }
    expect(stock.some((f) => f.path.includes('hudeditor/splat'))).toBe(false);
  });

  it('refuses to build an active Image whose pixels the page did not hand over', () => {
    expect(() => buildHud(design({ splatters: { splatTeam: { kind: 'image' } }, images: { splatTeam: PNG } })))
      .toThrow('Teammate card splatter: the image could not be read. Pick it again, or choose Stock.');
  });

  it('gives the preview the same tree without needing the pixels', () => {
    const d = design({ splatters: { splatTeam: { kind: 'image' } }, images: { splatTeam: PNG } });
    expect(kvFind(buildTrees(d)(CARD), ['HudEdSplatter'])).toBeDefined();
  });
});

describe('splatterPass, the scratches', () => {
  it('repoints the image key and ships the texture, with $vertexcolor unless Keep my colours', () => {
    const d = design({ splatters: { splatTop: { kind: 'image' }, splatBottom: { kind: 'fade', keepColours: true } },
      images: { splatTop: { w: 256, h: 64, png: 'iVBORw0KGgo=' } } });
    const files = buildHud(d, { images: { splatTop: TOP_PX } });
    const own = tree(files, OWN);
    expect(kvGet(kvFind(own, ['HealthbarTextureTop'])!, 'image')).toBe('hud/hudeditor/splattop');
    expect(kvGet(kvFind(own, ['HealthbarTextureBottom'])!, 'image')).toBe('hud/hudeditor/splatbottom');
    expect(decodeVTF(files.find((f) => f.path === 'materials/vgui/hud/hudeditor/splattop.vtf')!.data).rgba).toEqual(TOP_PX);
    expect(text(files, 'materials/vgui/hud/hudeditor/splattop.vmt')).toContain('$vertexcolor 1');
    expect(text(files, 'materials/vgui/hud/hudeditor/splatbottom.vmt')).not.toContain('$vertexcolor');
  });

  it('hard-hides a scratch set to None', () => {
    const n = kvFind(tree(buildHud(design({ splatters: { splatTop: { kind: 'none' } } })), OWN), ['HealthbarTextureTop'])!;
    expect(['visible', 'wide', 'tall', 'drawColor'].map((k) => kvGet(n, k))).toEqual(['0', '0', '0', '255 255 255 0']);
  });
});

describe('splatterProblem', () => {
  const ID = '7'.repeat(64);
  afterEach(() => { unregisterImport(ID); });
  const imported = () => design({ preset: 'imported', imported: { id: ID, name: 'x' } });

  it('is null where the block is there and shown', () => {
    for (const id of ['splatTeam', 'splatTop', 'splatBottom'] as const) expect(splatterProblem(design({}), id)).toBeNull();
  });
  it("says so where a preset hides the scratches (Modern)", () => {
    expect(splatterProblem(design({ preset: 'modern' }), 'splatTop')).toBe('This preset hides the scratches.');
    expect(splatterProblem(design({ preset: 'modern' }), 'splatTeam')).toBeNull();
  });
  it('names the missing block on an imported HUD, and writes nothing there', () => {
    const card = new TextDecoder('latin1').decode(sampleHud().get(CARD)!);
    registerImport(ID, sampleHud({ [CARD]: latin1(dropBlock(card, 'BackgroundImage')) }));
    expect(splatterProblem(imported(), 'splatTeam')).toBe('This HUD has no BackgroundImage in teammatepanel.res, so there is nothing to restyle.');
    const files = buildHud({ ...imported(), splatters: { splatTeam: { kind: 'fade' } } });
    expect(files.some((f) => f.path.includes('splatteam'))).toBe(false);
  });
});
```

Note for the implementer: check `sampleHud` in `importFixtures.ts` really carries `teammatepanel.res`; if it does not, pass the stock card text through `sampleHud({ [CARD]: ... })` built from `baseFile('stock', CARD)` minus the block instead. The expected strings above are the contract; adjust fixtures, not strings.

- [ ] **Step 2: Run** `npx vitest run --project web web/src/hud/splatter.build.test.ts`: RED.

- [ ] **Step 3: Implement in `build.ts`.**
  - Imports: `SPLATTERS, SPLAT_STAND_IN, splatterDef, splatterActive, splatterImageKey, splatterMaterial, fadePixels, type SplatterDef, type SplatterId` from `./splatter`.
  - The stand-in and the pass, with block comments that say why (cite the spec's client.dll findings in two sentences, and the `HudEdCardBg` precedent):

```ts
/** The teammate splatter's stand-in, right after BackgroundImage, at its final rect, zpos and tint; the stock one then draws at alpha 0. */
function insertStandIn(nodes: KvNode[], stock: KvNode, def: SplatterDef) {
  const colour = kvGet(stock, 'drawColor') ?? '255 255 255 255';
  const [r, g, b] = colour.split(' ');
  const pairs: [string, string][] = [
    ['ControlName', 'ImagePanel'], ['fieldName', SPLAT_STAND_IN],
    ['xpos', pcGet(stock, 'xpos') ?? '0'], ['ypos', pcGet(stock, 'ypos') ?? '0'],
    ['wide', pcGet(stock, 'wide') ?? '0'], ['tall', pcGet(stock, 'tall') ?? '0'],
    ['zpos', pcGet(stock, 'zpos') ?? '-1'], ['visible', '1'], ['enabled', '1'], ['scaleImage', '1'],
    ['image', splatterImageKey(def.id)], ['drawColor', colour],
  ];
  nodes.splice(nodes.indexOf(stock) + 1, 0, { key: SPLAT_STAND_IN, value: pairs.map(([key, value]) => ({ key, value })) });
  kvSet(stock, 'drawColor', `${r} ${g} ${b} 0`);
}

/**
 * `out` null: the preview's trees only, no pixels needed (buildTrees).
 */
function splatterPass(work: Work, design: HudDesign, assets: BuildAssets, out: VpkFile[] | null) {
  for (const def of SPLATTERS) {
    const style = design.splatters?.[def.id];
    if (!style || style.kind === 'stock') continue;
    const block = work.optional(def.file, [def.block]);
    if (!block) continue;                                           // an imported HUD without it: the row is disabled
    if (style.kind === 'none') { hardHide(block); continue; }       // the scratches only; see validateDesign
    if (!splatterActive(design, def.id)) continue;                  // an Image with no picture stored: stock
    if (def.route === 'standIn') {
      if (design.children.teamColumn?.[def.block]?.visible === false) continue;
      insertStandIn(work.tree(def.file), block, def);
    } else pcSet(block, 'image', splatterImageKey(def.id));
    if (!out) continue;
    const px = style.kind === 'fade' ? fadePixels(def, style) : assets.images?.[def.id];
    if (!px || px.length !== def.size.w * def.size.h * 4) {
      throw new Error(`${def.label}: the image could not be read. Pick it again, or choose Stock.`);
    }
    const name = splatterMaterial(def.id);
    out.push({ path: `materials/${name}.vtf`, data: encodeVTF(def.size.w, def.size.h, px) },
      { path: `materials/${name}.vmt`, data: enc(vmtFor(name, { vertexColor: !(def.healthTint && style.keepColours) })) });
  }
}
```

  Check that `work.tree(def.file)` is the same array `work.optional` searched (it is: `optional` calls `kvFind(this.tree(path), keys)`), so `indexOf` finds the block. `work.tree(...)` must also mark the file as edited, as fitPass's `nodes.unshift` relies on; confirm by reading `Work` before relying on it.
  - Call it in `buildHud` right after `hidePass(work, design);` as `splatterPass(work, design, assets, extra);`, and in `buildTrees` after `hidePass` as `splatterPass(work, design, {}, null);`.
  - Update the pass-order comment above `buildHud`: splatterPass runs after hidePass (it must see a hidden splatter and the fitted rect) and before teamPass and scalePass (the stand-in is a card child they scale like the rest); it writes only the splatter blocks it names and its own textures.
  - `splatterProblem`:

```ts
export function splatterProblem(design: HudDesign, id: SplatterId): string | null {
  const def = splatterDef(id)!;
  const block = kvFind(baseTree(baseOf(design), def.file), [def.block]);
  if (!block) return `This HUD has no ${def.block} in ${def.file.split('/').pop()}, so there is nothing to restyle.`;
  if (def.route === 'repoint' && ((pcGet(block, 'visible') ?? '1') === '0' || !(parseFloat(pcGet(block, 'wide') ?? '0') > 0))) {
    return 'This preset hides the scratches.';
  }
  return null;
}
```

- [ ] **Step 4: GREEN** for the new file, then `npx vitest run --project web web/src/hud/download.golden.test.ts web/src/hud/build.test.ts` (unchanged), the full suite, typecheck. Commit `web/src/hud/build.ts web/src/hud/splatter.build.test.ts`: "Write a custom damage splatter into the download: a stand-in on teammate cards, repointed scratches".

---

### Task 4: The preview draws it

**Files:**
- Modify: `web/src/hud/render.ts`, `web/src/hud/render.test.ts`

**Interfaces produced:**
- `splatterSource(design: HudDesign, id: SplatterId, onAsset?: () => void): { src: CanvasImageSource; key: string } | undefined` exported from `render.ts`: the canvas or image a splatter draws from (Task 6's tint strip uses it).
- `drawTexture` gains a last parameter `vertexColour = true`.

- [ ] **Step 1: Write the failing tests.** Append a `describe('custom splatter', ...)` to `web/src/hud/render.test.ts`, reusing `recCtx`, `instantImage`, `design` and `fakeCanvas` already in that file:

```ts
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
      expect(fade.pixels).toEqual(fadeTexture(512, 256, '200 0 0 255'));
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
      expect(green).toBeGreaterThan(0);
      scratch.calls.length = 0;
      _resetAssetCache(); _setImageFactory(instantImage);
      drawPanel(recCtx().ctx, design({ splatters: { splatTop: { kind: 'image', keepColours: true } }, images: img }), 'ownHealth', TEAM, 1);
      // Only HealthbarTextureBottom (stock, tinted) makes a multiply now; the kept-colour top makes none.
      expect(scratch.calls.filter((c) => c.m === 'fillRect' && c.op === 'multiply')).toHaveLength(1);
    } finally { _setCanvasFactory(null); }
  });
});
```

Add `fadeTexture` from `./textures` to the imports.

- [ ] **Step 2: Run** `npx vitest run --project web web/src/hud/render.test.ts`: RED.

- [ ] **Step 3: Implement in `render.ts`.**
  - Import `splatterForMaterial, fadePixels, type SplatterDef, type SplatterId` from `./splatter`.
  - `splatterSource`: Fade builds a scratch canvas once per `(id, colour)` (`canvasFactory(w, h)`, `createImageData`, `data.set(fadePixels(...))`, `putImageData`), cached in a module Map cleared by `_resetAssetCache`; Image returns `urlImage('data:image/png;base64,' + png, onAsset)`; anything else, or no canvas (happy-dom without a factory), `undefined`. The key is `splat|<id>|fade|<colour>` or `splat|<id>|<the data URL>`, unique per picture so `tinted`'s cache never mixes two uploads.
  - In `drawImageChild`, the `vgui/hud/hudeditor/` branch first asks `splatterForMaterial(material)`; for a splatter it calls `drawSplatter` and returns, else falls through to `drawSlotStyle` as now.

```ts
function drawSplatter(ctx: CanvasRenderingContext2D, design: HudDesign, n: KvNode, r: ChildRect, k: number, opts: DrawOpts, def: SplatterDef) {
  const style = design.splatters?.[def.id];
  const got = splatterSource(design, def.id, opts.onAsset);
  if (!style || !got) return;
  drawTexture(ctx, n, r, k, opts, got.src, def.size.w, def.size.h, got.key, false, !(def.healthTint && style.keepColours));
}
```

  - `drawTexture(..., additive: boolean, vertexColour = true)`: when `vertexColour` is false, `tr = tg = tb = 255` after the health-tint line (the material has no `$vertexcolor`, so the engine uses no RGB from the draw colour at all, file or code). Also return early when `ta === 0`: the engine draws nothing at alpha 0 and the stock splatter under a stand-in is exactly that.
  - Per-slot stock splatter: where `drawImageChild` resolves `material` for a generic image, if `n.key` is `BackgroundImage`, `material` matches `/^vgui\/hud\/healthbar_bg_\d+$/` and `opts.card !== undefined`, use `vgui/hud/healthbar_bg_${(opts.card % 4) + 1}`. Comment: client.dll sets card N's splatter to `hud/healthbar_bg_N` whatever the file says (spec, "What the game does").
  - Fix the stale comment above `SPLATTER_ALPHA` ("one file per team colour" becomes "one texture per card slot, set by client.dll") and say the factor applies only to the code-managed stock splatter, never the stand-in.
- [ ] **Step 4: GREEN**, full suite (the existing splatter and tint tests must pass untouched; if `made` counts in "tints an image by its drawColor" change, find out why before touching the test), typecheck. Commit: "Draw a custom damage splatter in the preview from the pixels the download ships".

---

### Task 5: Edit helpers and the page's assets

**Files:**
- Modify: `web/src/hud/edit.ts`, `web/src/hud/edit.test.ts`, `web/src/routes/Hud.tsx` (only `assetSize` and `assetsFor`), `web/src/routes/Hud.assets.test.tsx`

**Interfaces produced (edit.ts):**

```ts
export function splatterKind(d: HudDesign, id: SplatterId): SplatterKind;   // splatTeam: 'none' while the child is hidden
export function patchSplatter(d: HudDesign, id: SplatterId, p: Partial<SplatterStyle>): HudDesign;
export function withSplatterImage(d: HudDesign, id: SplatterId, png: string): HudDesign;
export function resetSplatter(d: HudDesign, id: SplatterId): HudDesign;
```

**Interfaces produced (Hud.tsx):** `export function assetSize(id: string): { w: number; h: number } | null`: a style slot's size, else a splatter's, else null.

- [ ] **Step 1: Write the failing tests.** Append to `web/src/hud/edit.test.ts`:

```ts
describe('splatter edits', () => {
  const base = () => structuredClone(DEFAULT_DESIGN);
  const hiddenBg = (d: HudDesign) => d.children.teamColumn?.BackgroundImage?.visible === false;

  it("makes the teammate splatter's None the child's hide, and any other kind shows it again", () => {
    const none = patchSplatter(base(), 'splatTeam', { kind: 'none' });
    expect(hiddenBg(none)).toBe(true);
    expect(none.splatters?.splatTeam).toBeUndefined();
    expect(splatterKind(none, 'splatTeam')).toBe('none');
    const fade = patchSplatter(none, 'splatTeam', { kind: 'fade' });
    expect(hiddenBg(fade)).toBe(false);
    expect(fade.children.teamColumn?.BackgroundImage).toBeUndefined();   // no empty override left behind
    expect(splatterKind(fade, 'splatTeam')).toBe('fade');
  });

  it('keeps a Fade colour when the kind changes, and stores None for a scratch', () => {
    const d = patchSplatter(patchSplatter(base(), 'splatTop', { kind: 'fade', color: '1 2 3 4' }), 'splatTop', { kind: 'none' });
    expect(d.splatters?.splatTop).toEqual({ kind: 'none', color: '1 2 3 4' });
  });

  it('stores an upload at the texture size and switches the splatter to Image', () => {
    const d = withSplatterImage(base(), 'splatTop', 'AAAA');
    expect(d.images.splatTop).toEqual({ w: 256, h: 64, png: 'AAAA' });
    expect(d.splatters?.splatTop?.kind).toBe('image');
  });

  it('resets to stock: no style, no stored image, and the teammate splatter shown', () => {
    let d = withSplatterImage(base(), 'splatTeam', 'AAAA');
    d = patchChild(d, 'BackgroundImage', { visible: false, color: '255 255 255 100' });
    d = resetSplatter(d, 'splatTeam');
    expect(d.splatters).toBeUndefined();
    expect(d.images.splatTeam).toBeUndefined();
    expect(d.children.teamColumn?.BackgroundImage).toEqual({ color: '255 255 255 100' });   // only the hide goes
  });
});
```

Append to `web/src/routes/Hud.assets.test.tsx`:

```ts
describe('assetSize', () => {
  it("redraws a splatter upload at its texture's size, and a style slot at its own", () => {
    expect(assetSize('splatTeam')).toEqual({ w: 512, h: 256 });
    expect(assetSize('splatBottom')).toEqual({ w: 256, h: 64 });
    expect(assetSize('panelBg')).toEqual({ w: 32, h: 32 });
    expect(assetSize('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run** both files: RED.

- [ ] **Step 3: Implement.**
  - `edit.ts`: a private `showChild(d, name)` that deletes `visible` from the child override and drops the override (and `teamColumn`) when empty. `patchSplatter` for splatTeam with `p.kind === 'none'` returns `patchChild(d, 'BackgroundImage', { visible: false })`; any other patch on splatTeam also calls `showChild`. The style merges as `{ ...(d.splatters?.[id] ?? { kind: 'stock' }), ...p }` with `kind: 'none'` never written for splatTeam. `withSplatterImage` uses `splatterDef(id)!.size`. `resetSplatter` deletes the style (dropping `splatters` when empty) and the image, and for splatTeam calls `showChild`. `splatterKind` returns `'none'` for splatTeam while `children.teamColumn.BackgroundImage.visible === false`, else the stored kind or `'stock'`.
  - `Hud.tsx`: `assetSize(id)` returns `SLOTS.find(...)?.size ?? splatterDef(id)?.size ?? null`; `assetsFor`'s image loop uses it (`const size = assetSize(id); if (!size) continue;`) and the error message uses the slot's or splatter's label. Keep the comment about untrusted `w/h`, extended to splatters.
- [ ] **Step 4: GREEN**, full suite, typecheck. Commit: "Add splatter edits (None is the teammate splatter's hide) and hand splatter uploads to the build".

---

### Task 6: The Splatter panel

**Files:**
- Create: `web/src/routes/hud/SplatterControls.tsx`
- Modify: `web/src/routes/Hud.tsx`, `web/src/routes/Hud.test.tsx`, `web/src/hud/children.ts`, `web/src/styles/app.css`

**What the UI does:** a Panel titled "Splatter" right after the Styles panel, inside a `fieldset` disabled while `locked`, one `SplatterRow` per `SPLATTERS` entry. A row:
- label; a select `aria-label="<label> style"` with options `stock` ("As imported" when `design.preset === 'imported'`, else "Stock"), `none` ("None"), `fade` ("Fade"), `image` ("Image"), value `splatterKind(design, id)`, change calls `patchSplatter`;
- for Fade: colour and opacity inputs exactly as `StyleRow` does them (`hexOf`, `withHex`, `alphaPct`, `withAlphaPct` from `routes/hud/controls.tsx`, `'gesture'` mode plus `onEnd`), on `style.color ?? def.defaultColor`;
- for Image: a "Choose image" file input `aria-label="<label> image"`, `accept="image/*"`, and a hint `Stretched to ${def.aspect}, ${w} x ${h} is ideal.`;
- for a `healthTint` splatter with Fade or Image: a checkbox "Colour by health" (`checked = !style.keepColours`) and, under it, the `TintStrip`: three small canvases labelled Healthy, Hurt and Critical (`aria-label`), each drawing `splatterSource(...)` through `tinted` with `healthRgb(100,100,false)`, `healthRgb(40,100,false)`, `healthRgb(10,100,false)` (untinted when Keep my colours is on). Where there is no 2D context (happy-dom) the canvases stay blank;
- a "Reset to stock" button, disabled when the row has no style and the splatter is not hidden;
- the row's upload error, and when `splatterProblem(design, id)` is not null, that sentence, with every control in the row disabled.
- The note under the heading: "Splatter art is flat in the game's files: pick None, a Fade, or your own picture. Your own picture shows on all four teammate cards, and also while a teammate is down or dead."

Upload: `onSplatterUpload(def, file)` in `Hud.tsx` mirrors `onSlotUpload`: `decodeUpload(file, def.size.w, def.size.h)` then `edit((d) => withSplatterImage(d, def.id, png))`, errors into `uploadErrors[def.id]`.

Save warning: where the page calls `saveDesign(design)` (the 300 ms timeout), when it returns false set the status to "This design is too big for this browser to keep. Remove an uploaded image, or use Export to save it as a file."

`children.ts`: BackgroundImage's note becomes "Opacity fades whatever art the splatter shows. Change the art itself under Splatter, below the canvas: stock, none, a fade or your own picture."

- [ ] **Step 1: Write the failing tests** in `web/src/routes/Hud.test.tsx`, in a new `describe('Splatter', ...)`, following the file's existing render and localStorage helpers (look at how the Styles tests near "Survivor panel background" render the page and read the saved design, and reuse those helpers rather than new ones):
  1. The panel shows three rows by label, and each select offers Stock, None, Fade, Image.
  2. Choosing Fade on "Teammate card splatter style" saves `splatters.splatTeam.kind === 'fade'`; choosing None saves `children.teamColumn.BackgroundImage.visible === false` and no `splatTeam` style; the select then shows None.
  3. "Reset to stock" after Fade removes `splatters`.
  4. On the Modern preset the two scratch rows are disabled and show "This preset hides the scratches."; the teammate row is enabled.
  5. "Colour by health" appears for "Your health: top scratches" with Fade and not for the teammate row; unticking saves `keepColours: true`.
  6. The tint strip renders three canvases labelled Healthy, Hurt and Critical for a scratch row on Fade.
  7. When `saveDesign` fails (spy on `Storage.prototype.setItem` to throw after the page mounts, then make an edit and advance timers by 300 ms), the status line shows the too-big sentence.
  8. The Undo button after choosing Fade brings the row back to Stock.
- [ ] **Step 2: Run** `npx vitest run --project web web/src/routes/Hud.test.tsx`: RED.
- [ ] **Step 3: Implement** `SplatterControls.tsx` (`SplatterRow`, `TintStrip`, props typed; no state of its own besides nothing), wire it in `Hud.tsx`, add `.hud__tintstrip` (a row of three 64 x 16 canvases with a small label under each, wrapping on phone widths) to `app.css`, update the note in `children.ts`.
- [ ] **Step 4: GREEN**, full suite, typecheck, `npm run build`. Then a headless look (see the memory note: vite on `:5199` from this worktree; if it is not running start it with `setsid nohup npx vite --port 5199 --strictPort --host 127.0.0.1 >/dev/null 2>&1 &` from the worktree; drive Chrome over CDP as `scripts/shoot-pages.mjs` does; read the canvas with `canvas.toDataURL()`, never a CDP screenshot, which shifts the page 7 px). Set a Fade teammate splatter in red and check the preview shows a red bar behind every card at full strength. Commit: "Add the Splatter panel: stock, none, fade or your own image for teammate cards and your health scratches".

---

### Task 7: A sample VPK with splatters for the independent reader

**Files:**
- Modify: `web/src/hud/sample.vpkcheck.test.ts`, `scripts/check-hud-vpk.sh`

- [ ] **Step 1:** Add sample `s` to `sample.vpkcheck.test.ts` (document it in the header list): a stock design with `splatters: { splatTeam: { kind: 'image' }, splatTop: { kind: 'image' }, splatBottom: { kind: 'fade', color: '255 0 255 200', keepColours: true } }`, `images` holding placeholder PNG entries at the right sizes (only their presence matters to the build), and `packHud(d, { images: { splatTeam: quadrants, splatTop: stripes } })` where `quadrants` is 512 x 256 RGBA with the four quadrants red, green, blue and yellow at alpha 200 and `stripes` is 256 x 64 white with alpha stepping 255/160/80/0 every 64 columns.
- [ ] **Step 2:** In `scripts/check-hud-vpk.sh`, pass `HUD_SAMPLE` through as now, and add to the Python block, only when `os.environ.get('HUD_SAMPLE') == 's'`: the four `materials/vgui/hud/hudeditor/splat*.vtf|vmt` files exist; `srctools.vtf.VTF.read` on `splatteam.vtf` gives 512 x 256 and format BGRA8888, and its pixel at (10, 10) is red with alpha 200; `splatbottom.vmt` has no `$vertexcolor`; `resource/ui/hud/teammatepanel.res` contains `HudEdSplatter` and `hud/hudeditor/splatteam`. (`srctools` is in `/home/volence/l4d/hud/.venv`; the script already uses that interpreter.) Read how srctools exposes format and pixels before writing the assertion; if its API differs from the names here, use its real names.
- [ ] **Step 3:** Run `HUD_SAMPLE=s bash scripts/check-hud-vpk.sh` and the three existing variants (`bash scripts/check-hud-vpk.sh`, `HUD_SAMPLE=b ...`, `HUD_SAMPLE=w ...`); all print "files ok". Full suite. Commit both files: "Check a splatter download with the independent VPK and VTF readers".

---

### Task 8: Final review and the in-game check

**Files:**
- Modify: `docs/superpowers/specs/2026-09-24-hud-editor-custom-splatter-design.md` (a new "In-game result" section only)
- Test art (not committed): `/home/volence/l4d/hud/test-splatter-2026-09-24/` (never under `/tmp/claude-1000`: headless Chrome cannot read files there)

- [ ] **Step 1: The whole chain**, with real output in the report:

```
npm test && npm run typecheck && npm run build && bash scripts/check-hud-vpk.sh && HUD_SAMPLE=b bash scripts/check-hud-vpk.sh && HUD_SAMPLE=w bash scripts/check-hud-vpk.sh && HUD_SAMPLE=s bash scripts/check-hud-vpk.sh
```

  The test count must be the baseline 4179 plus this plan's new tests, all passing.

- [ ] **Step 2: Make the test art** with `/home/volence/l4d/hud/.venv/bin/python` and PIL into `/home/volence/l4d/hud/test-splatter-2026-09-24/`: `team.png` 512 x 256, four quadrants red, green, blue, yellow at alpha 200 with a 6 px opaque white border; `top.png` 256 x 64, white, alpha stepping 255/160/80/0 every 64 columns.

- [ ] **Step 3: Build the download through the page**, headless, exactly as a player would: load `http://127.0.0.1:5199/hud` with a fresh stock design; upload `team.png` on "Teammate card splatter" (Image) and `top.png` on "Your health: top scratches" (Image, Colour by health on); set "Your health: bottom scratches" to Fade `255 0 255 200` with Colour by health off; Download (CDP `Browser.setDownloadBehavior` into the test folder). Save the preview as `preview.png` from `canvas.toDataURL()` at 16:9, Healthy state. Check with the Python `vpk` module that the downloaded `my_hud.vpk` holds the three `splat*` textures.

- [ ] **Step 4: Run the harness.** Read `/home/volence/l4d/hud/ingame-harness/README.md`. If the harness or that scenario does not exist yet, stop here: write "In-game check pending: harness not ready" plus the VPK path into the spec's "In-game result" section, commit, and report. Otherwise, follow its README to install `my_hud.vpk` and run scenario `survivor-hurt`, which produces a screenshot; the harness restores the owner's own HUD afterwards (confirm that it did). Never edit the owner's `gameinfo.txt` or `addonlist.txt` by hand, and never kill a game or srcds process the harness did not start.

- [ ] **Step 5: Compare the screenshot to the preview.** Scale both to the same 853 x 480 unit frame. Check and record, with crops saved beside the screenshots:
  1. Each teammate card shows the four quadrant colours at full strength (mean colour of each quadrant within about 10 percent of the preview's), with no black stock splatter and no faint factor. If the game draws it faint, measure the factor and record it; do not change code in this task.
  2. The top scratch is `top.png` multiplied by the health colour for the scenario's health (read the health from the harness output; expected RGB from `healthRgb` in `render.ts`: green above 50, orange above 15, red below).
  3. The bottom scratch is magenta, not multiplied by the health colour: Keep my colours works. If it is tinted, record that; the follow-up is to remove `keepColours` (validateDesign, the checkbox, the build's option) and keep `vmtFor`'s option unused.
  4. No magenta and black missing-texture checker anywhere.

- [ ] **Step 6:** Write the results (pass or fail per check, the measured numbers, the screenshot and crop paths) into the spec's new "## In-game result" section, commit only that file: "Record the in-game check of custom damage splatter". Report the four results and anything that needs a follow-up task.
