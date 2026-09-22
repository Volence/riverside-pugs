import type { DB } from '../db.js';
import { captureHealth } from '../integrityFlags.js';
import type { ServerReleaser } from '../serverRelease.js';
import { pausesFor, readyupsFor, slowToReady } from '../liveView.js';
import { archiveAborted } from '../matchArchive.js';
import { matchForecast, recomputeSeasonRatings } from '../rating.js';
import { getServer } from '../serverPool.js';
import type { LogAuth } from '../logAuth.js';
import { serverPasswordFor } from '../matchToken.js';

export function adminOverview(db: DB, logAuth?: LogAuth) {
  const openRows = db.prepare(
    `SELECT m.id, m.campaign, m.state, m.server_id AS serverId, m.token, m.created_at AS createdAt,
            m.went_live_at AS wentLiveAt,
            (SELECT COUNT(*) FROM match_players mp WHERE mp.match_id = m.id AND mp.connected_at IS NOT NULL) AS connected,
            (SELECT COUNT(*) FROM match_players mp WHERE mp.match_id = m.id) AS rostered
     FROM matches m WHERE m.state IN ('configuring', 'live') ORDER BY m.id DESC`,
  ).all() as (Record<string, unknown> & { id: number; serverId: number | null; token: string | null })[];
  // Two admin-only additions per open match.
  //
  // `connect` is the real game server, not SourceTV: an admin joining to see
  // what is happening needs the address and the match's own sv_password, which
  // is derived from the token and never stored. The token itself does not go
  // out; the password derived from it does, which is the thing you can type
  // into a console.
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
     FROM servers ORDER BY id`,
  ).all() as ({ id: number; logMode: string; hasLogSecret: number } & Record<string, unknown>)[])
    .map(({ logMode, hasLogSecret, ...s }) => ({
      ...s,
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
  }));
  // The anti-cheat capture pipeline's health sits with the servers it comes
  // from, not on the People queue, which is about people.
  return { open, servers, recent, aborted, voided, slowToReady: slowToReady(db), captureHealth: captureHealth(db) };
}

export type ActionResult = { ok: true } | { ok: false; status: number; error: string };

/** End a configuring or live match now: aborted, server freed through the
 *  releaser (which also tells the plugin), and what the live feed captured
 *  frozen into the permanent tables so the match page can still show who was
 *  in and how far they got. */
export function abortMatch(db: DB, releaser: ServerReleaser, matchId: number): ActionResult {
  const m = db.prepare('SELECT state, server_id FROM matches WHERE id = ?').get(matchId) as
    | { state: string; server_id: number | null } | undefined;
  if (!m) return { ok: false, status: 404, error: 'no such match' };
  if (m.state !== 'configuring' && m.state !== 'live') return { ok: false, status: 409, error: `match is ${m.state}` };
  db.prepare("UPDATE matches SET state = 'aborted', ended_at = datetime('now') WHERE id = ?").run(matchId);
  // Archive BEFORE releasing: the release tells the plugin to change level, and
  // a heartbeat naming the reset map must not land before the record is taken.
  archiveAborted(db, matchId);
  if (m.server_id !== null) releaser.release(m.server_id, { teardown: true, restart: true });
  return { ok: true };
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
