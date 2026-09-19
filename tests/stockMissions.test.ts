import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStockMissions } from '../src/stockMissions.js';

let dir: string;

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'missions-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'airport.txt'), AIRPORT);
  // Not a mission: the reader must skip it rather than throw.
  writeFileSync(join(dir, 'credits.txt'), 'this is not a mission file');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('readStockMissions', () => {
  // Keyed by the site's slug, not the mission's own Name: the file calls
  // itself "airport" and this site calls it "dead_air".
  it('reads a mission file into its versus chapter list', () => {
    const got = readStockMissions(dir);
    expect(got.get('dead_air')!.map((c) => c.map)).toEqual([
      'l4d_vs_airport01_greenhouse', 'l4d_vs_airport02_offices',
      'l4d_vs_airport03_garage', 'l4d_vs_airport04_terminal',
      'l4d_vs_airport05_runway',
    ]);
  });

  it('keeps the chapter display names', () => {
    expect(readStockMissions(dir).get('dead_air')![0].display).toBe('The Greenhouse');
  });

  // credits.txt sits in this directory on a real install and is not a mission.
  it('skips a file that is not a mission', () => {
    expect(readStockMissions(dir).has('credits')).toBe(false);
    expect(readStockMissions(dir).size).toBe(1);
  });

  // An unset or wrong path must not take the site down at startup.
  it('returns nothing for a directory that is not there', () => {
    expect(readStockMissions(join(dir, 'nope')).size).toBe(0);
  });

  it('returns nothing for an empty path', () => {
    expect(readStockMissions('').size).toBe(0);
  });
});
