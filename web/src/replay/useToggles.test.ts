import { describe, it, expect } from 'vitest';
import { readToggles, DEFAULT_TOGGLES } from './useToggles';

describe('readToggles', () => {
  it('falls back to the defaults with nothing stored', () => {
    expect(readToggles(null)).toEqual(DEFAULT_TOGGLES);
  });

  it('falls back to the defaults on unparseable storage', () => {
    expect(readToggles('not json')).toEqual(DEFAULT_TOGGLES);
  });

  it('keeps a stored value', () => {
    const raw = JSON.stringify({ ...DEFAULT_TOGGLES, ci: false });
    expect(readToggles(raw).ci).toBe(false);
  });

  // A toggle added in a later release must not leave everyone who has
  // already used the viewer with it undefined, which renders as off with no
  // way to discover it.
  it('fills in a key the stored value predates', () => {
    const raw = JSON.stringify({ hp: false });
    const got = readToggles(raw);
    expect(got.hp).toBe(false);
    expect(got.guns).toBe(DEFAULT_TOGGLES.guns);
    expect(got.entities).toBe(DEFAULT_TOGGLES.entities);
    // names is the newest key: a value stored before it existed has no key
    // for it at all, so this is the exact case the merge exists to cover.
    expect(got.names).toBe(DEFAULT_TOGGLES.names);
  });

  it('defaults names to true', () => {
    expect(DEFAULT_TOGGLES.names).toBe(true);
  });

  it('ignores a stored value that is not an object', () => {
    expect(readToggles('42')).toEqual(DEFAULT_TOGGLES);
    expect(readToggles('null')).toEqual(DEFAULT_TOGGLES);
  });

  it('defaults key off and showKind to all, and merges old storage without them', () => {
    expect(DEFAULT_TOGGLES.key).toBe(false);
    expect(DEFAULT_TOGGLES.showKind).toBe('all');
    expect(readToggles(JSON.stringify({ hp: false }))).toMatchObject({ hp: false, key: false, showKind: 'all' });
  });
});
