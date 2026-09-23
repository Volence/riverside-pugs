import { describe, it, expect, afterEach } from 'vitest';
import { buildHud, packHud, CLEAR_TEXTURE, type BuildReport } from './build';
import { validateDesign, type HudDesign } from './design';
import { registerImport, unregisterImport } from './base';
import { parseKv, kvFind, kvGet, type KvNode } from './kv';
import { decodeText } from './text';
import { readVPK } from '../vpk/read';
import { parsePos, screenW, SCREEN_H } from './units';
import { sampleHud, latin1, MARKER_PANEL } from './importFixtures';

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
