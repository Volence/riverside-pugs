import { describe, it, expect, afterEach } from 'vitest';
import { buildHud, packHud, CLEAR_TEXTURE, pieceMovableIn, panelChild, type BuildReport } from './build';
import { validateDesign, type HudDesign } from './design';
import { registerImport, unregisterImport, baseFile } from './base';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { decodeText } from './text';
import { readVPK } from '../vpk/read';
import { parsePos, screenW, SCREEN_H } from './units';
import { sampleHud, latin1, MARKER_PANEL, dropBlock } from './importFixtures';
import { patchChild } from './edit';
import { TEX } from '../crosshair/draw';

/**
 * An id is its files' content hash, so the base caches (baseTeam, the parsed
 * trees) keep what they read for an id for ever. These tests register a
 * different file set almost every time, so each registration gets an id of
 * its own: reusing one would read another test's files back from the cache
 * and pass or fail by test order.
 */
let minted = 0;                                   // never reset, so no id comes round twice
const used: string[] = [];
const freshId = () => { const id = (++minted).toString(16).padStart(64, '0'); used.push(id); return id; };
afterEach(() => { for (const id of used.splice(0)) unregisterImport(id); });

/** An imported design on `files`, with the game's own crosshair so layoutPass adds no xHair. */
const imported = (files: Map<string, Uint8Array>, extra: Record<string, unknown> = {}): HudDesign => {
  const id = freshId();
  registerImport(id, files);
  return validateDesign({ v: 1, name: 'edgehud', preset: 'imported', imported: { id, name: 'edgehud' }, crosshair: 'none', ...extra });
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

describe("an imported HUD's own crosshair", () => {
  const withXhair = () => sampleHud({
    'scripts/hudlayout.res': decodeText(sampleHud().get('scripts/hudlayout.res')!).text
      .replace(/\}\s*$/, '\t"xHair"\r\n\t{\r\n\t\t"fieldName" "xHair"\r\n\t\t"image" "hud/altcrosshair"\r\n\t}\r\n}\r\n'),
    'materials/vgui/hud/altcrosshair.vtf': new Uint8Array([0x56, 0x54, 0x46, 0, 9, 9, 9]),
    'materials/vgui/hud/altcrosshair.vmt': latin1('"UnlitGeneric" { "$basetexture" "vgui/hud/altcrosshair" }'),
  });
  const PX = new Uint8ClampedArray(TEX * TEX * 4);

  it("keeps the HUD's own xHair element on Game default: the editor adds no crosshair, and removes none", () => {
    const files = withXhair();
    const out = byPath(buildHud(imported(files)));
    expect(out.get('scripts/hudlayout.res')).toEqual(files.get('scripts/hudlayout.res'));
  });

  it("ships the HUD's own crosshair files byte for byte while the crosshair is still the HUD's own", () => {
    const files = withXhair();
    const report: BuildReport = { replaced: [] };
    const d = imported(files, { crosshair: 'bundle', xhairArt: { kind: 'built', state: {} } });
    const out = byPath(buildHud(d, { crosshair: PX, ownCrosshair: true }, report));
    for (const [path, data] of files) expect(out.get(path), path).toEqual(data);
    expect(report.replaced).toEqual([]);
  });

  it('writes the crosshair the player made over the HUD\'s own, and says so', () => {
    const files = withXhair();
    const report: BuildReport = { replaced: [] };
    const d = imported(files, { crosshair: 'bundle', xhairArt: { kind: 'built', state: {} } });
    const out = byPath(buildHud(d, { crosshair: PX }, report));
    expect(out.get('materials/vgui/hud/altcrosshair.vtf')).not.toEqual(files.get('materials/vgui/hud/altcrosshair.vtf'));
    expect(report.replaced).toEqual(['materials/vgui/hud/altcrosshair.vmt', 'materials/vgui/hud/altcrosshair.vtf']);
  });
});

describe('the revive anchor on an imported HUD', () => {
  // build.ts reviveAnchorPass: client.dll puts the own bar back at Items' x after a revive.
  const OWN = 'resource/ui/hud/localplayerpanel.res';
  const apart = baseFile('modern', OWN);                                // bar at 34, down picture at 0
  it('leaves an untouched upload byte for byte, even with the bar and the down picture apart', () => {
    const files = sampleHud({ [OWN]: apart });
    expect(byPath(buildHud(imported(files))).get(OWN)).toEqual(files.get(OWN));
  });
  it('anchors a panel the design edited', () => {
    const out = byPath(buildHud(imported(sampleHud({ [OWN]: apart }), { children: { ownHealth: { Health: { x: 40 } } } })));
    const items = kvFind(root(out, OWN), ['Items'])!;
    expect([kvGet(items, 'ControlName'), kvGet(items, 'xpos'), kvGet(items, 'visible')]).toEqual(['Label', '40', '0']);
  });
  it('anchors an edited panel the upload does not ship, which the game reads from its own files', () => {
    const out = byPath(buildHud(imported(sampleHud(), { children: { ownHealth: { Health: { x: 40 } } } })));
    expect(kvGet(kvFind(root(out, OWN), ['Items'])!, 'xpos')).toBe('40');
  });
});

describe('your infected health on an import whose Hunter file lacks a piece the Smoker and Boomer have', () => {
  const HUNTER = 'resource/ui/hud/hunterhealth.res', SMOKER = 'resource/ui/hud/smokerhealth.res', BOOMER = 'resource/ui/hud/boomerhealth.res';
  const noHunterNumber = () => sampleHud({ [HUNTER]: dropBlock(baseFile('stock', HUNTER), 'HealthNumber') });
  it('writes the edit to every linked file that has the piece: the Smoker (same) all of it, the Boomer (delta) all but its place and size', () => {
    const d = imported(noHunterNumber(), { children: { siHealth: { HealthNumber: { x: 300, y: 10, w: 60, color: '10 20 30 255' } } } });
    const out = byPath(buildHud(d));
    expect(kvFind(root(out, HUNTER), ['HealthNumber'])).toBeUndefined();
    const smoker = kvFind(root(out, SMOKER), ['HealthNumber'])!;
    expect([kvGet(smoker, 'xpos'), kvGet(smoker, 'ypos'), kvGet(smoker, 'wide'), kvGet(smoker, 'fgcolor_override')]).toEqual(['300', '10', '60', '10 20 30 255']);
    // The Boomer's place moves from the Hunter's, which this HUD lacks: it keeps its own, and takes the colour.
    const boomer = kvFind(root(out, BOOMER), ['HealthNumber'])!;
    const stock = kvFind(parseKv(baseFile('stock', BOOMER))[0].value as KvNode[], ['HealthNumber'])!;
    expect([kvGet(boomer, 'xpos'), kvGet(boomer, 'wide'), kvGet(boomer, 'fgcolor_override')]).toEqual([kvGet(stock, 'xpos'), kvGet(stock, 'wide'), '10 20 30 255']);
  });
  it('offers the place and size on the Smoker view, not on the Boomer view, and takes the rest on both', () => {
    const d = imported(noHunterNumber());
    expect(pieceMovableIn(d, 'siHealth', 'HealthNumber', SMOKER)).toBe(true);
    expect(pieceMovableIn(d, 'siHealth', 'HealthNumber', BOOMER)).toBe(false);
    expect(pieceMovableIn(d, 'siHealth', 'Health', BOOMER)).toBe(true);
    expect(patchChild(d, 'HealthNumber', { x: 5 }, 'siHealth', BOOMER)).toBe(d);
    expect(patchChild(d, 'HealthNumber', { x: 5, visible: false }, 'siHealth', BOOMER).children.siHealth).toEqual({ HealthNumber: { visible: false } });
    const moved = patchChild(d, 'HealthNumber', { x: 5 }, 'siHealth', SMOKER);
    expect(panelChild(moved, 'siHealth', 'HealthNumber', SMOKER)!.x).toBe(5);
  });
});
