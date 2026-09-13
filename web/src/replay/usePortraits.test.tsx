import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { usePortraits } from './usePortraits';

/** A stand-in for the DOM `Image` that never actually loads anything: it
 *  just exposes `onload`/`onerror`/`src` and remembers every instance so a
 *  test can fire the callback itself and inspect what was assigned. */
class StubImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  static instances: StubImage[] = [];
  constructor() {
    StubImage.instances.push(this);
  }
}

describe('usePortraits', () => {
  let realImage: typeof Image;

  beforeEach(() => {
    realImage = globalThis.Image;
    StubImage.instances = [];
    (globalThis as unknown as { Image: unknown }).Image = StubImage;
  });

  afterEach(() => {
    (globalThis as unknown as { Image: unknown }).Image = realImage;
  });

  it('returns a new map object, containing the loaded url, once an image finishes loading', () => {
    const { result } = renderHook(() => usePortraits());
    const before = result.current;
    expect(before).toEqual({});

    const img = StubImage.instances[0];
    expect(img).toBeTruthy();
    act(() => {
      img.onload?.();
    });

    const after = result.current;
    // A fresh object identity, not the same one mutated in place: the
    // canvas repaints on prop identity, so a mutated map would never
    // trigger the redraw that puts the newly-loaded face on screen.
    expect(after).not.toBe(before);
    expect(after[img.src]).toBe(img);
  });

  it('does not throw or warn when an image loads after the hook has unmounted', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() => usePortraits());
    const img = StubImage.instances[0];
    unmount();

    expect(() => {
      act(() => {
        img.onload?.();
      });
    }).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
