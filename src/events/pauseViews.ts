import type { DB } from '../db.js';
import { getPlayer } from '../players.js';
import type * as P from './play.js';
import * as R from './room.js';
import { gameNumberOf } from './seriesRules.js';

/**
 * Technical pauses as the room page and the Events desk show them (plan T5
 * Ruling 13): every pause to everyone, as the veto log is public; the reason
 * and the flag note only to the two rosters and staff; names, the penalty
 * note and who flagged only to staff (the desk).
 */
export interface RoomPause {
  id: number; game: number; tiebreak: boolean; side: 'a' | 'b'; cause: 'call' | 'disconnect';
  reason: string | null; startedAt: string; endedAt: string | null; usedS: number; budgetS: number;
  overrun: boolean; flagged: boolean; flagNote: string | null; penalty: 'warning' | 'forfeit' | null;
}
export interface DeskPause extends RoomPause { byName: string | null; flaggedBy: string | null; penaltyNote: string | null; live: boolean }

export function roomPauses(db: DB, m: P.MatchRow, insider: boolean): RoomPause[] {
  return viewOf(db, m, R.techPausesOf(db, m), insider);
}

function viewOf(db: DB, m: P.MatchRow, raw: R.TechPause[], insider: boolean): RoomPause[] {
  if (raw.length === 0) return [];
  const games = R.gamesOf(db, m.id);
  const series = R.seriesGames(db, m);
  return raw.map((p) => {
    const g = games.find((x) => x.match_id === p.gameMatchId);
    const sg = g ? series.find((x) => x.id === g.id) : undefined;
    // A pause the box never closed (no TECH end line reached the site) ended
    // no later than its game did, so it is not shown as still running.
    return {
      id: p.id, game: sg ? gameNumberOf(sg, series) : p.ordinal, tiebreak: g ? g.tiebreak_of !== null : false, side: p.side, cause: p.cause,
      reason: insider ? p.reason : null, startedAt: p.startedAt, endedAt: p.endedAt ?? g?.ended_at ?? null, usedS: p.used, budgetS: p.budget,
      overrun: p.overrun !== null, flagged: p.flagged !== null, flagNote: insider && p.flagged ? p.flagged.note : null,
      penalty: p.penalty?.kind ?? null,
    };
  });
}

export function deskPauses(db: DB, m: P.MatchRow, liveGameMatchId: number | null): DeskPause[] {
  const raw = R.techPausesOf(db, m);
  const name = (sid: string | null) => (sid === null ? null : getPlayer(db, sid)?.name ?? sid);
  return viewOf(db, m, raw, true).map((v, i) => {
    const p = raw[i]!;
    return { ...v, byName: name(p.by), flaggedBy: name(p.flagged?.by ?? null), penaltyNote: p.penalty?.note ?? null, live: liveGameMatchId !== null && p.gameMatchId === liveGameMatchId };
  });
}
