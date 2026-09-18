import { describe, it, expect } from 'vitest';
import { preloadOrder, shouldPreload } from './preloadLayers';

const layer = (cutHeight: number) => ({ image: `z${cutHeight}.webp`, cutHeight }) as never;

describe('preloadOrder', () => {
  it('fetches the layers nearest the one on screen first', () => {
    const layers = [layer(0), layer(100), layer(150), layer(400)];
    expect(preloadOrder(layers, 'z100.webp')).toEqual(['z150.webp', 'z0.webp', 'z400.webp']);
  });

  it('keeps stack order between two layers equally far away', () => {
    // A tie is a real case (cuts are often evenly spaced) and neither
    // direction is more likely, so the only thing worth guaranteeing is that
    // the order is deterministic rather than whatever the sort happened to do.
    const layers = [layer(0), layer(100), layer(200)];
    expect(preloadOrder(layers, 'z100.webp')).toEqual(['z0.webp', 'z200.webp']);
  });

  it('leaves out the layer already on screen', () => {
    const layers = [layer(0), layer(100)];
    expect(preloadOrder(layers, 'z0.webp')).toEqual(['z100.webp']);
  });

  it('has nothing to do for a single-layer map', () => {
    expect(preloadOrder([layer(0)], 'z0.webp')).toEqual([]);
  });

  it('still returns the stack when the current image is not one of them', () => {
    // A map whose art changed under a viewer holding an old URL: preload the
    // real stack rather than nothing.
    const layers = [layer(0), layer(100)];
    expect(preloadOrder(layers, 'gone.webp').sort()).toEqual(['z0.webp', 'z100.webp']);
  });
});

describe('shouldPreload', () => {
  it('preloads when the browser says nothing about the connection', () => {
    expect(shouldPreload(undefined)).toBe(true);
  });

  it('respects an explicit request to save data', () => {
    expect(shouldPreload({ saveData: true })).toBe(false);
  });

  it('stays off a slow connection, where tens of megabytes is rude', () => {
    expect(shouldPreload({ effectiveType: '2g' })).toBe(false);
    expect(shouldPreload({ effectiveType: 'slow-2g' })).toBe(false);
  });

  it('preloads on a connection that can take it', () => {
    expect(shouldPreload({ effectiveType: '4g' })).toBe(true);
  });
});
