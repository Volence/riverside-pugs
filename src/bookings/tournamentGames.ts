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

/** The burst for a game whose rows exist (so a lost burst can be sent again). */
export function gameLinesOf(db: DB, o: { matchId: number; stopAfterMap: string | null; notice: string }): string[] {
  const m = db.prepare('SELECT token, campaign FROM matches WHERE id = ?').get(o.matchId) as { token: string | null; campaign: string } | undefined;
  if (!m || !m.token) throw new Error(`match ${o.matchId} has no token`);
  if (!/^[A-Za-z0-9]+$/.test(m.token)) throw new Error('match token has unexpected characters');
  if (!/^[a-z0-9_]+$/.test(m.campaign)) throw new Error(`campaign ${JSON.stringify(m.campaign)} has unexpected characters`);
  if (o.stopAfterMap !== null && !isMapName(o.stopAfterMap)) throw new Error(`stop map ${JSON.stringify(o.stopAfterMap)} is not a valid map name`);
  const roster = db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ? ORDER BY team, rowid').all(o.matchId) as { player_id: string; team: 'a' | 'b' }[];
  return [
    `sm_pug_match ${o.matchId} ${m.token} ${m.campaign}${o.stopAfterMap ? ` "${o.stopAfterMap}"` : ''}`,
    // Quoted: the console splits an unquoted argument on ':' (orchestrator.ts).
    ...roster.filter((r) => /^\d{17}$/.test(r.player_id)).map((r) => `sm_pug_roster "${r.player_id}:${r.team}"`),
    `l4d_ready_league_notice ${quoted(consoleText(o.notice, 60))}`,
  ];
}

/** Pushed but not yet heard from: live with no heartbeat row. */
export function isPendingGame(db: DB, matchId: number): boolean {
  return !!db.prepare("SELECT 1 FROM matches m WHERE m.id = ? AND m.state = 'live' AND NOT EXISTS (SELECT 1 FROM match_live l WHERE l.match_id = m.id)").get(matchId);
}
