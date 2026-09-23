import { describe, it, expect, afterEach } from 'vitest';
import { registerImport, unregisterImport, baseFile, hasImport } from './base';
import { importProblem } from './importCheck';
import { sampleHud, dropBlock } from './importFixtures';

const OK = '4'.repeat(64);
const NO_LOCAL = '5'.repeat(64);
const EMPTY_TEAM = '6'.repeat(64);
afterEach(() => { for (const id of [OK, NO_LOCAL, EMPTY_TEAM]) unregisterImport(id); });

const LOCAL = 'resource/ui/hud/localplayerdisplay.res';

describe('importProblem: drawing and building a new import once, off screen', () => {
  it('finds nothing wrong with a HUD the editor can show', () => {
    registerImport(OK, sampleHud());
    expect(importProblem(OK)).toBeNull();
  });

  it('names the file when drawing or building throws on something the file checks do not cover', () => {
    registerImport(NO_LOCAL, sampleHud({ [LOCAL]: dropBlock(baseFile('stock', LOCAL), 'LocalPlayer') }));
    expect(importProblem(NO_LOCAL)).toMatch(/^This HUD's resource\/ui\/hud\/localplayerdisplay\.res could not be shown \(/);
  });

  it('also catches an import stored before the file checks existed', () => {
    registerImport(EMPTY_TEAM, sampleHud({ 'resource/ui/hud/teamdisplayhud.res': '// blank\r\n' }));
    expect(importProblem(EMPTY_TEAM)).toMatch(/^This HUD's resource\/ui\/hud\/teamdisplayhud\.res /);
  });

  it('leaves the import registered and readable either way', () => {
    registerImport(NO_LOCAL, sampleHud({ [LOCAL]: dropBlock(baseFile('stock', LOCAL), 'LocalPlayer') }));
    importProblem(NO_LOCAL);
    expect(hasImport(NO_LOCAL)).toBe(true);
    expect(baseFile(`imported:${NO_LOCAL}`, LOCAL)).toBe(dropBlock(baseFile('stock', LOCAL), 'LocalPlayer'));
  });
});
