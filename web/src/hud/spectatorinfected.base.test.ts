// @vitest-environment node
//
// Node, not happy-dom: this reads the base file, and the game's own copy when it is installed, off disk.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * The dead infected spawn countdown's file (plan task M4): the game ships
 * resource/ui/spectatorinfected.res loose in the install, not in pak01, and
 * an addon copy of it is read over the loose one (probe Q23,
 * /home/volence/l4d/hud/probe-phase2-infected/RESULTS.md, b9-e and b9v2-i).
 * The base copy must be the game's, byte for byte, or an untouched download
 * would change it. Modern ships none, so both presets read this one.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const BASE = `${here}base/stock/resource/ui/spectatorinfected.res`;
const GAME = `${homedir()}/.steam/steam/steamapps/common/left 4 dead/left4dead/resource/ui/spectatorinfected.res`;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('the spectatorinfected.res base file (plan task M4)', () => {
  it('is the game\'s loose file, byte for byte (sha256 pinned from the owner\'s install)', () => {
    expect(sha(readFileSync(BASE))).toBe('6b0630f9c4b7bfcc72f7187ca3d89182c5d7df3cb3052e9fe906cd82d9ba54b7');
  });
  it.skipIf(!existsSync(GAME))('equals the installed game\'s copy', () => {
    expect(readFileSync(BASE).equals(readFileSync(GAME))).toBe(true);
  });
  it('is not a Modern file: Modern falls back to it', () => {
    expect(existsSync(`${here}base/modern/resource/ui/spectatorinfected.res`)).toBe(false);
  });
});
