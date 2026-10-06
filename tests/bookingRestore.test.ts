import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { currentSeasonId } from '../src/players.js';
import { setMissionsDirs, invalidateCampaignCache } from '../src/campaignRegistry.js';
import { prepareRestore, replayableChapters, restoreSnapshot, resumeLines } from '../src/bookings/restore.js';

// The stock No Mercy chapter list, in the same mission-file shape the real
// game ships (see tests/campaignRegistry.test.ts's AIRPORT fixture). Without
// a missions directory configured, campaignRegistry's stock entries carry
// `maps: []`, which restore.ts needs to be the real five chapters.
const NO_MERCY = `"mission"
{
  "Name" "hospital"
  "DisplayTitle" "No Mercy"
  "modes"
  {
    "versus"
    {
      "1" { "Map" "l4d_vs_hospital01_apartment" "DisplayName" "The Apartments" }
      "2" { "Map" "l4d_vs_hospital02_subway" "DisplayName" "The Subway" }
      "3" { "Map" "l4d_vs_hospital03_sewers" "DisplayName" "The Sewers" }
      "4" { "Map" "l4d_vs_hospital04_interior" "DisplayName" "The Hospital" }
      "5" { "Map" "l4d_vs_hospital05_rooftop" "DisplayName" "Rooftop Finale" }
    }
  }
}
`;

let db: DB;
let m: number;
let missionsDir: string;
const A = ['76561199000000001', '76561199000000002'];
const B = ['76561199000000003', '76561199000000004'];

const round = (ordinal: number, half: number, surv: 'a' | 'b', score: number, ended = true) =>
  db.prepare('INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(m, ordinal, half, surv, score, ended ? '2026-10-02 20:30:00' : null);

beforeEach(() => {
  missionsDir = mkdtempSync(join(tmpdir(), 'missions-'));
  mkdirSync(missionsDir, { recursive: true });
  writeFileSync(join(missionsDir, 'hospital.txt'), NO_MERCY);
  setMissionsDirs([missionsDir]);
  invalidateCampaignCache();

  db = openDb(':memory:');
  for (const s of [...A, ...B]) db.prepare("INSERT INTO players (steamid, name, status) VALUES (?, ?, 'active')").run(s, s.slice(-2));
  m = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, token, origin) VALUES (?, 'live', 'no_mercy', 'tok123', 'in_game')")
    .run(currentSeasonId(db)).lastInsertRowid);
  for (const s of A) db.prepare("INSERT INTO match_players (match_id, player_id, team, source) VALUES (?, ?, 'a', 'udp')").run(m, s);
  for (const s of B) db.prepare("INSERT INTO match_players (match_id, player_id, team, source, joined_map) VALUES (?, ?, 'b', 'udp', 1)").run(m, s);
});

afterEach(() => {
  setMissionsDirs([]);
  invalidateCampaignCache();
  rmSync(missionsDir, { recursive: true, force: true });
});

describe('restoreSnapshot', () => {
  it('nothing finished: replays the map it was on, team a survives first', () => {
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital01_apartment', '2026-10-02 20:10:00')").run(m);
    round(0, 1, 'a', 300, true);
    const s = restoreSnapshot(db, m)!;
    expect(s).toMatchObject({ maps: [], map: 'l4d_vs_hospital01_apartment', firstMap: 'l4d_vs_hospital01_apartment', firstSurv: 'a', token: 'tok123' });
    expect(s.roster).toContainEqual({ steamid: B[0], team: 'b', joinedMap: 1 });
  });

  it('two maps finished: scores from match_rounds, the leader survives first on map 3', () => {
    round(0, 1, 'a', 400); round(0, 2, 'b', 350);
    round(1, 1, 'a', 200); round(1, 2, 'b', 500);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital03_sewers', '2026-10-02 21:00:00')").run(m);
    const s = restoreSnapshot(db, m)!;
    expect(s.maps).toEqual([
      { map: 'l4d_vs_hospital01_apartment', a: 400, b: 350 },
      { map: 'l4d_vs_hospital02_subway', a: 200, b: 500 },
    ]);
    expect(s.map).toBe('l4d_vs_hospital03_sewers');
    expect(s.firstSurv).toBe('b'); // b 850 > a 600
  });

  it('a tie keeps the previous map\'s half-1 survivors', () => {
    round(0, 1, 'b', 300); round(0, 2, 'a', 300);
    expect(restoreSnapshot(db, m)!.firstSurv).toBe('b');
  });

  it('nextSeq is one above the highest event the site holds', () => {
    db.prepare("INSERT INTO match_live_events (match_id, seq, kind, actor, value, map_ordinal, half, t_ms) VALUES (?, 41, 'kill', 'x', 0, 0, 1, 0)").run(m);
    expect(restoreSnapshot(db, m)!.nextSeq).toBe(42);
  });

  it('null once every campaign map is finished, and for a match that is not live', () => {
    const maps = ['l4d_vs_hospital01_apartment', 'l4d_vs_hospital02_subway', 'l4d_vs_hospital03_sewers', 'l4d_vs_hospital04_interior', 'l4d_vs_hospital05_rooftop'];
    maps.forEach((_, i) => { round(i, 1, 'a', 1); round(i, 2, 'b', 1); });
    expect(restoreSnapshot(db, m)).toBeNull();
    db.prepare("UPDATE matches SET state = 'aborted' WHERE id = ?").run(m);
    expect(restoreSnapshot(db, m)).toBeNull();
  });

  it('replays an earlier chapter when asked: the maps before it stand, it and everything after it are dropped (plan T3c)', () => {
    round(0, 1, 'a', 400); round(0, 2, 'b', 350);
    round(1, 1, 'a', 200); round(1, 2, 'b', 500);
    round(2, 1, 'b', 100);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital03_sewers', '2026-10-02 21:00:00')").run(m);
    const s = restoreSnapshot(db, m, { replayFrom: 1 })!;
    expect(s.maps).toEqual([{ map: 'l4d_vs_hospital01_apartment', a: 400, b: 350 }]);
    expect(s).toMatchObject({ map: 'l4d_vs_hospital02_subway', firstSurv: 'a' });
    expect(restoreSnapshot(db, m, { replayFrom: 2 })!.map).toBe('l4d_vs_hospital03_sewers');
    expect(restoreSnapshot(db, m, { replayFrom: 0 })!.maps).toEqual([]);
    expect(restoreSnapshot(db, m, { replayFrom: 3 })).toBeNull();
    expect(restoreSnapshot(db, m, { replayFrom: 4 })).toBeNull();
    prepareRestore(db, s);
    expect(db.prepare('SELECT MAX(ordinal) AS o FROM match_rounds WHERE match_id = ?').get(m)).toEqual({ o: 0 });
  });

  it('a sub who joined on a dropped map plays the replayed chapter; crash recovery keeps joined_map as stored (plan T3c)', () => {
    round(0, 1, 'a', 400); round(0, 2, 'b', 350);
    round(1, 1, 'a', 200); round(1, 2, 'b', 500);
    db.prepare("INSERT INTO players (steamid, name, status) VALUES ('76561199000000009', 'sub', 'active')").run();
    db.prepare("INSERT INTO match_players (match_id, player_id, team, source, joined_map) VALUES (?, '76561199000000009', 'a', 'web', 2)").run(m);
    expect(restoreSnapshot(db, m, { replayFrom: 1 })!.roster).toContainEqual({ steamid: '76561199000000009', team: 'a', joinedMap: 1 });
    expect(restoreSnapshot(db, m, { replayFrom: 1 })!.roster).toContainEqual({ steamid: B[0], team: 'b', joinedMap: 1 });
    expect(restoreSnapshot(db, m, { replayFrom: 0 })!.roster).toContainEqual({ steamid: B[0], team: 'b', joinedMap: 0 });
    expect(restoreSnapshot(db, m)!.roster).toContainEqual({ steamid: '76561199000000009', team: 'a', joinedMap: 2 });
  });

  it('lists the replayable chapters, never the finale (plan T3c)', () => {
    round(0, 1, 'a', 400); round(0, 2, 'b', 350);
    round(1, 1, 'a', 200); round(1, 2, 'b', 500);
    round(2, 1, 'a', 200); round(2, 2, 'b', 500);
    round(3, 1, 'a', 200); round(3, 2, 'b', 500);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital05_rooftop', '2026-10-02 21:00:00')").run(m);
    expect(replayableChapters(db, m)).toEqual([
      { ordinal: 0, map: 'l4d_vs_hospital01_apartment' }, { ordinal: 1, map: 'l4d_vs_hospital02_subway' },
      { ordinal: 2, map: 'l4d_vs_hospital03_sewers' }, { ordinal: 3, map: 'l4d_vs_hospital04_interior' },
    ]);
  });

  it('crash recovery is unchanged without replayFrom: every finished map stands and the map it was on is replayed (plan T3c)', () => {
    round(0, 1, 'a', 400); round(0, 2, 'b', 350);
    round(1, 1, 'a', 200); round(1, 2, 'b', 500);
    round(2, 1, 'b', 100);
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital03_sewers', '2026-10-02 21:00:00')").run(m);
    const s = restoreSnapshot(db, m)!;
    expect(restoreSnapshot(db, m, {})).toEqual(s);
    expect(s).toMatchObject({ firstMap: 'l4d_vs_hospital01_apartment', map: 'l4d_vs_hospital03_sewers', firstSurv: 'b' });
    expect(s.maps).toEqual([
      { map: 'l4d_vs_hospital01_apartment', a: 400, b: 350 },
      { map: 'l4d_vs_hospital02_subway', a: 200, b: 500 },
    ]);
    prepareRestore(db, s);
    expect(db.prepare('SELECT MAX(ordinal) AS o FROM match_rounds WHERE match_id = ?').get(m)).toEqual({ o: 1 });
  });
});

describe('restoreSnapshot on the finale', () => {
  it('null when the map to replay is the campaign\'s last map, so the finale is never replayed past the plugin\'s backstop', () => {
    [0, 1, 2, 3].forEach((i) => { round(i, 1, 'a', 100); round(i, 2, 'b', 100); });
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital05_rooftop', '2026-10-02 22:00:00')").run(m);
    expect(restoreSnapshot(db, m)).toBeNull();
  });

  it('still restores the map before the finale', () => {
    [0, 1, 2].forEach((i) => { round(i, 1, 'a', 100); round(i, 2, 'b', 100); });
    db.prepare("INSERT INTO match_live (match_id, current_map, last_seen) VALUES (?, 'l4d_vs_hospital04_interior', '2026-10-02 22:00:00')").run(m);
    expect(restoreSnapshot(db, m)!.map).toBe('l4d_vs_hospital04_interior');
  });
});

describe('resumeLines and prepareRestore', () => {
  it('lines: resume, each finished map, the roster with joined maps', () => {
    round(0, 1, 'a', 400); round(0, 2, 'b', 350); round(1, 1, 'b', 100, true);
    const s = restoreSnapshot(db, m)!;
    expect(resumeLines(s)).toEqual([
      `sm_pug_resume ${m} tok123 l4d_vs_hospital01_apartment a ${s.nextSeq}`,
      'sm_pug_resume_map l4d_vs_hospital01_apartment 400 350',
      `sm_pug_roster "${A[0]}:a:0"`, `sm_pug_roster "${A[1]}:a:0"`, `sm_pug_roster "${B[0]}:b:1"`, `sm_pug_roster "${B[1]}:b:1"`,
      'sm_pug_resume_commit',
    ]);
    prepareRestore(db, s);
    expect(db.prepare('SELECT COUNT(*) AS n FROM match_rounds WHERE match_id = ? AND ordinal = 1').get(m)).toEqual({ n: 0 });
    expect(db.prepare('SELECT restored_at_map FROM matches WHERE id = ?').get(m)).toEqual({ restored_at_map: 1 });
  });

  it('refuses a token or map that would break the console line', () => {
    db.prepare("UPDATE matches SET token = 'a b' WHERE id = ?").run(m);
    const s = restoreSnapshot(db, m)!;
    expect(() => resumeLines(s)).toThrow(/unexpected/);
  });
});
