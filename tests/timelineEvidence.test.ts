import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { playerTimeline } from '../src/admin/playerTimeline.js';
import { analyzerAdapter } from '../src/admin/timeline/analyzer.js';
import { dropsAdapter, repeatDropIds } from '../src/admin/timeline/drops.js';
import { steamAdapter } from '../src/admin/timeline/steam.js';
import { ANALYZER_VERSION } from '../src/integrity/store.js';

const P = '76561199000000001';
const STAFF = '76561199000000009';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P, STAFF]) upsertPlayer(db, { steamid: id, name: `p${id.slice(-3)}`, avatar: null }, []);
  db.prepare("INSERT INTO matches (id, season_id, state, campaign, ended_at) VALUES (7, 1, 'completed', 'dead_air', '2026-09-20 18:00:00')").run();
});

const clip = (version: number, startMs = 61500, kind = 'track') =>
  db.prepare(
    `INSERT INTO integrity_clips (match_id, ordinal, half, slot, steamid, start_ms, end_ms, kind, score, detail, analyzer_version)
     VALUES (7, 2, 1, 3, ?, ?, ?, ?, 0.82, '{}', ?)`,
  ).run(P, startMs, startMs + 6000, kind, version);

const replayRow = (pruned: string | null) =>
  db.prepare(
    `INSERT INTO match_replays (match_id, ordinal, half, filename, bytes, frames, sample_hz, pruned_at)
     VALUES (7, 2, 1, 'r.bin', 10, 10, 10, ?)`,
  ).run(pruned);

const drop = (at: string, enteredAfter: string | null = null) =>
  db.prepare(
    `INSERT INTO signon_drops (steamid, name, secs_connected, forced_count, at, entered_after_at)
     VALUES (?, 'ingame', 12, 651, ?, ?)`,
  ).run(P, at, enteredAfter);

const alert = (kind: string, marker: string, at: string) =>
  db.prepare('INSERT INTO steam_signal_alerts (player_id, kind, marker, match_id, at) VALUES (?, ?, ?, 7, ?)')
    .run(P, kind, marker, at);

describe('the analyzer source', () => {
  it('shows current-version clips only, dated by their match, with a replay link when the file is there', () => {
    clip(ANALYZER_VERSION);
    clip(ANALYZER_VERSION - 1, 1000);
    replayRow(null);
    const items = analyzerAdapter.items({ db, steamid: P, ids: [P], viewer: STAFF });
    expect(items).toHaveLength(1);
    expect(items[0].at).toBe('2026-09-20T18:00:00.000Z');
    expect(items[0].matchId).toBe(7);
    expect(items[0].replay).toEqual({ ordinal: 2, half: 1, tMs: 61500 });
    expect(items[0].summary).toMatch(/Watch it/);
  });

  it('offers no replay link when the replay was pruned or never indexed', () => {
    clip(ANALYZER_VERSION);
    expect(analyzerAdapter.items({ db, steamid: P, ids: [P], viewer: STAFF })[0].replay).toBeNull();
    replayRow('2026-09-21 00:00:00');
    expect(analyzerAdapter.items({ db, steamid: P, ids: [P], viewer: STAFF })[0].replay).toBeNull();
  });

  it('says in words which kind of moment a clip is', () => {
    clip(ANALYZER_VERSION, 1000, 'hidden_track');
    clip(ANALYZER_VERSION, 9000, 'ghost_track');
    const text = analyzerAdapter.items({ db, steamid: P, ids: [P], viewer: STAFF }).map((i) => i.summary);
    expect(text.some((t) => /followed a spawned infected nobody on the team could see/.test(t))).toBe(true);
    expect(text.some((t) => /followed a ghost/.test(t))).toBe(true);
  });
});

describe('the connect-drop source', () => {
  it('marks a second drop inside ten minutes with no entry between as a repeat', () => {
    drop('2026-09-20T10:00:00.000Z');
    drop('2026-09-20T10:05:00.000Z');
    drop('2026-09-20T12:00:00.000Z');
    const items = dropsAdapter.items({ db, steamid: P, ids: [P], viewer: STAFF });
    expect(items.map((i) => i.kind)).toEqual(['drop', 'repeat', 'drop']);
    expect(items[1].summary).toMatch(/ten minutes/);
    // The repeat carries the other reading too. It is the stronger hint, so
    // it is the one a reader is most likely to take for a finding.
    expect(items[1].summary).toMatch(/cancelled loading screen/);
    expect(items[2].summary).toMatch(/cancelled loading screen/);
  });

  it('a clean entry between two drops ends the run', () => {
    const rows = [
      { id: 1, steamid: P, name: 'n', secs_connected: 1, forced_count: 1, at: '2026-09-20T10:00:00.000Z', entered_after_at: '2026-09-20T10:01:00.000Z' },
      { id: 2, steamid: P, name: 'n', secs_connected: 1, forced_count: 1, at: '2026-09-20T10:05:00.000Z', entered_after_at: null },
    ];
    expect([...repeatDropIds(rows)]).toEqual([]);
    rows[0].entered_after_at = null;
    expect([...repeatDropIds(rows)]).toEqual([2]);
  });

  it('reports only repeats as evidence', () => {
    drop('2026-09-20T10:00:00.000Z');
    expect(dropsAdapter.evidence!(db)).toEqual([]);
    drop('2026-09-20T10:05:00.000Z');
    expect(dropsAdapter.evidence!(db)).toEqual([{ steamid: P, at: '2026-09-20T10:05:00.000Z' }]);
  });
});

describe('the Steam source', () => {
  it('words both alerts as context and lands them on the timeline', () => {
    alert('recent_ban', '2', '2026-09-20T10:00:00.000Z');
    alert('banned_lender', '76561198000000077', '2026-09-20T11:00:00.000Z');
    const items = steamAdapter.items({ db, steamid: P, ids: [P], viewer: STAFF });
    expect(items[0].summary).toMatch(/Households share libraries/);
    expect(items[1].summary).toMatch(/Steam does not say which game/);
    expect(playerTimeline(db, P, STAFF).map((i) => i.source)).toEqual(['steam', 'steam']);
    expect(steamAdapter.evidence!(db)).toEqual([{ steamid: P, at: '2026-09-20T11:00:00.000Z' }]);
  });
});
