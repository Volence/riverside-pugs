import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseManifest, repoManifest } from '../src/fleetManifest.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'man-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
function repo() {
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(join(dir, 'overrides/left4dead/cfg'), { recursive: true });
  mkdirSync(join(dir, 'overrides/left4dead_dlc4/missions'), { recursive: true });
  writeFileSync(join(dir, 'overrides/left4dead/cfg/pug_match.cfg'), 'pm');
  writeFileSync(join(dir, 'overrides/left4dead_dlc4/missions/m.txt'), 'm');
  writeFileSync(join(dir, '.gitignore'), 'secrets.cfg\n');
  writeFileSync(join(dir, 'overrides/left4dead/cfg/secrets.cfg'), 'rcon_password "x"');
  git('add', '-A'); git('commit', '-qm', 'x');
}

describe('repoManifest', () => {
  it('maps overrides to game dir paths, never includes ignored files, labels by commit', async () => {
    repo();
    const m = await repoManifest(dir);
    expect(m.kind).toBe('repo');
    expect(m.label).toMatch(/^[0-9a-f]{7,}$/);
    expect(m.files).toEqual({
      'left4dead/cfg/pug_match.cfg': { size: 2, sha256: sha('pm') },
      'left4dead_dlc4/missions/m.txt': { size: 1, sha256: sha('m') },
    });
  });
  it('refuses uncommitted changes and untracked files under overrides', async () => {
    repo();
    writeFileSync(join(dir, 'overrides/left4dead/cfg/pug_match.cfg'), 'changed');
    await expect(repoManifest(dir)).rejects.toThrow(/uncommitted/);
    git('checkout', '--', '.');
    writeFileSync(join(dir, 'overrides/left4dead/cfg/new.cfg'), 'n');
    await expect(repoManifest(dir)).rejects.toThrow(/uncommitted/);
  });
});

describe('baseManifest', () => {
  it('layers the two install folders, second wins, and drops 64-bit binaries', async () => {
    const top = join(dir, 'l4d1_Roto-AZMod/Files Here');
    const a = join(top, 'Linux Server Files/left4dead'), b = join(top, 'Roto-AZMod Main files/left4dead');
    mkdirSync(join(a, 'addons/sourcemod/bin/linux64'), { recursive: true });
    mkdirSync(join(a, 'cfg'), { recursive: true });
    mkdirSync(join(b, 'cfg'), { recursive: true });
    writeFileSync(join(a, 'addons/sourcemod/bin/linux64/x.so'), 'x');
    writeFileSync(join(a, 'cfg/server.cfg'), 'first');
    writeFileSync(join(b, 'cfg/server.cfg'), 'second');
    writeFileSync(join(b, 'cfg/rotoblin.cfg'), 'r');
    const m = await baseManifest(dir, 'Rotoblin-AZMod v8.6.4');
    expect(m).toMatchObject({ kind: 'base', label: 'Rotoblin-AZMod v8.6.4' });
    expect(m.files).toEqual({
      'left4dead/cfg/server.cfg': { size: 6, sha256: sha('second') },
      'left4dead/cfg/rotoblin.cfg': { size: 1, sha256: sha('r') },
    });
  });
});
