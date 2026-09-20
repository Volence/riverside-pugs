import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONSISTENCY_CFG, collisionMessage, consistencyCollisions, loadConsistencyList, parseConsistencyList,
} from '../src/consistencyList.js';

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
    // Groups 1 to 5 as committed in 1b4b5fb on 2026-09-19, which dropped the sound
    // manifest. A deliberate regeneration (group 6, a game update) changes this
    // number; update it then.
    expect(list!.length).toBe(651);
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
