import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { makeVpk, makeVpkMulti } from './fixtures/makeVpk.js';
import { parseKeyValues, parseMission, missionFromVpk, listVpkPaths, openVpk, MissionError } from '../src/vpk.js';

const MISSION = `
"mission"
{
  "Name" "dbd"
  "DisplayTitle" "Dead Before Dawn"
  "modes"
  {
    "coop"
    {
      "1" { "Map" "dbd1_alley" "DisplayName" "Alley" }
    }
    "versus"
    {
      "1" { "Map" "dbd1_alley" "DisplayName" "Alley (VS)" "VersusModifier" "1.0" }
      "2" { "Map" "dbd2_mall" "DisplayName" "Mall" }
      "10" { "Map" "dbd10_roof" "DisplayName" "Roof" }
    }
  }
}
`;

describe('parseKeyValues', () => {
  it('reads nested blocks and quoted values', () => {
    const kv = parseKeyValues('"a" { "b" "1" "c" { "d" "2" } }') as Record<string, never>;
    expect(kv).toEqual({ a: { b: '1', c: { d: '2' } } });
  });

  // Mission files in the wild are full of // comments, including on the same
  // line as a value. A parser that chokes on them rejects real campaigns.
  it('ignores line comments', () => {
    expect(parseKeyValues('// lead\n"a" "1" // trailing\n')).toEqual({ a: '1' });
  });
});

describe('parseMission', () => {
  it('reads the title and the versus chapters', () => {
    const m = parseMission(MISSION)!;
    expect(m.name).toBe('dbd');
    expect(m.displayTitle).toBe('Dead Before Dawn');
    expect(m.chapters.map((c) => c.map)).toEqual(['dbd1_alley', 'dbd2_mall', 'dbd10_roof']);
  });

  // Chapter keys are strings, so a naive sort puts "10" before "2" and the
  // campaign plays out of order. They must be ordered numerically.
  it('orders chapters numerically, not lexically', () => {
    expect(parseMission(MISSION)!.chapters[2].map).toBe('dbd10_roof');
  });

  it('takes versus, never coop', () => {
    expect(parseMission(MISSION)!.chapters[0].display).toBe('Alley (VS)');
  });

  // Returning null rather than a guess: a campaign with no versus chapters
  // cannot be played here, and an empty campaign row is worse than a refusal.
  it('returns null when there are no versus chapters', () => {
    expect(parseMission('"mission" { "Name" "x" "modes" { "coop" { } } }')).toBeNull();
  });
});

// A chapter's map name goes onto an rcon command line (`changelevel <map>`),
// and a mission file is whatever the uploader put in the VPK. The engine
// splits a command on ';' even inside an argument, so this is refused at the
// door rather than escaped at the far end.
describe('parseMission refuses a map name that is not a map name', () => {
  const withMap = (map: string) =>
    `"mission" { "Name" "x" "modes" { "versus" { "1" { "Map" "ok1" } "2" { "Map" "${map}" } } } }`;

  it.each([
    ['a second command', 'x;rcon_password pwned'],
    ['a space', 'm two'],
    ['a newline', 'x\nquit'],
    ['a path', '../x'],
    ['a dash', 'm-2'],
    ['a dot', 'm.2'],
    ['64 characters', 'a'.repeat(64)],
  ])('throws on %s', (_what, map) => {
    expect(() => parseMission(withMap(map))).toThrow(MissionError);
  });

  it('names the offending chapter so the uploader can fix it', () => {
    expect(() => parseMission(withMap('x;quit'))).toThrow(/chapter 2.*x;quit/);
  });

  it('accepts what real campaigns use', () => {
    for (const map of ['l4d_vs_hospital01_apartment', 'c1m1_hotel', 'AirCrash', 'dbd10_roof', 'a'.repeat(63)]) {
      expect(parseMission(withMap(map))!.chapters[1].map).toBe(map);
    }
  });

  it('ignores the coop list, which is never played here', () => {
    const text = '"mission" { "Name" "x" "modes" { "coop" { "1" { "Map" "x;quit" } } "versus" { "1" { "Map" "ok1" } } } }';
    expect(parseMission(text)!.chapters.map((c) => c.map)).toEqual(['ok1']);
  });
});

describe('missionFromVpk', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vpk-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('finds and parses missions/*.txt inside a VPK', () => {
    const p = join(dir, 'dbd.vpk');
    makeVpk(p, { ext: 'txt', dir: 'missions', name: 'dbd', body: MISSION });
    expect(missionFromVpk(p)!.displayTitle).toBe('Dead Before Dawn');
  });

  it('returns null for a VPK with no mission file', () => {
    const p = join(dir, 'skin.vpk');
    makeVpk(p, { ext: 'vmt', dir: 'materials', name: 'hunter', body: 'x' });
    expect(missionFromVpk(p)).toBeNull();
  });

  it('returns null for a file that is not a VPK at all', () => {
    const p = join(dir, 'notavpk.vpk');
    writeFileSync(p, Buffer.from('this is not a vpk'));
    expect(missionFromVpk(p)).toBeNull();
  });

  // The mission's bytes live entirely in a numbered archive (pak01_NNN.vpk)
  // that this reader deliberately never opens.
  it('returns null when the mission is entirely in an inaccessible numbered archive', () => {
    const p = join(dir, 'archived.vpk');
    makeVpk(p, { ext: 'txt', dir: 'missions', name: 'dbd', body: MISSION, archiveIndex: 0 });
    expect(missionFromVpk(p)).toBeNull();
  });

  // A short preload still tokenises into a complete-looking, but short,
  // chapter list: the KeyValues parser just stops at the last full block it
  // can see instead of erroring. That must not be accepted as the whole
  // mission, so assert the null itself, not merely that nothing threw.
  it('returns null when the mission is truncated between the preload and a numbered archive', () => {
    const p = join(dir, 'partial.vpk');
    const cut = MISSION.indexOf('"10"');
    makeVpk(p, {
      ext: 'txt',
      dir: 'missions',
      name: 'dbd',
      body: MISSION,
      archiveIndex: 0,
      preloadBytes: Buffer.byteLength(MISSION.slice(0, cut), 'utf8'),
    });
    expect(missionFromVpk(p)).toBeNull();
  });

  // Buffer.subarray clamps a past-the-end index instead of throwing, so a
  // file that got cut short in transit, while its entry still claims the
  // original length, must be caught by an explicit bounds check rather than
  // silently handing back whatever bytes happen to be physically present.
  it('returns null when the file is physically shorter than the entry claims', () => {
    const p = join(dir, 'truncated.vpk');
    makeVpk(p, { ext: 'txt', dir: 'missions', name: 'dbd', body: MISSION });
    const full = readFileSync(p);
    const bodyLength = Buffer.byteLength(MISSION, 'utf8');
    const headerAndTree = full.length - bodyLength; // default fixture has no preload
    const cut = MISSION.indexOf('"10"');
    const keepBytes = Buffer.byteLength(MISSION.slice(0, cut), 'utf8');
    // The tree's entry still says `length` covers the whole mission; only
    // the physical file is cut short, right after chapter "2".
    writeFileSync(p, full.subarray(0, headerAndTree + keepBytes));
    expect(missionFromVpk(p)).toBeNull();
  });

  // Nothing exercised the v2 header's extra 16 bytes before this: both real
  // files checked against were v1, and the fixture builder defaulted to v1.
  it('parses a v2 header (28-byte) VPK the same as v1', () => {
    const p = join(dir, 'dbd_v2.vpk');
    makeVpk(p, { ext: 'txt', dir: 'missions', name: 'dbd', body: MISSION, version: 2 });
    expect(missionFromVpk(p)).toEqual(parseMission(MISSION));
  });
});

describe('listVpkPaths', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vpk-list-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('lists dir/name.ext without opening a numbered archive', () => {
    const p = join(dir, 'a.vpk');
    makeVpk(p, { ext: 'vmt', dir: 'materials/models/infected/hunter', name: 'hunter_01', body: 'x', archiveIndex: 3 });
    expect(listVpkPaths(p)).toEqual(['materials/models/infected/hunter/hunter_01.vmt']);
  });

  it('steps over preload bytes and the v2 header', () => {
    const p = join(dir, 'b.vpk');
    makeVpk(p, { ext: 'txt', dir: 'scripts', name: 'game_sounds_weapons', body: 'abcdef', preloadBytes: 4, version: 2 });
    expect(listVpkPaths(p)).toEqual(['scripts/game_sounds_weapons.txt']);
  });

  it('spells a root-level file without the single-space directory', () => {
    const p = join(dir, 'c.vpk');
    makeVpk(p, { ext: 'txt', dir: ' ', name: 'addoninfo', body: 'x' });
    expect(listVpkPaths(p)).toEqual(['addoninfo.txt']);
  });

  it('returns nothing for a file that is not a VPK', () => {
    const p = join(dir, 'd.vpk');
    writeFileSync(p, 'not a vpk at all');
    expect(listVpkPaths(p)).toEqual([]);
  });
});

describe('openVpk', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vpk-open-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('is null for a file that is not a VPK', () => {
    const p = join(dir, 'a.vpk');
    writeFileSync(p, 'not a vpk at all');
    expect(openVpk(p)).toBeNull();
  });

  it('gives every entry its path, size and stored CRC', () => {
    const p = join(dir, 'pak01_dir.vpk');
    makeVpkMulti(p, [
      { ext: 'vmt', dir: 'materials/particle', name: 'warp', body: 'spritecard {}' },
      { ext: 'pcf', dir: 'particles', name: 'fire_fx', body: 'pcf-bytes' },
    ]);
    const vpk = openVpk(p)!;
    expect(vpk.entries.map((e) => [e.path, e.size, e.crc])).toEqual([
      ['materials/particle/warp.vmt', 13, crc32(Buffer.from('spritecard {}'))],
      ['particles/fire_fx.pcf', 9, crc32(Buffer.from('pcf-bytes'))],
    ]);
  });

  it('reads a body stored inline, after the tree', () => {
    const p = join(dir, 'pak01_dir.vpk');
    makeVpkMulti(p, [
      { ext: 'vmt', dir: 'materials/a', name: 'one', body: 'first' },
      { ext: 'vmt', dir: 'materials/a', name: 'two', body: 'second' },
    ]);
    const vpk = openVpk(p)!;
    expect(vpk.read(vpk.entries[1]).toString()).toBe('second');
  });

  // pak01 keeps almost nothing inline: the directory file names a numbered
  // archive and an offset into it.
  it('reads a body out of the numbered archive beside the directory file', () => {
    const p = join(dir, 'pak01_dir.vpk');
    makeVpkMulti(p, [
      { ext: 'vmt', dir: 'materials/a', name: 'one', body: 'first', archiveIndex: 3 },
      { ext: 'vmt', dir: 'materials/a', name: 'two', body: 'second', archiveIndex: 3 },
      { ext: 'vtf', dir: 'materials/a', name: 'tex', body: 'pixels', archiveIndex: 12 },
    ]);
    const vpk = openVpk(p)!;
    expect(vpk.entries.map((e) => vpk.read(e).toString())).toEqual(['first', 'second', 'pixels']);
  });

  it('joins the preload bytes to the rest', () => {
    const p = join(dir, 'b.vpk');
    makeVpk(p, { ext: 'txt', dir: 'scripts', name: 'x', body: 'abcdef', preloadBytes: 4 });
    const vpk = openVpk(p)!;
    expect(vpk.entries[0].size).toBe(6);
    expect(vpk.read(vpk.entries[0]).toString()).toBe('abcdef');
  });
});
