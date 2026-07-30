import { describe, it, expect } from 'vitest';
import { newToken, isValidTokenFormat } from '../src/matchToken.js';

describe('matchToken', () => {
  it('generates a 32-char lowercase hex token', () => {
    const t = newToken();
    expect(t).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates distinct tokens', () => {
    const set = new Set(Array.from({ length: 100 }, () => newToken()));
    expect(set.size).toBe(100);
  });

  it('validates token format', () => {
    expect(isValidTokenFormat(newToken())).toBe(true);
    expect(isValidTokenFormat('nope')).toBe(false);
    expect(isValidTokenFormat('ABCDEF0123456789abcdef0123456789')).toBe(false);
    expect(isValidTokenFormat('')).toBe(false);
  });
});
