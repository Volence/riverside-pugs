import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { addServer } from '../src/serverPool.js';
import type { Scheduler } from '../src/lobby.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);

class FakeScheduler implements Scheduler {
  timers = new Map<number, () => void>();
  private nextId = 1;
  set(fn: () => void, _ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, fn);
    return id;
  }
  clear(id: number): void {
    this.timers.delete(id);
  }
  fireAll(): void {
    const fns = [...this.timers.values()];
    this.timers.clear();
    fns.forEach((fn) => fn());
  }
}

let db: DB;
let mm: Matchmaker;
let sched: FakeScheduler;
let broadcasts: number;
let setupCalls: number[];

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) upsertPlayer(db, { steamid: id, name: `n${id.slice(-1)}`, avatar: null }, []);
  sched = new FakeScheduler();
  broadcasts = 0;
  setupCalls = [];
  mm = new Matchmaker(db, {
    broadcast: () => broadcasts++,
    orchestrator: { setupMatch: async (id) => void setupCalls.push(id), finishMatch: async () => {} },
    scheduler: sched,
    rng: () => 0,
  });
});

function fillQueue() {
  for (const id of IDS) mm.join(id);
}

/** The bare db/mm from beforeEach, handed back by name for readability at the
 *  call site rather than reaching for the module-level bindings directly. */
function fixture(): { db: DB; mm: Matchmaker } {
  return { db, mm };
}

/** A live match with a claimed server and a full roster, for the connect-block
 *  tests. The token is fixed so the expected derived password is fixed too. */
function fixtureWithLiveMatch(): { db: DB; mm: Matchmaker; matchId: number } {
  const serverId = addServer(db, {
    name: 's1',
    host: '10.0.0.1',
    port: 27015,
    rconPort: 27115,
    rconPassword: 'rconpw',
    status: 'live',
  });
  const season = db.prepare('SELECT id FROM seasons ORDER BY id LIMIT 1').get() as { id: number };
  const token = 'abcdef1234567890';
  const matchId = Number(
    db
      .prepare(
        `INSERT INTO matches (season_id, state, campaign, server_id, token)
         VALUES (?, 'live', 'dead_air', ?, ?)`,
      )
      .run(season.id, serverId, token).lastInsertRowid,
  );
  const insertMp = db.prepare(
    'INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)',
  );
  IDS.forEach((id, i) => insertMp.run(matchId, id, i < 4 ? 'a' : 'b'));
  return { db, mm, matchId };
}

describe('Matchmaker', () => {
  it('starts a lobby at 8 players', () => {
    fillQueue();
    const st = mm.stateFor(IDS[0]);
    expect(st.lobby?.phase).toBe('ready_check');
    expect(st.queue.count).toBe(0);
  });

  it('runs ready -> vote -> match creation with 4v4 teams', () => {
    fillQueue();
    for (const id of IDS) mm.ready(id);
    for (const id of IDS) mm.vote(id, 'dead_air');
    const match = db.prepare('SELECT * FROM matches').get() as any;
    expect(match.state).toBe('configuring');
    expect(match.campaign).toBe('dead_air');
    const mps = db.prepare('SELECT * FROM match_players WHERE match_id = ?').all(match.id) as any[];
    expect(mps).toHaveLength(8);
    expect(mps.filter((r) => r.team === 'a')).toHaveLength(4);
    expect(setupCalls).toEqual([match.id]);
    const st = mm.stateFor(IDS[0]);
    expect(st.lobby).toBeNull();
    expect(st.match?.campaign).toBe('dead_air');
    expect(st.match?.teamA).toHaveLength(4);
  });

  it('returns ready players to queue front on failed ready check', () => {
    fillQueue();
    mm.ready(IDS[0]);
    mm.ready(IDS[1]);
    sched.fireAll();
    const st = mm.stateFor(IDS[0]);
    expect(st.lobby).toBeNull();
    expect(st.queue.count).toBe(2);
    expect(st.queue.joined).toBe(true);
    expect(mm.stateFor(IDS[2]).queue.joined).toBe(false);
  });

  it('blocks joining while in a lobby', () => {
    fillQueue();
    expect(mm.join(IDS[0]).ok).toBe(false);
  });

  it('blocks joining while in an open match', () => {
    fillQueue();
    for (const id of IDS) mm.ready(id);
    for (const id of IDS) mm.vote(id, 'dead_air');
    const res = mm.join(IDS[0]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('already in an active match');
    db.prepare("UPDATE matches SET state = 'aborted'").run();
    expect(mm.join(IDS[0]).ok).toBe(true);
  });

  it('notifies at queue thresholds and on queue pop', () => {
    const notifications: string[] = [];
    const notifyMm = new Matchmaker(db, {
      broadcast: () => broadcasts++,
      orchestrator: { setupMatch: async (id) => void setupCalls.push(id), finishMatch: async () => {} },
      scheduler: sched,
      rng: () => 0,
      notify: (msg) => notifications.push(msg),
    });
    for (const id of IDS) notifyMm.join(id);
    expect(notifications).toContain('🧟 4/8 in queue');
    expect(notifications).toContain('🔔 Queue popped, ready check started!');
  });

  it('join succeeds and skips the notify when discord_queue_thresholds is malformed JSON', () => {
    setSetting(db, 'discord_queue_thresholds', '[4,6');
    const notifications: string[] = [];
    const notifyMm = new Matchmaker(db, {
      broadcast: () => broadcasts++,
      orchestrator: { setupMatch: async (id) => void setupCalls.push(id), finishMatch: async () => {} },
      scheduler: sched,
      rng: () => 0,
      notify: (msg) => notifications.push(msg),
    });
    const res = notifyMm.join(IDS[0]);
    expect(res.ok).toBe(true);
    expect(notifications).toEqual([]);
  });
});

describe('stateFor connect details', () => {
  it('gives a rostered player the connect block once the match is live', () => {
    const { db, mm } = fixtureWithLiveMatch();
    const snap = mm.stateFor(IDS[0]);
    expect(snap.match!.connect).toEqual({
      host: '10.0.0.1', port: 27015, password: 'pug_abcdef12',
    });
  });

  it('withholds the connect block while the match is still configuring', () => {
    const { db, mm, matchId } = fixtureWithLiveMatch();
    db.prepare("UPDATE matches SET state = 'configuring' WHERE id = ?").run(matchId);
    expect(mm.stateFor(IDS[0]).match!.connect).toBeNull();
  });

  it('lists who is in the queue, with avatars', () => {
    const { db, mm } = fixture();
    db.prepare('UPDATE players SET avatar = ? WHERE steamid = ?').run('http://a/1.jpg', IDS[0]);
    mm.join(IDS[0]);
    const snap = mm.stateFor(IDS[0]);
    expect(snap.queue.players).toEqual([
      { steamid: IDS[0], name: expect.any(String), avatar: 'http://a/1.jpg' },
    ]);
  });

  it('flags a match that is waiting for a free server', () => {
    const { db, mm, matchId } = fixtureWithLiveMatch();
    db.prepare("UPDATE matches SET state = 'configuring', server_id = NULL WHERE id = ?").run(matchId);
    expect(mm.stateFor(IDS[0]).match!.waitingForServer).toBe(true);
  });
});
