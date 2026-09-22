import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import { conductOf } from '../src/admin/conduct.js';

const P = '76561199000000001';
const Q = '76561199000000002';
const ALT = '76561199000000009';
let db: DB;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [P, Q, ALT]) upsertPlayer(db, { steamid: id, name: `p${id.slice(-1)}`, avatar: null }, []);
});

function match(roster: string[], opts: { voided?: boolean; state?: string } = {}): number {
  const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, ?, 'dead_air')")
    .run(opts.state ?? 'completed').lastInsertRowid);
  if (opts.voided) db.prepare("UPDATE matches SET voided_at = datetime('now') WHERE id = ?").run(id);
  for (const [i, s] of roster.entries()) {
    db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').run(id, s, i % 2 ? 'b' : 'a');
  }
  return id;
}

function readyup(matchId: number, seconds: Record<string, number>, last: string[], ended = true): void {
  const r = Number(db.prepare(
    `INSERT INTO match_readyups (match_id, map_ordinal, half, started_at, ended_at, last_unready)
     VALUES (?, 0, 1, '2026-09-22 10:00:00', ?, ?)`,
  ).run(matchId, ended ? '2026-09-22 10:01:00' : null, JSON.stringify(last)).lastInsertRowid);
  for (const [s, secs] of Object.entries(seconds)) {
    db.prepare('INSERT INTO match_readyup_players (readyup_id, match_id, player_id, seconds) VALUES (?, ?, ?, ?)')
      .run(r, matchId, s, secs);
  }
}

function pause(matchId: number, by: string | null, start: string, end: string | null): void {
  db.prepare(
    `INSERT INTO match_pauses (match_id, map_ordinal, half, team, leave_pause, started_at, ended_at, called_by)
     VALUES (?, 0, 1, 'a', 0, ?, ?, ?)`,
  ).run(matchId, start, end, by);
}

describe('conductOf: ready-ups', () => {
  it('averages over every ready-up they were rostered in, counting an instant ready as zero', () => {
    const m = match([P, Q]);
    readyup(m, { [P]: 40, [Q]: 10 }, [P]);
    readyup(m, { [Q]: 20 }, [Q]);
    const c = conductOf(db, P).readyups;
    expect(c.count).toBe(2);
    expect(c.avgSeconds).toBe(20);
    expect(c.timesLast).toBe(1);
    // League: (40 + 0 + 10 + 20) / 4, and 2 lasts over 4 participations.
    expect(c.leagueAvgSeconds).toBe(18);
    expect(c.leagueLastShare).toBeCloseTo(0.5);
    expect(c.slowest).toEqual([{ matchId: m, mapOrdinal: 0, half: 1, seconds: 40, wasLast: true }]);
  });

  it('leaves out voided matches and ready-ups still open, and keeps cancelled matches', () => {
    readyup(match([P], { voided: true }), { [P]: 500 }, [P]);
    readyup(match([P]), { [P]: 500 }, [P], false);
    readyup(match([P], { state: 'aborted' }), { [P]: 30 }, [P]);
    const c = conductOf(db, P).readyups;
    expect(c.count).toBe(1);
    expect(c.avgSeconds).toBe(30);
  });

  it('counts a sub only from the map they joined on', () => {
    const m = match([P, Q]);
    db.prepare('UPDATE match_players SET joined_map = 1 WHERE player_id = ?').run(P);
    readyup(m, { [Q]: 10 }, [Q]);
    const later = Number(db.prepare(
      `INSERT INTO match_readyups (match_id, map_ordinal, half, started_at, ended_at, last_unready)
       VALUES (?, 1, 1, '2026-09-22 11:00:00', '2026-09-22 11:01:00', '[]')`,
    ).run(m).lastInsertRowid);
    db.prepare('INSERT INTO match_readyup_players (readyup_id, match_id, player_id, seconds) VALUES (?, ?, ?, 30)').run(later, m, P);
    expect(conductOf(db, P).readyups).toMatchObject({ count: 1, avgSeconds: 30 });
  });

  it('counts a merged second account as the same person', () => {
    addAlias(db, { steamid: ALT, canonical: P, by: Q });
    readyup(match([ALT]), { [ALT]: 60 }, [ALT]);
    expect(conductOf(db, P).readyups).toMatchObject({ count: 1, avgSeconds: 60, timesLast: 1 });
  });

  it('says nothing rather than zero for someone with no ready-ups', () => {
    expect(conductOf(db, P).readyups).toMatchObject({ count: 0, avgSeconds: null, timesLast: 0, slowest: [] });
  });
});

describe('conductOf: pauses', () => {
  it('reports nothing tracked until a server has named a caller', () => {
    pause(match([P]), null, '2026-09-20 10:00:00', '2026-09-20 10:01:00');
    expect(conductOf(db, P).pauses).toEqual({ trackedSince: null, called: 0, matchesSince: 0, totalSeconds: 0, recent: [] });
  });

  it('counts only the pauses they called, never their team\'s, and totals the time', () => {
    const m = match([P, Q]);
    // It began before its first pause, as every match does.
    db.prepare("UPDATE matches SET created_at = '2026-09-22 09:30:00' WHERE id = ?").run(m);
    pause(m, P, '2026-09-22 10:00:00', '2026-09-22 10:01:30');
    pause(m, Q, '2026-09-22 10:05:00', '2026-09-22 10:06:00');
    pause(m, null, '2026-09-22 10:07:00', '2026-09-22 10:08:00');
    pause(m, P, '2026-09-22 10:09:00', null);
    match([Q]);
    match([P]);
    const voided = match([P], { voided: true });
    pause(voided, P, '2026-09-22 12:00:00', '2026-09-22 12:30:00');
    const c = conductOf(db, P).pauses;
    expect(c.trackedSince).toBe('2026-09-22 10:00:00');
    expect(c.called).toBe(2);
    // The match holding the first named pause counts, however early it began,
    // and so does a later one; a match they were not in does not.
    expect(c.matchesSince).toBe(2);
    expect(c.totalSeconds).toBe(90);
    expect(c.recent.map((p) => p.seconds)).toEqual([null, 90]);
  });
});
