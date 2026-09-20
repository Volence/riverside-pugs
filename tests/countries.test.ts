import { describe, it, expect } from 'vitest';
import { COUNTRY_CODES, countryFlag, countryName, isCountryCode } from '../src/countries.js';

describe('countries', () => {
  it('holds the whole ISO 3166-1 alpha-2 set', () => {
    expect(COUNTRY_CODES.length).toBeGreaterThan(240);
    expect(COUNTRY_CODES).toContain('US');
    expect(COUNTRY_CODES).toContain('GB');
    expect(COUNTRY_CODES).toContain('BR');
  });

  it('every code is two uppercase letters and unique', () => {
    for (const c of COUNTRY_CODES) expect(c).toMatch(/^[A-Z]{2}$/);
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
  });

  it('accepts a real code in any case and rejects anything else', () => {
    expect(isCountryCode('us')).toBe(true);
    expect(isCountryCode('US')).toBe(true);
    expect(isCountryCode('ZZ')).toBe(false);
    expect(isCountryCode('USA')).toBe(false);
    expect(isCountryCode('')).toBe(false);
    expect(isCountryCode('<script>')).toBe(false);
  });

  it('names a country, falling back to the code', () => {
    expect(countryName('US')).toBe('United States');
    // Never throws and never returns empty, whatever ICU has available.
    for (const c of COUNTRY_CODES) expect(countryName(c).length).toBeGreaterThan(0);
  });

  it('renders a flag from regional indicators', () => {
    expect(countryFlag('US')).toBe('\u{1F1FA}\u{1F1F8}');
    expect(countryFlag('GB')).toBe('\u{1F1EC}\u{1F1E7}');
    expect(countryFlag('ZZ')).toBe('');
  });
});
