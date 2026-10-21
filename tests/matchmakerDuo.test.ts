import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker, DUO_OFF } from '../src/matchmaker.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { partnerOf } from '../src/duos.js';
import type { Scheduler } from '../src/lobby.js';
import { banPlayer } from '../src/admin/players.js';

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

const IDS = Array.from({ length: 10 }, (_, i) => `765611980000001${String(i).padStart(2, '0')}`);
const [A, B] = IDS;
let db: DB;
let mm: Matchmaker;
let sched: FakeScheduler;
const blocked = new Set<string>();

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) { upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []); activatePlayer(db, id); }
  db.prepare('UPDATE seasons SET ranks = 1').run();
  blocked.clear();
  sched = new FakeScheduler();
  mm = new Matchmaker(db, {
    broadcast: () => {},
    orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
    scheduler: sched,
    rng: () => 0,
    queueGate: (s) => (blocked.has(s) ? 'link_discord' : null),
  });
});

function duo(a = A, b = B) {
  const inv = mm.inviteDuo(a, b, 'site');
  if (!inv.ok) throw new Error(inv.error);
  const r = mm.acceptDuo(inv.inviteId, b);
  if (!r.ok) throw new Error(r.error);
}

describe('duo invites through the matchmaker', () => {
  it('refuses before Season 1', () => {
    db.prepare('UPDATE seasons SET ranks = 0').run();
    expect(mm.inviteDuo(A, B, 'site')).toEqual({ ok: false, error: DUO_OFF });
  });

  it('shows the invite to both sides and the partner after accepting', () => {
    const inv = mm.inviteDuo(A, B, 'site');
    if (!inv.ok) throw new Error(inv.error);
    expect(mm.stateFor(B).duo!.incoming.map((i) => i.from.steamid)).toEqual([A]);
    expect(mm.stateFor(A).duo!.outgoing!.to.steamid).toBe(B);
    mm.acceptDuo(inv.inviteId, B);
    expect(mm.stateFor(A).duo!.partner!.steamid).toBe(B);
  });

  it('state.duo is null when the switch is off', () => {
    setSetting(db, 'duo_queue_enabled', '0');
    expect(mm.stateFor(A).duo).toBeNull();
  });
});

describe('queueing as a duo', () => {
  it('either member joining queues both, leaving removes both', () => {
    duo();
    expect(mm.join(B)).toEqual({ ok: true });
    expect(mm.stateFor(A).queue.joined).toBe(true);
    expect(mm.stateFor(A).queue.duos).toEqual([[B, A]]);
    mm.leave(A);
    expect(mm.stateFor(B).queue.joined).toBe(false);
  });

  it('a blocked partner stops the join and nobody is queued', () => {
    duo();
    blocked.add(B);
    const r = mm.join(A);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/your duo partner .* cannot queue/);
    expect(mm.publicQueue().count).toBe(0);
  });

  it('forming a duo while one is queued puts both at the back', () => {
    mm.join(A);
    mm.join(IDS[2]);
    duo();
    expect(mm.publicQueue().players.map((p) => p.steamid)).toEqual([IDS[2], A, B]);
  });

  it('accepting refuses when the other one cannot queue but one of them is queued', () => {
    mm.join(A);
    blocked.add(B);
    const inv = mm.inviteDuo(A, B, 'site');
    if (!inv.ok) throw new Error(inv.error);
    expect(mm.acceptDuo(inv.inviteId, B).ok).toBe(false);
    expect(partnerOf(db, A)).toBeNull();
  });

  it('7 solos then a duo joins: pops now with the duo, the newest solo goes to the front', () => {
    for (const id of IDS.slice(2, 9)) mm.join(id); // 7 solos, IDS[8] joined last
    duo();
    mm.join(A); // 9 queued: the duo cannot fit behind 7 solos
    const lobby = mm.lobbies()[0].snapshot.players;
    expect(lobby).toContain(A);
    expect(lobby).toContain(B);
    expect(lobby).not.toContain(IDS[8]);
    expect(mm.publicQueue().players.map((p) => p.steamid)).toEqual([IDS[8]]);
  });

  it('when the partner misses ready, the ready one is not requeued and is told why', () => {
    duo();
    mm.join(A);
    for (const id of IDS.slice(2, 8)) mm.join(id);
    const lobby = mm.lobbies()[0].snapshot.players;
    for (const id of lobby) if (id !== B) mm.ready(id);
    sched.fireAll(); // ready check times out with B not ready
    expect(mm.stateFor(A).queue.joined).toBe(false);
    expect(mm.stateFor(A).lobbyNotice!.duoMissed!.steamid).toBe(B);
    expect(mm.stateFor(IDS[2]).queue.joined).toBe(true);
  });

  it('with the switch off a queued duo pops as solos without errors', () => {
    duo();
    mm.join(A);
    setSetting(db, 'duo_queue_enabled', '0');
    for (const id of IDS.slice(2, 8)) mm.join(id);
    expect(mm.lobbies()).toHaveLength(1);
    expect(mm.stateFor(A).duo).toBeNull();
  });

  it('a staff removal ends the duo and leaves the partner queued as a solo', () => {
    duo();
    mm.join(A);
    mm.remove(A);
    expect(partnerOf(db, B)).toBeNull();
    expect(mm.stateFor(B).queue.joined).toBe(true);
  });

  it('ending a duo while queued keeps both queued as solos', () => {
    duo();
    mm.join(A);
    expect(mm.endDuo(B)).toEqual({ ok: true });
    expect(mm.publicQueue().count).toBe(2);
    expect(mm.publicQueue().duos).toEqual([]);
  });
});

describe('standing and staff action on a duo', () => {
  const penalties = (id: string) =>
    (db.prepare("SELECT COUNT(*) AS n FROM penalties WHERE player_id = ? AND kind = 'ready_fail'").get(id) as { n: number }).n;

  it('a partner banned while idle stops the other from queueing', () => {
    duo();
    banPlayer(db, B, 'admin', 'cheating', null);
    const r = mm.join(A);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/your duo partner .* cannot queue/);
    expect(mm.publicQueue().count).toBe(0);
  });

  it('an inviter banned before the accept forms no duo', () => {
    const inv = mm.inviteDuo(A, B, 'site');
    if (!inv.ok) throw new Error(inv.error);
    banPlayer(db, A, 'admin', 'cheating', null);
    const r = mm.acceptDuo(inv.inviteId, B);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot duo right now/);
    expect(partnerOf(db, B)).toBeNull();
  });

  it('removing an idle duo member ends the duo', () => {
    duo();
    mm.remove(A);
    expect(partnerOf(db, B)).toBeNull();
  });

  // The partner's page shows the duo, so ending it must reach them even
  // though nobody's queue or lobby changed.
  it('removing an idle duo member tells every surface', () => {
    duo();
    let changes = 0;
    mm.on({ stateChanged: () => { changes++; } });
    mm.remove(A);
    expect(changes).toBe(1);
  });

  it('staff taking a duo member out of the queue takes both and tells the partner', () => {
    duo();
    mm.join(A);
    mm.join(IDS[2]);
    mm.staffRemoveFromQueue(A);
    expect(mm.publicQueue().players.map((p) => p.steamid)).toEqual([IDS[2]]);
    expect(partnerOf(db, B)).toBe(A);
    expect(mm.stateFor(B).lobbyNotice!.duoMissed!.steamid).toBe(A);
    expect(mm.stateFor(A).lobbyNotice).toBeNull();
  });

  it('staff taking a solo out of the queue leaves no notice', () => {
    mm.join(IDS[2]);
    mm.join(IDS[3]);
    mm.staffRemoveFromQueue(IDS[2]);
    expect(mm.publicQueue().players.map((p) => p.steamid)).toEqual([IDS[3]]);
    expect(mm.stateFor(IDS[3]).lobbyNotice).toBeNull();
  });

  it('a duo that readied goes back to the front together when someone else misses', () => {
    duo();
    mm.join(A);
    for (const id of IDS.slice(2, 8)) mm.join(id);
    const lobby = mm.lobbies()[0].snapshot.players;
    for (const id of lobby) if (id !== IDS[2]) mm.ready(id);
    sched.fireAll();
    const order = mm.publicQueue().players.map((p) => p.steamid);
    expect(order).toEqual([A, B, ...IDS.slice(3, 8)]);
    expect(mm.publicQueue().duos).toEqual([[A, B]]);
    expect(penalties(IDS[2])).toBe(1);
    expect(penalties(A)).toBe(0);
    expect(penalties(B)).toBe(0);
  });

  it('only the partner who missed ready is penalised, not the one who readied', () => {
    duo();
    mm.join(A);
    for (const id of IDS.slice(2, 8)) mm.join(id);
    for (const id of mm.lobbies()[0].snapshot.players) if (id !== B) mm.ready(id);
    sched.fireAll();
    expect(penalties(B)).toBe(1);
    expect(penalties(A)).toBe(0);
  });
});

describe('duo pop skips', () => {
  const skips = () => (db.prepare('SELECT COUNT(*) AS n FROM duo_pop_skips').get() as { n: number }).n;

  it('records a duo passed over at a pop, one row per duo', () => {
    const X = '76561198000000199';
    upsertPlayer(db, { steamid: X, name: 'nX', avatar: null }, []);
    activatePlayer(db, X);
    for (const id of IDS.slice(2, 10)) mm.join(id);
    duo();
    mm.join(A);
    mm.join(X);
    for (const id of IDS.slice(2, 9)) mm.ready(id);
    sched.fireAll(); // IDS[9] misses; 7 go back in front of the duo and X
    expect(mm.lobbies()[0].snapshot.players).not.toContain(A);
    expect(skips()).toBe(1);
  });

  it('records nothing when the duo is swapped in', () => {
    for (const id of IDS.slice(2, 9)) mm.join(id);
    duo();
    mm.join(A);
    expect(mm.lobbies()[0].snapshot.players).toContain(A);
    expect(skips()).toBe(0);
  });
});

describe('lobby completion with a duo', () => {
  it('puts the duo on one team and stores partner and bonus', () => {
    duo();
    mm.join(A);
    for (const id of IDS.slice(2, 8)) mm.join(id);
    for (const id of mm.lobbies()[0].snapshot.players) mm.ready(id);
    sched.fireAll(); // campaign vote closes
    const rows = db.prepare('SELECT player_id, team, duo_partner, duo_bonus FROM match_players').all() as
      { player_id: string; team: string; duo_partner: string | null; duo_bonus: number | null }[];
    const a = rows.find((r) => r.player_id === A)!;
    const b = rows.find((r) => r.player_id === B)!;
    expect(a.team).toBe(b.team);
    expect(a.duo_partner).toBe(B);
    expect(b.duo_partner).toBe(A);
    expect(a.duo_bonus).toBeGreaterThan(0);
    expect(a.duo_bonus).toBe(b.duo_bonus);
    expect(rows.filter((r) => r.duo_partner === null)).toHaveLength(6);
  });
});
