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
//   s: a stock design with all three damage splatters custom: the teammate
//      splatter an Image (quadrants red, green, blue and yellow at alpha 200),
//      the top scratches an Image (white, alpha stepping 255/160/80/0 every
//      64 columns), the bottom scratches a magenta Fade with Keep my colours,
//      so the reader also sees the stand-in, the repoint and the textures.
//   o: a stock design with your own health fitted (built without
//      validateDesign, so the fit that probe Q2 still gates is kept), scaled
//      1.5 at (20, 380), the portrait moved and resized, the bottom scratches
//      hidden, the number at text size 20, the crouch icon at zpos 9 and a
//      rounded "Your health background", so the reader also sees the own
//      panel's file edits, HudEdOwnBg and its texture.
//   z: the infected panels (plan 2026-09-24-hud-editor-phase2-infected.md,
//      Task 15): your infected health fitted, scaled 1.25, its bar 20 units
//      shorter and coloured (Q24), its number blue; the infected card fitted
//      with gap 10, its bar coloured and its name green; the ability timer at
//      scale 1.5 with a ready colour; the marker at ability_size 30, green,
//      so the reader sees the three linked SI files, the card file and the
//      HudCrosshair keys. The same edits probe B14 checked in game.
//   r: every field of Phase 2's last slices (plan 2026-09-24-hud-editor-phase2-rest.md,
//      V3): kill notices cyan at size 24, centred, on a flat box; chat size
//      20 (the open box stays behind gate C2); the use bar's label, Subtext
//      and fill; the spawn panel's colours; the too-far and Tank offer boxes;
//      the frustration meter; the spawn countdown; the mic moved with an
//      upload; the vote box; the survival timer, peril, leaving-area and
//      finale panels moved; the pickup fly-in off. The same edits probe V1
//      checked in game.
//   u: a stock design with weapon uploads (plan phase2-rest, task W2): the M16
//      icon a 192x64 band (red, green, blue thirds), the pills a 64x64 of
//      quadrants, the active box a 128x128 of yellow corners, so the reader
//      sees the repointed cells with the uploads' own rects and the VTFs.
//   t: the Tab screen (tab screen spec, TAB-4): a stock design with every
//      open Tab control at TAB-1's probe value (/home/volence/l4d/hud/probe-tab/build.mts):
//      a navy backdrop, a red title, the versus panel at 420, 20, a flat
//      green stat box, a flat magenta team box, a yellow "Your Team", a
//      magenta distance, "Enemy Team" and "Health Bonus:" hidden (its number
//      with it), your row green, flat purple teammate rows, red row bars, the
//      ping glyph hidden, your infected row yellow, the infected names cyan.
//      HUD_DESIGN_OUT, when set, also gets the design as JSON.
// Unset (or any other value) keeps the original default: sample (a).
import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packHud } from './build';
import { validateDesign, DEFAULT_DESIGN, type HudDesign } from './design';
import { ammoOnly } from './edit';
import type { BuildAssets } from './build';
import { registerImport } from './base';
import { sampleHud } from './importFixtures';

const FONT_DIR = fileURLToPath(new URL('./base/fonts/', import.meta.url));
const fonts = (): BuildAssets['fonts'] => ({
  regular: new Uint8Array(readFileSync(`${FONT_DIR}RobotoCondensed-Regular.ttf`)),
  bold: new Uint8Array(readFileSync(`${FONT_DIR}RobotoCondensed-Bold.ttf`)),
});

/** A PNG signature: enough for validateDesign, which never decodes it. */
const PNG = 'iVBORw0KGgo=';
/** 512 x 256: red, green, blue and yellow quadrants (top-left, top-right, bottom-left, bottom-right), alpha 200. */
function quadrants(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(512 * 256 * 4);
  const q: [number, number, number][] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
    const [r, g, b] = q[(y < 128 ? 0 : 2) + (x < 256 ? 0 : 1)];
    px.set([r, g, b, 200], (y * 512 + x) * 4);
  }
  return px;
}
/** 256 x 64 white, alpha 255, 160, 80 and 0 in 64-column steps. */
function stripes(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(256 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 256; x++) px.set([255, 255, 255, [255, 160, 80, 0][x >> 6]], (y * 256 + x) * 4);
  return px;
}

/** Sample t: TAB-1's values through the editor's own controls (see the header). */
export const SAMPLE_T = { v: 1, preset: 'stock', name: 'tab4',
  elements: { tabVersus: { x: 420, y: 20 } },
  styles: {
    tabStatBox: { kind: 'flat', color: '0 255 0 255' },
    tabTeamBox: { kind: 'flat', color: '255 0 255 255' },
    tabRowBg: { kind: 'flat', color: '128 0 255 255' },
  },
  children: {
    tabBoard: { BackgroundImage: { keys: { bgcolor_override: '0 0 96 200' } }, MissionTitle: { color: '255 0 0 255' } },
    tabVersus: { TeamYours: { color: '255 255 0 255' }, DistanceAmount: { color: '255 0 255 255' }, TeamEnemy: { visible: false }, HealthLabel: { visible: false } },
    tabSurvivors: {
      PlayerBackground_Selected: { keys: { bgcolor_override: '0 128 0 255' } },
      SurvivorStatsHealth: { keys: { monochrome_color: '255 0 0 255' } },
      PingImage: { visible: false },
    },
    tabInfected: {
      PlayerBackground_Selected: { keys: { bgcolor_override: '255 255 0 255' } },
      Name: { color: '0 255 255 255' }, NoAvatarName: { color: '0 255 255 255' },
    },
  } };

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
  if (sample === 's') {
    // The stored PNGs are placeholders: the build only needs them present
    // and at the texture's size; the pixels come in as assets, as the page
    // hands over what it decoded.
    const d = validateDesign({ v: 1, preset: 'stock',
      splatters: { splatTeam: { kind: 'image' }, splatTop: { kind: 'image' },
        splatBottom: { kind: 'fade', color: '255 0 255 200', keepColours: true } },
      images: { splatTeam: { w: 512, h: 256, png: PNG }, splatTop: { w: 256, h: 64, png: PNG } } });
    if (!d.images.splatTeam || !d.images.splatTop) throw new Error('sample s lost its stored pictures in validateDesign');
    writeFileSync(process.env.HUD_VPK_OUT, packHud(d, { images: { splatTeam: quadrants(), splatTop: stripes() } }).bytes);
    return;
  }
  if (sample === 'u') {
    const tex = (w: number, h: number, f: (x: number, y: number) => number[]) => {
      const px = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(f(x, y), (y * w + x) * 4);
      return px;
    };
    const band = tex(192, 64, (x) => [x < 64 ? 255 : 0, x >= 64 && x < 128 ? 255 : 0, x >= 128 ? 255 : 0, 255]);
    const quad = tex(64, 64, (x, y) => (y < 32 ? (x < 32 ? [255, 255, 255, 255] : [255, 0, 0, 255]) : (x < 32 ? [0, 255, 0, 255] : [255, 255, 255, 128])));
    const box = tex(128, 128, (x, y) => ((x < 16 || x >= 112) && (y < 16 || y >= 112) ? [255, 255, 0, 255] : [0, 255, 255, 255]));
    const d = validateDesign({ v: 1, preset: 'stock',
      images: { wiconMachinegun: { w: 192, h: 64, png: PNG }, wiconPills: { w: 64, h: 64, png: PNG }, weaponBoxActive: { w: 128, h: 128, png: PNG } },
      weapons: { boxActive: { kind: 'image' }, icons: { icon_equip_machinegun: 'wiconMachinegun', icon_equip_pills: 'wiconPills' } } });
    if (Object.keys(d.weapons?.icons ?? {}).length !== 2 || d.weapons?.boxActive?.kind !== 'image') throw new Error('sample u lost its uploads in validateDesign');
    writeFileSync(process.env.HUD_VPK_OUT, packHud(d, { images: { wiconMachinegun: band, wiconPills: quad, weaponBoxActive: box } }).bytes);
    return;
  }
  if (sample === 'o') {
    const d: HudDesign = { ...structuredClone(DEFAULT_DESIGN),
      elements: { ...DEFAULT_DESIGN.elements, ownHealth: { fit: true, scale: 1.5, x: 20, y: 380 } },
      children: { ownHealth: { Head: { x: 100, y: 50, w: 20, h: 20 }, HealthbarTextureBottom: { visible: false },
        HealthNumber: { fontSize: 20 }, DuckingIcon: { z: 9 } } },
      styles: { ownBg: { kind: 'rounded', color: '0 40 80 180' } } };
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
  if (sample === 'z') {
    const d = validateDesign({ v: 1, preset: 'stock', crosshair: 'none',
      elements: {
        siHealth: { fit: true, scale: 1.25 },
        infectedRow: { fit: true, gap: 10 },
        abilityRing: { scale: 1.5, keys: { ability_ready_color: '255 0 255 255' } },
        abilityMarker: { keys: { ability_size: 30, ability_ready_color: '0 255 0 255' } },
      },
      children: {
        siHealth: { Health: { w: 112, keys: { monochrome_color: '255 0 255 255' } }, HealthNumber: { color: '0 0 255 255' } },
        infectedRow: { HealthPanel: { keys: { monochrome_color: '0 255 255 255' } }, NameLabel: { color: '0 255 0 255' } },
      } });
    if (!d.children.siHealth?.Health?.keys?.monochrome_color) throw new Error('sample z lost the Q24 bar colour in validateDesign');
    writeFileSync(process.env.HUD_VPK_OUT, packHud(d).bytes);
    return;
  }
  if (sample === 'r') {
    const mic = new Uint8ClampedArray(64 * 64 * 4).fill(255);
    const d = validateDesign({ v: 1, preset: 'stock', crosshair: 'none', pickupFlyIn: false,
      images: { voiceSelf: { w: 64, h: 64, png: PNG } },
      elements: {
        killNotices: { color: '0 255 255 255', fontSize: 24, keys: { label_textalign: 'center' }, noticeBox: { kind: 'flat', color: '0 0 255 160' } },
        chat: { fontSize: 20 },
        ghostPanel: { keys: { WhiteText: '0 255 255 255', RedText: '255 255 0 255' } },
        spawnCountdown: { color: '255 0 255 255', fontSize: 20 },
        ownMic: { x: 40, y: 40, w: 48, h: 48 },
        vote: { y: 100, bg: '128 0 128 240' },
        holdoutTimer: { y: 150 }, perilNotice: { y: 150 }, leavingArea: { y: 200 }, finaleMeter: { y: 250 },
      },
      children: {
        progressBar: { BarLabel: { color: '255 255 0 255' }, Subtext: { color: '255 0 255 255' }, Bar: { keys: { fill_color: '0 255 0 255' } } },
        zombiePanel: {
          'TooFarFromSurvivors/TooFarTitle': { color: '255 255 0 255' },
          'TankTakeover/Title': { color: '255 0 255 255' }, 'TankTakeover/Text': { color: '0 255 255 255' },
          'TankTakeover/Background': { keys: { bgcolor_override: '0 96 0 220' } },
        },
        tankPanel: { Countdown: { color: '255 0 255 255', fontSize: 24 }, FrustrationLabel: { color: '0 255 255 255' }, FrustrationBar: { keys: { east_aligned: '0' } } },
      } });
    if (d.elements.killNotices?.fontSize !== 24 || !d.children.tankPanel || !d.children.zombiePanel?.['TankTakeover/Title']) throw new Error('sample r lost a gated field in validateDesign');
    writeFileSync(process.env.HUD_VPK_OUT, packHud(d, { images: { voiceSelf: mic } }).bytes);
    return;
  }
  if (sample === 't') {
    const d = validateDesign(SAMPLE_T);
    // Every field must survive validation: a gate that closed would drop one silently.
    const kept = [d.elements.tabVersus?.x === 420, d.elements.tabVersus?.y === 20, d.children.tabBoard?.MissionTitle?.color,
      d.children.tabVersus?.HealthLabel?.visible === false, d.children.tabSurvivors?.SurvivorStatsHealth?.keys?.monochrome_color,
      d.children.tabSurvivors?.PingImage?.visible === false, d.children.tabInfected?.Name?.color, d.styles.tabRowBg];
    if (kept.some((k) => !k)) throw new Error(`sample t lost a field in validateDesign: ${JSON.stringify(kept)}`);
    if (process.env.HUD_DESIGN_OUT) writeFileSync(process.env.HUD_DESIGN_OUT, `${JSON.stringify(d, null, 2)}\n`);
    writeFileSync(process.env.HUD_VPK_OUT, packHud(d).bytes);
    return;
  }
  const d = validateDesign(SAMPLE_A);
  writeFileSync(process.env.HUD_VPK_OUT, packHud(d).bytes);
});
