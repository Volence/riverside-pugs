import { describe, it, expect } from 'vitest';
import { readHudUpload, hudId, IMPORT_ERRORS, MAX_HUD_BYTES } from './upload';
import { encodeVPK } from '../vpk';
import { encodeZip } from '../vpk/zip';
import { handMade, zipOf } from '../vpk/fixtures';
import { sampleHud, asList, latin1, dropBlock } from './importFixtures';
import { parseKv, writeKv, type KvNode } from './kv';
import { baseFile } from './base';

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

  it('names a renamed .vpk after what comes before its .vpk, not the letters of every extension run together', async () => {
    const files = sampleHud();
    expect((await readHudUpload('my_hud.vpk.orig', vpkOf(files))).name).toBe('my_hud');
    expect((await readHudUpload('pak01_dir.vpk.bak', vpkOf(files))).name).toBe('pak01');
    expect((await readHudUpload('edgehud.zip.1', vpkOf(files))).name).toBe('edgehud');
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

  it('drops OS junk and every path that could land outside the addon or that a VPK cannot hold, and says which', async () => {
    const x = latin1('x');
    const unsafe = [
      'edgehud/../../cfg/autoexec.cfg',                // climbs out of the addon
      'edgehud/./scripts/extra.res',                   // a "." folder
      'edgehud//scripts/extra.res',                    // an empty folder
      '/edgehud/abs.txt',                              // absolute
      'C:/Windows/evil.txt',                           // a drive letter
      'edgehud/bad\u0001name.txt',                    // a control character
      'edgehud/foo.',                                  // ends in a dot: no extension a VPK can hold
    ];
    const junk = [
      '__MACOSX/edgehud/scripts/._HudLayout.res',
      'edgehud/.DS_Store',
      'edgehud/scripts/Thumbs.db',
      'edgehud/desktop.ini',
      'edgehud/.gitignore',
    ];
    const zip = await zipOf([...under('edgehud/', sampleHud()), ...[...unsafe, ...junk].map((path) => ({ path, data: x }))]);
    const got = await readHudUpload('edgehud.zip', zip);
    expect(got.dropped).toEqual([...unsafe, ...junk].sort());
    expect([...got.files.keys()].sort()).toEqual([...sampleHud().keys()].sort());
    // What is left must download: encodeVPK throws on anything it cannot hold.
    expect(() => encodeVPK(asList(got.files))).not.toThrow();
  });

  it('drops the same paths from a .vpk, which a hand-rolled packer can write', async () => {
    const hud = asList(sampleHud()).map((f) => ({ path: f.path, archive: 0x7FFF, offset: 0, length: 0, preload: f.data }));
    const bad = ['../../cfg/autoexec.cfg', 'scripts/./x.res', 'desktop.ini'];
    const vpk = handMade([...hud, ...bad.map((path) => ({ path, archive: 0x7FFF, offset: 0, length: 0, preload: latin1('x') }))]);
    const got = await readHudUpload('edgehud.vpk', vpk);
    expect(got.dropped).toEqual([...bad].sort());
    expect(got.files).toEqual(sampleHud());
  });

  it("imports the VPK inside a zip that has no loose HUD, like the editor's own Advanced download", async () => {
    const files = sampleHud();
    const zip = encodeZip([{ path: 'riversidehud/pak01_dir.vpk', data: vpkOf(files) }, { path: 'README.txt', data: latin1('x') }]);
    const got = await readHudUpload('my_hud.zip', zip);
    expect(got.files).toEqual(files);
    expect(got.name).toBe('my_hud');
    expect(got.dropped).toEqual(['README.txt']);
  });

  it('keeps the first of two zip entries whose names differ only by case, and says it left the other out', async () => {
    const files = sampleHud();
    const zip = await zipOf([
      ...under('edgehud/', files),
      { path: 'edgehud/scripts/hudlayout.res', data: latin1('"x" { }') },
    ]);
    const got = await readHudUpload('edgehud.zip', zip);
    expect(got.files.get('scripts/hudlayout.res')).toEqual(files.get('scripts/hudlayout.res'));
    expect(got.dropped).toEqual(['edgehud/scripts/hudlayout.res']);
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

  describe('refuses a file that parses but lacks the shape the editor reads, naming the file', () => {
    const stock = (path: string) => baseFile('stock', path);
    // The stock file with one top-level block turned into a plain value.
    const asString = (path: string, name: string) => {
      const t = parseKv(stock(path));
      const n = (t[0].value as KvNode[]).find((c) => c.key.toLowerCase() === name.toLowerCase())!;
      n.value = 'x';
      return writeKv(t);
    };
    const cases: [string, string, string][] = [
      ['an empty hudlayout.res', 'scripts/hudlayout.res', ''],
      ['a comment-only hudlayout.res', 'scripts/hudlayout.res', '// nothing\r\n'],
      ['a hudlayout.res whose root is a string', 'scripts/hudlayout.res', '"Resource/HudLayout.res" "x"'],
      ['a teammatepanel.res whose root is a string', 'resource/ui/hud/teammatepanel.res', '"a" "b"'],
      ['an empty teamdisplayhud.res', 'resource/ui/hud/teamdisplayhud.res', '// blank\r\n'],
      ['an empty clientscheme.res', 'resource/clientscheme.res', ''],
      ['a clientscheme.res whose root is a string', 'resource/clientscheme.res', '"Scheme" "x"'],
      ['an empty basechat.res', 'resource/ui/basechat.res', ''],
      ['a basechat.res with no HudChat', 'resource/ui/basechat.res', '"Resource/UI/BaseChat.res" { "Other" { } }'],
      ['a mod_textures.txt with no TextureData', 'scripts/mod_textures.txt', '"sprites/640_hud.txt" { }'],
      ['an empty mod_textures.txt', 'scripts/mod_textures.txt', ''],
      ['a hudlayout.res panel written as a string', 'scripts/hudlayout.res', asString('scripts/hudlayout.res', 'HudWeaponSelection')],
      ['TeamPlayer1 written as a string', 'resource/ui/hud/teamdisplayhud.res', asString('resource/ui/hud/teamdisplayhud.res', 'TeamPlayer1')],
      ['a card child written as a string', 'resource/ui/hud/teammatepanel.res', asString('resource/ui/hud/teammatepanel.res', 'Name')],
    ];
    for (const [what, path, text] of cases) {
      it(what, async () => {
        const files = sampleHud({ [path]: text });
        const escaped = path.replace(/[./]/g, (c) => `\\${c}`);
        await expect(readHudUpload('bad.vpk', vpkOf(files))).rejects.toThrow(new RegExp(`^This HUD's ${escaped} `));
      });
    }

    it('and still takes a HUD that simply lacks a panel, which the editor degrades around', async () => {
      const layout = dropBlock(stock('scripts/hudlayout.res'), 'HudWeaponSelection');
      await expect(readHudUpload('ok.vpk', vpkOf(sampleHud({ 'scripts/hudlayout.res': layout })))).resolves.toBeTruthy();
    });
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
