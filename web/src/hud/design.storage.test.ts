// design.test.ts runs under node for CompressionStream, and node has no
// localStorage, so the storage tests run here under happy-dom.
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_DESIGN, saveDesign } from './design';

describe('saveDesign', () => {
  it('says whether the browser kept the design', () => {
    expect(saveDesign(structuredClone(DEFAULT_DESIGN))).toBe(true);
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    try { expect(saveDesign(structuredClone(DEFAULT_DESIGN))).toBe(false); } finally { spy.mockRestore(); }
  });
});
