import type { DB } from '../db.js';
import { aliasesOf } from '../aliases.js';
import { marks } from './timeline/types.js';

/**
 * How a player behaves around the game rather than in it: how long they keep
 * a ready-up waiting and how often they pause. Kept apart from the evidence
 * sources on purpose: slow readying is worth a word, never a place on Needs a
 * look, so nothing here feeds that list.
 *
 * Every figure sits beside the league's, because "38 seconds" means nothing
 * until you know the room averages 12.
 */
export interface ConductSection {
  readyups: {
    /** Finished ready-ups of matches they were rostered in, voided ones aside. */
    count: number;
    avgSeconds: number | null;
    /** Ready-ups they were the last one to ready in. */
    timesLast: number;
    leagueAvgSeconds: number | null;
    /** Share of ready-ups the average player is last in, 0..1. */
    leagueLastShare: number | null;
    slowest: ConductReadyup[];
  };
  pauses: {
    /** When the servers began naming who called a pause; null until then.
     *  Pauses before it have a team only and are never attributed. */
    trackedSince: string | null;
    called: number;
    /** Matches they played since tracking began, to read `called` against. */
    matchesSince: number;
    totalSeconds: number;
    recent: ConductPause[];
  };
}

export interface ConductReadyup {
  matchId: number; mapOrdinal: number; half: number | null; seconds: number; wasLast: boolean;
}
export interface ConductPause {
  matchId: number; mapOrdinal: number; half: number | null; seconds: number | null; startedAt: string;
}

const SHOWN = 5;

/** One row per (finished ready-up, rostered player), voided matches aside.
 *  Rostered rather than "has a seconds row": a player charged nothing has no
 *  row, and leaving them out would drop exactly the fast readiers from the
 *  average. A sub counts from the map they joined on. A player who left
 *  mid-match still counts for the maps after, as zero: nothing records when
 *  a rostered player left for good. */
const PARTICIPATIONS = `
  FROM match_readyups r
  JOIN matches m ON m.id = r.match_id AND m.voided_at IS NULL
  JOIN match_players mp ON mp.match_id = r.match_id AND r.map_ordinal >= mp.joined_map
  LEFT JOIN match_readyup_players rp ON rp.readyup_id = r.id AND rp.player_id = mp.player_id
  WHERE r.ended_at IS NOT NULL`;
const WAS_LAST = 'EXISTS (SELECT 1 FROM json_each(r.last_unready) WHERE value = mp.player_id)';

function sqliteSeconds(start: string, end: string): number {
  const ms = (s: string) => Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Math.max(0, Math.round((ms(end) - ms(start)) / 1000));
}

export function conductOf(db: DB, canonical: string): ConductSection {
  const ids = [canonical, ...aliasesOf(db, canonical).map((a) => a.steamid)];
  const inIds = `mp.player_id IN (${marks(ids)})`;

  const mine = db.prepare(
    `SELECT COUNT(*) AS count, AVG(COALESCE(rp.seconds, 0)) AS avg, SUM(${WAS_LAST}) AS last
     ${PARTICIPATIONS} AND ${inIds}`,
  ).get(...ids) as { count: number; avg: number | null; last: number | null };
  const league = db.prepare(
    `SELECT AVG(COALESCE(rp.seconds, 0)) AS avg, AVG(${WAS_LAST}) AS lastShare ${PARTICIPATIONS}`,
  ).get() as { avg: number | null; lastShare: number | null };
  const slowest = (db.prepare(
    `SELECT r.match_id AS matchId, r.map_ordinal AS mapOrdinal, r.half, COALESCE(rp.seconds, 0) AS seconds,
            ${WAS_LAST} AS wasLast
     ${PARTICIPATIONS} AND ${inIds} AND COALESCE(rp.seconds, 0) > 0
     ORDER BY seconds DESC, r.id DESC LIMIT ?`,
  ).all(...ids, SHOWN) as (Omit<ConductReadyup, 'wasLast'> & { wasLast: number })[])
    .map((r) => ({ ...r, wasLast: r.wasLast === 1 }));

  const since = (db.prepare('SELECT MIN(started_at) AS at FROM match_pauses WHERE called_by IS NOT NULL')
    .get() as { at: string | null }).at;
  const pauseRows = since === null ? [] : db.prepare(
    `SELECT p.match_id AS matchId, p.map_ordinal AS mapOrdinal, p.half, p.started_at AS startedAt, p.ended_at AS endedAt
     FROM match_pauses p JOIN matches m ON m.id = p.match_id AND m.voided_at IS NULL
     WHERE p.called_by IN (${marks(ids)}) ORDER BY p.id DESC`,
  ).all(...ids) as { matchId: number; mapOrdinal: number; half: number | null; startedAt: string; endedAt: string | null }[];
  const pauses = pauseRows.map((p) => ({
    matchId: p.matchId, mapOrdinal: p.mapOrdinal, half: p.half, startedAt: p.startedAt,
    seconds: p.endedAt === null ? null : sqliteSeconds(p.startedAt, p.endedAt),
  }));
  // From the first match that named a caller, by id rather than by date: that
  // match began before the first named pause, so a date cut would drop it.
  const matchesSince = since === null ? 0 : (db.prepare(
    `SELECT COUNT(DISTINCT mp.match_id) AS n FROM match_players mp
     JOIN matches m ON m.id = mp.match_id AND m.voided_at IS NULL AND m.state IN ('completed', 'aborted')
     WHERE ${inIds}
       AND mp.match_id >= (SELECT MIN(match_id) FROM match_pauses WHERE called_by IS NOT NULL)`,
  ).get(...ids) as { n: number }).n;

  const round = (v: number | null) => (v === null ? null : Math.round(v));
  return {
    readyups: {
      count: mine.count,
      avgSeconds: mine.count === 0 ? null : round(mine.avg),
      timesLast: mine.last ?? 0,
      leagueAvgSeconds: round(league.avg),
      leagueLastShare: league.lastShare,
      slowest,
    },
    pauses: {
      trackedSince: since,
      called: pauses.length,
      matchesSince,
      totalSeconds: pauses.reduce((sum, p) => sum + (p.seconds ?? 0), 0),
      recent: pauses.slice(0, SHOWN),
    },
  };
}
