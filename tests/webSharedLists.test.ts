import { describe, it, expect } from 'vitest';
import { PLATFORM_KEYS } from '../src/profileFields.js';
import { COUNTRY_CODES } from '../src/countries.js';
import { WEB_PLATFORMS } from '../web/src/socialPlatforms.js';
import { WEB_COUNTRY_CODES } from '../web/src/countries.js';

/**
 * web/ cannot import from src/, so two small lists are duplicated. These tests
 * are what stop the copies drifting: a platform added on one side and not the
 * other is a field the player can fill in and the server then refuses, with no
 * message that explains why.
 */
describe('web and server platform lists', () => {
  it('agree on which platforms exist, and in what order', () => {
    expect(WEB_PLATFORMS.map((p) => p.key)).toEqual([...PLATFORM_KEYS]);
  });

  it('the web copy carries no patterns and no url builders', () => {
    // The server is the only thing that validates a handle and the only thing
    // that builds a URL. A second answer to either question is how the two
    // drift into disagreeing about what is safe.
    for (const p of WEB_PLATFORMS) {
      expect(Object.keys(p).sort()).toEqual(['key', 'label', 'placeholder']);
    }
  });
});

describe('web and server country lists', () => {
  it('agree exactly', () => {
    expect([...WEB_COUNTRY_CODES]).toEqual([...COUNTRY_CODES]);
  });
});
