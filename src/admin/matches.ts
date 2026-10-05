import type { DB } from '../db.js';
import { captureHealth } from '../integrityFlags.js';
import type { ServerReleaser } from '../serverRelease.js';
import { pausesFor, readyupsFor, slowToReady } from '../liveView.js';
import { archiveAborted } from '../matchArchive.js';
import { matchForecast, recomputeSeasonRatings } from '../rating.js';
import { getServer, PICK_ORDER_SQL } from '../serverPool.js';
import type { LogAuth } from '../logAuth.js';
import { serverPasswordFor } from '../matchToken.js';
import { noteMatchAborted } from '../matchAborts.js';
import { clearMatchNoShows } from '../penalties.js';

export function adminOverview(db: DB, logAuth?: LogAuth) {
  const rosterOf = db.prepare(
    `SELECT mp.player_id AS steamid, COALESCE(p.name, mp.player_id) AS name FROM match_players mp
     LEFT JOIN players p ON p.steamid = mp.player_id WHERE mp.match_id = ? ORDER BY mp.team, mp.rowid`,
  );
  const openRows = db.prepare(
    `SELECT m.id, m.campaign, m.state, m.server_id AS serverId, m.token, m.created_at AS createdAt,
            m.went_live_at AS wentLiveAt, m.booking_id AS bookingId, m.server_pick_note AS serverPickNote,
            (SELECT COUNT(*) FROM match_players mp WHERE mp.match_id = m.id AND mp.connected_at IS NOT NULL) AS connected,
            (SELECT COUNT(*) FROM match_players mp WHERE mp.match_id = m.id) AS rostered
     FROM matches m WHERE m.state IN ('configuring', 'live') ORDER BY m.id DESC`,
  ).all() as (Record<string, unknown> & { id: number; serverId: number | null; token: string | null; bookingId: number | null })[];
  // Two staff additions per open match. This overview is read by admins AND
  // moderators (moderators see the Live desk with its server controls
  // hidden), and both fields go to both.
  //
  // `connect` is the real game server, not SourceTV (SourceTV's address is
  // public anyway, see src/spectate.ts): staff joining to see what is
  // happening, say after a /mod call, need the address and the match's own
  // sv_password, which is derived from the token and never stored. Moderators
  // get it by owner ruling 2026-09-28 (see the caster guard in
  // src/routes/guards.ts). The token itself does not go out; the password
  // derived from it does, which is the thing you can type into a console.
  //
  // `forecast` for a live match comes from current ratings, which while a
  // match is in flight ARE the pre-match ratings, since nothing updates until
  // completion.
  const open = openRows.map(({ token, ...m }) => {
    const server = m.serverId !== null ? getServer(db, m.serverId) : null;
    return {
      ...m,
      connect: server && token && m.state === 'live'
        ? { host: server.host, port: server.port, password: serverPasswordFor(token) }
        : null,
      forecast: matchForecast(db, m.id),
      // For the abort dialog's "leave out of the queue" boxes.
      roster: rosterOf.all(m.id) as { steamid: string; name: string }[],
    };
  });
  // Never the rcon password, and never the log secret: this goes to a browser.
  // Whether a secret EXISTS is sent, the mode, and what the verifier has
  // counted since this process started, which is what an admin watches while
  // a box is in log mode to decide it is safe to enforce.
  const servers = (db.prepare(
    `SELECT id, name, host, port, status, enabled, tv_port AS tvPort,
            tv_password AS tvPassword, tv_enabled AS tvEnabled, restart_after_match AS restartAfterMatch,
            log_auth AS logMode, log_secret IS NOT NULL AS hasLogSecret
     FROM servers ORDER BY ${PICK_ORDER_SQL}`,
  ).all() as ({ id: number; logMode: string; hasLogSecret: number } & Record<string, unknown>)[])
    .map(({ logMode, hasLogSecret, ...s }) => ({
      ...s,
      // A box lent out for practice is 'idle' in status (a lease is a row,
      // not a status; see src/practiceLeases.ts), so without this the table
      // would call a box people are practising on idle.
      practice: practiceOn(db, s.id),
      logAuth: {
        mode: logMode,
        hasSecret: hasLogSecret === 1,
        counters: logAuth?.counters(s.id) ?? null,
      },
    }));
  const recent = (db.prepare(
    `SELECT id, campaign, ended_at AS endedAt, team_a_score AS teamAScore, team_b_score AS teamBScore, winner
     FROM matches WHERE state = 'completed' ORDER BY id DESC LIMIT 30`,
  // Pauses ride along per match: when one side says the other paused them
  // to death, this is the record, and it outlives the live scratch tables.
  ).all() as { id: number }[]).map((m) => ({
    ...m, forecast: matchForecast(db, m.id), pauses: pausesFor(db, m.id), readyups: readyupsFor(db, m.id),
  }));
  const voided = db.prepare(
    `SELECT id, campaign, voided_at AS voidedAt, void_reason AS voidReason
     FROM matches WHERE voided_at IS NOT NULL ORDER BY voided_at DESC LIMIT 30`,
  ).all();
  // Matches that ended with no result: a leaver used up their reconnects, an
  // admin pulled the plug, or the reaper found the server had stopped talking.
  // These used to be unreachable from anywhere once the Discord card scrolled
  // away; archiveAborted keeps their record, and this is the index into it.
  // Voided matches are excluded because they are the list right below.
  const aborted = (db.prepare(
    `SELECT id, campaign, ended_at AS endedAt, team_a_score AS teamAScore, team_b_score AS teamBScore
     FROM matches WHERE state = 'aborted' AND voided_at IS NULL ORDER BY id DESC LIMIT 30`,
  ).all() as { id: number }[]).map((m) => ({
    // Who walked, if anyone did: the abandon path files a ban naming the match.
    ...m,
    abandonedBy: (db.prepare(
      `SELECT COALESCE(p.name, b.player_id) AS name FROM bans b
       LEFT JOIN players p ON p.steamid = b.player_id
       WHERE b.reason = ? ORDER BY b.id LIMIT 1`,
    ).get(`Abandoned match #${m.id}`) as { name: string } | undefined)?.name ?? null,
    // The no-shows it handed out and nobody has cleared, for the row's
    // "Clear no-shows" button: the no-show reaper records them as it aborts.
    noShows: (db.prepare(
      "SELECT COUNT(*) AS n FROM penalties WHERE match_id = ? AND kind = 'no_show' AND cleared_at IS NULL",
    ).get(m.id) as { n: number }).n,
  }));
  // The anti-cheat capture pipeline's health sits with the servers it comes
  // from, not on the People queue, which is about people.
  return { open, servers, recent, aborted, voided, slowToReady: slowToReady(db), captureHealth: captureHealth(db) };
}

export type ActionResult = { ok: true } | { ok: false; status: number; error: string };
export type AbortResult = { ok: true; bookingContinues?: true } | { ok: false; status: number; error: string };
/** Tells a booked box to drop one of its games (BookingRunner.abortGame). */
export type BookingGameAborter = (matchId: number, token: string) => Promise<void> | void;

/** End a configuring or live match now: aborted, server freed through the
 *  releaser (which also tells the plugin; a booking game instead goes through
 *  `abortBookingGame` and its box stays with the booking), and what the live feed captured
 *  frozen into the permanent tables so the match page can still show who was
 *  in and how far they got. Everyone on it is told, and goes back to the
 *  front of the queue if they may queue: staff pulling the plug is nobody's
 *  fault on the roster. `leaveOut` is who staff ticked to keep out: a ban
 *  keeps a player out only once it exists, and eight back at the front
 *  re-pop at once, before staff have filed it. */
export function abortMatch(
  db: DB, releaser: ServerReleaser, matchId: number, leaveOut: string[] = [], abortBookingGame?: BookingGameAborter,
): AbortResult {
  const m = db.prepare('SELECT state, server_id, booking_id, token FROM matches WHERE id = ?').get(matchId) as
    | { state: string; server_id: number | null; booking_id: number | null; token: string | null } | undefined;
  if (!m) return { ok: false, status: 404, error: 'no such match' };
  if (m.state !== 'configuring' && m.state !== 'live') return { ok: false, status: 409, error: `match is ${m.state}` };
  db.prepare("UPDATE matches SET state = 'aborted', abort_cause = 'admin', ended_at = datetime('now') WHERE id = ?").run(matchId);
  if (m.booking_id !== null) {
    // A game inside a booked block: the box stays with the booking (the
    // releaser would refuse it anyway), so the plugin is told to drop the
    // match directly and the booking carries on. Nobody is put in the PUG queue.
    archiveAborted(db, matchId);
    if (m.token !== null && abortBookingGame) {
      void Promise.resolve(abortBookingGame(matchId, m.token)).catch((err) => {
        console.warn(`[admin] booking game ${matchId}: telling the box to abort failed:`, err instanceof Error ? err.message : err);
      });
    }
    noteMatchAborted(db, { matchId, cause: 'admin', requeue: false });
    return { ok: true, bookingContinues: true };
  }
  // Archive BEFORE releasing: the release tells the plugin to change level, and
  // a heartbeat naming the reset map must not land before the record is taken.
  archiveAborted(db, matchId);
  if (m.server_id !== null) releaser.release(m.server_id, { teardown: true, restart: true });
  noteMatchAborted(db, { matchId, cause: 'admin', requeue: true, leaveOut });
  return { ok: true };
}

/**
 * Clear the no-show penalties one match handed out, for an aborted match
 * whose no-shows turn out not to be the players' doing (our server, a Steam
 * outage). Only an aborted match can have handed any out: the reaper records
 * them as it aborts, which is also why the abort dialog offers no such box.
 */
export function clearNoShowsOf(db: DB, matchId: number, by: string): { ok: true; cleared: string[] } | { ok: false; status: number; error: string } {
  const m = db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as { state: string } | undefined;
  if (!m) return { ok: false, status: 404, error: 'no such match' };
  return { ok: true, cleared: clearMatchNoShows(db, matchId, by) };
}

/** Void a completed match: it stops counting anywhere, and the season's
 *  ratings are rebuilt without it. */
export function voidMatch(db: DB, matchId: number, reason: string): ActionResult {
  const m = db.prepare('SELECT state, season_id FROM matches WHERE id = ?').get(matchId) as
    | { state: string; season_id: number } | undefined;
  if (!m) return { ok: false, status: 404, error: 'no such match' };
  if (m.state !== 'completed') return { ok: false, status: 409, error: 'only a completed match can be voided' };
  db.transaction(() => {
    db.prepare("UPDATE matches SET state = 'aborted', voided_at = ?, void_reason = ? WHERE id = ?")
      .run(new Date().toISOString(), reason, matchId);
    recomputeSeasonRatings(db, m.season_id);
  })();
  return { ok: true };
}

/** The open practice lease holding this server, for the admin Servers
 *  table, or null. Winding down counts: the box is not free until its
 *  restart has finished. */
function practiceOn(db: DB, serverId: number): { leaseId: number; kind: 'park' | 'drill'; ownerName: string; ending: boolean } | null {
  const row = db.prepare(
    `SELECT l.id, l.kind, l.end_reason, COALESCE(p.name, l.owner_player_id) AS ownerName
     FROM practice_leases l LEFT JOIN players p ON p.steamid = l.owner_player_id
     WHERE l.server_id = ? AND l.ended_at IS NULL ORDER BY l.id DESC LIMIT 1`,
  ).get(serverId) as { id: number; kind: 'park' | 'drill'; end_reason: string | null; ownerName: string } | undefined;
  return row ? { leaseId: row.id, kind: row.kind, ownerName: row.ownerName, ending: row.end_reason !== null } : null;
}
