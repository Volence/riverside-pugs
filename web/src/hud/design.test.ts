// @vitest-environment node
// CompressionStream is a Node and browser global; happy-dom does not provide it.
import { describe, it, expect } from 'vitest';
import { DEFAULT_DESIGN, validateDesign, encodeShare, decodeShare, safeName } from './design';

describe('validateDesign', () => {
  it('returns the defaults for junk', () => {
    expect(validateDesign(null)).toEqual(DEFAULT_DESIGN);
    expect(validateDesign('x')).toEqual(DEFAULT_DESIGN);
    expect(validateDesign({ v: 99 })).toEqual(DEFAULT_DESIGN);
  });

  it('clamps numbers and drops unknown keys', () => {
    const d = validateDesign({
      v: 1, preset: 'modern', evil: 1,
      elements: { teamColumn: { x: 99999, y: -99999, scale: 50, junk: true, dir: 'column', spacing: 9999 } },
    });
    expect(d.preset).toBe('modern');
    expect((d as unknown as Record<string, unknown>).evil).toBeUndefined();
    expect(d.elements.teamColumn).toEqual({ x: 1000, y: -200, scale: 2, dir: 'column', spacing: 400 });
  });

  it('rejects colours that are not four bytes', () => {
    const d = validateDesign({ v: 1, elements: { chat: { color: '255 0 0 255', bg: '999 0 0 0' } } });
    expect(d.elements.chat).toEqual({ color: '255 0 0 255' });
  });

  it('drops oversize images', () => {
    const d = validateDesign({ v: 1, images: {
      ok: { w: 64, h: 64, png: 'AAAA' },
      wide: { w: 4096, h: 64, png: 'AAAA' },
      heavy: { w: 64, h: 64, png: 'A'.repeat(1_500_000) },
    } });
    expect(Object.keys(d.images)).toEqual(['ok']);
  });
});

describe('safeName', () => {
  it('keeps a file-safe subset and never returns empty', () => {
    expect(safeName('my "cool" hud!!')).toBe('my cool hud');
    expect(safeName('///')).toBe('my_hud');
  });
});

describe('share links', () => {
  it('round-trips a design without its images', async () => {
    const d = validateDesign({ v: 1, preset: 'modern', elements: { chat: { x: 134, y: 320 } },
      images: { panelBg: { w: 8, h: 8, png: 'AAAA' } } });
    const s = await encodeShare(d);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = await decodeShare(s);
    expect(back).toEqual({ ...d, images: {} });
  });

  it('returns null for a damaged link', async () => {
    expect(await decodeShare('not-a-design')).toBeNull();
  });
});
