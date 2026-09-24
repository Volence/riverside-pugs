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

  it('loads no file for an inactive entry, so an imageless Image downloads the same files as the plain design', () => {
    const paths = (d: HudDesign) => buildHud(d).map((f) => f.path).sort();
    const d = design({ splatters: { splatTeam: { kind: 'image' }, splatTop: { kind: 'image' }, splatBottom: { kind: 'image' } } });
    expect(paths(d)).toEqual(paths(design({})));
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

describe('the alpha-0 drawColor of a stand-in and a hard hide', () => {
  const ID = '6'.repeat(64);
  afterEach(() => { unregisterImport(ID); });
  const withColour = (c: string) => {
    const card = baseFile('stock', CARD).replace('"hud/healthbar_bg_1"', `"hud/healthbar_bg_1"\r\n\t\t"drawColor"\t"${c}"`);
    registerImport(ID, sampleHud({ [CARD]: card }));
    return (patch: Partial<HudDesign>) => ({ ...design({ preset: 'imported', imported: { id: ID, name: 'x' } }), ...patch });
  };
  const stockAlpha = (files: { path: string; data: Uint8Array }[]) => kvGet(kvFind(tree(files, CARD), ['BackgroundImage'])!, 'drawColor');

  it('reads a colour with doubled or padded spaces', () => {
    const d = withColour(' 10  20\t30 200 ');
    expect(stockAlpha(buildHud(d({ splatters: { splatTeam: { kind: 'fade' } } })))).toBe('10 20 30 0');
    expect(stockAlpha(buildHud(d({ children: { teamColumn: { BackgroundImage: { visible: false } } } })))).toBe('10 20 30 0');
  });
  it('writes 0 0 0 0 for a scheme colour name rather than mangling it', () => {
    const d = withColour('Black');
    expect(stockAlpha(buildHud(d({ splatters: { splatTeam: { kind: 'fade' } } })))).toBe('0 0 0 0');
    expect(stockAlpha(buildHud(d({ children: { teamColumn: { BackgroundImage: { visible: false } } } })))).toBe('0 0 0 0');
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
