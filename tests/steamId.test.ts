import { describe, it, expect } from 'vitest';
import { steam64ToSteam2 } from '../src/steamId.js';

describe('steam64ToSteam2', () => {
  it('converts the verified live pair', () => {
    // How the Dallas logs print this account. Recorded in the spec.
    expect(steam64ToSteam2('76561198030413993')).toBe('STEAM_1:1:35074132');
  });

  it('handles an even account id', () => {
    // base + 2 -> Y = 0, Z = 1
    expect(steam64ToSteam2('76561197960265730')).toBe('STEAM_1:0:1');
  });

  it('handles the first possible account', () => {
    expect(steam64ToSteam2('76561197960265729')).toBe('STEAM_1:1:0');
  });

  it('rejects anything that is not a SteamID64', () => {
    expect(() => steam64ToSteam2('STEAM_1:1:35074132')).toThrow(/not a SteamID64/);
    expect(() => steam64ToSteam2('1234')).toThrow(/not a SteamID64/);
    expect(() => steam64ToSteam2('')).toThrow(/not a SteamID64/);
    // 17 digits but below the base: not an individual account.
    expect(() => steam64ToSteam2('10000000000000000')).toThrow(/not a SteamID64/);
  });
});
