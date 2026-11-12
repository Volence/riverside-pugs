import { describe, it, expect } from 'vitest';
import { findSteamIds, theatreContentType, theatreForbidden, theatreKey } from '../src/theatreAssets.js';

describe('theatreKey', () => {
  it('puts a file under its version folder', () => {
    expect(theatreKey('85b5d89e3f12', 'map/l4d_vs_hospital01_apartment.lit.glb'))
      .toBe('theatre/85b5d89e3f12/map/l4d_vs_hospital01_apartment.lit.glb');
    expect(theatreKey('v', 'sound\\out\\a\\x.ogg')).toBe('theatre/v/sound/out/a/x.ogg');
  });
});

describe('theatreContentType', () => {
  it('knows every type the heavy set holds', () => {
    expect(theatreContentType('map/a.lit.glb')).toBe('model/gltf-binary');
    expect(theatreContentType('sound/out/a/1.ogg')).toBe('audio/ogg');
    expect(theatreContentType('models/out/fx/smoke.webp')).toBe('image/webp');
    expect(theatreContentType('map/a.lightmap.png')).toBe('image/png');
    expect(theatreContentType('map/a.proplight.bin')).toBe('application/octet-stream');
    expect(theatreContentType('manifest.json')).toBe('application/json');
  });
  it('takes every sky file the viewer fetches (viewer/sky.js)', () => {
    expect(theatreContentType('map/a.sky.json')).toBe('application/json');
    expect(theatreContentType('map/a.sky.webp')).toBe('image/webp');
    expect(theatreContentType('map/a.sky.low.webp')).toBe('image/webp');
    expect(theatreContentType('map/a.sky.glb')).toBe('model/gltf-binary');
    expect(theatreContentType('map/a.sky.low.glb')).toBe('model/gltf-binary');
    expect(theatreContentType('map/a.sky.lightmap.png')).toBe('image/png');
  });
  it('refuses anything else', () => {
    expect(theatreContentType('viewer/index.html')).toBeNull();
    expect(theatreContentType('a.dem')).toBeNull();
    expect(theatreContentType('README')).toBeNull();
  });
});

describe('theatreForbidden', () => {
  it('keeps backups, logs, bookmark files and parser samples out', () => {
    expect(theatreForbidden('models/out/before-attacks/hunter.glb')).toBe(true);
    expect(theatreForbidden('models/out/hunter.before-touch3.glb')).toBe(true);
    expect(theatreForbidden('bookmarks/match-1081.json')).toBe(true);
    expect(theatreForbidden('sample-hospital01.json')).toBe(true);
    expect(theatreForbidden('map/a.lit.log')).toBe(true);
    expect(theatreForbidden('map/a.lit.stats.json')).toBe(true);
    expect(theatreForbidden('map/a.sky.stats.json')).toBe(true);
    expect(theatreForbidden('map/a.sky.json')).toBe(false);
    expect(theatreForbidden('map/a.lit.glb')).toBe(false);
    expect(theatreForbidden('map/a.dynamic.json')).toBe(false);
  });
});

describe('findSteamIds', () => {
  it('finds each SteamID form once, and not the SteamID64 base constant', () => {
    expect(findSteamIds('{"sid":"76561198012345678","x":"76561198012345678"}')).toEqual(['76561198012345678']);
    expect(findSteamIds('<ID:STEAM_1:0:12345678> [U:1:24691357]')).toEqual(['STEAM_1:0:12345678', '[U:1:24691357]']);
    expect(findSteamIds('const BASE = 76561197960265728n; // e.g. STEAM_1:1:123')).toEqual([]);
  });
});
