import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONSISTENCY_CFG, collisionMessage, consistencyCollisions, loadConsistencyList, parseConsistencyList,
} from '../src/consistencyList.js';
import { neverForceReason } from '../src/consistencyGen.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('parseConsistencyList', () => {
  it('keeps paths and skips blanks, comments and group headers', () => {
    const text = [
      '# GENERATED, do not edit', '', '# group 1: special infected models and materials',
      'models/infected/hunter.mdl', '  materials/models/infected/hunter/hunter_01.vmt  ', '',
      '# group 3: gunfire', 'scripts/game_sounds_weapons.txt', '',
    ].join('\n');
    expect(parseConsistencyList(text)).toEqual([
      'models/infected/hunter.mdl', 'materials/models/infected/hunter/hunter_01.vmt', 'scripts/game_sounds_weapons.txt',
    ]);
  });

  it('copes with CRLF line endings', () => {
    expect(parseConsistencyList('# c\r\nmodels/infected/hunter.mdl\r\n')).toEqual(['models/infected/hunter.mdl']);
  });
});

describe('loadConsistencyList', () => {
  it('loads the committed list from the repo, relative to src/', () => {
    const list = loadConsistencyList();
    expect(list).not.toBeNull();
    // Groups 1 to 5 (651, committed 1b4b5fb on 2026-09-19) plus groups 7 to 15
    // (880), promoted 2026-09-23. A deliberate regeneration (group 6, a game
    // update) changes this number; update it then.
    expect(list!.length).toBe(1531);
    expect(list).toContain('materials/models/infected/hunter/hunter_01.vmt');
    expect(list).toContain('scripts/game_sounds_weapons.txt');
    expect(list!.every((p) => !p.startsWith('#') && p.trim() === p && p !== '')).toBe(true);
  });

  it('is null, loudly, when the file is missing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadConsistencyList('/nonexistent/l4d_consistency.cfg')).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('is null, loudly, when the file holds no paths', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'consistency-'));
    try {
      const empty = join(dir, 'l4d_consistency.cfg');
      writeFileSync(empty, '# GENERATED\n\n# group 1: nothing survived the rules\n');
      expect(loadConsistencyList(empty)).toBeNull();
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The list only protects uploads on the box if it is on the box. deploy-web.sh
  // rsyncs the whole tree minus its excludes, so the way to lose the file is an
  // exclude that catches it.
  it('is not excluded by the web deploy script', () => {
    const script = readFileSync(join(CONSISTENCY_CFG, '..', '..', '..', 'deploy-web.sh'), 'utf8');
    const excludes = [...script.matchAll(/--exclude '([^']+)'/g)].map((m) => m[1]);
    // Sanity: the regex really is reading the rsync excludes.
    expect(excludes).toContain('node_modules/');
    const wouldDropTheList = excludes.filter((e) => e.startsWith('consistency') || e === 'configs/' || e === '*.cfg');
    expect(wouldDropTheList).toEqual([]);
  });
});

// Groups 7 to 15 were batch 2, generated beside the shipped list until the
// owner's two-population client gate passed on 2026-09-23 and they were promoted.
describe('the shipped list, groups 1 to 5 and the promoted batch 2', () => {
  const BATCH2_CFG = CONSISTENCY_CFG;
  const batch2 = loadConsistencyList()!;

  it('holds groups 1 to 5 and then 7 to 15, in that order', () => {
    // 4 + 4 + 28 + 1 + 246 + 296 + 6 + 9 + 286 on top of the 651, as generated 2026-09-21.
    expect(batch2.length).toBe(651 + 880);
    const headers = readFileSync(BATCH2_CFG, 'utf8').split('\n').filter((l) => l.startsWith('# group '));
    expect(headers.map((h) => Number(/^# group (\d+):/.exec(h)![1]))).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('lists no path twice, whatever the case', () => {
    expect(new Set(batch2.map((p) => p.toLowerCase())).size).toBe(batch2.length);
  });

  it('reaches what it was written to reach', () => {
    for (const p of [
      'models/infected/hulk_dlc3.mdl', 'materials/models/infected/hulk/hulk_traincar_01.vmt',
      'materials/effects/flat_normal.vtf', 'materials/effects/burned.vtf',
      'models/infected/hunter.vvd', 'models/infected/hulk_dlc3.dx90.vtx',
      'materials/models/infected/common/common_infected_shared.vmt',
      'particles/blood_fx.pcf', 'materials/particle/warp_ripple3.vmt',
      'materials/detail/ruraldetailsprites.vtf', 'materials/effects/flashlight001_infected.vtf',
      'models/props_debris/concrete_chunk01a.mdl',
    ]) expect(batch2, p).toContain(p);
    expect(batch2.filter((p) => p.startsWith('sound/player/footsteps/infected/') || p.startsWith('sound/player/footsteps/boomer/'))).toHaveLength(296);
  });

  it('forces nothing the owner lets players change', () => {
    expect(batch2.filter((p) => neverForceReason(p) !== null)).toEqual([]);
  });

  // Each of these is a file left4dead_dlc4 also ships, or that base and dlc3 hold
  // in different versions. Forcing one disconnects a whole population of
  // legitimate players, so their absence is pinned as well as generated.
  it('leaves out every manifest and the particle definitions the Sacrifice pak overrides', () => {
    for (const p of [
      'scripts/game_sounds_manifest.txt', 'particles/particles_manifest.txt', 'scripts/weapon_manifest.txt',
      'scripts/propdata.txt', 'scripts/soundscapes_manifest.txt', 'gameinfo.txt',
      'particles/burning_fx.pcf', 'particles/environment_fx.pcf', 'particles/environmental_fx.pcf', 'particles/fire_01.pcf',
      'particles/fire_01l4d.pcf', 'particles/fire_infected_fx.pcf', 'particles/water_fx.pcf', 'particles/weapon_fx.pcf',
    ]) expect(batch2.map((x) => x.toLowerCase()), p).not.toContain(p);
  });

  it('adds no common infected beyond the one parent material', () => {
    expect(batch2.filter((p) => /infected\/common/.test(p))).toEqual(['materials/models/infected/common/common_infected_shared.vmt']);
  });
});

describe('consistencyCollisions', () => {
  const forced = ['models/infected/hunter.mdl', 'materials/models/infected/hunter/hunter_01.vmt', 'scripts/game_sounds_weapons.txt'];

  it('is empty for a campaign that ships only its own files', () => {
    expect(consistencyCollisions(['missions/dbd.txt', 'maps/dbd1_alley.bsp', 'materials/dbd/wall.vmt'], forced)).toEqual([]);
  });

  it('finds a collision whatever the case or the slash', () => {
    expect(consistencyCollisions(['Materials\\Models\\Infected\\Hunter\\Hunter_01.VMT', 'missions/dbd.txt'], forced))
      .toEqual(['materials/models/infected/hunter/hunter_01.vmt']);
  });

  it('returns collisions in list order, in the list\'s spelling', () => {
    expect(consistencyCollisions(['scripts/game_sounds_weapons.txt', 'MODELS/infected/hunter.mdl'], forced))
      .toEqual(['models/infected/hunter.mdl', 'scripts/game_sounds_weapons.txt']);
  });
});

describe('collisionMessage', () => {
  it('names every path when there are few', () => {
    expect(collisionMessage(['a/b.vmt'])).toContain('a file the server enforces');
    expect(collisionMessage(['a/b.vmt', 'c/d.wav'])).toContain('a/b.vmt, c/d.wav.');
  });

  it('names ten and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, i) => `sound/x/${i}.wav`);
    const msg = collisionMessage(many);
    expect(msg).toContain('sound/x/9.wav, and 3 more.');
    expect(msg).not.toContain('sound/x/10.wav');
  });
});
