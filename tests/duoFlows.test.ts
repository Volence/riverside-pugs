import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import type { Scheduler } from '../src/lobby.js';
import { banPlayer } from '../src/admin/players.js';
import { recordPenalty } from '../src/penalties.js';
import { setRequeue } from '../src/matchRequeue.js';
import { partnerOf } from '../src/duos.js';
import { chooseTeams } from '../src/statBalance.js';
import { validSplits, type RatedPlayer } from '../src/balance.js';

/**
 * Adversarial review 2026-11-02: the duo queue against the features built
 * after it (requeue after a match, abort requeue, restore, staff cancel,
 * the stat tie-break).
 */

class FakeScheduler implements Scheduler {
  timers = new Map<number, () => void>();
  private nextId = 1;
  set(fn: () => void, _ms: number): number { const id = this.nextId++; this.timers.set(id, fn); return id; }
  clear(id: number): void { this.timers.delete(id); }
  fireAll(): void { const fns = [...this.timers.values()]; this.timers.clear(); fns.forEach((fn) => fn()); }
}

const IDS = Array.from({ length: 14 }, (_, i) => `765611980000003${String(i).padStart(2, '0')}`);
const [A, B, C, D] = IDS;
let db: DB;
let mm: Matchmaker;
let sched: FakeScheduler;

function build(): Matchmaker {
  return new Matchmaker(db, {
    broadcast: () => {},
    orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
    scheduler: sched,
    rng: () => 0,
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) { upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []); activatePlayer(db, id); }
  db.prepare('UPDATE seasons SET ranks = 1').run();
  sched = new FakeScheduler();
  mm = build();
});

function duo(a: string, b: string) {
  const inv = mm.inviteDuo(a, b, 'site');
  if (!inv.ok) throw new Error(inv.error);
  const r = mm.acceptDuo(inv.inviteId, b);
  if (!r.ok) throw new Error(r.error);
}

const queued = () => mm.publicQueue().players.map((p) => p.steamid);

/** A completed queue PUG with these eight on it. */
function completedMatch(players: string[]): number {
  const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, kind, origin) VALUES (1, 'live', 'dead_air', 'pug', 'queue')").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  players.forEach((p, i) => ins.run(id, p, i < 4 ? 'a' : 'b'));
  return id;
}
const complete = (id: number) =>
  db.prepare("UPDATE matches SET state = 'completed', ended_at = datetime('now') WHERE id = ?").run(id);

describe('requeue after a match (!rq) with a duo', () => {
  it('both opted in: queued once each, together, at the back', () => {
    duo(A, B);
    mm.join(IDS[10]);
    const id = completedMatch(IDS.slice(0, 8));
    setRequeue(db, id, B, true);
    setRequeue(db, id, A, true);
    complete(id);
    const r = mm.requeueAfterMatch(id);
    expect(r.get(A)).toEqual({ ok: true });
    expect(r.get(B)).toEqual({ ok: true });
    expect(queued()[0]).toBe(IDS[10]);
    expect(queued().slice(1).sort()).toEqual([A, B].sort());
  });

  it('only one opted in: the partner who did not ask is queued too (spec: either member joining adds both)', () => {
    duo(A, B);
    const id = completedMatch(IDS.slice(0, 8));
    setRequeue(db, id, A, true);
    complete(id);
    const r = mm.requeueAfterMatch(id);
    expect([...r.keys()]).toEqual([A]);
    expect(queued()).toEqual([A, B]);
  });

  it('partner banned since: the duo ended at the ban, the one who asked goes back as a solo', () => {
    duo(A, B);
    const id = completedMatch(IDS.slice(0, 8));
    setRequeue(db, id, A, true);
    complete(id);
    banPlayer(db, B, IDS[13], 'test', null);
    mm.remove(B);
    expect(partnerOf(db, A)).toBeNull();
    expect(mm.requeueAfterMatch(id).get(A)).toEqual({ ok: true });
    expect(queued()).toEqual([A]);
  });

  it('partner timed out since: the one who asked is refused with the reason, nobody is queued half', () => {
    duo(A, B);
    const id = completedMatch(IDS.slice(0, 8));
    setRequeue(db, id, A, true);
    complete(id);
    recordPenalty(db, B, 'ready_fail', null);
    const r = mm.requeueAfterMatch(id).get(A);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/duo partner/);
    expect(queued()).toEqual([]);
  });
});

describe('abort requeue with a duo', () => {
  it('both innocent: back at the front together', () => {
    duo(A, B);
    mm.join(IDS[10]);
    expect(mm.requeueAfterAbort([C, A, D, B])).toEqual([C, A, D, B]);
    expect(queued().slice(0, 4)).toEqual([C, A, D, B]);
    expect(mm.publicQueue().duos).toEqual([[A, B]]);
  });

  it('partner is the culprit: the innocent member is not requeued half and is told why', () => {
    duo(A, B);
    expect(mm.requeueAfterAbort([C, A, D])).toEqual([C, D]);
    expect(mm.stateFor(A).queue.joined).toBe(false);
    expect(mm.stateFor(A).lobbyNotice?.duoMissed?.steamid).toBe(B);
  });
});

describe('restore with a duo', () => {
  it('a held pop restores held, and pops on the next join', () => {
    for (const id of IDS.slice(2, 9)) mm.join(id);
    duo(A, B);
    mm.join(A);
    expect(mm.publicQueue().count).toBe(9);
    mm = build();
    mm.restore();
    expect(mm.publicQueue().count).toBe(9);
    expect(mm.publicQueue().duos).toEqual([[A, B]]);
    expect(mm.lobbies()).toHaveLength(0);
    mm.join(IDS[9]);
    expect([...mm.lobbies()[0].snapshot.players].sort()).toEqual(IDS.slice(2, 10).sort());
  });

  it('a duo in a restored ready check still lands on one team', () => {
    duo(A, B);
    mm.join(A);
    for (const id of IDS.slice(2, 8)) mm.join(id);
    expect(mm.lobbies()).toHaveLength(1);
    sched = new FakeScheduler();
    mm = build();
    mm.restore();
    for (const id of mm.lobbies()[0].snapshot.players) mm.ready(id);
    sched.fireAll();
    const t = db.prepare('SELECT player_id, team FROM match_players').all() as { player_id: string; team: string }[];
    expect(t.find((r) => r.player_id === A)!.team).toBe(t.find((r) => r.player_id === B)!.team);
  });
});

describe('staff cancel of a pop with a duo', () => {
  it('excluding one duo member drops the other with a notice', () => {
    duo(A, B);
    mm.join(A);
    for (const id of IDS.slice(2, 8)) mm.join(id);
    const r = mm.cancelLobby(undefined, [B]);
    expect(r.ok).toBe(true);
    expect(mm.stateFor(A).queue.joined).toBe(false);
    expect(mm.stateFor(A).lobbyNotice?.duoMissed?.steamid).toBe(B);
  });
});

describe('the switch going off mid ready check', () => {
  it('the duo is balanced as two solos and stores no bonus', () => {
    duo(A, B);
    mm.join(A);
    for (const id of IDS.slice(2, 8)) mm.join(id);
    setSetting(db, 'duo_queue_enabled', '0');
    for (const id of mm.lobbies()[0].snapshot.players) mm.ready(id);
    sched.fireAll();
    const rows = db.prepare('SELECT duo_partner, duo_bonus FROM match_players').all() as { duo_partner: string | null; duo_bonus: number | null }[];
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.duo_partner === null && r.duo_bonus === null)).toBe(true);
  });
});

describe('several duos in one lobby', () => {
  it('four duos (every slot), in odd partner orders, all land on shared teams', () => {
    duo(A, B);
    duo(IDS[5], C);
    duo(D, IDS[7]);
    duo(IDS[6], IDS[4]);
    mm.join(B);
    mm.join(IDS[5]);
    mm.join(IDS[7]);
    mm.join(IDS[4]);
    expect(mm.lobbies()).toHaveLength(1);
    for (const id of mm.lobbies()[0].snapshot.players) mm.ready(id);
    sched.fireAll();
    const t = new Map((db.prepare('SELECT player_id, team FROM match_players').all() as { player_id: string; team: string }[])
      .map((r) => [r.player_id, r.team]));
    for (const [x, y] of [[A, B], [IDS[5], C], [D, IDS[7]], [IDS[6], IDS[4]]]) expect(t.get(x)).toBe(t.get(y));
  });

  it('the stat tie-break only ever picks a split that keeps every duo together', () => {
    // Pseudo-random mus and stats; tolerance wide open so every valid split
    // is a candidate and the stat side is free to choose any of them.
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let trial = 0; trial < 200; trial++) {
      const players: RatedPlayer[] = IDS.slice(0, 8).map((steamid) => ({ steamid, mu: 20 + rnd() * 15, sigma: 2 + rnd() * 4 }));
      const s = new Map(players.map((p) => [p.steamid, rnd() * 2 - 1]));
      const shuffled = [...IDS.slice(0, 8)].sort(() => rnd() - 0.5);
      const groups: [string, string][] = [];
      const nDuos = 1 + (trial % 4);
      for (let i = 0; i < nDuos; i++) groups.push([shuffled[2 * i], shuffled[2 * i + 1]]);
      const d = chooseTeams(players, s, { enabled: true, gate: 0, tolerance: 1, holdoutEvery: 0 }, { groups, holdout: false });
      for (const sp of [d.chosen, d.ratingBest, ...validSplits(players, { groups })]) {
        for (const [x, y] of groups) expect(sp.teamA.includes(x)).toBe(sp.teamA.includes(y));
      }
    }
  });
});

describe('side games opt-in of a duo member dropped from a failed ready check', () => {
  it('is cleared, so rejoining later does not silently opt them back in', () => {
    duo(A, B);
    mm.join(A);
    mm.setSideOptIn(A, true);
    for (const id of IDS.slice(2, 8)) mm.join(id);
    for (const id of mm.lobbies()[0].snapshot.players) if (id !== B) mm.ready(id);
    sched.fireAll(); // B misses ready; A is not requeued
    expect(mm.stateFor(A).queue.joined).toBe(false);
    mm.join(A);
    expect(mm.isSideOptedIn(A)).toBe(false);
  });
});
