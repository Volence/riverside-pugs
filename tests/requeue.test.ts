import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { Matchmaker } from '../src/matchmaker.js';
import type { Scheduler } from '../src/lobby.js';
import { parseLogDatagram } from '../src/logParse.js';
import { LATE_REQUEUE_MS, requeueMatchFor, requeueOptIns, setRequeue, wantsRequeue } from '../src/matchRequeue.js';
import { cleanNote, ratingNote } from '../src/endNotes.js';
import type { LadderEntry } from '../src/seasonRules.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000001${i}`);
const OTHER = '76561198000000020';

class FakeScheduler implements Scheduler {
  private n = 1;
  set(): number { return this.n++; }
  clear(): void {}
}

let db: DB;
let mm: Matchmaker;
let blocked: Set<string>;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [...IDS, OTHER]) { upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []); activatePlayer(db, id); }
  blocked = new Set();
  mm = new Matchmaker(db, {
    broadcast: () => {}, orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
    scheduler: new FakeScheduler(),
    queueGate: (s) => blocked.has(s) ? 'link_discord' : null,
  });
});

function match(state: string, opts: { kind?: string; endedAt?: string | null } = {}): number {
  const id = Number(db.prepare('INSERT INTO matches (season_id, state, campaign, kind, ended_at) VALUES (1, ?, ?, ?, ?)')
    .run(state, 'dead_air', opts.kind ?? 'pug', opts.endedAt ?? null).lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((p, i) => ins.run(id, p, i < 4 ? 'a' : 'b'));
  return id;
}

const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

describe('requeueMatchFor', () => {
  it('accepts a rostered player on a live queue PUG', () => {
    const id = match('live');
    expect(requeueMatchFor(db, id, IDS[0])).toMatchObject({ id, state: 'live' });
  });

  it('refuses someone not on the roster, a scrim, and a line from another box', () => {
    const id = match('live');
    expect(requeueMatchFor(db, id, OTHER)).toBeNull();
    expect(requeueMatchFor(db, match('live', { kind: 'scrim' }), IDS[0])).toBeNull();
    expect(requeueMatchFor(db, id, IDS[0], 7)).toBeNull();
  });

  it('still takes a late !rq just after the match ended, but not long after', () => {
    const now = new Date('2026-11-10T20:00:00Z');
    const fresh = match('completed', { endedAt: sqlTime(new Date(now.getTime() - 30_000)) });
    const stale = match('completed', { endedAt: sqlTime(new Date(now.getTime() - LATE_REQUEUE_MS - 60_000)) });
    expect(requeueMatchFor(db, fresh, IDS[0], null, now)).toMatchObject({ state: 'completed' });
    expect(requeueMatchFor(db, stale, IDS[0], null, now)).toBeNull();
    expect(requeueMatchFor(db, match('aborted', { endedAt: sqlTime(now) }), IDS[0], null, now)).toBeNull();
  });
});

describe('requeue after the match', () => {
  it('is idempotent on, and off removes it', () => {
    const id = match('live');
    setRequeue(db, id, IDS[1], true);
    setRequeue(db, id, IDS[1], true);
    expect(requeueOptIns(db, id)).toEqual([IDS[1]]);
    setRequeue(db, id, IDS[1], false);
    expect(wantsRequeue(db, id, IDS[1])).toBe(false);
  });

  it('puts those who asked at the BACK of the queue, and says why someone could not go', () => {
    mm.join(OTHER);
    const id = match('live');
    setRequeue(db, id, IDS[0], true);
    setRequeue(db, id, IDS[5], true);
    blocked.add(IDS[5]);
    db.prepare("UPDATE matches SET state = 'completed', ended_at = datetime('now') WHERE id = ?").run(id);
    const r = mm.requeueAfterMatch(id);
    expect(r.get(IDS[0])).toEqual({ ok: true });
    expect(r.get(IDS[5])).toMatchObject({ ok: false });
    expect(mm.stateFor(OTHER).queue.players.map((p) => p.steamid)).toEqual([OTHER, IDS[0]]);
  });

  it('shows the viewer their own toggle on a live queue match only, and only from Season 1', () => {
    const id = match('live');
    expect(mm.stateFor(IDS[2]).match?.requeue).toBeNull();
    db.prepare('UPDATE seasons SET ranks = 1').run();
    expect(mm.stateFor(IDS[2]).match?.requeue).toBe(false);
    setRequeue(db, id, IDS[2], true);
    expect(mm.stateFor(IDS[2]).match?.requeue).toBe(true);
    db.prepare("UPDATE matches SET kind = 'scrim' WHERE id = ?").run(id);
    expect(mm.stateFor(IDS[2]).match?.requeue).toBeNull();
  });
});

describe('PUGRQ parsing', () => {
  const parse = (line: string) => parseLogDatagram(Buffer.from(line, 'utf8'));
  it('reads on and off', () => {
    expect(parse(`PUGRQ steamid=${IDS[0]} match=42 on=1`)).toEqual({ kind: 'requeue', steamid: IDS[0], matchId: 42, on: true });
    expect(parse(`PUGRQ steamid=${IDS[0]} match=42 on=0`)).toMatchObject({ on: false });
  });
  it('drops a bad line', () => {
    expect(parse(`PUGRQ steamid=nope match=42 on=1`)).toBeNull();
    expect(parse(`PUGRQ steamid=${IDS[0]} match=0 on=1`)).toBeNull();
    expect(parse(`PUGRQ steamid=${IDS[0]} match=42 on=yes`)).toBeNull();
  });
});

describe('end note text', () => {
  const entry = (o: Partial<LadderEntry>): LadderEntry => ({
    steamid: IDS[0], mu: 25, sigma: 3, wins: 0, losses: 0, games: 10, sr: 1900, placed: true, rankIdx: 6, peakSr: 1900, peakRankIdx: 6, ...o,
  });

  it('gives the SR change every match, with the rank', () => {
    expect(ratingNote(5, entry({ sr: 1916 }), entry({ sr: 1934, games: 11 }))).toBe('+18 SR, now 1934 (Gold III).');
    expect(ratingNote(5, entry({ sr: 1934 }), entry({ sr: 1912, games: 11 }))).toBe('-22 SR, now 1912 (Gold III).');
  });

  it('calls out a promotion and a drop', () => {
    expect(ratingNote(5, entry({ sr: 1740, rankIdx: 6 }), entry({ sr: 1781, rankIdx: 7, games: 11 }))).toBe('+41 SR, now 1781. Promoted to Gold II!');
    expect(ratingNote(5, entry({ sr: 1620, rankIdx: 6 }), entry({ sr: 1540, rankIdx: 5, games: 11 }))).toBe('-80 SR, now 1540. Down to Silver I.');
  });

  it('shows placement progress, then where they placed, and no rank in a season without ranks', () => {
    expect(ratingNote(5, entry({ placed: false, games: 2, rankIdx: null }), entry({ placed: false, games: 3, rankIdx: null }))).toBe('Placement 3 of 5 done.');
    expect(ratingNote(5, entry({ placed: false, games: 4, rankIdx: null }), entry({ games: 5, sr: 1712, rankIdx: 6 }))).toBe('Placed: Gold III (1712 SR).');
    expect(ratingNote(0, entry({ rankIdx: null }), entry({ sr: 1910, games: 11, rankIdx: null }))).toBe('+10 SR, now 1910.');
  });

  it('says nothing when the match did not rate them', () => {
    expect(ratingNote(5, entry({}), entry({}))).toBeNull();
    expect(ratingNote(5, null, null)).toBeNull();
  });

  it('keeps the text safe as one rcon argument', () => {
    expect(cleanNote('Not requeued: "x"; quit\\ é')).toBe('Not requeued: x quit');
  });
});
