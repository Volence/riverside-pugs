// @vitest-environment node
// CompressionStream is a Node and browser global; happy-dom does not provide it.
import { describe, it, expect } from 'vitest';
import { DEFAULT_DESIGN, validateDesign, encodeShare, decodeShare, safeName, clampOverride, clampChild, baseTeam } from './design';

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
    // spacing 9999 is first held to its old cap (400), then becomes the gap that keeps that pitch:
    // 400 / scale 2 - Modern's 34-unit column card = 166.
    expect(d.elements.teamColumn).toEqual({ x: 1000, y: -200, scale: 2, dir: 'column', gap: 166 });
  });

  it('rejects colours that are not four bytes', () => {
    const d = validateDesign({ v: 1, elements: { chat: { color: '255 0 0 255', bg: '999 0 0 0' } } });
    expect(d.elements.chat).toEqual({ color: '255 0 0 255' });
  });

  it('drops oversize images', () => {
    const d = validateDesign({ v: 1, images: {
      panelBg: { w: 64, h: 64, png: 'AAAA' },
      incapPanel: { w: 4096, h: 64, png: 'AAAA' },
      deadPanel: { w: 64, h: 64, png: 'A'.repeat(1_500_000) },
    } });
    expect(Object.keys(d.images)).toEqual(['panelBg']);
  });

  it('drops styles and images for slots the editor no longer has', () => {
    const d = validateDesign({ v: 1,
      styles: { barGreen: { kind: 'flat' }, barWhite: { kind: 'flat' }, panelBg: { kind: 'flat' } },
      images: { barRed: { w: 8, h: 8, png: 'AAAA' } } });
    expect(Object.keys(d.styles)).toEqual(['panelBg']);
    expect(d.images).toEqual({});
  });

  it('drops overrides for elements the editor no longer has', () => {
    const d = validateDesign({ v: 1, elements: { killFeed: { visible: false }, chat: { x: 5 } } });
    expect(d.elements).toEqual({ chat: { x: 5 } });
  });

  it('keeps hideGameCrosshair only when it is true', () => {
    expect(validateDesign({ v: 1, hideGameCrosshair: true }).hideGameCrosshair).toBe(true);
    expect('hideGameCrosshair' in validateDesign({ v: 1, hideGameCrosshair: 'yes' })).toBe(false);
    expect('hideGameCrosshair' in validateDesign({ v: 1 })).toBe(false);
  });
});

describe('baseTeam', () => {
  it('reads each preset card, direction and pitch from its own teamdisplayhud.res', () => {
    expect(baseTeam('stock')).toEqual({ dir: 'row', pitch: 140, card: { w: 150, h: 150 } });
    expect(baseTeam('modern')).toEqual({ dir: 'column', pitch: 34, card: { w: 120, h: 34 } });
  });
});

describe('validateDesign, the teammate layout', () => {
  const team = (preset: 'stock' | 'modern', o: Record<string, unknown>) =>
    validateDesign({ v: 1, preset, elements: { teamColumn: o } }).elements.teamColumn;

  it('migrates a saved spacing to the gap that keeps the same pitch', () => {
    // gap = spacing / scale - the unfitted card along the direction.
    expect(team('stock', { dir: 'column', spacing: 180 })).toEqual({ dir: 'column', gap: 30 });
    expect(team('modern', { spacing: 40 })).toEqual({ gap: 6 });                            // Modern's own column, card 34 tall
    expect(team('modern', { dir: 'row', spacing: 130 })).toEqual({ dir: 'row', gap: 10 });  // card 120 wide
    expect(team('modern', { dir: 'column', spacing: 45, scale: 1.25 })).toEqual({ dir: 'column', scale: 1.25, gap: 2 });
  });

  it('fits an old design whose unfitted cards overlapped, and keeps its pitch with the fitted card', () => {
    // Stock column at 40: the 150-tall card overlapped, the 36-tall fitted one leaves 4.
    expect(team('stock', { dir: 'column', spacing: 40 })).toEqual({ dir: 'column', fit: true, gap: 4 });
    // Stock's own row at 140: 150 wide overlapped, 121 fitted leaves 19.
    expect(team('stock', { dir: 'row', spacing: 140 })).toEqual({ dir: 'row', fit: true, gap: 19 });
    // Tighter than even the fitted card: fitted, then clamped at 0.
    expect(team('stock', { dir: 'column', spacing: 20 })).toEqual({ dir: 'column', fit: true, gap: 0 });
  });

  it('keeps the pitch of a saved spacing that was already fitted, and never overrides fit off', () => {
    expect(team('stock', { dir: 'column', fit: true, spacing: 60 })).toEqual({ dir: 'column', fit: true, gap: 24 });
    expect(team('stock', { dir: 'column', fit: false, spacing: 40 })).toEqual({ dir: 'column', fit: false, gap: 0 });
  });

  it('keeps a stored gap over a stale spacing, and clamps it to 0..200', () => {
    expect(team('stock', { gap: 12, spacing: 400 })).toEqual({ gap: 12 });
    expect(team('stock', { gap: 500 })).toEqual({ gap: 200 });
    expect(team('stock', { gap: -5 })).toEqual({ gap: 0 });
  });

  it('keeps the infected row spacing as it is, and never gives it a gap, fit or slots', () => {
    const d = validateDesign({ v: 1, elements: { infectedRow: { spacing: 124, gap: 5, fit: true, slots: [] } } });
    expect(d.elements.infectedRow).toEqual({ spacing: 124 });
  });

  it('leaves fit off when a saved design has none, while a new design starts fitted', () => {
    expect(validateDesign({ v: 1 }).elements).toEqual({});
    expect(validateDesign({ v: 1, elements: { chat: { x: 5 } } }).elements.teamColumn).toBeUndefined();
    expect(DEFAULT_DESIGN.elements.teamColumn).toEqual({ fit: true });
    expect(validateDesign(null).elements.teamColumn).toEqual({ fit: true });
    expect(team('stock', { fit: false })).toEqual({ fit: false });
    expect(team('stock', { fit: 'yes' })).toBeUndefined();
  });

  it('clamps slots like element positions, and drops any set that is not four finite points', () => {
    const four = [{ x: 5000, y: -900 }, { x: 8, y: 100 }, { x: 8, y: 150 }, { x: 700, y: 100 }];
    expect(team('stock', { dir: 'free', slots: four })).toEqual({
      dir: 'free', slots: [{ x: 1000, y: -200 }, { x: 8, y: 100 }, { x: 8, y: 150 }, { x: 700, y: 100 }],
    });
    expect(team('stock', { dir: 'free', slots: four.slice(0, 3) })).toBeUndefined();
    expect(team('stock', { slots: [...four.slice(0, 3), { x: NaN, y: 1 }] })).toBeUndefined();
    // Row with slots stored keeps them, so switching back to Free restores the cards.
    expect(team('stock', { dir: 'row', slots: four })!.slots).toHaveLength(4);
  });

  it('keeps Free only on the survivor team', () => {
    expect(validateDesign({ v: 1, elements: { chat: { dir: 'free' } } }).elements.chat).toBeUndefined();
  });
});

describe('clampOverride', () => {
  // The editor's number boxes call this directly so a typed value snaps to
  // the same cap validateDesign would clamp it to on load: the canvas and
  // the downloaded file must never disagree about what a value became.
  it('clamps to the same RANGES bounds validateDesign uses, and leaves an in-range value alone', () => {
    expect(clampOverride('spacing', 500)).toBe(400);
    expect(clampOverride('spacing', -50)).toBe(0);
    expect(clampOverride('spacing', 120)).toBe(120);
  });
});

describe('validateDesign, the teammate card children', () => {
  const kids = (raw: unknown) => validateDesign({ v: 1, children: raw }).children;

  it('keeps only the teammate card, only registry children, and clamps their numbers', () => {
    expect(kids({ ownHealth: { Head: { x: 1 } } })).toEqual({});
    expect(kids({ teamColumn: { Nope: { x: 1 }, Head: { x: 9999, y: -9999, junk: 1 } } }))
      .toEqual({ teamColumn: { Head: { x: 512, y: -64 } } });
  });

  it('drops each field the child does not offer', () => {
    const got = kids({ teamColumn: {
      Name: { color: '10 20 30 255', fontSize: 99, on: true },
      HealthNumber: { color: '10 20 30 255', on: true, fontSize: 14 },
      Head: { fontSize: 20, color: '1 2 3 4' },
      Items: { w: 90, h: 9, fontSize: 22, y: 20 },
      BackgroundImage: { x: 5, visible: false },
    } }).teamColumn;
    expect(got).toEqual({
      Name: { color: '10 20 30 255', fontSize: 64 },
      HealthNumber: { on: true, fontSize: 14 },
      Items: { fontSize: 22, y: 20 },
      BackgroundImage: { visible: false },
    });
  });

  it('stores square art with both sides equal, the smaller winning', () => {
    expect(kids({ teamColumn: { Head: { w: 30, h: 20 } } }).teamColumn!.Head).toEqual({ w: 20, h: 20 });
    expect(kids({ teamColumn: { Dead: { w: 30 } } }).teamColumn!.Dead).toEqual({ w: 30, h: 30 });
    expect(kids({ teamColumn: { Health: { w: 30, h: 5 } } }).teamColumn!.Health).toEqual({ w: 30, h: 5 });
  });

  it('starts a new design with no children', () => {
    expect(DEFAULT_DESIGN.children).toEqual({});
    expect(validateDesign({ v: 1 }).children).toEqual({});
  });
});

describe('clampChild', () => {
  it('clamps child numbers to their own ranges', () => {
    expect(clampChild('x', 9999)).toBe(512);
    expect(clampChild('y', -100)).toBe(-64);
    expect(clampChild('w', 0)).toBe(1);
    expect(clampChild('fontSize', 99)).toBe(64);
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

  it('carries the teammate card children through a share link', async () => {
    const d = validateDesign({ v: 1, children: { teamColumn: { HealthNumber: { on: true }, Items: { y: 20 } } } });
    expect((await decodeShare(await encodeShare(d)))!.children).toEqual(d.children);
  });
});
