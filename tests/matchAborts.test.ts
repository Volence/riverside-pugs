import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { Matchmaker } from '../src/matchmaker.js';
import { recordPenalty } from '../src/penalties.js';
import { banPlayer } from '../src/admin/players.js';
import { abortNoticeFor, anyRequeued, dismissAbortNotices, noteMatchAborted, subscribeMatchAborts } from '../src/matchAborts.js';
import type { Scheduler } from '../src/lobby.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000001${i}`);
const EXTRA = Array.from({ length: 3 }, (_, i) => `7656119800000002${i}`);

class FakeScheduler implements Scheduler {
  timers = new Map<number, () => void>();
  private n = 1;
  set(fn: () => void): number { const id = this.n++; this.timers.set(id, fn); return id; }
  clear(id: number): void { this.timers.delete(id); }
}

let db: DB;
let mm: Matchmaker;
let off: () => void;
let blocked: Set<string>;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of [...IDS, ...EXTRA]) { upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []); activatePlayer(db, id); }
  blocked = new Set();
  mm = new Matchmaker(db, {
    broadcast: () => {}, orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
    scheduler: new FakeScheduler(),
    queueGate: (s) => blocked.has(s) ? 'link_discord' : null,
  });
  // The same wiring server.ts does.
  off = subscribeMatchAborts((e) => (e.db === db ? mm.requeueAfterAbort(e.requeueIds) : undefined));
});
afterEach(() => off());

function abortedMatch(): number {
  const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, ended_at) VALUES (1, 'aborted', 'dead_air', datetime('now'))").run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  IDS.forEach((p, i) => ins.run(id, p, i < 4 ? 'a' : 'b'));
  return id;
}

describe('noteMatchAborted', () => {
  it('puts the blameless back at the FRONT of the queue, in roster order, and tells everyone', () => {
    mm.join(EXTRA[0]);
    const id = abortedMatch();
    noteMatchAborted(db, { matchId: id, cause: 'abandon', culprits: [IDS[2]], requeue: true });
    const queued = mm.publicQueue().players.map((p) => p.steamid);
    // Seven back plus the one already waiting is a full queue, so it pops.
    expect(queued).toEqual([]);
    expect(mm.lobbyMembers().sort()).toEqual([...IDS.filter((p) => p !== IDS[2]), EXTRA[0]].sort());
    expect(abortNoticeFor(db, IDS[0])).toMatchObject({ matchId: id, cause: 'abandon', role: 'innocent', requeued: true });
    expect(abortNoticeFor(db, IDS[2])).toMatchObject({ matchId: id, role: 'culprit', requeued: false });
    expect(abortNoticeFor(db, IDS[0])!.reason).not.toMatch(/n1/);
    expect(anyRequeued(db, id)).toBe(true);
  });

  it('keeps out anyone who may not queue: banned, timed out, or missing the Discord requirement', () => {
    const id = abortedMatch();
    banPlayer(db, IDS[0], 'admin', 'cheating', null);
    recordPenalty(db, IDS[1], 'ready_fail', null);
    blocked.add(IDS[3]);
    noteMatchAborted(db, { matchId: id, cause: 'admin', requeue: true });
    expect(mm.publicQueue().players.map((p) => p.steamid)).toEqual(IDS.filter((p) => ![IDS[0], IDS[1], IDS[3]].includes(p)));
    expect(abortNoticeFor(db, IDS[1])).toMatchObject({ role: 'innocent', requeued: false });
    expect(abortNoticeFor(db, IDS[4])).toMatchObject({ requeued: true });
  });

  it('requeues nobody when told not to, but still leaves the notice', () => {
    const id = abortedMatch();
    noteMatchAborted(db, { matchId: id, cause: 'uncollected', requeue: false });
    expect(mm.publicQueue().count).toBe(0);
    expect(abortNoticeFor(db, IDS[5])).toMatchObject({ cause: 'uncollected', requeued: false });
    expect(anyRequeued(db, id)).toBe(false);
  });

  it('a file check reject is neither a culprit nor requeued', () => {
    const id = abortedMatch();
    noteMatchAborted(db, { matchId: id, cause: 'no_show', culprits: [IDS[7]], fileCheck: [IDS[6]], requeue: true });
    expect(mm.publicQueue().players.map((p) => p.steamid)).toEqual(IDS.slice(0, 6));
    expect(abortNoticeFor(db, IDS[6])).toMatchObject({ role: 'file_check', requeued: false });
  });

  it('the notice survives until dismissed, and dismissing clears it', () => {
    const id = abortedMatch();
    noteMatchAborted(db, { matchId: id, cause: 'server_lost', requeue: false });
    expect(mm.stateFor(IDS[0]).abortNotice).toMatchObject({ matchId: id });
    dismissAbortNotices(db, IDS[0]);
    expect(mm.stateFor(IDS[0]).abortNotice).toBeNull();
    expect(mm.stateFor(IDS[1]).abortNotice).toMatchObject({ matchId: id });
  });

  it('never requeues the roster of a match started in game', () => {
    const id = abortedMatch();
    db.prepare("UPDATE matches SET origin = 'in_game' WHERE id = ?").run(id);
    noteMatchAborted(db, { matchId: id, cause: 'server_lost', requeue: true });
    expect(mm.publicQueue().count).toBe(0);
    expect(abortNoticeFor(db, IDS[0])).toMatchObject({ requeued: false });
  });

  it('ignores an abort in another database', () => {
    const other = openDb(':memory:');
    for (const p of IDS) { upsertPlayer(other, { steamid: p, name: p, avatar: null }, []); activatePlayer(other, p); }
    const id = Number(other.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'aborted', 'dead_air')").run().lastInsertRowid);
    other.prepare("INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, 'a')").run(id, IDS[0]);
    noteMatchAborted(other, { matchId: id, cause: 'admin', requeue: true });
    expect(mm.publicQueue().count).toBe(0);
  });
});

describe('Matchmaker.cancelLobby', () => {
  const popped = () => {
    for (const p of IDS) mm.join(p);
    expect(mm.lobbies()).toHaveLength(1);
  };

  it('cancels a ready check: everyone back at the front, nobody penalised, the excluded left out', () => {
    mm.join(EXTRA[0]);
    for (const p of IDS.slice(1)) mm.join(p);
    // The queue popped on the eighth: EXTRA[0] + seven. One more waits behind.
    mm.join(IDS[0]);
    expect(mm.publicQueue().players.map((p) => p.steamid)).toEqual([IDS[0]]);
    // Two left out, so the six back and the one waiting are not a new pop.
    const r = mm.cancelLobby(undefined, [IDS[3], IDS[4]]);
    expect(r).toMatchObject({ ok: true, excluded: [IDS[3], IDS[4]] });
    expect(mm.lobbies()).toHaveLength(0);
    const queued = mm.publicQueue().players.map((p) => p.steamid);
    expect(queued).toEqual([EXTRA[0], ...IDS.slice(1).filter((p) => p !== IDS[3] && p !== IDS[4]), IDS[0]]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM penalties').get()).toEqual({ n: 0 });
    expect(mm.stateFor(IDS[1]).lobbyNotice).toMatchObject({ cancelled: true });
    expect(mm.stateFor(IDS[3]).lobbyNotice).toBeNull();
  });

  it('cancels a campaign vote the same way', () => {
    popped();
    for (const p of IDS) mm.ready(p);
    expect(mm.lobbies()[0].snapshot.phase).toBe('map_vote');
    const first = mm.lobbies()[0].id;
    expect(mm.cancelLobby(first, [IDS[0]])).toMatchObject({ ok: true, requeued: IDS.slice(1) });
    expect(mm.lobbies()).toHaveLength(0);
    expect(mm.publicQueue().count).toBe(7);
  });

  it('with nobody left out and a full queue, a fresh ready check starts at once', () => {
    popped();
    const first = mm.lobbies()[0].id;
    expect(mm.cancelLobby()).toMatchObject({ ok: true });
    expect(mm.lobbies()).toHaveLength(1);
    expect(mm.lobbies()[0].id).not.toBe(first);
    expect(mm.lobbies()[0].snapshot.phase).toBe('ready_check');
  });

  it('refuses when nothing is running, and for an unknown id', () => {
    expect(mm.cancelLobby()).toMatchObject({ ok: false });
    popped();
    expect(mm.cancelLobby('lob_nope')).toMatchObject({ ok: false });
  });
});
