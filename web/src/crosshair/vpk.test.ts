import { describe, it, expect } from 'vitest';
import { buildVPK } from './vpk';

describe('buildVPK', () => {
  it('packs the four files the game needs to show a crosshair', () => {
    const out = buildVPK('My Crosshair', 2, 2, new Uint8ClampedArray(16), 'LAYOUT');
    const text = new TextDecoder().decode(out);
    expect(text).toContain('altcrosshair');
    expect(text).toContain('hudlayout');
    expect(text).toContain('addoninfo');
    expect(text).toContain('LAYOUT');
    expect(text).toContain('My Crosshair');
  });

  it('strips quotes from the addon name so the manifest cannot be broken', () => {
    // addoninfo.txt is a KeyValues file: an unescaped quote in the title
    // truncates the block and the addon silently fails to load.
    const out = buildVPK('He said "hi"', 2, 2, new Uint8ClampedArray(16), 'L');
    expect(new TextDecoder().decode(out)).toContain('addontitle\t\t"He said hi"');
  });
});
