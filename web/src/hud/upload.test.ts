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
