import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { getSetting, setSetting } from '../src/settings.js';
import { validateSetting } from '../src/settingsSchema.js';
import { DEFAULT_RESET_MAP, resetMap, abortCommand, problemText } from '../src/matchTeardown.js';

const TOKEN = 'a'.repeat(32);

describe('reset_map setting', () => {
  it('is seeded with the stock default', () => {
    const db = openDb(':memory:');
    expect(getSetting(db, 'reset_map')).toBe(DEFAULT_RESET_MAP);
    expect(DEFAULT_RESET_MAP).toBe('l4d_hospital01_apartment');
  });

  it('is editable through the schema and cannot be blank', () => {
    expect(validateSetting('reset_map', 'l4d_vs_farm01_hilltop')).toEqual({ ok: true, value: 'l4d_vs_farm01_hilltop' });
    expect(validateSetting('reset_map', '')).toEqual({ ok: false, error: 'cannot be empty' });
  });

  it('agrees with resetMap at the length boundary', () => {
    const db = openDb(':memory:');
    const ok63 = 'a'.repeat(63);
    const too64 = 'a'.repeat(64);
    expect(validateSetting('reset_map', ok63)).toEqual({ ok: true, value: ok63 });
    expect(validateSetting('reset_map', too64).ok).toBe(false);
    setSetting(db, 'reset_map', ok63);
    expect(resetMap(db)).toBe(ok63);
  });
});

describe('resetMap', () => {
  it('returns the setting', () => {
    const db = openDb(':memory:');
    setSetting(db, 'reset_map', 'l4d_airport01_greenhouse');
    expect(resetMap(db)).toBe('l4d_airport01_greenhouse');
  });

  it('falls back rather than sending garbage to the console', () => {
    const db = openDb(':memory:');
    setSetting(db, 'reset_map', 'x; rcon_password pwned');
    expect(resetMap(db)).toBe(DEFAULT_RESET_MAP);
    setSetting(db, 'reset_map', '');
    expect(resetMap(db)).toBe(DEFAULT_RESET_MAP);
    // Linux map files are case-sensitive, so a mixed-case value must fall
    // back too rather than reach changelevel and fail there.
    setSetting(db, 'reset_map', 'L4d_Hospital01_Apartment');
    expect(resetMap(db)).toBe(DEFAULT_RESET_MAP);
  });
});

describe('abortCommand', () => {
  it('is the plain abort without teardown', () => {
    expect(abortCommand(TOKEN, false, 'l4d_hospital01_apartment')).toBe(`sm_pug_abort ${TOKEN}`);
  });
  it('carries the map with teardown', () => {
    expect(abortCommand(TOKEN, true, 'l4d_hospital01_apartment')).toBe(`sm_pug_abort ${TOKEN} teardown l4d_hospital01_apartment`);
  });
  it('validates the map only when teardown actually sends it', () => {
    expect(() => abortCommand(TOKEN, true, 'x; sv_cheats 1')).toThrow(/invalid reset map/);
    expect(abortCommand(TOKEN, false, 'x; sv_cheats 1')).toBe(`sm_pug_abort ${TOKEN}`);
  });
});

describe('problemText', () => {
  it('explains the unpause timeout and names the match', () => {
    expect(problemText('unpause_timeout', 42)).toMatch(/match #42/);
    expect(problemText('unpause_timeout', 42)).toMatch(/did not unpause/);
  });
  it('still says something for a code it does not know', () => {
    expect(problemText('mystery', null)).toMatch(/mystery/);
  });
});
