// @vitest-environment node
//
// Node, not happy-dom: this reads the Roboto files off disk with node:fs, and
// happy-dom's synthetic import.meta.url is not a file: URL.
import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packHud } from './build';
import { DEFAULT_DESIGN, validateDesign, type HudDesign } from './design';
import { registerImport, unregisterImport } from './base';
import { sampleHud } from './importFixtures';
import { ammoOnly } from './edit';

/**
 * The download, pinned. The preview's drawing may change (which face a label
 * is drawn in, how tall its text is), but the file a player downloads must
 * not move with it: the preview follows the file, never the other way round.
 * These hashes are the packed downloads as they were before the preview drew
 * the game's own fonts (4886f6b). A change that means to alter the download
 * updates them on purpose, and says why in its commit.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const fonts = {
  regular: new Uint8Array(readFileSync(`${here}base/fonts/RobotoCondensed-Regular.ttf`)),
  bold: new Uint8Array(readFileSync(`${here}base/fonts/RobotoCondensed-Bold.ttf`)),
};
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const download = (d: HudDesign) => sha(packHud(d, { fonts }).bytes);

describe('the download is unchanged by the preview', () => {
  const cases: [string, HudDesign, string][] = [
    ['an untouched design', structuredClone(DEFAULT_DESIGN), '6d8ec815dd449012fcb2fc549e4392d5d43285751cce51cd5b101ea56cab9e04'],
    ['Ammo only', ammoOnly(structuredClone(DEFAULT_DESIGN)), 'c4376fdc9664eea94ea324011cc9c86744c221db9ecc98663ab76d4630673d18'],
    ['an untouched Modern design', { ...structuredClone(DEFAULT_DESIGN), preset: 'modern' }, 'eb9efa8889f984af2e62f17368d9568647e96aa5c4c1bed78bb3a947301c1d1a'],
    ['an untouched design in Roboto', { ...structuredClone(DEFAULT_DESIGN), font: 'roboto' }, '53437d599a759fc5b4a3c20609d28ce928332146b9598bf90e7a2095a661f180'],
    // A design as a saved one loads, which must give the same bytes as a new one.
    ['a saved design', validateDesign({ v: 1, crosshair: 'none', elements: { teamColumn: { fit: true } } }), '6d8ec815dd449012fcb2fc549e4392d5d43285751cce51cd5b101ea56cab9e04'],
    ['a saved Modern design', validateDesign({ v: 1, preset: 'modern', crosshair: 'none', elements: { teamColumn: { fit: true } } }), 'eb9efa8889f984af2e62f17368d9568647e96aa5c4c1bed78bb3a947301c1d1a'],
    ['a saved Roboto design', validateDesign({ v: 1, font: 'roboto', crosshair: 'none', elements: { teamColumn: { fit: true } } }), '53437d599a759fc5b4a3c20609d28ce928332146b9598bf90e7a2095a661f180'],
  ];
  for (const [name, d, hash] of cases) {
    it(`${name} packs to the same bytes`, () => {
      expect(download(d)).toBe(hash);
    });
  }
});

/**
 * Saved designs as validateDesign returns them (the load path players really
 * take), so a regression in child edits, Free, Modern children, weapons,
 * splatters or an import shows here and not only in an untouched design.
 * Pinned at 71c86fb (after the splatter plan, before Phase 2).
 */
describe('saved Phase 1 designs download the same bytes', () => {
  const ID = '9'.repeat(64);
  afterAll(() => { unregisterImport(ID); });
  const cases: [string, () => HudDesign, string][] = [
    ['fitted teammates with inside edits, a card background, a scaled column and a moved own panel', () => validateDesign({
      v: 1,
      elements: { teamColumn: { fit: true, dir: 'column', gap: 4, scale: 1.25 }, ownHealth: { x: 20, y: 380, scale: 1.5 }, chat: { x: 500, y: 20, w: 300, h: 150 } },
      styles: { panelBg: { kind: 'rounded', color: '10 20 30 200' } },
      children: { teamColumn: {
        Head: { x: 20, y: 40, w: 30, h: 30 }, HealthNumber: { on: true, fontSize: 14 }, Name: { color: '255 200 0 255' },
        BackgroundImage: { color: '255 255 255 90' }, Items: { visible: false },
      } },
    }), 'a5c4d983db210c5efb0f9ca1943791058869b4fff65cecccebf47b7ea499686d'],
    ['a Free team', () => validateDesign({ v: 1, elements: { teamColumn: { fit: true, dir: 'free',
      slots: [{ x: 10, y: 300 }, { x: 200, y: 300 }, { x: 400, y: 300 }, { x: 600, y: 300 }] } } }), 'adeb39a45a4d96e6fb735176b7ed6ae0df6b29eb9e5f491c5af0dab8d6c1b523'],
    ['Modern with inside edits and scaled infected panels', () => validateDesign({
      v: 1, preset: 'modern',
      elements: { teamColumn: { fit: true }, siHealth: { scale: 1.5 }, infectedRow: { scale: 2 } },
      children: { teamColumn: { Status: { visible: false }, Head: { w: 20, h: 20 } } },
    }), 'a4a58415428f8df5ddb5185fdb0bc786b7aebb1a2dfc616987633aa79d4463ed'],
    ['hidden chat and notices, the game crosshair hidden, weapons edited', () => validateDesign({
      v: 1, crosshair: 'none', hideGameCrosshair: true,
      elements: { chat: { visible: false }, killNotices: { visible: false } },
      weapons: { indent: 10, boxActive: { kind: 'flat', color: '255 0 0 128' } },
    }), '82c38aa4101fe354d21b71030d50f8f04854ea14c0fa7b25f0d9ebbe88983fbd'],
    ['damage splatters', () => validateDesign({ v: 1, splatters: {
      splatTeam: { kind: 'fade', color: '200 0 0 255' }, splatTop: { kind: 'fade' }, splatBottom: { kind: 'none' },
    } }), '7160dc9059ec11b974fdc19ec29e5cac1a346ec622eb1c5d53cb88bef5a26cff'],
    ['an imported HUD with edits', () => {
      registerImport(ID, sampleHud());
      return validateDesign({ v: 1, preset: 'imported', imported: { id: ID, name: 'x' },
        elements: { ownHealth: { x: 30, y: 400 } }, children: { teamColumn: { Head: { x: 30 } } } });
    }, 'e50181ce8a80b8757da74d0088775769adb97351b79b1cb37c65d74404f3b2c6'],
  ];
  for (const [name, make, hash] of cases) {
    it(`${name} packs to the same bytes`, () => {
      expect(download(make())).toBe(hash);
    });
  }
});
