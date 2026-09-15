import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { roundAttribution, unrecordedOrdinals } from '../src/roundStats.js';

const P_A = 'STEAM_0:0:1';
const P_B = 'STEAM_0:0:2';

/** A snapshot with the keys the LIVESTAT line ACTUALLY carries.
 *
 *  The five short keys are the core counters (`ck`, `sidmg`, `sikill`, `ff`,
 *  `rev`); they are columns on match_players, not entries in statKeys.ts, so
 *  an implementation that resolves sides through the registry alone drops
 *  every one of them. These fixtures used registry keys only while claiming to
 *  mirror the live pipeline, which is exactly how that went unnoticed.
 *
 *  `hp` rides the same line and must be dropped: it is a level, not a counter,
 *  so there is no correct half to file it under. */
function liveSnapshot(over: Record<string, number>): string {
  return JSON.stringify({
    hp: 100, ck: 42, sidmg: 1200, sikill: 5, ff: 33, rev: 2,
    tank_damage: 700, damage_as_si: 500, tank_punches: 4,
    skeets: 3, ...over,
  });
}

/** One map, two halves. Team a is survivor in half 1, team b in half 2. */
function matchWithOneMap() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
  db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'no_mercy')").run();
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (1, 0, 1, 'a', 300, '2026-09-11 00:10:00')").run();
  db.prepare("INSERT INTO match_rounds (match_id, ordinal, half, surv_team, score, ended_at) VALUES (1, 0, 2, 'b', 250, '2026-09-11 00:30:00')").run();
  // Cumulative end-of-map snapshot, exactly as the live pipeline writes it.
  // Both players have survivor AND infected keys from the same map, because
  // they each played both sides on it.
  const ins = db.prepare(
    'INSERT INTO match_live_map_stats (match_id, ordinal, player_id, stats_json) VALUES (1, 0, ?, ?)',
  );
  ins.run(P_A, liveSnapshot({}));
  ins.run(P_B, liveSnapshot({ ck: 17, sidmg: 900, sikill: 3, ff: 0, rev: 1, skeets: 1, damage_as_si: 800 }));
  return db;
}

/** The survivor-side keys of the fixture snapshot, for team a. */
const A_SURVIVOR = { ck: 42, sidmg: 1200, sikill: 5, ff: 33, rev: 2, tank_damage: 700, skeets: 3 };
/** And its infected-side keys. */
const A_INFECTED = { damage_as_si: 500, tank_punches: 4 };

const TEAMS = new Map<string, 'a' | 'b'>([[P_A, 'a'], [P_B, 'b']]);

describe('per-round side attribution', () => {
  it('puts a survivor stat only in the round its owner held survivor', () => {
    const rounds = roundAttribution(matchWithOneMap(), 1, TEAMS);
    const h1 = rounds.find((r) => r.half === 1)!;
    const h2 = rounds.find((r) => r.half === 2)!;
    // Team a were survivors in half 1, so their survivor keys belong there.
    expect(h1.byPlayer[P_A]).toEqual(A_SURVIVOR);
    // And their infected keys belong to half 2, when they were infected.
    expect(h2.byPlayer[P_A]).toEqual(A_INFECTED);
  });

  it('attributes the opposing team the other way round', () => {
    const rounds = roundAttribution(matchWithOneMap(), 1, TEAMS);
    const h1 = rounds.find((r) => r.half === 1)!;
    const h2 = rounds.find((r) => r.half === 2)!;
    expect(h1.byPlayer[P_B]).toEqual({ damage_as_si: 800, tank_punches: 4 });
    expect(h2.byPlayer[P_B]).toEqual({
      ck: 17, sidmg: 900, sikill: 3, ff: 0, rev: 1, tank_damage: 700, skeets: 1,
    });
  });

  /** The regression this whole fixture rewrite exists for. These five keys are
   *  not in statKeys.ts, so resolving sides through the registry alone silently
   *  dropped all of them from every round. They are also the only stats a
   *  server without skill_detect produces, so losing them emptied the survivor
   *  half almost completely. */
  it('lands the five core counters in the survivor half, not the infected one', () => {
    const rounds = roundAttribution(matchWithOneMap(), 1, TEAMS);
    const h1 = rounds.find((r) => r.half === 1)!;
    const h2 = rounds.find((r) => r.half === 2)!;
    for (const [key, value] of Object.entries({ ck: 42, sidmg: 1200, sikill: 5, ff: 33, rev: 2 })) {
      expect(h1.byPlayer[P_A][key]).toBe(value);
      expect(h2.byPlayer[P_A]).not.toHaveProperty(key);
    }
  });

  it('drops hp from both halves because a level cannot be side-partitioned', () => {
    const rounds = roundAttribution(matchWithOneMap(), 1, TEAMS);
    expect(rounds[0].byPlayer[P_A]).not.toHaveProperty('hp');
    expect(rounds[1].byPlayer[P_A]).not.toHaveProperty('hp');
  });

  it('drops an unknown stat key rather than guessing its side', () => {
    const db = matchWithOneMap();
    db.prepare('UPDATE match_live_map_stats SET stats_json = ? WHERE player_id = ?')
      .run(JSON.stringify({ ck: 4, not_a_stat: 9 }), P_A);
    const h1 = roundAttribution(db, 1, TEAMS).find((r) => r.half === 1)!;
    expect(h1.byPlayer[P_A]).toEqual({ ck: 4 });
  });

  it('carries the score and ended_at of each round', () => {
    const rounds = roundAttribution(matchWithOneMap(), 1, TEAMS);
    expect(rounds[0].score).toBe(300);
    expect(rounds[0].endedAt).toBe('2026-09-11 00:10:00');
    expect(rounds[1].score).toBe(250);
  });

  it('reports endedAt null for a round that never received a ROUND_END', () => {
    const db = matchWithOneMap();
    db.prepare('UPDATE match_rounds SET ended_at = NULL WHERE half = 2').run();
    const h2 = roundAttribution(db, 1, TEAMS).find((r) => r.half === 2)!;
    // The score column is NOT NULL DEFAULT 0, so a consumer needs endedAt to
    // tell "scored nothing" from "never told us". Both values ride along.
    expect(h2.endedAt).toBeNull();
  });

  it('reports an unreliable round so callers can refuse to show it', () => {
    const db = matchWithOneMap();
    db.prepare('UPDATE match_rounds SET reliable = 0 WHERE half = 1').run();
    const h1 = roundAttribution(db, 1, TEAMS).find((r) => r.half === 1)!;
    expect(h1.reliable).toBe(false);
  });

  it('marks both rounds of an ordinal unreliable when the halves do not partition the sides', () => {
    const db = matchWithOneMap();
    // Both halves recorded as team a holding survivor: recordRoundEnd only
    // warns on this disagreement, it does not prevent it, so the derivation
    // must defend against it rather than trust surv_team blindly.
    db.prepare("UPDATE match_rounds SET surv_team = 'a' WHERE ordinal = 0").run();
    const rounds = roundAttribution(db, 1, TEAMS);
    const h1 = rounds.find((r) => r.half === 1)!;
    const h2 = rounds.find((r) => r.half === 2)!;
    expect(h1.reliable).toBe(false);
    expect(h2.reliable).toBe(false);
  });

  it('returns nothing for a match with no rounds recorded', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    db.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'no_mercy')").run();
    expect(roundAttribution(db, 1, TEAMS)).toEqual([]);
  });
});

describe('unrecordedOrdinals', () => {
  it('is empty for a match with no rounds, and for one whose rounds all hold up', () => {
    const empty = openDb(':memory:');
    empty.prepare("INSERT INTO seasons (name) VALUES ('t')").run();
    empty.prepare("INSERT INTO matches (season_id, state, campaign) VALUES (1, 'completed', 'no_mercy')").run();
    expect(unrecordedOrdinals(empty, 1).size).toBe(0);
    expect(unrecordedOrdinals(matchWithOneMap(), 1).size).toBe(0);
  });

  it('names an ordinal with any stored unreliable round', () => {
    const db = matchWithOneMap();
    db.prepare('UPDATE match_rounds SET reliable = 0 WHERE match_id = 1 AND ordinal = 0 AND half = 2').run();
    expect([...unrecordedOrdinals(db, 1)]).toEqual([0]);
  });

  it('names an ordinal whose two halves fail to partition the sides, as roundAttribution does', () => {
    // Same correction, same answer: the map flag and rounds[].reliable must
    // never disagree about the same ordinal.
    const db = matchWithOneMap();
    db.prepare("UPDATE match_rounds SET surv_team = 'a' WHERE match_id = 1 AND ordinal = 0 AND half = 2").run();
    expect([...unrecordedOrdinals(db, 1)]).toEqual([0]);
    expect(roundAttribution(db, 1, TEAMS).every((r) => !r.reliable)).toBe(true);
  });
});
