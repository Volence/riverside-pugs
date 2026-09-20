import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStockMissions } from '../src/stockMissions.js';

let dir: string;
let dlc4Dir: string;

const AIRPORT = `"mission"
{
  "Name" "airport"
  "DisplayTitle" "Dead Air"
  "modes"
  {
    "versus"
    {
      "1" { "Map" "l4d_vs_airport01_greenhouse" "DisplayName" "The Greenhouse" }
      "2" { "Map" "l4d_vs_airport02_offices" "DisplayName" "The Crane" }
      "3" { "Map" "l4d_vs_airport03_garage" "DisplayName" "The Garage" }
      "4" { "Map" "l4d_vs_airport04_terminal" "DisplayName" "The Terminal" }
      "5" { "Map" "l4d_vs_airport05_runway" "DisplayName" "The Runway" }
    }
  }
}
`;

const DEAD_CENTER = `"mission"
{
  "Name" "DeadCenter"
  "DisplayTitle" "Dead Center"
  "modes"
  {
    "coop"
    {
      "1" { "Map" "c1m1_hotel" "DisplayName" "Hotel" }
    }
    "versus"
    {
      "1" { "Map" "c1m1_hotel" "DisplayName" "Hotel (VS)" }
      "2" { "Map" "c1m2_streets" "DisplayName" "Streets (VS)" }
      "3" { "Map" "c1m3_mall" "DisplayName" "Mall (VS)" }
      "4" { "Map" "c1m4_atrium" "DisplayName" "Atrium (VS)" }
    }
  }
}
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'missions-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'airport.txt'), AIRPORT);
  // Not a mission: the reader must skip it rather than throw.
  writeFileSync(join(dir, 'credits.txt'), 'this is not a mission file');
  dlc4Dir = mkdtempSync(join(tmpdir(), 'missions-dlc4-'));
  mkdirSync(dlc4Dir, { recursive: true });
  writeFileSync(join(dlc4Dir, 'DeadCenter.txt'), DEAD_CENTER);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dlc4Dir, { recursive: true, force: true });
});

describe('readStockMissions', () => {
  // Keyed by the site's slug, not the mission's own Name: the file calls
  // itself "airport" and this site calls it "dead_air".
  it('reads a mission file into its versus chapter list', () => {
    const got = readStockMissions([dir]);
    expect(got.get('dead_air')!.map((c) => c.map)).toEqual([
      'l4d_vs_airport01_greenhouse', 'l4d_vs_airport02_offices',
      'l4d_vs_airport03_garage', 'l4d_vs_airport04_terminal',
      'l4d_vs_airport05_runway',
    ]);
  });

  it('keeps the chapter display names', () => {
    expect(readStockMissions([dir]).get('dead_air')![0].display).toBe('The Greenhouse');
  });

  // credits.txt sits in this directory on a real install and is not a mission.
  it('skips a file that is not a mission', () => {
    expect(readStockMissions([dir]).has('credits')).toBe(false);
    expect(readStockMissions([dir]).size).toBe(1);
  });

  // An unset or wrong path must not take the site down at startup.
  it('returns nothing for a directory that is not there', () => {
    expect(readStockMissions([join(dir, 'nope')]).size).toBe(0);
  });

  it('returns nothing for an empty path', () => {
    expect(readStockMissions(['']).size).toBe(0);
  });

  it('reads campaigns from every directory it is given', () => {
    const got = readStockMissions([dir, dlc4Dir]);
    expect(got.get('dead_air')?.map((c) => c.map)).toEqual([
      'l4d_vs_airport01_greenhouse', 'l4d_vs_airport02_offices',
      'l4d_vs_airport03_garage', 'l4d_vs_airport04_terminal',
      'l4d_vs_airport05_runway',
    ]);
    expect(got.get('dead_center')?.map((c) => c.map)).toEqual([
      'c1m1_hotel', 'c1m2_streets', 'c1m3_mall', 'c1m4_atrium',
    ]);
  });

  // The versus block is what the site plays. A mission file also carries coop,
  // and coop's chapter 1 has a different DisplayName, so reading the wrong
  // block is silently wrong rather than an error.
  it('takes the versus block, not coop', () => {
    const got = readStockMissions([dlc4Dir]);
    expect(got.get('dead_center')?.[0].display).toBe('Hotel (VS)');
  });

  it('skips a directory that does not exist without losing the others', () => {
    const got = readStockMissions([dir, join(dlc4Dir, 'nope')]);
    expect(got.has('dead_air')).toBe(true);
    expect(got.size).toBe(1);
  });

  it('returns empty for an empty list', () => {
    expect(readStockMissions([]).size).toBe(0);
  });
});
