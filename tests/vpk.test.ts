import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
