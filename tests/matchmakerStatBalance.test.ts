import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { Matchmaker } from '../src/matchmaker.js';
import { upsertPlayer, activatePlayer, getRatings } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { balanceTeams } from '../src/balance.js';
import type { Scheduler } from '../src/lobby.js';

class FakeScheduler implements Scheduler {
  timers = new Map<number, () => void>();
  private nextId = 1;
  set(fn: () => void, _ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, fn);
    return id;
  }
  clear(id: number): void { this.timers.delete(id); }
  fireAll(): void {
    const fns = [...this.timers.values()];
    this.timers.clear();
    fns.forEach((fn) => fn());
  }
}

const IDS = Array.from({ length: 8 }, (_, i) => `765611980000002${String(i).padStart(2, '0')}`);
// The first two in the queue are the damage stars.
const [S1, S2] = IDS;
let db: DB;
let mm: Matchmaker;
let sched: FakeScheduler;

beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) { upsertPlayer(db, { steamid: id, name: `n${id.slice(-2)}`, avatar: null }, []); activatePlayer(db, id); }
  // Three past PUGs each: the stars did 9000 SI damage a game, everyone else 3000.
  for (let g = 0; g < 3; g++) {
    const id = Number(db.prepare("INSERT INTO matches (season_id, state, campaign, kind) VALUES (1, 'completed', 'no_mercy', 'pug')").run().lastInsertRowid);
    IDS.forEach((p, i) => db.prepare('INSERT INTO match_players (match_id, player_id, team, si_damage) VALUES (?, ?, ?, ?)')
      .run(id, p, i % 2 ? 'b' : 'a', p === S1 || p === S2 ? 9000 : 3000));
  }
  sched = new FakeScheduler();
  mm = new Matchmaker(db, {
    broadcast: () => {},
    orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} },
    scheduler: sched,
    rng: () => 0,
  });
});

function pop(): { id: number; teamA: string[] } {
  for (const id of IDS) mm.join(id);
  for (const id of mm.lobbies()[0].snapshot.players) mm.ready(id);
  sched.fireAll(); // campaign vote closes
  const m = db.prepare("SELECT id FROM matches WHERE origin = 'queue' ORDER BY id DESC LIMIT 1").get() as { id: number };
  const teamA = (db.prepare("SELECT player_id FROM match_players WHERE match_id = ? AND team = 'a'").all(m.id) as { player_id: string }[])
    .map((r) => r.player_id);
  return { id: m.id, teamA };
}

const together = (teamA: string[], x: string, y: string) => teamA.includes(x) === teamA.includes(y);

describe('stat-aware balance at the queue pop', () => {
  it('off: the teams are the rating split and the match is still logged', () => {
    const ratings = getRatings(db, IDS);
    const expected = balanceTeams(IDS.map((s) => ({ steamid: s, mu: ratings.get(s)!.mu, sigma: ratings.get(s)!.sigma })));
    const { id, teamA } = pop();
    expect(new Set(teamA)).toEqual(new Set(expected.teamA.includes(teamA[0]) ? expected.teamA : expected.teamB));
    // Equal ratings put the first two in the queue, the stars, together.
    expect(together(teamA, S1, S2)).toBe(true);
    const row = db.prepare('SELECT * FROM match_balance_log WHERE match_id = ?').get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ enabled: 0, over_gate: 1, gate_fired: 0, moved: 0 });
    const players = JSON.parse(String(row.players_json)) as { steamid: string; games: number; rawPerGame: number; s: number }[];
    expect(players).toHaveLength(8);
    expect(players.find((p) => p.steamid === S1)).toMatchObject({ games: 3, rawPerGame: 9000 });
    expect(players.find((p) => p.steamid === S1)!.s).toBeGreaterThan(0);
  });

  it('on: the stars are split and the move is logged', () => {
    setSetting(db, 'balance_stats_enabled', '1');
    const { id, teamA } = pop();
    expect(together(teamA, S1, S2)).toBe(false);
    const row = db.prepare('SELECT * FROM match_balance_log WHERE match_id = ?').get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ enabled: 1, over_gate: 1, gate_fired: 1, moved: 2 });
    expect(Math.abs(Number(row.chosen_stat_a) - 0.5)).toBeLessThan(Math.abs(Number(row.best_stat_a) - 0.5));
  });
});
