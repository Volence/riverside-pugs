import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeVpk } from './fixtures/makeVpk.js';
import { parseKeyValues, parseMission, missionFromVpk } from '../src/vpk.js';

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
