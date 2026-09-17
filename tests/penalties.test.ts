import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { setSetting } from '../src/settings.js';
import { Matchmaker } from '../src/matchmaker.js';
import { reapNoShowMatches } from '../src/noShow.js';
import { recordPenalty, activeTimeout, clearPenalties, penaltyHistory } from '../src/penalties.js';
import type { Scheduler } from '../src/lobby.js';

const IDS = Array.from({ length: 8 }, (_, i) => `7656119800000000${i + 1}`);
const P = IDS[0];
const T0 = new Date('2026-09-18T12:00:00Z');
const plus = (min: number) => new Date(T0.getTime() + min * 60_000);

class FakeScheduler implements Scheduler {
  timers = new Map<number, () => void>();
  private n = 1;
  set(fn: () => void): number { const id = this.n++; this.timers.set(id, fn); return id; }
  clear(id: number): void { this.timers.delete(id); }
  fireAll(): void { const f = [...this.timers.values()]; this.timers.clear(); f.forEach((x) => x()); }
}

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  for (const id of IDS) { upsertPlayer(db, { steamid: id, name: id.slice(-1), avatar: null }, []); activatePlayer(db, id); }
});

describe('timeout ladder', () => {
  it('5, 15, 60, then 1440 minutes, measured from the latest offense', () => {
    expect(activeTimeout(db, P, T0)).toBeNull();
    const expected = [5, 15, 60, 1440, 1440];
    let t = T0;
    for (const mins of expected) {
      recordPenalty(db, P, 'ready_fail', null, t);
      const to = activeTimeout(db, P, t)!;
      expect(Math.round((to.until.getTime() - t.getTime()) / 60_000)).toBe(mins);
      t = new Date(to.until.getTime() + 1000);
      expect(activeTimeout(db, P, t)).toBeNull();
    }
  });

  it('offenses older than the window stop counting', () => {
    recordPenalty(db, P, 'no_show', null, T0);
    recordPenalty(db, P, 'no_show', null, plus(60));
    const later = plus(8 * 24 * 60 + 61);
    recordPenalty(db, P, 'no_show', null, later);
    const to = activeTimeout(db, P, later)!;
    expect(to.offenses).toBe(1);
    expect(Math.round((to.until.getTime() - later.getTime()) / 60_000)).toBe(5);
  });

  it('cleared offenses do not count, and history keeps them marked', () => {
    recordPenalty(db, P, 'no_show', 3, T0);
    clearPenalties(db, P, IDS[7], T0);
    expect(activeTimeout(db, P, T0)).toBeNull();
    expect(penaltyHistory(db, P)[0]).toMatchObject({ kind: 'no_show', matchId: 3, clearedBy: IDS[7] });
  });

  it('disabled means no timeout and nothing recorded', () => {
    setSetting(db, 'penalties_enabled', '0');
    recordPenalty(db, P, 'no_show', null, T0);
    expect(penaltyHistory(db, P)).toEqual([]);
    expect(activeTimeout(db, P, T0)).toBeNull();
  });
});

describe('penalty sources', () => {
  it('a failed ready check penalises only the players who did not ready', () => {
    const sched = new FakeScheduler();
    const mm = new Matchmaker(db, { broadcast: () => {}, orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} }, scheduler: sched });
    for (const id of IDS) mm.join(id);
    mm.ready(IDS[0]);
    mm.ready(IDS[1]);
    sched.fireAll();
    expect(penaltyHistory(db, IDS[0])).toEqual([]);
    for (const id of IDS.slice(2)) expect(penaltyHistory(db, id).map((p) => p.kind)).toEqual(['ready_fail']);
  });

  it('a timed-out player cannot join, from any surface', () => {
    const mm = new Matchmaker(db, { broadcast: () => {}, orchestrator: { setupMatch: async () => {}, finishMatch: async () => {} } });
    recordPenalty(db, P, 'no_show', null);
    const r = mm.join(P);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/i);
    expect(mm.stateFor(P).timeout?.offenses).toBe(1);
    expect(mm.publicQueue().count).toBe(0);
  });

  it('the no-show reaper penalises rostered players who never connected, when it aborts for too few connected', () => {
    const release = { release: () => {} } as never;
    const id = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, went_live_at) VALUES (1, 'live', 'dead_air', datetime('now', '-20 minutes'))",
    ).run().lastInsertRowid);
    const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team, connected_at) VALUES (?, ?, ?, ?)');
    IDS.forEach((p, i) => ins.run(id, p, i < 4 ? 'a' : 'b', i < 3 ? "2026-09-18 12:00:00" : null));
    expect(reapNoShowMatches(db, release)).toEqual([id]);
    expect(penaltyHistory(db, IDS[0])).toEqual([]);
    for (const p of IDS.slice(3)) expect(penaltyHistory(db, p)).toMatchObject([{ kind: 'no_show', matchId: id }]);
  });

  it('the no-round rule (everyone connected, nobody readied) penalises nobody', () => {
    const release = { release: () => {} } as never;
    const id = Number(db.prepare(
      "INSERT INTO matches (season_id, state, campaign, went_live_at) VALUES (1, 'live', 'dead_air', datetime('now', '-40 minutes'))",
    ).run().lastInsertRowid);
    const ins = db.prepare("INSERT INTO match_players (match_id, player_id, team, connected_at) VALUES (?, ?, ?, '2026-09-18 12:00:00')");
    IDS.forEach((p, i) => ins.run(id, p, i < 4 ? 'a' : 'b'));
    expect(reapNoShowMatches(db, release)).toEqual([id]);
    for (const p of IDS) expect(penaltyHistory(db, p)).toEqual([]);
  });
});
