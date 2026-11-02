import { describe, it, expect } from 'vitest';
import { MAP_THUMBS, MAP_THUMB_BASE, mapThumb } from '../../src/mapThumbs';
import { OVERVIEWS } from '../../src/mapOverviews';

describe('map thumbnails', () => {
  it('has a picture for every map with an overview, and only those', () => {
    expect(Object.keys(MAP_THUMBS).sort()).toEqual(Object.keys(OVERVIEWS).sort());
  });

  it('builds the URL beside the overview layers, or null for an unknown map', () => {
    const map = Object.keys(MAP_THUMBS)[0]!;
    expect(mapThumb(map, 640)).toBe(`${MAP_THUMB_BASE}/${map}.thumb640.webp`);
    expect(mapThumb('not_a_map', 1280)).toBeNull();
    expect(MAP_THUMBS[map]).toBeGreaterThan(0);
  });
});
