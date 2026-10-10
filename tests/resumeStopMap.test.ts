import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invalidateCampaignCache, setMissionsDirs } from '../src/campaignRegistry.js';
import { presetConfig } from '../src/events/vetoConfig.js';
import { restoreSnapshot, resumeLines } from '../src/bookings/restore.js';
import { gameStopMap } from '../src/events/stopMap.js';
import { HA, MIN, driveHomeAway, seriesFixture, type SeriesFixture } from './seriesFixture.js';

// Audit 2026-10-09 D1: a resumed tournament game is sent the stop map it was
// started with, so it does not run on to the finale backstop.

const NO_MERCY = `"mission"
{
  "Name" "hospital"
  "modes"
  {
    "versus"
    {
      "1" { "Map" "l4d_vs_hospital01_apartment" }
      "2" { "Map" "l4d_vs_hospital02_subway" }
      "3" { "Map" "l4d_vs_hospital03_sewers" }
      "4" { "Map" "l4d_vs_hospital04_interior" }
      "5" { "Map" "l4d_vs_hospital05_rooftop" }
    }
  }
}
`;
const DEATH_TOLL = NO_MERCY.replace('"hospital"', '"smalltown"')
  .replace('hospital01_apartment', 'smalltown01_caves').replace('hospital02_subway', 'smalltown02_drainage')
  .replace('hospital03_sewers', 'smalltown03_ranchhouse').replace('hospital04_interior', 'smalltown04_mainstreet')
  .replace('hospital05_rooftop', 'smalltown05_houseboat');

/** The quoted stop map on a sm_pug_match / sm_pug_resume line, or null. */
const stopArg = (line: string | undefined): string | null => /"([^"]+)"\s*$/.exec(line ?? '')?.[1] ?? null;

describe('sm_pug_resume carries the game\'s stop map (audit D1)', () => {
  let f: SeriesFixture;
  let missionsDir = '';
  beforeEach(() => {
    missionsDir = mkdtempSync(join(tmpdir(), 'missions-'));
    writeFileSync(join(missionsDir, 'hospital.txt'), NO_MERCY);
    writeFileSync(join(missionsDir, 'smalltown.txt'), DEATH_TOLL);
    setMissionsDirs([missionsDir]);
    invalidateCampaignCache();
  });
  afterEach(() => {
    vi.restoreAllMocks(); f?.close();
    setMissionsDirs([]);
    invalidateCampaignCache();
    rmSync(missionsDir, { recursive: true, force: true });
  });

  async function game1(): Promise<number> {
    f = await seriesFixture({ pool: HA, veto: presetConfig('home_away', 4), drive: driveHomeAway });
    await f.tick();
    const g1 = f.gameOf(1).match_id!;
    f.goLive(g1);
    return g1;
  }

  it('the resume line ends with the same quoted stop map the game\'s sm_pug_match line had', async () => {
    const g1 = await game1();
    const started = f.sent.find((c) => c.startsWith(`sm_pug_match ${g1} `));
    const want = stopArg(started);
    expect(want).not.toBeNull();
    expect(gameStopMap(f.db, g1)).toBe(want);
    const snap = restoreSnapshot(f.db, g1)!;
    expect(snap.stopMap).toBe(want);
    const line = resumeLines(snap)[0]!;
    expect(line).toMatch(new RegExp(`^sm_pug_resume ${g1} \\S+ \\S+ [ab] \\d+ "${want}"$`));
  });

  it('a stage with a chapter count stops after that chapter', async () => {
    const g1 = await game1();
    f.db.prepare('UPDATE event_stages SET chapters = 2').run();
    // Game 1 of this fixture is Death Toll.
    expect(gameStopMap(f.db, g1)).toBe('l4d_vs_smalltown02_drainage');
    expect(stopArg(resumeLines(restoreSnapshot(f.db, g1)!)[0])).toBe('l4d_vs_smalltown02_drainage');
  });

  it('a tiebreak resumes with its one map as the stop map', async () => {
    const g1 = await game1();
    f.endGame(g1, [{ map: 'l4d_vs_smalltown01_caves', a: 500, b: 400 }]);
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    const g2 = f.gameOf(2).match_id!;
    f.goLive(g2);
    // 900 to 900 on total: a tiebreak.
    f.endGame(g2, [{ map: 'l4d_vs_hospital01_apartment', a: 100, b: 100, half1Surv: 'a' }, { map: 'l4d_vs_hospital02_subway', a: 300, b: 400, half1Surv: 'b' }]);
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    const tbRow = f.gameOf(21);
    const tb = tbRow.match_id!;
    expect(tb).not.toBeNull();
    expect(tbRow.map).toMatch(/^l4d_vs_/);
    const started = f.sent.find((c) => c.startsWith(`sm_pug_match ${tb} `));
    expect(stopArg(started)).toBe(tbRow.map);
    expect(gameStopMap(f.db, tb)).toBe(tbRow.map);
  });

  it('a game that is not a tournament game resumes with no stop map, as before', async () => {
    const g1 = await game1();
    f.db.prepare("UPDATE matches SET kind = 'scrim' WHERE id = ?").run(g1);
    expect(gameStopMap(f.db, g1)).toBeNull();
    const snap = restoreSnapshot(f.db, g1)!;
    expect(snap.stopMap).toBeNull();
    expect(resumeLines(snap)[0]).toMatch(new RegExp(`^sm_pug_resume ${g1} \\S+ \\S+ [ab] \\d+$`));
  });

  it('crash recovery sends the stop map on the box', async () => {
    const g1 = await game1();
    const want = stopArg(f.sent.find((c) => c.startsWith(`sm_pug_match ${g1} `)));
    f.box.resumeOk = true;
    f.box.marker = ''; f.box.map = 'l4d_vs_smalltown01_caves'; f.box.pug = { state: 'none', match: 0 }; f.box.tournament = false;
    f.sent.length = 0;
    f.t.t += MIN;
    await f.tick();
    await f.runner.idle();
    const resume = f.sent.find((c) => c.startsWith(`sm_pug_resume ${g1} `));
    expect(stopArg(resume)).toBe(want);
  });

  it('refuses a stop map with unexpected characters', async () => {
    const g1 = await game1();
    const snap = restoreSnapshot(f.db, g1)!;
    expect(() => resumeLines({ ...snap, stopMap: 'x" ; quit' })).toThrow();
  });
});
