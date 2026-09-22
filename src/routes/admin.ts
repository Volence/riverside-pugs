import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { makeRequireAdmin } from './guards.js';
import type { ServerReleaser } from '../serverRelease.js';
import { getServer, listServers, serversMissingDlc4, setEnabled, setHasDlc4, setRestartAfterMatch, type ServerRow } from '../serverPool.js';
import { serverHasDlc4 } from '../dlc4.js';
import { abortMatch, adminOverview, voidMatch } from '../admin/matches.js';
import { SETTINGS_SCHEMA, settingDef, validateSetting } from '../settingsSchema.js';
import { getCampaignPool, getSetting, setSetting } from '../settings.js';
import { logAdmin, recentActions } from '../admin/audit.js';
import {
  activeBan, addNote, banPlayer, playerDetail, searchPlayers, unbanPlayer,
} from '../admin/players.js';
import { activatePlayer, getPlayer, unlinkDiscord } from '../players.js';
import { poolableCampaigns } from '../campaignRegistry.js';
import { clearPenalties } from '../penalties.js';
import { listSeasons, renameSeason, startNewSeason } from '../seasons.js';
import { integrityBoard, integrityPlayer } from '../admin/integrity.js';
import { captureHealth, recentFlagFeed } from '../integrityFlags.js';
import { setReview, unanalysableCounts } from '../integrity/store.js';
import { removeAlias, resolveAlias } from '../aliases.js';
import { MergeError, mergePlayers } from '../mergePlayers.js';
import { publishAdminEvent } from '../adminFeed.js';
import { publishBanChange } from '../banEvents.js';
import { hasActiveBan } from '../banState.js';
import { matchInFlight, pendingRoundCount, type IntegrityJobs, type JobMode } from '../integrity/job.js';
import { reseedOrphanedTickets, restrictOpenTicketAbout, type RestrictOutcome } from '../tickets/store.js';
import { publishTicketSignal } from '../tickets/signals.js';
import type { ServerAdminSync } from '../serverAdmins.js';
import { LOG_AUTH_MODES, newLogSecret, setLogAuthMode, setLogSecret, type LogAuth, type LogAuthMode } from '../logAuth.js';
import { endSessions } from '../session.js';
import { applyLeaveState, isRostered } from '../presence.js';
import { LEAVE_ACTIONS, LEAVE_ADD_MAX_S, leaveCommand, parseLeaveReply, type LeaveAction, type ServerQuery } from '../leaveControl.js';
import { buildLiveBoard, type VoiceLookup } from '../admin/liveBoard.js';
import { redactSecrets } from '../redact.js';

export interface AdminRouteOpts {
  db: DB;
  matchmaker: Matchmaker;
  releaser: ServerReleaser;
  broadcast: (event: string) => void;
  /** Absent on an install with no replay directory, where there is nothing to
   *  analyse and the panel says so rather than offering a button that cannot
   *  work. */
  integrityJobs?: IntegrityJobs;
  /** Probes one server for the dlc4 mappack. Injected in tests so the check
   *  never dials a real box; defaults to the real serverHasDlc4, which does. */
  dlc4Probe?: (server: ServerRow) => Promise<boolean>;
  /** Pushes the website's admin list to every box. Absent in tests that do
   *  not exercise it, where the route reports that rather than pretending. */
  adminSync?: ServerAdminSync;
  /** The log signature verifier, for its counters in the overview. */
  logAuth?: LogAuth;
  /** Pushes one server its log secret over rcon; true when the box knew the
   *  cvar. Absent in tests that do not exercise it, where the route says so. */
  logSecretPusher?: (server: ServerRow, secret: string) => Promise<boolean>;
  /** Runs one console command on one server and returns its reply. Absent in
   *  tests that do not exercise it, where the route says so. */
  serverQuery?: ServerQuery;
  /** Who is in a Discord voice channel, for the live board's "not in a voice
   *  channel" reason. Null or absent when Discord is not configured, and then
   *  the board simply never gives that reason. */
  voice?: VoiceLookup | null;
  /** Asks Steam about one player now and resolves with the rows written.
   *  Absent on an install with no Steam api key, where the route says so. */
  refreshSignals?: (steamid: string) => Promise<number>;
  /** config.adminSteamIds: who is let into a ticket that becomes restricted
   *  because the player it is about was just promoted. */
  adminSteamIds: string[];
}

const NOBODY_TO_RESTRICT = 'A ticket about a player who is now staff could not be restricted: there is nobody else to give it to. Add another admin or set ADMIN_STEAMIDS, then restrict it from the ticket page.';

/** Everything under /api/admin. Each route starts with requireAdmin and each
 *  mutation ends with logAdmin. */
export async function adminRoutes(app: FastifyInstance, opts: AdminRouteOpts): Promise<void> {
  const { db, matchmaker, releaser, broadcast, integrityJobs, adminSync, logAuth, logSecretPusher, serverQuery, adminSteamIds } = opts;
  const requireAdmin = makeRequireAdmin(db);
  const dlc4Probe = opts.dlc4Probe ?? serverHasDlc4;

  app.get('/api/admin/players', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const q = String((req.query as { q?: string }).q ?? '').trim().slice(0, 100);
    return { players: searchPlayers(db, q) };
  });

  app.get('/api/admin/players/:steamid', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const detail = playerDetail(db, (req.params as { steamid: string }).steamid, adminId);
    if (!detail) return reply.code(404).send({ error: 'no such player' });
    return detail;
  });

  /** Shared preamble for per-player mutations: admin, then the target exists. */
  const target = (req: FastifyRequest, reply: FastifyReply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return null;
    const steamid = (req.params as { steamid: string }).steamid;
    if (!getPlayer(db, steamid)) {
      reply.code(404).send({ error: 'no such player' });
      return null;
    }
    return { adminId, steamid };
  };

  app.post('/api/admin/players/:steamid/ban', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    const { reason, minutes } = (req.body ?? {}) as { reason?: unknown; minutes?: unknown };
    if (t.steamid === t.adminId) return reply.code(400).send({ error: 'you cannot ban yourself' });
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) {
      return reply.code(400).send({ error: 'a reason is required (up to 500 characters)' });
    }
    let mins: number | null = null;
    if (minutes !== undefined && minutes !== null && minutes !== '') {
      mins = Number(minutes);
      if (!Number.isInteger(mins) || mins <= 0 || mins > 60 * 24 * 365) {
        return reply.code(400).send({ error: 'minutes must be a whole number between 1 and 525600' });
      }
    }
    banPlayer(db, t.steamid, t.adminId, reason.trim(), mins);
    // Out of the queue AND out of any ready check or vote in progress.
    matchmaker.remove(t.steamid);
    logAdmin(db, t.adminId, 'ban', t.steamid, { reason: reason.trim(), minutes: mins });
    return { ok: true };
  });

  app.post('/api/admin/players/:steamid/unban', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    unbanPlayer(db, t.steamid, t.adminId);
    logAdmin(db, t.adminId, 'unban', t.steamid);
    return { ok: true };
  });

  app.post('/api/admin/players/:steamid/activate', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    if (activeBan(db, t.steamid) || getPlayer(db, t.steamid)?.status === 'banned') {
      return reply.code(409).send({ error: 'player is banned; unban instead' });
    }
    activatePlayer(db, t.steamid);
    logAdmin(db, t.adminId, 'activate', t.steamid);
    return { ok: true };
  });

  app.post('/api/admin/players/:steamid/admin', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    const { isAdmin } = (req.body ?? {}) as { isAdmin?: unknown };
    if (typeof isAdmin !== 'boolean') return reply.code(400).send({ error: 'isAdmin must be true or false' });
    if (t.steamid === t.adminId && !isAdmin) return reply.code(400).send({ error: 'you cannot remove your own admin' });
    // `as`, not an annotation: the assignment inside the closure is invisible
    // to TypeScript's narrowing, which would pin this to 'none'.
    let outcome = 'none' as RestrictOutcome;
    const was = getPlayer(db, t.steamid)?.is_admin === 1;
    db.transaction(() => {
      db.prepare('UPDATE players SET is_admin = ? WHERE steamid = ?').run(isAdmin ? 1 : 0, t.steamid);
      if (isAdmin) {
        outcome = restrictOpenTicketAbout(db, t.steamid, adminSteamIds);
        // A restricted ticket nobody could be given is given to the first
        // admin who could take it, which may be this one.
        reseedOrphanedTickets(db, adminSteamIds);
      }
      // A change of rights starts from a fresh sign-in: a session that was open
      // while somebody was an admin does not outlive their being one. Only on
      // a real change, so re-saving the same value signs nobody out.
      if (was !== isAdmin) endSessions(db, t.steamid);
    })();
    logAdmin(db, t.adminId, 'set_admin', t.steamid, { isAdmin });
    publishTicketSignal({ kind: 'staff' });
    if (outcome === 'nobody') publishAdminEvent({ kind: 'problem', text: NOBODY_TO_RESTRICT });
    return { ok: true };
  });

  /** Sign a player out everywhere: every cookie they hold stops working, on
   *  every device, and they sign in again. For an account that may be in
   *  somebody else's hands, where waiting out a 30 day session is not on. */
  app.post('/api/admin/players/:steamid/sign-out', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    endSessions(db, t.steamid);
    logAdmin(db, t.adminId, 'sign_out', t.steamid);
    return { ok: true };
  });

  app.post('/api/admin/players/:steamid/mod', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    const { isMod } = (req.body ?? {}) as { isMod?: unknown };
    if (typeof isMod !== 'boolean') return reply.code(400).send({ error: 'isMod must be true or false' });
    // `as`, not an annotation: the assignment inside the closure is invisible
    // to TypeScript's narrowing, which would pin this to 'none'.
    let outcome = 'none' as RestrictOutcome;
    const was = getPlayer(db, t.steamid)?.is_mod === 1;
    db.transaction(() => {
      db.prepare('UPDATE players SET is_mod = ? WHERE steamid = ?').run(isMod ? 1 : 0, t.steamid);
      if (isMod) outcome = restrictOpenTicketAbout(db, t.steamid, adminSteamIds);
      // The same rule as the admin flag above: a demoted moderator loses the
      // tickets now, not when a 30 day session runs out, and a promoted one
      // starts from a fresh sign-in. Only on a real change.
      if (was !== isMod) endSessions(db, t.steamid);
    })();
    logAdmin(db, t.adminId, 'set_mod', t.steamid, { isMod });
    publishTicketSignal({ kind: 'staff' });
    if (outcome === 'nobody') publishAdminEvent({ kind: 'problem', text: NOBODY_TO_RESTRICT });
    return { ok: true };
  });

  app.post('/api/admin/players/:steamid/unlink-discord', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    const before = getPlayer(db, t.steamid)?.discord_name ?? null;
    unlinkDiscord(db, t.steamid, t.adminId);
    logAdmin(db, t.adminId, 'unlink_discord', t.steamid, { was: before });
    return { ok: true };
  });

  /**
   * Fold this account into another one: one person, one identity, one rating.
   *
   * `dryRun` first, always, from the panel. The merge rewrites rating history
   * for everyone who played in the affected matches, not just the two
   * accounts, because ratings are sequential and a roster corrected four
   * matches back changes every rating computed since. The plan says how much
   * it is about to move before anyone commits to it.
   */
  app.post('/api/admin/players/:steamid/merge', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    const { into, dryRun } = (req.body ?? {}) as { into?: unknown; dryRun?: unknown };
    if (typeof into !== 'string' || !/^\d{17}$/.test(into)) {
      return reply.code(400).send({ error: 'into must be a SteamID64' });
    }
    try {
      const plan = mergePlayers(db, {
        from: t.steamid, into, dryRun: dryRun === true, by: t.adminId, adminSteamIds,
      });
      if (dryRun === true) return { plan };
      logAdmin(db, t.adminId, 'merge_player', t.steamid, { ...plan });
      publishAdminEvent({
        kind: 'problem',
        text: `${t.steamid} was merged into ${into}: ${plan.matchesMoved} matches moved, ${plan.matchesCollapsed} collapsed, season ${plan.seasons.join(', ')} recomputed.`,
      });
      return { ok: true, plan };
    } catch (err) {
      // Only what the merge itself rejects becomes a 400: same account,
      // unknown account, an alias chain. Anything else is a fault on our side
      // and must surface as a 500 rather than be dressed up as bad input.
      if (err instanceof MergeError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  /** Undo the alias a merge left behind. The history stays merged; this only
   *  frees the SteamID to be its own account again.
   *
   *  Does NOT go through `target`: a merged alt has no player row by
   *  definition, so requiring one here would 404 on every id this route
   *  exists to act on. The alias row is the thing that must exist. */
  app.post('/api/admin/players/:steamid/unalias', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { steamid } = req.params as { steamid: string };
    const canonical = resolveAlias(db, steamid);
    if (canonical === steamid) {
      return reply.code(404).send({ error: 'that account is not an alias' });
    }
    removeAlias(db, steamid);
    // While it was an alias this id carried its main's engine ban, which is
    // permanent on the box and which the sweep will never lift now that the
    // two are no longer connected. The main stays banned; only this id is
    // freed, because on the website it is now an account with no ban at all.
    if (hasActiveBan(db, canonical)) publishBanChange({ kind: 'unban', steamid });
    logAdmin(db, adminId, 'unalias_player', steamid);
    return { ok: true };
  });

  app.post('/api/admin/players/:steamid/clear-penalties', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    const n = clearPenalties(db, t.steamid, t.adminId);
    logAdmin(db, t.adminId, 'clear_penalties', t.steamid, { cleared: n });
    return { ok: true, cleared: n };
  });

  /** Ask Steam about this account now, rather than wait for the weekly pass.
   *  Not audited: it changes nothing an admin did, only how fresh the panel is. */
  app.post('/api/admin/players/:steamid/steam-refresh', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    if (!opts.refreshSignals) return reply.code(503).send({ error: 'no Steam api key is configured' });
    return { ok: true, refreshed: await opts.refreshSignals(t.steamid) };
  });

  app.post('/api/admin/players/:steamid/notes', async (req, reply) => {
    const t = target(req, reply);
    if (!t) return reply;
    const { text } = (req.body ?? {}) as { text?: unknown };
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) {
      return reply.code(400).send({ error: 'a note needs text (up to 2000 characters)' });
    }
    addNote(db, t.steamid, t.adminId, text.trim());
    logAdmin(db, t.adminId, 'note', t.steamid);
    return { ok: true };
  });

  app.get('/api/admin/overview', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { ...adminOverview(db, logAuth), queue: matchmaker.publicQueue().players };
  });

  app.post('/api/admin/matches/:id/abort', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    const r = abortMatch(db, releaser, id);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, adminId, 'abort_match', id);
    broadcast('refresh');
    return { ok: true };
  });

  app.post('/api/admin/matches/:id/void', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    const { reason } = (req.body ?? {}) as { reason?: unknown };
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) {
      return reply.code(400).send({ error: 'a reason is required (up to 500 characters)' });
    }
    const r = voidMatch(db, id, reason.trim());
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    logAdmin(db, adminId, 'void_match', id, { reason: reason.trim() });
    broadcast('refresh');
    return { ok: true };
  });

  app.get('/api/admin/live', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return buildLiveBoard(db, { voice: opts.voice ?? null });
  });

  /**
   * Hold, release, extend or end one dropped player's reconnect allowance.
   *
   * The allowance lives in the plugin, so this is an rcon command and its
   * answer. Only a PUGOK changes the board. A refusal, an old plugin, an
   * unreachable box and an unreadable answer all leave presence exactly as it
   * was and come back as the error the card shows. The attempt is audited
   * either way, the same way the log secret push is.
   */
  app.post('/api/admin/live/:matchId/players/:steamid/leave', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { matchId: rawId, steamid } = req.params as { matchId: string; steamid: string };
    const matchId = Number(rawId);
    const { action, seconds } = (req.body ?? {}) as { action?: unknown; seconds?: unknown };
    if (typeof action !== 'string' || !(LEAVE_ACTIONS as readonly string[]).includes(action)) {
      return reply.code(400).send({ error: 'action must be hold, release, add or end' });
    }
    let secs: number | undefined;
    if (action === 'add') {
      secs = Number(seconds);
      if (!Number.isInteger(secs) || secs < 1 || secs > LEAVE_ADD_MAX_S) {
        return reply.code(400).send({ error: `seconds must be a whole number between 1 and ${LEAVE_ADD_MAX_S}` });
      }
    }
    const match = db.prepare('SELECT state, token, server_id FROM matches WHERE id = ?').get(matchId) as
      | { state: string; token: string | null; server_id: number | null } | undefined;
    if (!match) return reply.code(404).send({ error: 'no such match' });
    if (match.state !== 'configuring' && match.state !== 'live') return reply.code(409).send({ error: `match is ${match.state}` });
    if (!isRostered(db, matchId, steamid)) return reply.code(404).send({ error: 'not on that match\'s roster' });
    const server = match.server_id !== null ? getServer(db, match.server_id) : undefined;
    if (!match.token || !server) return reply.code(409).send({ error: 'that match has no server yet' });
    if (!serverQuery) return reply.code(503).send({ error: 'clock control is not available here' });

    const detail = { matchId, action, ...(secs === undefined ? {} : { seconds: secs }) };
    // Built OUTSIDE the try. leaveCommand asserts its arguments, and a throw
    // from it means our own tables hold something that must never become a
    // console line; reported as a 502 "could not reach Dallas" it would read
    // as a box being down, and someone would go and look at the box.
    const command = leaveCommand(match.token, steamid, action as LeaveAction, secs);
    // Anything the box says back can quote the command, and the command holds
    // the token, which is this match's sv_password.
    const hide = (text: string): string => redactSecrets(text, [match.token]);
    let body: string;
    try {
      body = await serverQuery(server, command);
    } catch (err) {
      const message = hide(err instanceof Error ? err.message : String(err));
      logAdmin(db, adminId, 'leave_clock', steamid, { ...detail, ok: false, error: message });
      return reply.code(502).send({ error: `could not reach ${server.name}: ${message}` });
    }
    let answer = parseLeaveReply(body);
    // An rcon response carries whatever else was on the console. An answer
    // about another player is somebody else's answer, and leave_control is
    // deliberately NOT set to 1 on it: an answer we are not reading tells us
    // nothing about the plugin this command reached.
    if (answer.ok && answer.steamid !== steamid) answer = { ok: false, oldPlugin: false, error: 'the answer was about another player' };
    if (!answer.ok) {
      if (answer.oldPlugin) {
        db.prepare('UPDATE matches SET leave_control = 0 WHERE id = ?').run(matchId);
        broadcast('refresh');
      }
      const error = hide(answer.error);
      logAdmin(db, adminId, 'leave_clock', steamid, { ...detail, ok: false, error });
      return reply.code(409).send({
        error: answer.oldPlugin ? error : `${server.name} refused: ${error}`,
        code: answer.oldPlugin ? 'old_plugin' : 'refused',
      });
    }
    db.prepare('UPDATE matches SET leave_control = 1 WHERE id = ?').run(matchId);
    applyLeaveState(db, matchId, steamid, answer.state);
    logAdmin(db, adminId, 'leave_clock', steamid, { ...detail, ok: true, remaining: answer.state.remaining, held: answer.state.held });
    broadcast('refresh');
    return { ok: true, reply: answer.line, state: answer.state };
  });

  app.post('/api/admin/servers/:id/idle', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    if (!getServer(db, id)) return reply.code(404).send({ error: 'no such server' });
    releaser.release(id);
    logAdmin(db, adminId, 'server_idle', id);
    broadcast('refresh');
    return { ok: true };
  });

  /** Take a server in or out of the matchmaker's pool.
   *
   *  Separate from /idle, which changes where a box is in a match's lifecycle.
   *  This changes whether it is eligible at all, and deliberately leaves a
   *  running match alone: disabling mid-match lets that match finish. */
  app.post('/api/admin/servers/:id/enabled', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    if (!getServer(db, id)) return reply.code(404).send({ error: 'no such server' });
    const { enabled } = (req.body ?? {}) as { enabled?: unknown };
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be true or false' });
    setEnabled(db, id, enabled);
    logAdmin(db, adminId, enabled ? 'server_enable' : 'server_disable', id);
    broadcast('refresh');
    return { ok: true };
  });

  /** Restart srcds after every match on this box.
   *
   *  Per server and off by default. The lever is `quit` over rcon and the
   *  box's own supervisor starting it again; on a box where nothing does, the
   *  server is gone until someone opens its host's control panel. So this is
   *  turned on one box at a time by an admin who can watch the first cycle,
   *  never as a global default. */
  app.post('/api/admin/servers/:id/restart-after-match', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    if (!getServer(db, id)) return reply.code(404).send({ error: 'no such server' });
    const { on } = (req.body ?? {}) as { on?: unknown };
    if (typeof on !== 'boolean') return reply.code(400).send({ error: 'on must be true or false' });
    setRestartAfterMatch(db, id, on);
    logAdmin(db, adminId, 'server_restart_after_match', id, { on });
    broadcast('refresh');
    return { ok: true };
  });

  /**
   * Give a server its log secret, which its plugins sign every log line with
   * (src/logAuth.ts). One button for three cases:
   *
   *   no secret yet   generate one, store it, push it. Stored even when the
   *                   push does not land (plugins not staged yet): setupMatch
   *                   pushes it again with every match.
   *   has one         push the SAME one again. The repair for a box that lost
   *                   it: rebuilt, or its data/ directory wiped.
   *   rotate: true    a new one, stored ONLY once the box has it. The other
   *                   order would leave an enforcing server signing with a
   *                   secret the backend had already thrown away.
   *
   * The secret never goes to the browser or into the audit log.
   */
  app.post('/api/admin/servers/:id/log-secret', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    const server = getServer(db, id);
    if (!server) return reply.code(404).send({ error: 'no such server' });
    if (!logSecretPusher) return reply.code(503).send({ error: 'pushing a log secret is not available here' });
    const rotate = (req.body as { rotate?: unknown } | null)?.rotate === true && server.log_secret !== null;
    const secret = rotate || server.log_secret === null ? newLogSecret() : server.log_secret;
    if (server.log_secret === null) setLogSecret(db, id, secret);
    let pushed = false;
    try {
      pushed = await logSecretPusher(server, secret);
    } catch (err) {
      // The push is `sm_pug_log_secret "<secret>"`, and an rcon timeout names
      // the command it gave up on, so the failure message is the secret.
      const message = redactSecrets(err instanceof Error ? err.message : String(err), [secret]);
      logAdmin(db, adminId, 'server_log_secret', id, { rotated: false, pushed: false, error: message });
      return reply.code(502).send({ error: `could not reach ${server.name}: ${message}` });
    }
    const rotated = rotate && pushed;
    if (rotated) setLogSecret(db, id, secret);
    logAdmin(db, adminId, 'server_log_secret', id, { rotated, pushed });
    broadcast('refresh');
    return { ok: true, pushed, rotated };
  });

  /** What happens to a log line that fails its signature: off, log (count it,
   *  accept it) or enforce (drop it). Per server, because plugins roll out a
   *  box at a time. Refused without a secret, since there would be nothing to
   *  check a line against and `enforce` would read as protection it is not. */
  app.post('/api/admin/servers/:id/log-auth', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    const server = getServer(db, id);
    if (!server) return reply.code(404).send({ error: 'no such server' });
    const { mode } = (req.body ?? {}) as { mode?: unknown };
    if (typeof mode !== 'string' || !(LOG_AUTH_MODES as readonly string[]).includes(mode)) {
      return reply.code(400).send({ error: `mode must be one of ${LOG_AUTH_MODES.join(', ')}` });
    }
    if (mode !== 'off' && server.log_secret === null) {
      return reply.code(409).send({ error: 'give this server a log secret first' });
    }
    setLogAuthMode(db, id, mode as LogAuthMode);
    logAdmin(db, adminId, 'server_log_auth', id, { mode });
    broadcast('refresh');
    return { ok: true };
  });

  app.post('/api/admin/servers/:id/sourcetv', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    if (!getServer(db, id)) return reply.code(404).send({ error: 'no such server' });
    const { enabled, port, password } = (req.body ?? {}) as { enabled?: unknown; port?: unknown; password?: unknown };
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be true or false' });
    let tvPort: number | null = null;
    if (port !== undefined && port !== null && port !== '') {
      tvPort = Number(port);
      if (!Number.isInteger(tvPort) || tvPort < 1024 || tvPort > 65535) {
        return reply.code(400).send({ error: 'port must be between 1024 and 65535' });
      }
    }
    if (enabled && tvPort === null) return reply.code(400).send({ error: 'a port is needed to enable SourceTV' });
    const pw = typeof password === 'string' ? password.trim().slice(0, 64) : '';
    db.prepare('UPDATE servers SET tv_enabled = ?, tv_port = ?, tv_password = ? WHERE id = ?')
      .run(enabled ? 1 : 0, tvPort, pw, id);
    logAdmin(db, adminId, 'server_sourcetv', id, { enabled, port: tvPort });
    broadcast('refresh');
    return { ok: true };
  });

  // Probing is a network round trip per server, so this is an explicit admin
  // action rather than something that runs on page load. The result is
  // stored, and the pool gate (serversMissingDlc4) reads that stored value
  // rather than probing again.
  app.post('/api/admin/servers/dlc4-check', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const results = [];
    for (const s of listServers(db)) {
      const hasDlc4 = await dlc4Probe(s);
      setHasDlc4(db, s.id, hasDlc4);
      results.push({ id: s.id, name: s.name, hasDlc4 });
    }
    // 'all': this action is about every server at once and has no single
    // target id, unlike server_idle/server_enable which target one.
    logAdmin(db, adminId, 'server_dlc4_check', 'all', { results });
    broadcast('refresh');
    return { results };
  });

  /**
   * Put every website admin on every box now.
   *
   * There is a sweep and a push on every `set_admin`, so this is the manual
   * repair: an admin who has just been told "I still have no admin on
   * Chicago" wants to fix it and see per-box confirmation, not wait fifteen
   * minutes and hope. Returns a row per server, failures included, because
   * "it worked on three of four" is the answer that actually needs showing.
   */
  app.post('/api/admin/servers/admins-sync', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    if (!adminSync) return reply.code(503).send({ error: 'admin sync is not configured on this server' });
    const results = await adminSync.sync();
    logAdmin(db, adminId, 'server_admins_sync', 'all', { results });
    return { results };
  });

  app.post('/api/admin/queue/remove', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { steamid } = (req.body ?? {}) as { steamid?: unknown };
    if (typeof steamid !== 'string') return reply.code(400).send({ error: 'steamid required' });
    matchmaker.leave(steamid);
    logAdmin(db, adminId, 'queue_remove', steamid);
    return { ok: true };
  });

  // The map_pool value as it stands right now, tolerating anything that is
  // not a clean JSON string array rather than 500ing the settings page over
  // a setting no admin can otherwise see or fix from here.

  app.get('/api/admin/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return {
      settings: SETTINGS_SCHEMA.map((d) => ({ ...d, value: getSetting(db, d.key) ?? '' })),
      // alsoAllow keeps an already-pooled campaign in the list even after it
      // stops qualifying on its own (disabled, or a server lost its VPK), so
      // the panel does not make its own already-saved setting look invalid.
      campaigns: poolableCampaigns(db, { alsoAllow: getCampaignPool(db) })
        .map((c) => ({ slug: c.slug, name: c.name, custom: c.custom })),
      // Named servers, not just a boolean, so the panel can say which box is
      // holding the dlc4 campaigns out of the pool instead of leaving an
      // admin to guess.
      serversMissingDlc4: serversMissingDlc4(db),
    };
  });

  app.put('/api/admin/settings/:key', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { key } = req.params as { key: string };
    const def = settingDef(key);
    if (!def) return reply.code(404).send({ error: 'unknown setting' });
    // Same alsoAllow reasoning as the GET above: this must accept whatever
    // it is about to offer as a candidate, or saving any other campaigns
    // setting unrelated to this exact key could reject on a slug the panel
    // itself still shows as checked.
    const v = validateSetting(key, (req.body as { value?: unknown } | undefined)?.value, {
      campaignSlugs: new Set(poolableCampaigns(db, { alsoAllow: getCampaignPool(db) }).map((c) => c.slug)),
    });
    if (!v.ok) return reply.code(400).send({ error: `${def.label} ${v.error}` });
    const from = getSetting(db, key) ?? '';
    setSetting(db, key, v.value);
    logAdmin(db, adminId, 'setting', key, def.secret ? { changed: true } : { from, to: v.value });
    return { ok: true, value: v.value };
  });

  const REVIEW_STATES = new Set(['new', 'reviewed', 'dismissed']);

  app.get('/api/admin/integrity', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const raw = (req.query as { season?: string }).season;
    const seasonId = raw === undefined || raw === '' ? null : Number(raw);
    if (seasonId !== null && !Number.isInteger(seasonId)) return reply.code(400).send({ error: 'bad season' });
    // The feed and the health line ship with the board so the panel can show
    // them before anyone clicks a player. Without them an empty page cannot
    // distinguish "nothing suspicious" from "silently broken".
    return {
      players: integrityBoard(db, seasonId),
      flags: recentFlagFeed(db),
      health: captureHealth(db),
    };
  });

  /**
   * The analysis job: its state, and starting one.
   *
   * GET is safe to poll; the panel does while a run is going. `pending` is the
   * count of indexed rounds nothing has measured, which is what tells an admin
   * whether pressing the button would do anything. `unanalysable` is the rounds
   * the current analyzer tried and gave up on, which are NOT pending and would
   * otherwise be invisible.
   */
  app.get('/api/admin/integrity/backfill', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!integrityJobs) return { available: false as const };
    return {
      available: true as const,
      job: integrityJobs.snapshot(),
      pending: pendingRoundCount(db),
      unanalysable: unanalysableCounts(db),
      matchInFlight: matchInFlight(db),
    };
  });

  app.post('/api/admin/integrity/backfill', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    if (!integrityJobs) return reply.code(409).send({ error: 'no replay directory is configured' });
    const body = (req.body ?? {}) as { mode?: string; force?: boolean };
    const mode: JobMode = body.mode === 'pending' ? 'pending' : 'full';
    const started = integrityJobs.start(mode, { force: body.force === true });
    if (!started.ok) return reply.code(409).send({ error: started.reason });
    // Logged with the force flag: overriding the in-flight guard is exactly
    // the decision someone will later want to know was made deliberately.
    logAdmin(db, adminId, 'integrity_backfill', mode, { force: body.force === true });
    return { job: integrityJobs.snapshot() };
  });

  app.get('/api/admin/integrity/:steamid', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const { steamid } = req.params as { steamid: string };
    return integrityPlayer(db, steamid);
  });

  app.post('/api/admin/integrity/:matchId/:ordinal/:half/:slot/review', async (req, reply) => {
    // requireAdmin RETURNS the acting admin steamid (src/routes/guards.ts:47), or
    // null having already sent the 401/403. That id is what the audit log needs.
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const p = req.params as { matchId: string; ordinal: string; half: string; slot: string };
    const body = (req.body ?? {}) as { state?: string; note?: string };
    const state = String(body.state ?? '');
    if (!REVIEW_STATES.has(state)) return reply.code(400).send({ error: 'unknown review state' });
    const key = { matchId: Number(p.matchId), ordinal: Number(p.ordinal), half: Number(p.half) };
    const slot = Number(p.slot);
    if (![key.matchId, key.ordinal, key.half, slot].every(Number.isInteger)) {
      return reply.code(400).send({ error: 'bad round' });
    }
    const note = String(body.note ?? '').slice(0, 500);
    setReview(db, key, slot, state, note, adminId);
    logAdmin(db, adminId, 'integrity_review', `${key.matchId}/${key.ordinal}/${key.half}/${slot}`, { state, note });
    return { ok: true };
  });

  const seasonName = (raw: unknown): string | null =>
    typeof raw === 'string' && raw.trim() && raw.trim().length <= 60 ? raw.trim() : null;

  app.get('/api/admin/seasons', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { seasons: listSeasons(db) };
  });

  app.post('/api/admin/seasons/:id/rename', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const id = Number((req.params as { id: string }).id);
    const name = seasonName((req.body as { name?: unknown } | undefined)?.name);
    if (!name) return reply.code(400).send({ error: 'a season name of up to 60 characters is required' });
    if (!renameSeason(db, id, name)) return reply.code(404).send({ error: 'no such season' });
    logAdmin(db, adminId, 'rename_season', id, { name });
    broadcast('refresh');
    return { ok: true };
  });

  app.post('/api/admin/seasons/new', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const name = seasonName((req.body as { name?: unknown } | undefined)?.name);
    if (!name) return reply.code(400).send({ error: 'a season name of up to 60 characters is required' });
    const r = startNewSeason(db, name);
    if (!r.ok) return reply.code(409).send({ error: r.error });
    logAdmin(db, adminId, 'new_season', r.id, { name });
    broadcast('refresh');
    return { ok: true, id: r.id };
  });

  app.get('/api/admin/audit', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    return { actions: recentActions(db, adminId) };
  });
}
