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

/**
 * Saved designs that touch the three infected panels, pinned before slices
 * 2.2 to 2.4 (the infected panels plan, Task 0) change how those panels are
 * written: a design saved with none of the new edits must keep its bytes.
 * infectedRow still carries the pre-gap `spacing` here, as saved designs do.
 */
describe('saved infected designs download the same bytes', () => {
  const infected = (preset: 'stock' | 'modern'): [string, () => HudDesign][] => [
    [`${preset}: your infected health scaled 1.5 and moved`, () => validateDesign({ v: 1, preset, elements: { siHealth: { scale: 1.5, x: 400, y: 380 } } })],
    [`${preset}: infected teammates scaled 2 with a stored spacing 200`, () => validateDesign({ v: 1, preset, elements: { infectedRow: { scale: 2, spacing: 200 } } })],
    [`${preset}: the ability timer moved`, () => validateDesign({ v: 1, preset, elements: { abilityRing: { x: 300, y: 300 } } })],
    [`${preset}: the game crosshair hidden`, () => validateDesign({ v: 1, preset, hideGameCrosshair: true })],
  ];
  const hashes: Record<string, string> = {
    'stock: your infected health scaled 1.5 and moved': '840539fa287b8094c1e6535a8436299137d27c792fc35f1fa0f3c6e176ad4216',
    'stock: infected teammates scaled 2 with a stored spacing 200': '93ed646c11be551258e91c3ede3efcc3f8833f79b765b81dcd3aa3d627918334',
    'stock: the ability timer moved': 'e3c0ddd98ad677d3d77d0e324fe4da9c45bf86c55cf990dd9afc9a5914faf29a',
    'stock: the game crosshair hidden': '93f6382e8f97c317c910a3f73265973e430530b954c65b23c00ce462fb9b79a5',
    'modern: your infected health scaled 1.5 and moved': 'dfdaca22c54f5079208a647c7a88614eb292642cd004fa3f0fd9a4ca792e564c',
    'modern: infected teammates scaled 2 with a stored spacing 200': '35fd853d2f0d9b3b12285a28c1114b013a5b9cdc55e859f3076def9a3b43fac8',
    'modern: the ability timer moved': 'a9f4601215c651d2ef5a0a6fd0b283bb04d99775bac5ce3df33f9428acf3460a',
    'modern: the game crosshair hidden': '0c95532a480d1c13cde0afff8e75c593f399e85b08c7fd931b5dd13c5c5cd734',
  };
  for (const [name, make] of [...infected('stock'), ...infected('modern')]) {
    it(`${name} packs to the same bytes`, () => {
      expect(download(make())).toBe(hashes[name]);
    });
  }
});

/**
 * Saved designs that touch the elements the rest of Phase 2 builds on
 * (the plan 2026-09-24-hud-editor-phase2-rest.md, Task L0), pinned before
 * slices 2.5 to 2.8 add keys to them: a design saved with none of the new
 * fields must keep these bytes.
 */
describe('saved designs download the same bytes before the rest of Phase 2', () => {
  const cases: [string, () => HudDesign, string][] = [
    ['a flat active weapon box', () => validateDesign({ v: 1, weapons: { boxActive: { kind: 'flat', color: '0 80 160 200' } } }), 'b960a8d79edb04c71baa7c54ff4d2948379b0c2c808e595ff0efa3951ee88a2a'],
    ['the kill notices moved', () => validateDesign({ v: 1, elements: { killNotices: { x: 200, y: 60 } } }), '95fa29054e26483c3c5907333ed0a7c16ad2295837541ad68153ad0f238b858f'],
    ['the chat moved and resized', () => validateDesign({ v: 1, elements: { chat: { x: 40, y: 200, w: 280, h: 120 } } }), '57ee338e7dfedec79291fc7b00df254a0e033a9fab0c0a1d5cb21f6f58ca8c29'],
    ['the use bar moved', () => validateDesign({ v: 1, elements: { progressBar: { x: 250, y: 300 } } }), '780e206a5ff64a5a34de8aacd6b8ac264d35d6496b690f3449d22a3d7af5bd1f'],
    ['the ghost panel moved', () => validateDesign({ v: 1, elements: { ghostPanel: { x: 100, y: 320 } } }), 'dd1617d153899a670919cd75d4d2abfa3edc1ddca90da0e0ea1e0b3116b70a97'],
    ['the Tank panel hidden', () => validateDesign({ v: 1, elements: { tankPanel: { visible: false } } }), '5503105c05369a7399429d6353d6571514cdb1a778cf1549c05e63e357802049'],
  ];
  for (const [name, make, hash] of cases) {
    it(`${name} packs to the same bytes`, () => {
      expect(download(make())).toBe(hash);
    });
  }
});
