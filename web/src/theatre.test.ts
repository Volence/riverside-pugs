import { describe, it, expect, vi } from 'vitest';
import { initialView, loadTheatreManifest, parseManifest, theatreGap, theatreSrc, THEATRE_PAGE } from './theatre';

const manifest = parseManifest({
  format: 'theatre-manifest/1', generated: '2026-11-11T08:00:00Z',
  maps: { l4d_vs_hospital01_apartment: { lit: true, low: true, bytes: 12_000_000 } },
})!;

describe('parseManifest', () => {
  it('reads a manifest and drops malformed entries', () => {
    const m = parseManifest({ format: 'theatre-manifest/1', generated: 'x', maps: { a: { lit: 1, low: 0, bytes: '5' }, b: null } });
    expect(m?.maps).toEqual({ a: { lit: true, low: false, bytes: 5 } });
  });
  it('is null for anything that is not a manifest', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest('<!doctype html>')).toBeNull();
    expect(parseManifest({ format: 'other', maps: {} })).toBeNull();
    expect(parseManifest({ format: 'theatre-manifest/1' })).toBeNull();
  });
});

describe('theatreGap', () => {
  it('needs a demo first', () => {
    expect(theatreGap('l4d_vs_hospital01_apartment', false, manifest)).toBe('no-demo');
  });
  it('is null for a converted map with a demo', () => {
    expect(theatreGap('l4d_vs_hospital01_apartment', true, manifest)).toBeNull();
  });
  it('tells a mirrored map from one not converted yet', () => {
    expect(theatreGap('mc1m3_mall', true, manifest)).toBe('mirror');
    expect(theatreGap('l4d_vs_farm05_cornfield', true, manifest)).toBe('no-map');
  });
});

describe('theatreSrc', () => {
  it('points the viewer at the same-origin demo route, the bookmarks and the map', () => {
    const url = new URL(theatreSrc({ matchId: 1081, ordinal: 0, map: 'l4d_vs_hospital01_apartment' }), 'https://riversidepug.com');
    expect(url.pathname).toBe(THEATRE_PAGE);
    expect(url.searchParams.get('demo')).toBe('/api/matches/1081/demos/0');
    expect(url.searchParams.get('match')).toBe('1081');
    expect(url.searchParams.get('ord')).toBe('0');
    expect(url.searchParams.get('site')).toBe('self');
    expect(url.searchParams.get('map')).toBe('/theatre/map/l4d_vs_hospital01_apartment.glb');
    expect(url.searchParams.has('modelbase')).toBe(false);
  });
  it('moves the models with the assets when they live on another host', () => {
    const url = new URL(theatreSrc({ matchId: 5, ordinal: 2, map: 'c1m1_hotel' }, 'https://assets.riversidepug.com/theatre'), 'https://riversidepug.com');
    expect(url.searchParams.get('map')).toBe('https://assets.riversidepug.com/theatre/map/c1m1_hotel.glb');
    expect(url.searchParams.get('modelbase')).toBe('https://assets.riversidepug.com/theatre/models/out/');
  });
});

describe('initialView', () => {
  it('opens 3D only for a #map-N-3d hash', () => {
    expect(initialView('#map-2-3d')).toBe('3d');
    expect(initialView('#map-2')).toBe('2d');
    expect(initialView('')).toBe('2d');
    expect(initialView('#map--3d')).toBe('2d');
  });
});

describe('loadTheatreManifest', () => {
  it('does not keep a failure, so the next try fetches again', async () => {
    const bad = vi.fn(async () => new Response('nope', { status: 404 }));
    expect(await loadTheatreManifest(bad as unknown as typeof fetch)).toBeNull();
    const good = vi.fn(async () => new Response(JSON.stringify({ format: 'theatre-manifest/1', generated: 'x', maps: {} })));
    expect((await loadTheatreManifest(good as unknown as typeof fetch))?.maps).toEqual({});
    expect(good).toHaveBeenCalledTimes(1);
    // and a success is shared
    await loadTheatreManifest(good as unknown as typeof fetch);
    expect(good).toHaveBeenCalledTimes(1);
  });
});
