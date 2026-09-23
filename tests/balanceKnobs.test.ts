import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadBalanceKnobs, renderBalanceListInc, BALANCE_KNOBS_PATH } from '../src/balanceKnobs.js';

describe('balance knobs', () => {
  it('loads and validates the checked-in list', () => {
    const k = loadBalanceKnobs(BALANCE_KNOBS_PATH);
    expect(k.cvars.length).toBeGreaterThan(10);
    expect(k.cvars.every((c) => /^[a-z0-9_]{1,63}$/.test(c.cvar))).toBe(true);
    expect(new Set(k.cvars.map((c) => c.cvar)).size).toBe(k.cvars.length);
  });

  it('rejects a path with a space or a leading slash', () => {
    const bad = { cvars: [], files: [{ path: '/etc/passwd', label: 'x' }], dirs: [], versionless: [] };
    expect(() => loadBalanceKnobs(undefined, bad)).toThrow(/path/);
  });

  it('rejects a knobs file missing the versionless array', () => {
    const bad = { cvars: [], files: [], dirs: [] };
    expect(() => loadBalanceKnobs(undefined, bad)).toThrow(/versionless/);
  });

  it('the checked-in plugin include matches knobs.json', () => {
    const k = loadBalanceKnobs(BALANCE_KNOBS_PATH);
    const onDisk = readFileSync(new URL('../plugin/pug-balance-list.inc', import.meta.url), 'utf8');
    expect(onDisk).toBe(renderBalanceListInc(k));
  });
});
