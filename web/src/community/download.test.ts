import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../hud/build', async (orig) => {
  const real = await orig<typeof import('../hud/build')>();
  return { ...real, packHud: vi.fn(() => ({ filename: 'Edge HUD.vpk', mime: 'application/octet-stream', bytes: new Uint8Array([1]) })) };
});
vi.mock('../hud/assets', () => ({ assetsFor: vi.fn(async () => ({})) }));
vi.mock('./open', async (orig) => {
  const real = await orig<typeof import('./open')>();
  return { ...real, openCommunityImport: vi.fn(async () => ({ id: 'x', name: 'x', kept: true })) };
});

import { downloadCommunityHud, downloadCommunityCrosshair } from './download';
import { packHud } from '../hud/build';
import { openCommunityImport, SAFETY_FAILED } from './open';
import { validateDesign } from '../hud/design';
import { readVPK } from '../vpk/read';
import { TEX } from '../crosshair/draw';
import type { CommunityEntryDetail } from '../api';

const base = { kind: 'hud' as const, description: '', author: { steamid: '1', name: 'a', avatar: null }, likes: 0, likedByMe: false, createdAt: '' };
const ID = 'b'.repeat(64);

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('downloadCommunityHud', () => {
  it('builds a Modern entry from its validated design, named by the title', async () => {
    const raw = { v: 1, name: 'whatever', preset: 'modern', aspect: '16:10', elements: { ammo: { x: 1e9 } } };
    const entry: CommunityEntryDetail = { ...base, id: 3, title: 'Edge <HUD>', design: raw };
    const out = await downloadCommunityHud(entry);
    expect(out.filename).toBe('Edge HUD.vpk');
    expect(openCommunityImport).not.toHaveBeenCalled();
    const built = vi.mocked(packHud).mock.calls[0][0];
    expect(built).toEqual(validateDesign({ ...raw, name: 'Edge HUD' }));
  });

  it('opens the import first on an imported entry', async () => {
    const raw = { v: 1, name: 'x', preset: 'imported', imported: { id: ID, name: 'edge' } };
    const entry: CommunityEntryDetail = { ...base, id: 4, title: 'Edge', design: raw, importId: ID };
    await downloadCommunityHud(entry);
    expect(openCommunityImport).toHaveBeenCalledWith(entry);
    expect(vi.mocked(openCommunityImport).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(packHud).mock.invocationCallOrder[0]);
  });

  it("refuses a design naming an import other than the entry's", async () => {
    const raw = { v: 1, name: 'x', preset: 'imported', imported: { id: ID, name: 'edge' } };
    const entry: CommunityEntryDetail = { ...base, id: 4, title: 'Edge', design: raw, importId: 'c'.repeat(64) };
    await expect(downloadCommunityHud(entry)).rejects.toThrow(SAFETY_FAILED);
    expect(packHud).not.toHaveBeenCalled();
  });
});

describe('downloadCommunityCrosshair', () => {
  it("returns the Crosshair page's own addon files", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({}, {
      get: (_t, k) => (..._a: unknown[]) => (k === 'getImageData' ? { data: new Uint8ClampedArray(TEX * TEX * 4) } : undefined),
      set: () => true,
    }) as never);
    const out = await downloadCommunityCrosshair({ title: 'Tiny dot', art: { kind: 'built', state: { shape: 'dot' } } });
    expect(out.filename).toBe('Tiny_dot.vpk');
    expect([...readVPK(out.bytes).keys()].sort()).toEqual([
      'addoninfo.txt', 'materials/vgui/hud/altcrosshair.vmt', 'materials/vgui/hud/altcrosshair.vtf', 'scripts/hudlayout.res',
    ]);
  });

  it('refuses art that is not a crosshair', async () => {
    await expect(downloadCommunityCrosshair({ title: 'x', art: { kind: 'built', state: { shape: 'nope' } } }))
      .rejects.toThrow('This crosshair cannot be drawn.');
  });
});
