import { describe, it, expect } from 'vitest';
import type { DB } from '../src/db.js';
import * as E from '../src/events/events.js';
import * as N from '../src/events/entries.js';
import { profileEvents } from '../src/events/profileEvents.js';
import { ADMIN, NOW } from './eventFixture.js';
import { cutDraft, draftFixture, P } from './draftFixture.js';

/** Owner 2026-10-23: event play shows on profiles, in its own section. */
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};

function withEntries() {
  const f = cutDraft({ balance: true });
  const { entries } = must(N.createDraftEntries(f.db, { eventId: f.eventId, actor: ADMIN, now: NOW }));
  const stageId = (f.db.prepare('SELECT id FROM event_stages WHERE event_id = ? ORDER BY ordinal LIMIT 1').get(f.eventId) as { id: number }).id;
  return { ...f, entries, stageId };
}

describe('profileEvents', () => {
  it('lists the event once per entry with the team, captaincy and record', () => {
    const f = withEntries();
    const [e1, e2] = f.entries as [number, number];
    const captain = N.getEntry(f.db, e1)!.captain_steamid!;
    const mate = N.rosterOf(f.db, e1).starters.find((s) => s !== captain)!;
    f.db.prepare(
      `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, entry_a, entry_b, status, best_of, winner_entry, score_a, score_b, created_at, finished_at)
       VALUES (?, ?, 1, 1, 1, ?, ?, 'done', 1, ?, 1, 0, ?, ?)`,
    ).run(f.eventId, f.stageId, e1, e2, e1, NOW.toISOString(), NOW.toISOString());

    const mine = profileEvents(f.db, captain);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.entry).toMatchObject({ id: e1, captain: true });
    expect(mine[0]!).toMatchObject({ wins: 1, losses: 0 });
    expect(mine[0]!.matches[0]).toMatchObject({ result: 'win', scoreFor: 1, scoreAgainst: 0, opponent: N.getEntry(f.db, e2)!.name });

    expect(profileEvents(f.db, mate)[0]!.entry.captain).toBe(false);
    const theirs = profileEvents(f.db, N.getEntry(f.db, e2)!.captain_steamid!);
    expect(theirs[0]!).toMatchObject({ wins: 0, losses: 1 });
    expect(theirs[0]!.matches[0]).toMatchObject({ result: 'loss', scoreFor: 0, scoreAgainst: 1 });
  });

  it('shows nothing for a player on no entry, or for a cancelled event', () => {
    const f = withEntries();
    expect(profileEvents(f.db, '76561190000000999')).toEqual([]);
    const captain = N.getEntry(f.db, f.entries[0]!)!.captain_steamid!;
    f.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(f.eventId);
    expect(profileEvents(f.db, captain)).toEqual([]);
  });
});

const t = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

/** A draft entry inserted by hand (test setup only), four starters. */
function entry(db: DB, eventId: number, name: string, starters: string[], seed: number): number {
  const id = Number(db.prepare(
    `INSERT INTO event_entries (event_id, team_id, name, tag, logo_key, seed, registered_by, created_at, captain_steamid)
     VALUES (?, NULL, ?, '', NULL, ?, ?, ?, ?)`,
  ).run(eventId, name, seed, ADMIN, t(0), starters[0]).lastInsertRowid);
  for (const s of starters) db.prepare("INSERT INTO event_entry_players (entry_id, steamid, role, added_at) VALUES (?, ?, 'starter', ?)").run(id, s, t(0));
  return id;
}

/** Moves a player from one entry to another, as the desk swap does. */
function move(db: DB, steamid: string, from: number, to: number, min: number): void {
  db.prepare('UPDATE event_entry_players SET removed_at = ? WHERE entry_id = ? AND steamid = ? AND removed_at IS NULL').run(t(min), from, steamid);
  db.prepare("INSERT INTO event_entry_players (entry_id, steamid, role, added_at) VALUES (?, ?, 'starter', ?)").run(to, steamid, t(min));
}

function match(db: DB, eventId: number, stageId: number, round: number, a: number, b: number, winner: number | null, slot = 1): number {
  return Number(db.prepare(
    `INSERT INTO event_matches (event_id, stage_id, grp, round, slot, entry_a, entry_b, status, winner_entry, score_a, score_b, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(eventId, stageId, round, slot, a, b, winner === null ? 'waiting' : 'done', winner,
    winner === null ? null : winner === a ? 1 : 0, winner === null ? null : winner === a ? 0 : 1, t(0)).lastInsertRowid);
}

function lineup(db: DB, matchId: number, entryId: number, four: string[]): void {
  db.prepare("INSERT INTO event_lineups (event_match_id, game, entry_id, steamids, locked_by, auto, locked_at) VALUES (?, 1, ?, ?, NULL, 0, ?)")
    .run(matchId, entryId, JSON.stringify(four), t(0));
}

describe('profileEvents after roster moves', () => {
  it('shows a player moved between teams only the matches they played for each', () => {
    const f = draftFixture();
    const db = f.db;
    const mover = P[3]!;
    const a = entry(db, f.eventId, 'Team A', P.slice(0, 4), 1);
    const b = entry(db, f.eventId, 'Team B', P.slice(4, 8), 2);
    const c = entry(db, f.eventId, 'Team C', P.slice(8, 12), 3);
    const d = entry(db, f.eventId, 'Team D', P.slice(12, 16), 4);
    const stageId = E.stagesOf(db, f.eventId)[0]!.id;
    db.prepare("UPDATE events SET status = 'live' WHERE id = ?").run(f.eventId);

    // Briefly on D before any match, then back to A: D never shows.
    move(db, mover, a, d, 1);
    move(db, mover, d, a, 2);
    // Round 1: the mover plays for A.
    const r1 = match(db, f.eventId, stageId, 1, a, c, a);
    lineup(db, r1, a, P.slice(0, 4));
    lineup(db, r1, c, P.slice(8, 12));
    // Day 2 the mover goes to B; A plays round 2 with a stand-in, B's match is not reached yet.
    move(db, mover, a, b, 60);
    db.prepare("INSERT INTO event_entry_players (entry_id, steamid, role, added_at) VALUES (?, ?, 'starter', ?)").run(a, P[16], t(60));
    const r2 = match(db, f.eventId, stageId, 2, a, d, d);
    lineup(db, r2, a, [P[0]!, P[1]!, P[2]!, P[16]!]);
    lineup(db, r2, d, P.slice(12, 16));
    match(db, f.eventId, stageId, 2, b, c, null, 2);
    db.prepare('UPDATE event_entries SET placement = 2 WHERE id = ?').run(a);

    const rows = profileEvents(db, mover);
    const byName = Object.fromEntries(rows.map((r) => [r.entry.name, r]));
    expect(Object.keys(byName).sort()).toEqual(['Team A', 'Team B']);
    expect(byName['Team A']!.matches.map((m) => m.opponent)).toEqual(['Team C']);
    expect([byName['Team A']!.wins, byName['Team A']!.losses]).toEqual([1, 0]);
    expect(byName['Team A']!.placement).toBeNull();
    expect(byName['Team B']!.matches.map((m) => m.opponent)).toEqual(['Team C']);

    // A teammate who stayed keeps the whole run and the placement.
    const stayer = profileEvents(db, P[0]!)[0]!;
    expect(stayer.matches.map((m) => m.opponent)).toEqual(['Team C', 'Team D']);
    expect(stayer.placement).toBe(2);
  });
});
