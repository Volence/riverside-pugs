import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  deviceView, hashView, loadTheatreManifest, parseManifest, storeView, storedView, theatreAssets, theatreGap,
  theatreSrc, THEATRE_ASSET_HOST, THEATRE_PAGE,
} from './theatre';

const raw = {
  format: 'theatre-manifest/2', version: '85b5d89e3f12', generated: '2026-11-11T08:00:00Z',
  viewer: { mirrors: false },
  maps: {
    l4d_vs_hospital01_apartment: { lit: true, low: true, bytes: 12_000_000 },
    l4d_vs_mhospital01_apartment: { lit: true, low: true, bytes: 12_000_000, mirror_of: 'l4d_vs_hospital01_apartment' },
    l4d_vs_mfarm01_hilltop: { lit: true, low: true, bytes: 9_000_000, mirror_of: 'l4d_vs_farm01_hilltop' },
  },
};
const manifest = parseManifest(raw)!;

describe('parseManifest', () => {
  it('reads a manifest and drops malformed entries', () => {
    const m = parseManifest({ format: 'theatre-manifest/2', version: 'abc', generated: 'x', maps: { a: { lit: 1, low: 0, bytes: '5' }, b: null } });
    expect(m?.maps).toEqual({ a: { lit: true, low: false, bytes: 5 } });
    expect(m?.mirrors).toBe(false);
  });
  it('keeps the version, the mirror originals and whether the viewer draws mirrors', () => {
    expect(manifest.version).toBe('85b5d89e3f12');
    expect(manifest.maps.l4d_vs_mhospital01_apartment.mirrorOf).toBe('l4d_vs_hospital01_apartment');
    expect(parseManifest({ ...raw, viewer: { mirrors: true } })?.mirrors).toBe(true);
  });
  it('is null for anything that is not a manifest', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest('<!doctype html>')).toBeNull();
    expect(parseManifest({ format: 'other', version: 'a', maps: {} })).toBeNull();
    expect(parseManifest({ format: 'theatre-manifest/2', version: 'a' })).toBeNull();
    // the old unversioned format, and a version that would break out of its folder
    expect(parseManifest({ format: 'theatre-manifest/1', maps: {} })).toBeNull();
    expect(parseManifest({ ...raw, version: '../x' })).toBeNull();
  });
});

describe('theatreGap', () => {
  it('needs a demo first', () => {
    expect(theatreGap('l4d_vs_hospital01_apartment', false, manifest)).toBe('no-demo');
  });
  it('is null for a converted map with a demo', () => {
    expect(theatreGap('l4d_vs_hospital01_apartment', true, manifest)).toBeNull();
  });
  it('reads mirrors from the manifest, not from a list of names', () => {
    // listed as a mirror, but this viewer cannot draw mirrors yet
    expect(theatreGap('l4d_vs_mhospital01_apartment', true, manifest)).toBe('mirror');
    // a mirror-looking name the manifest does not list is simply not converted
    expect(theatreGap('mc1m3_mall', true, manifest)).toBe('no-map');
    expect(theatreGap('l4d_vs_farm05_cornfield', true, manifest)).toBe('no-map');
    // once the viewer draws mirrors: playable when the original is there too
    const later = parseManifest({ ...raw, viewer: { mirrors: true } })!;
    expect(theatreGap('l4d_vs_mhospital01_apartment', true, later)).toBeNull();
    expect(theatreGap('l4d_vs_mfarm01_hilltop', true, later)).toBe('mirror');
  });
});

describe('theatreSrc', () => {
  const assets = 'https://assets.riversidepug.com/theatre/85b5d89e3f12/';
  it('passes the embed parameters the viewer documents', () => {
    const url = new URL(theatreSrc({ matchId: 1081, ordinal: 0, map: 'l4d_vs_hospital01_apartment' }, assets), 'https://riversidepug.com');
    expect(url.origin).toBe('https://riversidepug.com');
    expect(url.pathname).toBe(THEATRE_PAGE);
    expect(url.searchParams.get('embed')).toBe('1');
    expect(url.searchParams.get('site')).toBe('self');
    expect(url.searchParams.get('match')).toBe('1081');
    expect(url.searchParams.get('ord')).toBe('0');
    expect(url.searchParams.get('demo')).toBe('/api/matches/1081/demos/0');
    expect(url.searchParams.get('assets')).toBe(assets);
    expect(url.searchParams.get('ambbase')).toBe(`${assets}light/`);
    expect(url.searchParams.get('map')).toBe(`${assets}map/l4d_vs_hospital01_apartment.glb`);
    expect(url.searchParams.has('modelbase')).toBe(false);
  });
  it('leaves a mirror map to the viewer, which loads its original', () => {
    const url = new URL(theatreSrc({ matchId: 5, ordinal: 2, map: 'l4d_vs_mhospital01_apartment', mirror: true }, assets), 'https://riversidepug.com');
    expect(url.searchParams.has('map')).toBe(false);
    expect(url.searchParams.get('assets')).toBe(assets);
  });
});

describe('theatreAssets', () => {
  it('is the version folder under the asset host', () => {
    expect(theatreAssets('abc', 'https://assets.riversidepug.com/theatre/')).toBe('https://assets.riversidepug.com/theatre/abc/');
    expect(theatreAssets('abc', '/theatre')).toBe('/theatre/abc/');
  });
  it('is this site in development and tests', () => {
    expect(THEATRE_ASSET_HOST).toBe('/theatre/');
  });
});

describe('hashView', () => {
  it('asks for 3D only on a #map-N-3d hash', () => {
    expect(hashView('#map-2-3d')).toBe('3d');
    expect(hashView('#map-2')).toBeNull();
    expect(hashView('')).toBeNull();
    expect(hashView('#map--3d')).toBeNull();
  });
});

describe('deviceView', () => {
  it('starts on 3D with hardware WebGL2', () => {
    expect(deviceView({ webgl2: true, renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 Ti Direct3D11 vs_5_0 ps_5_0)' })).toBe('3d');
    expect(deviceView({ webgl2: true, renderer: 'Apple GPU' })).toBe('3d');
    expect(deviceView({ webgl2: true, renderer: null })).toBe('3d');
  });
  it('starts on 2D on a phone, without WebGL2, or on a software renderer', () => {
    expect(deviceView({ phone: true, webgl2: true, renderer: 'Adreno (TM) 740' })).toBe('2d');
    expect(deviceView({ webgl2: false })).toBe('2d');
    expect(deviceView({ webgl2: true, renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)' })).toBe('2d');
    expect(deviceView({ webgl2: true, renderer: 'llvmpipe (LLVM 17.0.6, 256 bits)' })).toBe('2d');
    expect(deviceView({ webgl2: true, renderer: 'Microsoft Basic Render Driver' })).toBe('2d');
  });
});

describe('storedView', () => {
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
  it('remembers the pick per browser', () => {
    expect(storedView()).toBeNull();
    storeView('2d');
    expect(storedView()).toBe('2d');
    storeView('3d');
    expect(storedView()).toBe('3d');
  });
  it('survives a browser that refuses storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(() => storeView('3d')).not.toThrow();
    expect(storedView()).toBeNull();
  });
});

describe('loadTheatreManifest', () => {
  it('does not keep a failure, so the next try fetches again', async () => {
    const bad = vi.fn(async () => new Response('nope', { status: 404 }));
    expect(await loadTheatreManifest(bad as unknown as typeof fetch)).toBeNull();
    const good = vi.fn(async () => new Response(JSON.stringify({ ...raw, maps: {} })));
    expect((await loadTheatreManifest(good as unknown as typeof fetch))?.maps).toEqual({});
    expect(good).toHaveBeenCalledTimes(1);
    // and a success is shared
    await loadTheatreManifest(good as unknown as typeof fetch);
    expect(good).toHaveBeenCalledTimes(1);
  });
});
