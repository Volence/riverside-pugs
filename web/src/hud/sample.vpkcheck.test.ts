// @vitest-environment node
//
// Not a real test: a hook scripts/check-hud-vpk.sh uses to get a real VPK out
// of the real generator, for the Python vpk reader to check independently of
// vitest. It matches web/**/*.test.ts, so plain `npm test` runs it too; the
// guard below makes that a no-op rather than a stray file write.
//
// HUD_SAMPLE picks which design gets built, so the same mechanism also
// produces the owner's three hand-off samples (Task 13, step 4):
//   a: stock preset, health panel bottom-left, team as a fitted column at
//      scale 1.25 with a 4-unit gap, the health number on, the item icons
//      above a half-width bar, chat moved, rounded card backgrounds, normal VPK.
//   b: modern preset, otherwise untouched, normal VPK. The modern preset
//      always needs a Roboto Condensed pass, so this reads the two real ttf
//      files off disk and hands them to packHud as assets.fonts.
//   c: sample (a) again, but in advanced mode with a recoloured incapacitated panel,
//      which comes out as a zip instead of a VPK.
//   w: a stock design with the weapons' Ammo only preset (edit.ts's ammoOnly),
//      so the reader also sees mod_textures.txt and the clear texture.
//   i: an imported HUD (importFixtures.ts's sampleHud) with the health panel
//      moved, so the reader also sees pass-through files and the upload's
//      own hudlayout.res with an edit in it.
// Unset (or any other value) keeps the original default: sample (a).
import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packHud } from './build';
import { validateDesign, DEFAULT_DESIGN } from './design';
import { ammoOnly } from './edit';
import type { BuildAssets } from './build';
import { registerImport } from './base';
import { sampleHud } from './importFixtures';

const FONT_DIR = fileURLToPath(new URL('./base/fonts/', import.meta.url));
const fonts = (): BuildAssets['fonts'] => ({
  regular: new Uint8Array(readFileSync(`${FONT_DIR}RobotoCondensed-Regular.ttf`)),
  bold: new Uint8Array(readFileSync(`${FONT_DIR}RobotoCondensed-Bold.ttf`)),
});

const SAMPLE_A = { v: 1, preset: 'stock', elements: {
  ownHealth: { x: 8, y: 400 },
  teamColumn: { scale: 1.25, dir: 'column', gap: 4, fit: true },
  chat: { x: 8, y: 8 },
}, children: { teamColumn: { HealthNumber: { on: true }, Items: { x: 37, y: 40 }, Health: { w: 48 } } },
  styles: { panelBg: { kind: 'rounded', color: '0 0 0 150' } } };

it('writes a sample VPK or zip for the Python/unzip readers', () => {
  if (!process.env.HUD_VPK_OUT) return;
  const sample = process.env.HUD_SAMPLE ?? 'a';
  if (sample === 'b') {
    const d = validateDesign({ v: 1, preset: 'modern' });
    writeFileSync(process.env.HUD_VPK_OUT, packHud(d, { fonts: fonts() }).bytes);
    return;
  }
  if (sample === 'w') {
    writeFileSync(process.env.HUD_VPK_OUT, packHud(ammoOnly(structuredClone(DEFAULT_DESIGN))).bytes);
    return;
  }
  if (sample === 'c') {
    const d = validateDesign({ ...SAMPLE_A, advanced: true,
      styles: { ...SAMPLE_A.styles, incapPanel: { kind: 'flat', color: '120 60 200 255' } } });
    writeFileSync(process.env.HUD_VPK_OUT, packHud(d).bytes);
    return;
  }
  if (sample === 'i') {
    const id = 'f'.repeat(64);
    registerImport(id, sampleHud());
    const d = validateDesign({ v: 1, preset: 'imported', imported: { id, name: 'edgehud' }, crosshair: 'none', elements: { ownHealth: { x: 8, y: 400 } } });
    writeFileSync(process.env.HUD_VPK_OUT, packHud(d).bytes);
    return;
  }
  const d = validateDesign(SAMPLE_A);
  writeFileSync(process.env.HUD_VPK_OUT, packHud(d).bytes);
});
