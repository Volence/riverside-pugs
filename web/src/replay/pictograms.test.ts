import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PICTOGRAMS, pictogramFor, pictogramPath, resetPictogramCache } from './pictograms';

/** happy-dom has no Path2D. The stub records the path data it was built from
 *  so a test can prove the right figure was requested. */
class FakePath2D { constructor(public d: string) {} }

describe('pictograms', () => {
  beforeEach(() => { (globalThis as any).Path2D = FakePath2D; resetPictogramCache(); });
  afterEach(() => { delete (globalThis as any).Path2D; resetPictogramCache(); });

  it('has a figure for every special class and the witch', () => {
    for (const name of ['smoker', 'boomer', 'hunter', 'tank', 'witch'] as const) {
      expect(PICTOGRAMS[name]).toMatch(/^M/);
    }
  });

  it('maps the zombie class byte to a figure, and unknown classes to null', () => {
    expect(pictogramFor(1)).toBe('smoker');
    expect(pictogramFor(2)).toBe('boomer');
    expect(pictogramFor(3)).toBe('hunter');
    expect(pictogramFor(5)).toBe('tank');
    expect(pictogramFor(4)).toBe('witch');
    expect(pictogramFor(0)).toBeNull();
    expect(pictogramFor(99)).toBeNull();
  });

  it('builds each Path2D once and hands back the same object', () => {
    const a = pictogramPath('hunter') as unknown as FakePath2D;
    const b = pictogramPath('hunter') as unknown as FakePath2D;
    expect(a).toBe(b);
    expect(a.d).toBe(PICTOGRAMS.hunter);
  });

  it('is null for an unknown name', () => {
    expect(pictogramPath('charger')).toBeNull();
  });

  it('is null when the environment has no Path2D, rather than throwing', () => {
    delete (globalThis as any).Path2D;
    resetPictogramCache();
    expect(pictogramPath('tank')).toBeNull();
  });
});
