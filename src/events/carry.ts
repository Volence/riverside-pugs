import type { DB } from '../db.js';
import { parseRules } from '../rulesets.js';
import * as E from './events.js';
import * as R from './room.js';

// Plan T6: game 2 of a best of 2 may start with game 1's totals in the
// box's l4dscores tally (ruleset series.carryScore). This module only reads.

/** Game 1's totals in pug-team order: a is the game's pug team a (the entry on matches.booking_side_a). */
export interface Carry { a: number; b: number }

interface GameCtx { eventMatchId: number; stageId: number; sideA: 'a' | 'b' | null; rulesJson: string | null }

function contextOf(db: DB, gameMatchId: number): GameCtx | null {
  const row = db.prepare(
    `SELECT em.id AS eventMatchId, em.stage_id AS stageId, m.booking_side_a AS sideA, m.rules_json AS rulesJson
       FROM matches m JOIN event_matches em ON em.booking_id = m.booking_id
      WHERE m.id = ? AND m.booking_id IS NOT NULL AND m.kind = 'tournament'`,
  ).get(gameMatchId) as GameCtx | undefined;
  return row ?? null;
}

function entriesOf(db: DB, gameMatchId: number, c: GameCtx): { entryA: number; entryB: number } | null {
  if (c.rulesJson === null) return null;
  let carry: boolean;
  try { carry = parseRules(c.rulesJson).series.carryScore; } catch { return null; }
  if (!carry) return null;
  const stage = E.getStage(db, c.stageId);
  if (!stage || E.stageSettingsOf(stage).veto.games !== 2) return null;
  const games = R.gamesOf(db, c.eventMatchId);
  const me = games.find((g) => g.match_id === gameMatchId);
  if (!me || me.tiebreak_of !== null || me.ordinal !== 2) return null;
  const g1 = games.find((g) => g.ordinal === 1 && g.tiebreak_of === null);
  if (!g1 || g1.score_a === null || g1.score_b === null) return null;
  return { entryA: g1.score_a, entryB: g1.score_b };
}

/** The same in entry order (event score_a/score_b are entry_a/entry_b), for the site's own lines. */
export function carryEntries(db: DB, gameMatchId: number): { entryA: number; entryB: number } | null {
  const c = contextOf(db, gameMatchId);
  return c ? entriesOf(db, gameMatchId, c) : null;
}

/** What this tournament game (a matches.id) starts with, or null: only game 2
 *  of a best of 2 whose ruleset carries the score and whose game 1 has two scores. */
export function carryFor(db: DB, gameMatchId: number): Carry | null {
  const c = contextOf(db, gameMatchId);
  const e = c ? entriesOf(db, gameMatchId, c) : null;
  if (!c || !e) return null;
  return (c.sideA ?? 'a') === 'a' ? { a: e.entryA, b: e.entryB } : { a: e.entryB, b: e.entryA };
}
