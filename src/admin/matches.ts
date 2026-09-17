import type { DB } from '../db.js';
import type { ServerReleaser } from '../serverRelease.js';
import { clearLive } from '../liveView.js';
import { recomputeSeasonRatings } from '../rating.js';

export function adminOverview(db: DB) {
  const open = db.prepare(
    `SELECT m.id, m.campaign, m.state, m.server_id AS serverId, m.created_at AS createdAt, m.went_live_at AS wentLiveAt,
            (SELECT COUNT(*) FROM match_players mp WHERE mp.match_id = m.id AND mp.connected_at IS NOT NULL) AS connected,
            (SELECT COUNT(*) FROM match_players mp WHERE mp.match_id = m.id) AS rostered
     FROM matches m WHERE m.state IN ('configuring', 'live') ORDER BY m.id DESC`,
  ).all();
  // Never the rcon password: this goes to a browser.
  const servers = db.prepare(
    `SELECT id, name, host, port, status, tv_port AS tvPort, tv_password AS tvPassword, tv_enabled AS tvEnabled
     FROM servers ORDER BY id`,
  ).all();
  const recent = db.prepare(
    `SELECT id, campaign, ended_at AS endedAt, team_a_score AS teamAScore, team_b_score AS teamBScore, winner
     FROM matches WHERE state = 'completed' ORDER BY id DESC LIMIT 30`,
  ).all();
  const voided = db.prepare(
    `SELECT id, campaign, voided_at AS voidedAt, void_reason AS voidReason
     FROM matches WHERE voided_at IS NOT NULL ORDER BY voided_at DESC LIMIT 30`,
  ).all();
  return { open, servers, recent, voided };
}

export type ActionResult = { ok: true } | { ok: false; status: number; error: string };

/** End a configuring or live match now: aborted, server freed through the
 *  releaser (which also tells the plugin), live scratch cleared. */
export function abortMatch(db: DB, releaser: ServerReleaser, matchId: number): ActionResult {
  const m = db.prepare('SELECT state, server_id FROM matches WHERE id = ?').get(matchId) as
    | { state: string; server_id: number | null } | undefined;
  if (!m) return { ok: false, status: 404, error: 'no such match' };
  if (m.state !== 'configuring' && m.state !== 'live') return { ok: false, status: 409, error: `match is ${m.state}` };
  db.prepare("UPDATE matches SET state = 'aborted', ended_at = datetime('now') WHERE id = ?").run(matchId);
  if (m.server_id !== null) releaser.release(m.server_id);
  clearLive(db, matchId);
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
