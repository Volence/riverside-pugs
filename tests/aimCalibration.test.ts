import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { openDb, type DB } from '../src/db.js';
import { recordSiKill } from '../src/aimRules.js';
import { aimCalibration } from '../src/aimCalibration.js';

const NOW = new Date('2026-10-24T22:00:00.000Z');
let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

function play(matchId: number, steamid: string, weapon: string, n: number, hs: number, flicks = 0, at = new Date('2026-10-20T20:00:00.000Z')): void {
  for (let i = 0; i < n; i++) {
    recordSiKill(db, {
      matchId, serverId: 1, steamid, weapon, headshot: i < hs, dist: 400,
      pre: i < flicks ? 120 : 6, back: i < flicks ? 10 : 2, victimClass: 'hunter',
    }, at);
  }
}

describe('aimCalibration', () => {
  it('reports pools, p-value buckets, the lowest p-values and flick counts over the window', () => {
    play(1, 'honest1', 'smg', 12, 4, 1);
    play(2, 'honest2', 'smg', 15, 6);
    play(3, 'cheat', 'smg', 16, 14, 2);
    play(4, 'sniper', 'hunting_rifle', 12, 9);
    play(5, 'old', 'smg', 20, 20, 0, new Date('2026-10-01T00:00:00.000Z')); // outside 7 days
    const r = aimCalibration(db, NOW);
    expect(r.playerMatches).toBe(4);
    expect(r.pools).toEqual([
      { group: 'auto', kills: 43, headshots: 24, rate: 24 / 43 },
      { group: 'rifle', kills: 12, headshots: 9, rate: 0.75 },
    ]);
    const auto = r.hs.find((h) => h.group === 'auto')!;
    expect(auto.scored).toBe(3);
    expect(auto.lowest[0]).toMatchObject({ steamid: 'cheat', matchId: 3, kills: 16, headshots: 14 });
    expect(auto.buckets.reduce((s, b) => s + b.count, 0)).toBe(3);
    expect(r.flicks.counts).toEqual([{ flicks: 0, playerMatches: 2 }, { flicks: 1, playerMatches: 1 }, { flicks: 2, playerMatches: 1 }]);
    expect(r.flicks.top[0]).toMatchObject({ steamid: 'cheat', matchId: 3, flicks: 2, kills: 16 });
  });
});

describe('si_kills schema and the calibration script', () => {
  it('indexes si_kills by at', () => {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'si_kills'").all() as { name: string }[];
    expect(names.map((n) => n.name)).toContain('si_kills_at');
  });

  it('exits with an error when a flag has no value', () => {
    for (const a of [['--db'], ['--days'], ['--db', '--days', '3']]) {
      const r = spawnSync('npx', ['tsx', 'scripts/aim-calibration.ts', ...a], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/needs a value/);
    }
  }, 30000);
});
