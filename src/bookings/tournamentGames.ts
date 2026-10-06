import type { DB } from '../db.js';
import { isMapName } from '../campaigns.js';
import { newToken } from '../matchToken.js';
import { currentSeasonId } from '../players.js';
import { consoleText, quoted } from '../serverSetup.js';
import { getBooking, logBookingEvent, type Side } from './bookings.js';

/**
 * A tournament game's rows and its plugin burst (tournaments plan T3b
 * Rulings 3 and 15). The site starts every tournament game, as the
 * orchestrator starts a queue PUG: a matches row first (so the id exists),
 * then `sm_pug_match <id> <token> <campaign> ["<stop map>"]` and one quoted
 * `sm_pug_roster "<steamid>:<a|b>"` per player. Pug team a starts as
 * survivors on map 1 (plugin Cmd_Match), so the caller puts the team the
 * veto named on team a and says which booking side that is.
 *
 * The row is inserted live with no went_live_at, as an adopted booking game
 * is: the PUG no-show reaper never looks at it, and the orphan reaper
 * applies once the plugin heartbeats. The booking's own rules and game
 * config are copied onto it, as adoption copies them.
 */

export function createTournamentGame(db: DB, o: {
  bookingId: number; serverId: number; campaign: string; teams: { a: string[]; b: string[] }; bookingSideA: Side; now?: Date;
}): { matchId: number; token: string } {
  const now = o.now ?? new Date();
  const b = getBooking(db, o.bookingId);
  if (!b) throw new Error(`booking ${o.bookingId} does not exist`);
  const token = newToken();
  const matchId = db.transaction((): number => {
    const id = Number(db.prepare(
      `INSERT INTO matches (season_id, state, campaign, server_id, token, origin, kind, visibility, rules_json, game_config, booking_id, booking_side_a)
       VALUES (?, 'live', ?, ?, ?, 'queue', 'tournament', 'participants', ?, ?, ?, ?)`,
    ).run(currentSeasonId(db), o.campaign, o.serverId, token, b.rules_json, b.game_config, b.id, o.bookingSideA).lastInsertRowid);
    const ins = db.prepare("INSERT INTO match_players (match_id, player_id, team, source) VALUES (?, ?, ?, 'web')");
    for (const s of o.teams.a) ins.run(id, s, 'a');
    for (const s of o.teams.b) ins.run(id, s, 'b');
    logBookingEvent(db, b.id, null, 'game_started', { matchId: id, campaign: o.campaign }, now);
    return id;
  })();
  return { matchId, token };
}

/** On a tournament box only (T3b final review), in the booking lines (so the
 *  minute re-push keeps them) and in every game burst: a player who drops
 *  for five minutes must not end a series game as a PUG abandon (0 turns
 *  the plugin's leave tracking off), and the plugin must not kick everyone
 *  eight seconds after each game of the series (sm_pug_end_kick, pug-match
 *  0.3.24; an older plugin answers "unknown command" and kicks anyway). */
export const TOURNAMENT_LINES: readonly string[] = [
  // sm_pug_tournament turns on !sub, !admin and the staff freeze (pug-match 0.3.25, plan T3c).
  'sm_pug_tournament 1',
  'sm_pug_leave_budget 0', 'sm_pug_end_kick 0',
];

/** The burst for a game whose rows exist (so a lost burst can be sent again). */
export function gameLinesOf(db: DB, o: { matchId: number; stopAfterMap: string | null; notice: string }): string[] {
  const m = db.prepare('SELECT token, campaign FROM matches WHERE id = ?').get(o.matchId) as { token: string | null; campaign: string } | undefined;
  if (!m || !m.token) throw new Error(`match ${o.matchId} has no token`);
  if (!/^[A-Za-z0-9]+$/.test(m.token)) throw new Error('match token has unexpected characters');
  if (!/^[a-z0-9_]+$/.test(m.campaign)) throw new Error(`campaign ${JSON.stringify(m.campaign)} has unexpected characters`);
  if (o.stopAfterMap !== null && !isMapName(o.stopAfterMap)) throw new Error(`stop map ${JSON.stringify(o.stopAfterMap)} is not a valid map name`);
  const roster = (tournamentRoster(db, o.matchId) ?? matchPlayersRoster(db, o.matchId)).map((r) => ({ player_id: r.steamid, team: r.team }));
  return [
    // Before the match line, so the plugin has them when the game goes live (TOURNAMENT_LINES).
    ...TOURNAMENT_LINES,
    `sm_pug_match ${o.matchId} ${m.token} ${m.campaign}${o.stopAfterMap ? ` "${o.stopAfterMap}"` : ''}`,
    // Quoted: the console splits an unquoted argument on ':' (orchestrator.ts).
    ...roster.filter((r) => /^\d{17}$/.test(r.player_id)).map((r) => `sm_pug_roster "${r.player_id}:${r.team}"`),
    `l4d_ready_league_notice ${quoted(consoleText(o.notice, 60))}`,
  ];
}

export interface RosterLine { steamid: string; team: 'a' | 'b'; joinedMap: number }

/** Every match_players row: the roster of a game that is not a series game. */
export function matchPlayersRoster(db: DB, matchId: number): RosterLine[] {
  return (db.prepare('SELECT player_id, team, joined_map FROM match_players WHERE match_id = ? ORDER BY team, rowid').all(matchId) as
    { player_id: string; team: 'a' | 'b'; joined_map: number }[]).map((r) => ({ steamid: r.player_id, team: r.team, joinedMap: r.joined_map }));
}

/** The roster of a tournament game as the box must hold it now (plan T3c
 *  final review): each side's current four from the event lineup (game 1
 *  carries the series and a sub rewrites it), never every match_players
 *  row, which keeps a subbed-out player for his stats. A replay, a move, a
 *  crash recovery or a re-push sends this, so a sub survives them (the
 *  plugin's ResetMatchState forgets the slot-out flag). Pug team a is the
 *  room side named by matches.booking_side_a. A player's joined map is his
 *  match_players row's (a sub's is the maps finished when he came in), 0
 *  without one. Null for a game that is not a series game, or whose room
 *  no longer holds its booking or both lineups: the caller falls back to
 *  match_players. */
export function tournamentRoster(db: DB, matchId: number): RosterLine[] | null {
  const row = db.prepare(
    `SELECT m.kind, m.booking_side_a, em.id AS em_id, em.entry_a, em.entry_b FROM matches m
       JOIN event_matches em ON em.booking_id = m.booking_id WHERE m.id = ?`,
  ).get(matchId) as { kind: string; booking_side_a: Side | null; em_id: number; entry_a: number | null; entry_b: number | null } | undefined;
  if (!row || row.kind !== 'tournament') return null;
  const four = (entryId: number | null): string[] | null => {
    if (entryId === null) return null;
    const l = db.prepare('SELECT steamids FROM event_lineups WHERE event_match_id = ? AND game = 1 AND entry_id = ?').get(row.em_id, entryId) as { steamids: string } | undefined;
    return l ? JSON.parse(l.steamids) as string[] : null;
  };
  const sideA: Side = row.booking_side_a ?? 'a';
  const teamA = four(sideA === 'a' ? row.entry_a : row.entry_b);
  const teamB = four(sideA === 'a' ? row.entry_b : row.entry_a);
  if (!teamA || !teamB) return null;
  const joined = new Map((db.prepare('SELECT player_id, joined_map FROM match_players WHERE match_id = ?').all(matchId) as
    { player_id: string; joined_map: number }[]).map((r) => [r.player_id, r.joined_map] as const));
  return [
    ...teamA.map((s) => ({ steamid: s, team: 'a' as const, joinedMap: joined.get(s) ?? 0 })),
    ...teamB.map((s) => ({ steamid: s, team: 'b' as const, joinedMap: joined.get(s) ?? 0 })),
  ];
}

/** Pushed but never started: live, and no MATCH_START (or round start)
 *  has named a map for it. A heartbeat alone leaves current_map null
 *  (liveView touch COALESCEs), so a game the box only heartbeated in
 *  ready-up still counts (T3b final review). */
export function isUnstartedGame(db: DB, matchId: number): boolean {
  return !!db.prepare(
    "SELECT 1 FROM matches m WHERE m.id = ? AND m.state = 'live' AND NOT EXISTS (SELECT 1 FROM match_live l WHERE l.match_id = m.id AND l.current_map IS NOT NULL)",
  ).get(matchId);
}

/** Pushed but not yet heard from: live with no heartbeat row. */
export function isPendingGame(db: DB, matchId: number): boolean {
  return !!db.prepare("SELECT 1 FROM matches m WHERE m.id = ? AND m.state = 'live' AND NOT EXISTS (SELECT 1 FROM match_live l WHERE l.match_id = m.id)").get(matchId);
}

/** Whether a box's sm_pug_status (pug-match Cmd_Status, first line
 *  `STATUS state=<none|pending|live|ended> match=<id> ...`) shows it needs
 *  the burst of game `matchId` again (T3b final review): it holds no match,
 *  or an older one that is not live. A box holding this game in any state,
 *  or another game live, does not; nor does a body that cannot be read. */
export function boxNeedsGame(statusBody: string, matchId: number): boolean {
  const m = /^STATUS state=(\w+) match=(-?\d+)/m.exec(statusBody);
  if (!m) return false;
  if (Number(m[2]) === matchId) return false;
  return m[1] !== 'live';
}

/** A sub's roster row on a tournament game (plan T3c Ruling 5): source web,
 *  joined_map the maps finished so far, so the dump's STAT line finds a row
 *  and the rating of a pug never applies anyway (kind tournament). A second
 *  call for the same player changes nothing. Null, with nothing written,
 *  for a match that is not a tournament game. */
export function addTournamentSub(db: DB, o: { matchId: number; inId: string; team: 'a' | 'b'; now?: Date }): { joinedMap: number } | null {
  const now = o.now ?? new Date();
  return db.transaction(() => {
    const row = db.prepare('SELECT booking_id, kind FROM matches WHERE id = ?').get(o.matchId) as { booking_id: number | null; kind: string } | undefined;
    if (!row) throw new Error(`match ${o.matchId} does not exist`);
    if (row.kind !== 'tournament') return null;
    const joinedMap = (db.prepare(
      'SELECT COUNT(DISTINCT ordinal) AS n FROM match_rounds WHERE match_id = ? AND half = 2 AND ended_at IS NOT NULL',
    ).get(o.matchId) as { n: number }).n;
    const existing = db.prepare('SELECT joined_map FROM match_players WHERE match_id = ? AND player_id = ?').get(o.matchId, o.inId) as { joined_map: number } | undefined;
    if (existing) return { joinedMap: existing.joined_map };
    db.prepare("INSERT INTO match_players (match_id, player_id, team, joined_map, source) VALUES (?, ?, ?, ?, 'web')").run(o.matchId, o.inId, o.team, joinedMap);
    if (row.booking_id !== null) logBookingEvent(db, row.booking_id, null, 'sub_added', { matchId: o.matchId, steamid: o.inId, team: o.team, joinedMap }, now);
    return { joinedMap };
  })();
}
