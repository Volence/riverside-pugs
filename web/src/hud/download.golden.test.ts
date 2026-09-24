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
 * updates them on purpose, and says why in its commit. The four untouched
 * designs moved on purpose when a new design started fitting your own
 * health (slice 2.F X14, after the incap fix); the designs saved before that
 * keep their old bytes (the three "saved before" cases).
 *
 * Every fitted stock card moved on purpose with the card bar fit (probe X15,
 * /home/volence/l4d/hud/probe-2f/x15/RESULTS.md): the game draws a card's
 * bar at its item row's x, 39, not its own 37, so the bar ends at 135 and
 * the fitted card is 122 wide, not 121 (a 121 card clipped the bar's right
 * outline in game, b13-stock full-1.png). The untouched stock download
 * differs only in that: TeamPlayer1..4 and the card's squared Incapacitated
 * and Dead 122, Voice at 106, the container 555. Modern's card has bar and
 * row both at 32 and keeps its bytes.
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
    ['an untouched design', structuredClone(DEFAULT_DESIGN), '0ff735b5c626c374c4ee64d8b35591b3efc1bb4d150468c4c7060667e8c87756'],
    ['Ammo only', ammoOnly(structuredClone(DEFAULT_DESIGN)), '64bf9c263167e79439f125f32fe872a91f9bbddd5482cd6ec71f5b3d030e242c'],
    // Modern moved on purpose with the revive anchor (build.ts reviveAnchorPass): its own panel has the
    // bar at 34 and the down picture at 0, so it gains a hidden Items label at 34.
    ['an untouched Modern design', { ...structuredClone(DEFAULT_DESIGN), preset: 'modern' }, '1b285e76db27d4b2dfbb0e7b39c19077d1f3d6e7825a5e3f0e4210bfd25b2264'],
    ['an untouched design in Roboto', { ...structuredClone(DEFAULT_DESIGN), font: 'roboto' }, '5deb06123b98d7017cc7454d3e9d5d4c0e2e5352b3deff94e0b96181293bbb88'],
    // A design saved before your own health fitted by default (slice 2.F X14) keeps the bytes it had:
    // these are the old untouched hashes, built as such a saved design loads.
    ['a design saved before the own panel fitted by default', validateDesign({ v: 1, crosshair: 'none', elements: { teamColumn: { fit: true } } }), 'c400e2a6ff36772b3d3c09151b2859a99bb1c8538ca11bd01ec3826ce23da4db'],
    ['a Modern design saved before the own panel fitted by default', validateDesign({ v: 1, preset: 'modern', crosshair: 'none', elements: { teamColumn: { fit: true } } }), '4c67fb0c1bba67763efe27a75b74c4c383ac02dcfbcf47e95349ff276d4d3a54'],
    ['a Roboto design saved before the own panel fitted by default', validateDesign({ v: 1, font: 'roboto', crosshair: 'none', elements: { teamColumn: { fit: true } } }), '9a193ebada1b8afb78094d9a737dd1000fe7e8df2fa367636c469b9752ed5b58'],
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
    }), 'f86d06e0e1a42e4db014ceb92ac059e65fc47c330501c0a5c2d4ca947a4c024f'],
    ['a Free team', () => validateDesign({ v: 1, elements: { teamColumn: { fit: true, dir: 'free',
      slots: [{ x: 10, y: 300 }, { x: 200, y: 300 }, { x: 400, y: 300 }, { x: 600, y: 300 }] } } }), '21e18600df553220d162da4e3661d6c2e2d948e80e7cf0ba3df53ccddd6ee13e'],
    ['Modern with inside edits and scaled infected panels', () => validateDesign({
      v: 1, preset: 'modern',
      elements: { teamColumn: { fit: true }, siHealth: { scale: 1.5 }, infectedRow: { scale: 2 } },
      children: { teamColumn: { Status: { visible: false }, Head: { w: 20, h: 20 } } },
    }), '9c61b7503e2c1aa2076e17a71d5620c1c0eacafde4d43a3b6940c35e52a51843'],
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
