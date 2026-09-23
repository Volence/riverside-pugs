import { spawn } from 'node:child_process';
import { pruneDemos } from './demoPrune.js';
import { sweepDemos } from './demoOffload.js';
import { r2FromEnv } from './r2.js';
import { reindexRecentMatches } from './reindex.js';
import { IntegrityJobs, matchInFlight, pendingRoundCount } from './integrity/job.js';
import { handleAbandon } from './abandon.js';
import { AdminFeedPoster } from './discord/adminFeedPoster.js';
import { TicketSync } from './discord/ticketSync.js';
import { TicketMirror } from './discord/ticketMirror.js';
import { ReporterChats } from './discord/reporterChats.js';
import { AttachmentStore, httpFetcher } from './tickets/attachments.js';
import { handleTicketButton, handleTicketModal, opensTicketModal } from './discord/ticketButtons.js';
import { ReportButton, handleReportButton, handleReportModal, opensReportModal } from './discord/reportButton.js';
import { handleRemoveCommand, REMOVE_COMMAND } from './discord/ticketRemove.js';
import { purgeRemovedFiles } from './tickets/removal.js';
import { playerByDiscordId } from './players.js';
import { applyGate } from './discord/gate.js';
import { GuildMembership } from './discord/membership.js';
import { VoicePresence } from './discord/voicePresence.js';
import { makeQueueGate } from './queueGate.js';
import { makeReadyGate } from './readyGate.js';
import { canonicalise } from './aliases.js';
import { recordPlayerNet } from './playerNetworks.js';
import { publishAdminEvent } from './adminFeed.js';
import { activeTimeout } from './penalties.js';
import { adminRoutes } from './routes/admin.js';
import { isWheel } from './inputStats.js';
import { peopleRoutes } from './routes/people.js';
import { banMessage, liftExpiredBans } from './admin/players.js';
import { botEnabled, startBot, type RunningBot } from './discord/index.js';
import { createDjsTransport } from './discord/djsTransport.js';
import { VoiceChannels } from './discord/voice.js';
import { COMMAND_DEFS, handleCommand } from './discord/commands.js';
import { fetchDiscordApi, type DiscordApi } from './discord/api.js';
import type { ModerationOps } from './discord/transport.js';
import { discordAuthRoutes } from './routes/discordAuth.js';
import { twitchAuthRoutes } from './routes/twitchAuth.js';
import { makeTwitchApi, type TwitchApi } from './twitch/api.js';
import { startTwitchPoll } from './twitchPoll.js';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STATUS_CODES } from 'node:http';
import { readFileSync } from 'node:fs';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { verifyLogin as realVerifyLogin, fetchPersona as realFetchPersona } from './steamAuth.js';
import { backfillPersonas } from './personaBackfill.js';
import { refreshSteamSignals, startSteamSignalRefresh, type SignalDeps } from './steamSignals.js';
import { authRoutes } from './routes/auth.js';
import { renewSession } from './session.js';
import { Hub } from './ws.js';
import { wsRoutes } from './routes/ws.js';
import { ticketNudger } from './tickets/nudge.js';
import { subscribeTicketSignals } from './tickets/signals.js';
import { Matchmaker } from './matchmaker.js';
import { DevOrchestrator, RealOrchestrator, type Orchestrator } from './orchestrator.js';
import { ServerReleaser, reconcileServers, type ServerCleaner } from './serverRelease.js';
import { cheatName, cvarActOf, liveMatchOf, recordIntegrityFlag } from './integrityFlags.js';
import { inputThresholds, recordInputBurst, recordInputCap } from './inputBursts.js';
import { resolveServerBySource, isKnownServerAddress, type ServerRow } from './serverPool.js';
import { abortCommand, resetMap, problemText } from './matchTeardown.js';
import { PendingMatches } from './pendingMatches.js';
import { RconClient as RealRcon } from './rcon.js';
import type { ServerQuery } from './leaveControl.js';
import { ServerBanSync, type ServerExec } from './serverBans.js';
import { ServerAdminSync } from './serverAdmins.js';
import { kickThenQuit, rconRestarter, type ServerRestarter } from './serverRestart.js';
import { LogListener, type LogMeta } from './logListener.js';
import { LogAuth, pushLogSecret } from './logAuth.js';
import { SelfStartedMatches } from './selfStarted.js';
import { SignonDropNotifier } from './signonDropNotify.js';
import {
  recordMatchStart, recordMapResult, recordHeartbeat, recordLiveStat, recordLiveEvent, recordChat,
  recordRoundStart, recordRoundEnd,
  reapOrphanedMatches,
  recordPhase,
} from './liveView.js';
import { recordPlayerConnect, reapNoShowMatches } from './noShow.js';
import { recordPresenceLine, sweepPresence } from './presence.js';
import { recordMatchDemos } from './demos.js';
import { recordMatchReplays } from './replays.js';
import { pruneReplays } from './replayPrune.js';
import { apiRoutes } from './routes/api.js';
import { ticketRoutes } from './routes/tickets.js';
import { statsRoutes } from './routes/stats.js';
import { replayRoutes } from './routes/replays.js';
import { devRoutes } from './routes/dev.js';
import { campaignRoutes } from './routes/campaigns.js';
import type { InstallTarget } from './campaignInstall.js';
import { notifyDiscord } from './discord.js';
import { setMissionsDirs } from './campaignRegistry.js';

export interface ServerDeps {
  config: Config;
  db: DB;
  verifyLogin?: typeof realVerifyLogin;
  fetchPersona?: typeof realFetchPersona;
  hub?: Hub;
  orchestrator?: Orchestrator;
  /** Injected in tests; built from config.discord otherwise. */
  discordApi?: DiscordApi;
  /** Injected in tests; built from config.twitch otherwise. Explicit null
   *  means "no Twitch even though it is configured", which is how a test keeps
   *  the poller from starting. */
  twitchApi?: TwitchApi | null;
  /** Every Steam Web API call the signals and the persona backfill make.
   *  Injected in tests, which also keeps the background refresher from
   *  starting; production leaves it out and gets the real fetch. */
  steamFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Injected in tests so releasing a server never dials rcon. */
  serverCleaner?: ServerCleaner;
  /** Runs a batch of console commands on one server, for the ban sync.
   *  Injected in tests so a ban never dials rcon. */
  serverExec?: ServerExec;
  /** Injected in tests so nothing ever asks a real box to quit. */
  serverRestarter?: ServerRestarter;
  /** Free bytes on the addons filesystem, for the campaign upload disk-floor
   *  check. Injected in tests; built from a real statfs on config.addonsDir
   *  otherwise, same as orchestrator and serverCleaner. */
  freeBytes?: () => Promise<number>;
  /** Servers a published or reinstalled campaign is pushed to, or a deleted
   *  one is pulled from. Injected in tests so a fake transport's per-server
   *  results can be asserted without a real servers table. Defaults to every
   *  enabled server, resolved through transportFor. */
  installTargets?: () => InstallTarget[];
  /** Overrides the campaign upload's multipart file-size limit. Injected in
   *  tests to exercise the truncation path without a multi-gigabyte body. */
  maxUploadBytes?: number;
  /** Overrides where the campaign uploader reads the enforced file list from.
   *  Injected in tests only; production reads the committed cfg. */
  consistencyListPath?: string;
  /** Probes one server for the dlc4 mappack, for the admin's dlc4-check
   *  route. Injected in tests so the check never dials a real box; defaults
   *  to the real serverHasDlc4 otherwise. */
  dlc4Probe?: (server: ServerRow) => Promise<boolean>;
  /** Pushes one server its log secret, for the admin's log-secret route.
   *  Injected in tests so it never dials a real box. */
  logSecretPusher?: (server: ServerRow, secret: string) => Promise<boolean>;
  /** Runs one console command on one server and returns the reply, for the
   *  live board's clock actions. Injected in tests so they never dial a box. */
  serverQuery?: ServerQuery;
  /** Test seam: stands in for the running bot's moderation surface, so a
   *  ticket-discord-sanction route can be tested without a real bot. When
   *  set, it wins over whatever the bot (if any) is actually running. */
  discordModeration?: ModerationOps;
  /** Test seam: stands in for the running bot's reporter chats, so the
   *  chat routes can be tested without a real bot. Wins when set. */
  reporterChats?: ReporterChats;
}

/** Delays between attempts to collect a finished match, in ms.
 *
 *  MATCH_END is emitted from the plugin's OnMapStart when the finale loads,
 *  which is the single worst moment to dial rcon: srcds is mid-changelevel and
 *  the connection times out. That is exactly what happened to match 8 on
 *  2026-09-11, and because nothing retried, a fully played four-map match sat
 *  unrecorded until it was collected by hand.
 *
 *  Every failure path in finishMatch deliberately leaves the match 'live' and
 *  logs "leaving live for retry" -- this is the thing that was supposed to be
 *  doing the retrying. Spaced to cover a slow map load and then some.
 *
 *  Roughly four minutes end to end. When they run out the match is aborted and
 *  its server released; see the give-up block at the end of finishWithRetry for
 *  why leaving it live is not an option. */
const FINISH_RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

/** Injection seam for the tests only; production passes nothing. */
export interface FinishRetryOpts {
  delays?: number[];
  sleep?: (ms: number) => Promise<void>;
}

export async function finishWithRetry(
  db: DB, orchestrator: RealOrchestrator, matchId: number, releaser: ServerReleaser,
  opts: FinishRetryOpts = {},
): Promise<void> {
  const delays = opts.delays ?? FINISH_RETRY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const stillLive = () =>
    (db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as
      { state: string } | undefined)?.state === 'live';

  // `not_ended` is not a failed collection, and must not be treated as one:
  // the plugin answered, and what it said is that the match is still being
  // played. Everything below this loop aborts the match and releases its box,
  // which sends sm_pug_abort, so falling through would let the forged
  // MATCH_END that got us here kill the match it could no longer rate.
  if (await orchestrator.finishMatch(matchId) === 'not_ended') return;
  for (const wait of delays) {
    if (!stillLive()) return;
    await sleep(wait);
    // Re-check after the wait: another path may have completed it meanwhile.
    if (!stillLive()) return;
    console.warn(`[orchestrator] retrying collection of match ${matchId}`);
    if (await orchestrator.finishMatch(matchId) === 'not_ended') return;
  }
  if (!stillLive()) return;

  // Out of retries. Leaving the match 'live' was the old behaviour and it pins
  // the box forever, because nothing can ever find it again: the plugin's
  // Timer_Heartbeat emits for any state that is not MS_None and MS_Ended
  // qualifies, so an ended-but-uncollected match keeps heartbeating and
  // reapOrphanedMatches, which needs heartbeat LOSS, never fires; and
  // reapNoShowMatches matches neither of its rules, because these players did
  // connect and rounds were recorded. Before the web queue that cost a manual
  // cleanup (match 8, 2026-09-11). With it, every later queue pop pends behind
  // the pinned server and the queue is dead.
  //
  // Guarded on state = 'live' so a completion that lands in the same tick as
  // this write is never clobbered.
  const row = db.prepare('SELECT server_id, token FROM matches WHERE id = ?').get(matchId) as
    { server_id: number | null; token: string | null } | undefined;
  const changed = db
    .prepare("UPDATE matches SET state = 'aborted', ended_at = datetime('now') WHERE id = ? AND state = 'live'")
    .run(matchId).changes;
  if (changed === 0) return;

  // Collect the dump HERE, before the release, because the release is what
  // destroys it: releaser.release sends sm_pug_abort for this same token and
  // the plugin drops its result on that. This block used to tell the operator
  // to run sm_pug_dump afterwards, which by then answers PUGERR every time, so
  // a case that was recoverable by hand (match 8, 2026-09-11, the incident
  // that motivated these retries) had become guaranteed unrecoverable.
  //
  // Best effort on purpose: a dump we cannot fetch is a worse incident, never
  // a reason to keep the box, since giving up exists precisely so a lost
  // result cannot wedge the queue.
  let dump: string | null = null;
  if (row?.server_id != null && row.token) {
    try {
      dump = await orchestrator.pullDump(row.server_id, row.token);
    } catch (err) {
      console.error(
        `[orchestrator] could not pull the dump for match ${matchId} before releasing:`, err,
      );
    }
  }

  // Loud, and worded as an incident rather than a routine sweep: a played
  // match whose result was lost costs everyone on it their rating movement,
  // and the dump is the only copy. It is inlined below rather than left on the
  // box, so it survives in the log whether or not anyone reaches the server in
  // time, and whether or not the plugin is reloaded first.
  publishAdminEvent({
    kind: 'problem', matchId,
    text: `Match #${matchId} was played but its result could not be collected, so it was aborted with no rating change. ${dump ? 'The dump is in the server log for scripts/recover-match.ts.' : 'The dump could not be collected either.'}`,
  });
  console.error(
    `[orchestrator] INCIDENT: match ${matchId} was played but never collected after ` +
    `${delays.length} retries. It has been aborted and its server released so the queue can ` +
    `move on, which means NO result and NO rating change was recorded. ` +
    (dump
      ? 'Its final dump follows; feed it to scripts/recover-match.ts to close the match by ' +
        `hand.\n${dump}`
      : 'Its dump could NOT be collected either, so there is nothing left to recover from ' +
        'and scripts/recover-match.ts has no input.'),
  );
  // Through the releaser rather than a raw status write, and this is the half
  // that also stops the heartbeat: the releaser clears sv_password AND sends
  // sm_pug_abort for this token, so the plugin drops back to MS_None instead
  // of holding a match nobody is collecting. It also wakes the waiters.
  //
  // Deliberately no clearLive() here, unlike reapOrphanedMatches: the live
  // scratch rows are now the only surviving trace of a match whose
  // authoritative dump was lost, and they cost nothing, since every reader
  // filters on state = 'live'.
  if (row?.server_id != null) releaser.release(row.server_id);
}

/** Vite builds web/ to dist/public (see vite.config.ts). In dev the Vite
 *  server owns the browser and proxies here, so this path only matters in
 *  production. */
const STATIC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'public');

/** The app shell as bytes, or null when there is no built frontend to serve.
 *
 *  Only for the malformed-URL handler, which runs before @fastify/static has
 *  decorated a reply and so has no sendFile to call: the fallback at the
 *  bottom of buildServer still goes through the plugin. Same file, same
 *  directory, so the two cannot serve different shells. */
function readShell(): Buffer | null {
  try {
    return readFileSync(join(STATIC_ROOT, 'index.html'));
  } catch {
    return null;
  }
}

/**
 * Whether this is a browser navigating to a page, rather than something
 * asking this server for one of the things it owns.
 *
 * One list, asked by both the SPA fallback and the malformed-URL handler
 * above it: two copies of "what counts as a page" would drift, and the one
 * that drifted would start answering a typo'd endpoint with a 200 full of
 * HTML that fails somewhere much less obvious. Non-GET methods are never a
 * page navigation. The list is what the fallback has always used: a mistyped
 * `/download/...` link still lands on the site's own not-found page rather
 * than a JSON body, which is what somebody following a link from Discord
 * should see.
 */
function isPageRequest(method: string, url: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return !['/api/', '/auth/', '/ws'].some((prefix) => url.startsWith(prefix));
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // A URL fastify cannot even parse, which is almost always a percent
    // escape truncated by a paste or a chat client, is refused here, before
    // routing, so the SPA fallback at the bottom of this file never sees it.
    // On a page path that handed the reader a bare 400 JSON body for what is
    // otherwise an ordinary page URL, so the same answer the fallback gives
    // is given here. Everything else is answered exactly as fastify would:
    // this replaces the framework's own handler rather than wrapping it, so
    // the default response is rebuilt rather than inherited.
    frameworkErrors: (err, req, reply) => {
      const e = err as Error & { code?: string; statusCode?: number };
      // The reply handed to this hook is typed against a route that does not
      // exist yet, so its send() accepts nothing; it is an ordinary reply.
      const res = reply as unknown as FastifyReply;
      if (e.code === 'FST_ERR_BAD_URL' && isPageRequest(req.method, req.raw.url ?? '')) {
        const shell = readShell();
        if (shell !== null) {
          // Spelled out because this path sends bytes rather than going
          // through @fastify/static, which appends the charset itself.
          void res.type('text/html; charset=utf-8').send(shell);
          return;
        }
      }
      const statusCode = e.statusCode ?? 500;
      void res.code(statusCode).send({
        error: STATUS_CODES[statusCode] ?? 'Error',
        code: e.code,
        message: e.message,
        statusCode,
      });
    },
  });

  // Module state rather than a constructor argument: campaignRegistry(db) is
  // called from a dozen places that have no business knowing about the game
  // directory, so this is set once here instead of threaded through all of them.
  setMissionsDirs([deps.config.missionsDir, deps.config.dlc4MissionsDir]);

  // Null unless all five R2 variables are set, which turns the whole offload
  // off: demos then stay on disk and are served from there, exactly as before.
  // Read once here rather than per request so a half-edited .env cannot change
  // behaviour mid-process.
  const r2 = r2FromEnv();
  if (r2) console.log(`[demoOffload] R2 configured: bucket ${r2.bucket}`);

  // logger: false above means Fastify's own default error handler is the only
  // thing that would otherwise put err.message on the wire in a 500 body. For
  // a route error that carries an explicit statusCode, that message is a
  // deliberate, deliberately-worded HTTP error and is fine to show. Anything
  // else is a bug, not a chosen response, and its message can carry things
  // that must never reach an anonymous caller: an ENOENT raised while reading
  // a ranked replay carries the absolute path, and that filename contains the
  // match token that seeds the game server's sv_password. Log the real error
  // here, the same way the rest of this codebase reports errors, and send
  // back nothing but a fixed, generic message.
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const statusCode = err.statusCode;
    if (typeof statusCode === 'number') {
      reply.code(statusCode).send({
        statusCode,
        error: STATUS_CODES[statusCode] ?? 'Error',
        message: err.message,
      });
      return;
    }
    console.error('[server] unhandled error:', err);
    reply.code(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'internal server error',
    });
  });

  // Best effort and never awaited: a Steam outage must not delay boot.
  void backfillPersonas(deps.db, deps.config.steamApiKey, deps.steamFetch)
    .then((n) => { if (n > 0) console.log(`[persona] backfilled ${n} player(s)`); })
    .catch((err) => console.error('[persona] backfill failed:', err));

  // What Steam says about each account, for the admin player page. Without an
  // api key every call below is a no-op, so nothing here is conditional on it.
  const signalDeps: SignalDeps = { db: deps.db, apiKey: deps.config.steamApiKey, fetchFn: deps.steamFetch };
  // Fire and forget, always: a caller is a login or a log event, and neither
  // may wait on Steam or fail because of it. refreshSteamSignals does not
  // throw; the catch is for whatever it has not thought of.
  const refreshSignals = (steamids: string[], opts: Parameters<typeof refreshSteamSignals>[2] = {}): void => {
    void refreshSteamSignals(signalDeps, steamids, opts)
      .catch((err) => console.error('[steamSignals] refresh failed:', err));
  };
  // Same rule as the Twitch poller below: tests inject the fetch and drive the
  // refresh directly, so a timer started for them would only outlive the test.
  const stopSignalRefresh = deps.steamFetch === undefined ? startSteamSignalRefresh(signalDeps) : null;

  await app.register(cookie, { secret: deps.config.cookieSecret });
  // Sliding renewal. After the cookie plugin, whose own onRequest hook is
  // what parses the header this reads. Not on the way out: renewing a
  // session in the same response that clears it would send both cookies.
  const secureCookies = deps.config.publicUrl.startsWith('https://');
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.split('?')[0] === '/auth/logout') return;
    renewSession(req, reply, deps.db, secureCookies);
  });
  await app.register(websocket);
  await app.register(fastifyStatic, { root: STATIC_ROOT });

  const membership = new GuildMembership();
  const presence = new VoicePresence();
  const discordApi: DiscordApi | null = deps.config.discord
    ? deps.discordApi ?? fetchDiscordApi(deps.config.discord)
    : null;
  await app.register(authRoutes, {
    config: deps.config,
    db: deps.db,
    verifyLogin: deps.verifyLogin ?? realVerifyLogin,
    fetchPersona: deps.fetchPersona ?? realFetchPersona,
    refreshSignals: (steamid) => refreshSignals([steamid]),
    discordApi,
    membership,
  });
  await app.register(discordAuthRoutes, {
    config: deps.config, db: deps.db, api: discordApi,
    // The matchmaker is built further down; by the time a request can arrive
    // it exists.
    engaged: () => matchmaker.engagedIds(),
  });

  // Injectable for tests, built from config otherwise. Null when unconfigured,
  // which makes every twitch route 404 rather than half-work.
  const twitchApi: TwitchApi | null = deps.twitchApi !== undefined
    ? deps.twitchApi
    : (deps.config.twitch ? makeTwitchApi(deps.config.twitch) : null);
  await app.register(twitchAuthRoutes, { config: deps.config, db: deps.db, api: twitchApi });

  // Only when Twitch is configured AND a real API exists. Tests inject a fake
  // and drive pollTwitch directly, so a timer started for them would be noise
  // that outlives the test.
  const stopTwitchPoll = deps.twitchApi === undefined && twitchApi
    ? startTwitchPoll(deps.db, twitchApi)
    : null;

  const hub = deps.hub ?? new Hub();
  await app.register(wsRoutes, { hub, db: deps.db });

  // Every ticket mutation and every filing publishes a ticket signal after
  // its commit (phase 2a). Open ticket pages of people who may see that
  // ticket refetch on it; nobody else hears a thing.
  const nudgeTicket = ticketNudger(deps.db, hub);
  const offTicketNudge = subscribeTicketSignals((s) => {
    if (s.kind === 'ticket') nudgeTicket(s.ticketId);
  });
  // Files of removed messages that could not be unlinked last time (a full
  // disk, a permissions fault). Rows only: with none owed this touches nothing.
  purgeRemovedFiles(deps.db, deps.config.ticketAttachmentsDir);

  // With the bot running, the bot's own cards say everything the webhook did
  // (and more), so the webhook would only duplicate them.
  const notify = botEnabled(deps.config) ? () => {} : (msg: string) => notifyDiscord(deps.db, msg);

  // Built unconditionally, not just in the RealOrchestrator branch: the orphan
  // reaper below needs it too, and construction itself dials no rcon.
  // Cycling srcds between matches, for boxes that have it turned on. `quit`
  // rather than ssh and systemctl: every box is supervised, and quit is the
  // one lever that works on all of them, Chicago included, over the rcon we
  // already have. See src/serverRestart.ts.
  const restarter = deps.serverRestarter ?? rconRestarter({
    quit: async (server) => {
      const rcon = new RealRcon({ host: server.host, port: server.rcon_port, password: server.rcon_password });
      try {
        await rcon.connect();
        await kickThenQuit(rcon, server.name);
      } finally {
        rcon.close();
      }
    },
    // sm_pug_status, not the engine's `status`: rcon answers as soon as the
    // engine is up, which is before SourceMod has loaded the plugin, and a
    // match set up in that gap would fail on its first sm_pug_match. Seeing
    // the plugin's own STATUS block come back means it is loaded and ready to
    // be handed a match.
    //
    // The body is matched, not merely measured. An rcon response carries
    // whatever is sitting in the console buffer, so the FIRST call after a
    // boot comes back full of unrelated plugin chatter (verified on the local
    // test server 2026-09-21: the first sm_pug_status returned another
    // plugin's bhop table and nothing else). A length check would read that as
    // ready on a box where pug-match had not loaded at all.
    ready: async (server) => {
      const rcon = new RealRcon({ host: server.host, port: server.rcon_port, password: server.rcon_password });
      try {
        await rcon.connect();
        return (await rcon.exec('sm_pug_status')).includes('STATUS state=');
      } finally {
        rcon.close();
      }
    },
  });

  const releaser = new ServerReleaser(deps.db, deps.serverCleaner ?? (async (server, token, opts) => {
    const rcon = new RealRcon({ host: server.host, port: server.rcon_port, password: server.rcon_password });
    try {
      await rcon.connect();
      // Both halves on the one connection, and each guarded on its own so a
      // failure of either still lets the other run. Freeing the row while the
      // plugin still held the match was the gap: after a no-show abort the box
      // was advertised as claimable, players stayed connected, and the plugin
      // went on enforcing a roster and a token the backend had already binned.
      // A stale or unknown token just draws a PUGERR, which is a no-op.
      // pug_match.cfg unloads l4d2_spec_stays_spec for the match; casual play
      // wants it back. Loading an already-loaded plugin is a no-op.
      try {
        await rcon.exec('sm plugins load_unlock; sm plugins load l4d2_spec_stays_spec.smx; sm plugins load_lock');
      } catch (err) {
        console.error(`[serverRelease] spec_stays_spec reload failed on ${server.name} (non-fatal):`, err);
      }
      if (token) {
        try {
          // With teardown the plugin announces, waits for an unpause, kicks
          // everyone and changes to the reset map itself. One command rather
          // than five because exec secrets.cfg below drops the session and
          // each extra command is another thing that can time out first.
          await rcon.exec(abortCommand(token, opts.teardown, resetMap(deps.db)));
        } catch (err) {
          console.error(`[serverRelease] sm_pug_abort failed on ${server.name} (non-fatal):`, err);
        }
      }
      // RESTORE the configured password, never blank it. This box carries a
      // standing sv_password from secrets.cfg (exec'd by local.cfg) which is
      // how strangers are kept off it; local.cfg's own comment records them
      // walking in when it was not being enforced. Blanking it here, which is
      // what this line did when it only had to undo a per-match password,
      // would have left the server open to the internet the first time any
      // match was released, including an ordinary in-game one.
      //
      // exec is the right shape rather than setting a literal: secrets.cfg is
      // the single source of truth, it lives on the box, it is gitignored, and
      // the backend has no business knowing the value. Re-exec is idempotent
      // and only re-asserts rcon_password to what it already is.
      //
      // And it goes LAST. secrets.cfg re-sets rcon_password, and on 2026-09-17
      // this exec timed out on every release and took the sm_pug_abort queued
      // behind it on the same connection down with it. The likeliest cause is
      // srcds dropping rcon sessions when rcon_password is set, so nothing may
      // follow it on this connection.
      try {
        await rcon.exec('exec secrets.cfg');
      } catch (err) {
        console.error(`[serverRelease] sv_password restore failed on ${server.name} (non-fatal):`, err);
      }
    } finally {
      rcon.close();
    }
  }), restarter);

  // Every enabled box mirrors the website's bans. Built here, next to the
  // releaser, because both are the backend reaching into a game server
  // outside a match; started below once the server list has been reconciled.
  const banSync = new ServerBanSync({
    db: deps.db,
    exec: deps.serverExec ?? (async (server, commands) => {
      const rcon = new RealRcon({ host: server.host, port: server.rcon_port, password: server.rcon_password });
      try {
        await rcon.connect();
        for (const c of commands) await rcon.exec(c);
      } finally {
        rcon.close();
      }
    }),
  });

  // Website admins get the same rights on every box. Same replica model as
  // banSync above and the same injected exec, but it writes a file (SourceMod
  // has no console command that adds an admin) and then asks for a reload.
  const adminSync = new ServerAdminSync({
    db: deps.db,
    exec: deps.serverExec ?? (async (server, commands) => {
      const rcon = new RealRcon({ host: server.host, port: server.rcon_port, password: server.rcon_password });
      try {
        await rcon.connect();
        for (const c of commands) await rcon.exec(c);
      } finally {
        rcon.close();
      }
    }),
  });

  // Built whether or not there is a listener to feed it: the admin overview
  // reads its counters either way. See src/logAuth.ts.
  const logAuth = new LogAuth(deps.db, deps.config.logPublicAddress.split(':')[0]);

  let orchestrator = deps.orchestrator;
  let logListener: LogListener | null = null;
  // Assigned further down, once the bot variable it reads exists: the same
  // forward reference selfStarted uses, null-safe for the same reason.
  let signonDrops: SignonDropNotifier | null = null;
  if (!orchestrator) {
    if (deps.config.devMode) {
      orchestrator = new DevOrchestrator();
    } else {
      // Declared before the listener so the message handler can close over it;
      // assigned just below, once the orchestrator it needs exists.
      let selfStarted: SelfStartedMatches | null = null;
      // Which server row a datagram belongs to. The server whose secret
      // signed the line, when one did: that cannot be forged or confused.
      // Otherwise address AND port, because two srcds on one machine share an
      // address (Riverside #3 and #4).
      const serverOf = (source: string, meta: LogMeta): number | null =>
        meta.serverId ?? resolveServerBySource(deps.db, source, feedHost, meta.port);
      logListener = new LogListener((raw, source, meta) => {
        // One rewrite at the door, before anything reads a SteamID off this
        // event. A player who connects on a second account that has been
        // merged into their main arrives here as the main, so the roster,
        // the stats, the events and the rating all agree without a dozen
        // call sites each remembering to resolve. See src/aliases.ts.
        const ev = canonicalise(deps.db, raw);
        // The two token-less kinds. LogListener has already pinned them to a
        // game server's address. Handled first so nothing below is ever
        // asked for a token they do not have, and guarded so a database error
        // cannot take down the listener that also carries match_end.
        if (ev.kind === 'signon_drop') {
          signonDrops?.onDrop(ev).catch((err) => console.error('[consistency] failed to record a connect drop:', err));
          return;
        }
        if (ev.kind === 'lilac_flag') {
          // Evidence only, and never on the critical path: a failure here must
          // not take down the listener that also carries match_end.
          try {
            const serverId = serverOf(source, meta);
            const matchId = liveMatchOf(deps.db, serverId, ev.steamid);
            const kind = cheatName(ev.cheat);
            // Stored whether or not the player is in a live match: unlike an
            // input burst, a LilAC flag is worth keeping in warmup or on a
            // spectator, and there is one row per event rather than thousands.
            const stored = recordIntegrityFlag(deps.db, {
              matchId, serverId, steamid: ev.steamid, source: 'lilac',
              kind, severity: ev.banned ? 'banned' : 'suspected', detail: '',
            });
            if (stored) {
              publishAdminEvent({
                kind: 'lilac_flag', steamid: ev.steamid, cheat: kind,
                banned: ev.banned, matchId,
              });
            }
          } catch (err) {
            console.error('[lilac] failed to record a flag:', err);
          }
          return;
        }
        if (ev.kind === 'cvar_flag') {
          // Evidence only, never on the critical path. Stored in or out of a
          // match, like a LilAC flag; the admin channel hears about each act
          // once per player per live match, since the plugin reports every
          // connection and every ready-up. The act rides in detail, after the
          // value, so rows from before it existed read as `live`.
          try {
            const serverId = serverOf(source, meta);
            const matchId = liveMatchOf(deps.db, serverId, ev.steamid);
            const seenThisMatch = matchId !== null && (deps.db.prepare(
              "SELECT detail FROM integrity_flags WHERE source = 'cvar' AND kind = ? AND steamid = ? AND match_id = ?",
            ).all(ev.cvar, ev.steamid, matchId) as { detail: string }[]).some((r) => cvarActOf(r.detail) === ev.act);
            // Deduped on detail too: a `fixed` a few seconds after a `held` is
            // the whole story, not a repeat of it.
            const stored = recordIntegrityFlag(deps.db, {
              matchId, serverId, steamid: ev.steamid, source: 'cvar',
              kind: ev.cvar, severity: 'suspected', detail: `value=${ev.value} act=${ev.act}`,
            }, new Date(), { dedupeOnDetail: true });
            if (stored && matchId !== null && !seenThisMatch) {
              publishAdminEvent({ kind: 'cvar_flag', steamid: ev.steamid, matchId, cvar: ev.cvar, value: ev.value, act: ev.act });
            }
          } catch (err) {
            console.error('[cvarwatch] failed to record a client setting:', err);
          }
          return;
        }
        if (ev.kind === 'input_cap') {
          // Same rules as a burst: evidence only, live matches only, and never
          // allowed to take the listener down.
          try {
            const serverId = serverOf(source, meta);
            // The player's own match, like a burst: two live matches can share
            // a server id while the Riverside boxes share an address.
            const matchId = liveMatchOf(deps.db, serverId, ev.steamid);
            if (matchId === null) return;
            recordInputCap(deps.db, {
              matchId, serverId, steamid: ev.steamid, kind: ev.burstKind, serverTick: ev.serverTick,
            });
          } catch (err) {
            console.error('[inputstats] failed to record a capture cap:', err);
          }
          return;
        }
        if (ev.kind === 'input_burst') {
          // Evidence only, and never on the critical path: a failure here must
          // not take down the listener that also carries match_end.
          try {
            const serverId = serverOf(source, meta);
            const matchId = liveMatchOf(deps.db, serverId, ev.steamid);
            // Rostered players in a live match only: a burst that belongs to
            // no match is not evidence about a ranked game, and storing warmup
            // and spectators would grow the table for nothing. Dropped rather
            // than stored with a null match.
            if (matchId === null) return;
            const stored = recordInputBurst(deps.db, {
              matchId, serverId, steamid: ev.steamid, kind: ev.burstKind, weapon: ev.weapon,
              airPresses: ev.airPresses, groundTicks: ev.groundTicks,
              serverTick: ev.serverTick, clientTick: ev.clientTick, intervals: ev.intervals,
              wire: ev.wire, serverSpan: ev.serverSpan, holds: ev.holds,
            }, inputThresholds(deps.db));
            // `detections` names a signature only on the burst that completed
            // its repeat count, so this posts once per player, match and
            // signature however many bursts qualify afterwards.
            for (const { signature, note } of stored.created) {
              // A scroll wheel bind is allowed; the file keeps the row, the
              // admin channel does not need telling.
              if (isWheel(note)) continue;
              publishAdminEvent({
                kind: 'input_flag', steamid: ev.steamid, matchId, signature,
                detail: `repeated across separate ${ev.burstKind} bursts this match; holds: ${note}`,
              });
            }
          } catch (err) {
            console.error('[inputstats] failed to record an input burst:', err);
          }
          return;
        }
        if (ev.kind === 'player_net') {
          // Cosmetic-adjacent and never on the critical path: a failure here
          // must not take down the listener that also carries match_end.
          try {
            recordPlayerNet(deps.db, ev);
          } catch (err) {
            console.error('[networks] failed to record a connect address:', err);
          }
          return;
        }
        if (ev.kind === 'entered') {
          try {
            signonDrops?.onEntered(ev.steamid);
          } catch (err) {
            console.error('[consistency] failed to record an entry:', err);
          }
          return;
        }
        if (ev.kind === 'match_end') {
          const row = deps.db.prepare('SELECT id FROM matches WHERE token = ?').get(ev.token) as { id: number } | undefined;
          if (row) void finishWithRetry(deps.db, orchestrator as RealOrchestrator, row.id, releaser);
          return;
        }
        if (ev.kind === 'abandon') {
          // Ends a match and bans someone, so it is handled here with the
          // result path rather than in the cosmetic feed below. handleAbandon
          // confirms over rcon before acting.
          const orch = orchestrator as RealOrchestrator;
          void handleAbandon(
            { db: deps.db, releaser, confirm: (serverId, steamid) => orch.confirmAbandon(serverId, steamid) },
            ev.token, ev.steamid,
          ).then((id) => { if (id !== null) hub.broadcast('refresh'); })
            .catch((err) => console.error('[abandon] failed:', err));
          return;
        }
        if (ev.kind === 'leave' || ev.kind === 'return') {
          // The live board's view of who is missing. Guarded like everything
          // here that is not the result path: a database error must not take
          // down the listener that also carries match_end.
          try {
            const change = recordPresenceLine(deps.db, ev);
            if (change?.changed) hub.broadcast('refresh');
            // The plugin released a hold at its ceiling. Announced only on the
            // held to not held transition, so whichever of this line and the
            // sweep below gets there first is the one that speaks.
            if (change?.holdReleased && ev.kind === 'leave' && ev.auto) {
              publishAdminEvent({ kind: 'clock', what: 'hold_expired', steamid: ev.steamid, matchId: change.matchId, remainingS: ev.remaining });
            }
          } catch (err) {
            console.error('[presence] failed to record', ev.kind, err);
          }
          return;
        }
        if (ev.kind === 'problem') {
          // The plugin could not do part of a teardown (today: the game never
          // unpaused). The match is already aborted; this is for the admin
          // channel, so someone knows the box may need a hand.
          const row = deps.db.prepare('SELECT id FROM matches WHERE token = ?').get(ev.token) as { id: number } | undefined;
          publishAdminEvent({ kind: 'problem', matchId: row?.id, text: problemText(ev.code, row?.id ?? null) });
          return;
        }
        if (ev.kind === 'match_create' || ev.kind === 'match_roster' || ev.kind === 'match_create_end') {
          // SelfStartedMatches keeps the sender of a burst's first line as an
          // opaque string and hands it back to resolveServerId below, so the
          // port, and the server a signature named, ride along inside it.
          selfStarted?.handle(ev, `${source}|${meta.port}|${meta.serverId ?? ''}`);
          // A roster line for a match that is already live is a sub being put
          // on a team, in game by definition, and the plugin sends no connect
          // event for them. During the opening burst the match is not live
          // yet, so this stays quiet and MATCH_START does the whole roster.
          // Guarded like everything else here that is not the result path.
          if (ev.kind === 'match_roster') {
            try {
              const rostered = deps.db.prepare(
                `SELECT m.id FROM matches m JOIN match_players mp ON mp.match_id = m.id
                  WHERE m.token = ? AND m.state = 'live' AND mp.player_id = ?`,
              ).get(ev.token, ev.steamid) as { id: number } | undefined;
              if (rostered) refreshSignals([ev.steamid], { sharing: true, matchId: rostered.id, freshMs: 60 * 60 * 1000 });
            } catch (err) {
              console.error('[steamSignals] could not check a late joiner:', err);
            }
          }
          return;
        }
        // Spectator feed. Cosmetic by design, so a throw here must never take
        // down the listener that also carries match_end.
        try {
          if (ev.kind === 'match_start') {
            recordMatchStart(deps.db, ev.token, ev.map);
            // Everyone has readied up, so everyone rostered is in game: the one
            // moment the Family Sharing question means anything, and the point
            // at which a ban elsewhere is worth an admin's attention.
            const started = deps.db.prepare("SELECT id FROM matches WHERE token = ? AND state = 'live'")
              .get(ev.token) as { id: number } | undefined;
            if (started) {
              const roster = deps.db.prepare('SELECT player_id FROM match_players WHERE match_id = ?')
                .all(started.id) as { player_id: string }[];
              refreshSignals(roster.map((r) => r.player_id), { sharing: true, matchId: started.id });
            }
          }
          else if (ev.kind === 'heartbeat') {
            recordHeartbeat(deps.db, ev.token);
            // The heartbeat repeats the phase so a lost PHASE datagram is
            // corrected within thirty seconds; recordPhase treats a repeat
            // as confirmation and does not restart anything.
            if (ev.phase) recordPhase(deps.db, ev.token, ev.phase);
            // Demos are also scanned here, not only on MAP_RESULT. A map's
            // demo is not closed until the NEXT map's tv_record replaces it,
            // so at MAP_RESULT time it is still the newest file and is
            // excluded as in-progress: scanning only there meant map N's demo
            // appeared one whole map late. The heartbeat is every 30s and a
            // readdir is cheap, so it picks the demo up shortly after the next
            // map loads.
            const hb = deps.db.prepare("SELECT id FROM matches WHERE token = ? AND state = 'live'")
              .get(ev.token) as { id: number } | undefined;
            if (hb) {
              recordMatchDemos(deps.db, hb.id, ev.token, deps.config.demoDir,
                { excludeInProgress: true });
            }
          }
          else if (ev.kind === 'player' && ev.event === 'connect') {
            recordPlayerConnect(deps.db, ev.token, ev.steamid);
            // A 'refresh' on top of the 'live' every feed line ends with: the
            // admin board listens for refresh only, because 'live' fires ten
            // times a second. Only a real change, so the connect pulse of a map
            // change wakes nobody.
            if (recordPresenceLine(deps.db, ev)?.changed) hub.broadcast('refresh');
            // The plugin emits this from OnClientPostAdminCheck, which only
            // fires once the client is fully in game, so it is an entry too.
            // The engine's own "entered the game" line normally gets here
            // first; this is the second chance when that datagram was lost.
            signonDrops?.onEntered(ev.steamid);
            // Covers whoever the match-start pass cannot: a late joiner, and a
            // reconnect on a different copy of the game. Someone checked
            // within the hour is only asked whose copy they are playing on.
            const joined = deps.db.prepare("SELECT id FROM matches WHERE token = ? AND state = 'live'")
              .get(ev.token) as { id: number } | undefined;
            if (joined) refreshSignals([ev.steamid], { sharing: true, matchId: joined.id, freshMs: 60 * 60 * 1000 });
          }
          else if (ev.kind === 'live_stat') recordLiveStat(deps.db, ev.token, ev.steamid, ev.stats);
          else if (ev.kind === 'live_event') recordLiveEvent(deps.db, ev.token, ev);
          else if (ev.kind === 'chat') recordChat(deps.db, ev.token, ev);
          else if (ev.kind === 'phase') recordPhase(deps.db, ev.token, ev.phase);
          else if (ev.kind === 'round_start') recordRoundStart(deps.db, ev.token, ev);
          else if (ev.kind === 'round_end') {
            recordRoundEnd(deps.db, ev.token, ev);
            // A round just closed, so the plugin has finished its replay file.
            // Rounds are the unit here, unlike demos which are per map, so this
            // is the earliest honest moment to index one. excludeOpen skips the
            // half that is already recording. Upserts, so an early scan is
            // corrected by the next one.
            const rr = deps.db.prepare("SELECT id FROM matches WHERE token = ? AND state = 'live'")
              .get(ev.token) as { id: number } | undefined;
            if (rr) {
              recordMatchReplays(deps.db, rr.id, ev.token, deps.config.replayDir,
                { excludeOpen: true });
            }
          }
          else if (ev.kind === 'map_result') {
            recordMapResult(deps.db, ev.token, ev.map, ev.a, ev.b);
            // A map just ended, so its demo is finished (or about to be, when
            // the next map's tv_record replaces it). Scan now so demos are
            // linkable during the match instead of only at the very end.
            // recordMatchDemos upserts, so a size captured slightly early is
            // corrected by the next scan.
            const row = deps.db.prepare("SELECT id FROM matches WHERE token = ? AND state = 'live'")
              .get(ev.token) as { id: number } | undefined;
            if (row) {
              recordMatchDemos(deps.db, row.id, ev.token, deps.config.demoDir,
                { excludeInProgress: true });
            }
          }
          else return;
          // Same protocol as the rest of the app: broadcast a name, let
          // clients re-fetch. No per-client diffing on the server.
          hub.broadcast('live');
        } catch (err) {
          console.error('[live] failed to record', ev.kind, err);
        }
      });
      logListener.setAuthenticator((input) => logAuth.check(input));
      await logListener.listen(deps.config.logListenPort);
      // pending is declared before the orchestrator it depends on and assigned
      // after: the same forward-reference the selfStarted callback above uses,
      // including the null default and optional call so a read before
      // assignment no-ops instead of throwing. Nothing today can reach
      // onNoServer before pending is assigned (every statement in between is
      // synchronous), but the null-safe form keeps a future await inserted in
      // that stretch from turning this into a crash instead of a silent no-op.
      let pending: PendingMatches | null = null;
      orchestrator = new RealOrchestrator({
        db: deps.db,
        listener: logListener,
        logPublicAddress: deps.config.logPublicAddress,
        releaser,
        notify,
        demoDir: deps.config.demoDir,
        replayDir: deps.config.replayDir,
        onNoServer: (id) => pending?.add(id),
        beforeLive: (rcon) => banSync.pushAll((c) => rcon.exec(c)),
      });

      // Re-arm the listener for matches that were already running when this
      // process started. Registered tokens live only in memory, so without
      // this EVERY restart silently deafens the backend to an in-flight match:
      // no scores, no live stats, no MATCH_END, and the match eventually gets
      // reaped as orphaned despite the game still going. Bit us repeatedly
      // while iterating on 2026-09-11.
      const running = deps.db
        .prepare("SELECT token FROM matches WHERE state = 'live' AND token IS NOT NULL")
        .all() as { token: string }[];
      for (const r of running) logListener.register(r.token);
      if (running.length > 0) {
        console.log(`[server] re-registered ${running.length} in-flight match token(s)`);
      }

      // Same discipline as the token re-registration above: reapOrphanedMatches
      // only ever finds a match that is still 'live', so a crash between the
      // abort write and the release write in a previous run leaves a server
      // stranded non-idle forever with nothing left pointing at it. Boot is
      // the one moment that can self-heal that, since it is not scoped to
      // matches at all.
      const stranded = reconcileServers(deps.db, releaser);
      if (stranded.length > 0) {
        console.log(`[server] reconciled ${stranded.length} stranded server(s) at boot`);
      }

      // Rebuilt from state='configuring' rather than trusted to survive in
      // memory: the same class of bug already deafened in-flight matches once
      // (see the token re-registration above), and a deploy while a match is
      // waiting on a box must not strand it. Registered after reconcileServers
      // so a server it just freed can drain straight into a waiting match.
      pending = new PendingMatches(deps.db, (id) => (orchestrator as RealOrchestrator).setupMatch(id));
      pending.rebuildFromDb();
      releaser.onFreed(() => pending.drain());
      // Drain once at boot, because the pending list is otherwise driven
      // entirely by servers being freed and an already-idle box frees nothing:
      // a match that was waiting when the process died and an idle server
      // sitting next to it would never meet, and the match would sit
      // 'configuring' forever, which hasOpenMatch counts, locking its eight
      // players out of the queue. This is also the path an operator takes when
      // Step 1 of the runbook tells them to set a server back to idle by hand.
      //
      // Sequenced behind the reconcile above rather than fired synchronously
      // alongside it: this drain calls setupMatch, which dials
      // `sv_password "pug_..."`, and reconcileServers has rcon sessions of its
      // own in flight clearing that same cvar. Run concurrently the clear can
      // land last and leave a recovered ranked match sitting unpassworded.
      // Not awaited, so an unreachable box delays only the drain, not boot.
      void releaser.settled().then(() => pending.drain());

      // Day one is a single game server, so the self-start burst is admitted
      // from each known server's address and adopted onto the first server row.
      // When there is more than one box this must key on rinfo.address instead.
      const servers = deps.db.prepare('SELECT id, host FROM servers ORDER BY id').all() as Array<{
        id: number;
        host: string;
      }>;
      // Two different addresses, and conflating them breaks one or the other.
      // servers.host is where WE dial rcon (srcds binds rcon to its public IP,
      // not loopback, so this is the public IP even for a server on this box).
      // The datagram source is decided by where we told srcds to send, i.e. the
      // host half of logPublicAddress: a loopback target is sourced from
      // 127.0.0.1, not from the public IP. Allow both.
      for (const s of servers) logListener.allowMatchCreateFrom(s.host);
      const feedHost = deps.config.logPublicAddress.split(':')[0];
      if (feedHost) logListener.allowMatchCreateFrom(feedHost);
      logListener.allowMatchCreateWhen((address) => isKnownServerAddress(deps.db, address, feedHost));
      selfStarted = new SelfStartedMatches({
        db: deps.db,
        listener: logListener,
        resolveServerId: (key) => {
          const [address, port, signedBy] = key.split('|');
          if (signedBy) return Number(signedBy);
          return resolveServerBySource(deps.db, address, feedHost, Number(port));
        },
        setMatchId: (token, matchId, serverId) =>
          (orchestrator as RealOrchestrator).assignMatchId(serverId, token, matchId),
        adminSteamIds: deps.config.adminSteamIds,
        notify,
      });
    }
  }

  const matchmaker = new Matchmaker(deps.db, {
    broadcast: (event) => hub.broadcast(event),
    orchestrator,
    notify,
    queueGate: makeQueueGate(deps.db, deps.config.discord !== null, membership),
    readyGate: makeReadyGate(deps.db, deps.config.discord !== null, presence),
  });
  // Before the bot starts, so restored lobbies keep their Discord cards.
  matchmaker.restore();
  app.decorate('matchmaker', matchmaker);
  // Sweep matches the game server has forgotten. Without it a plugin reload,
  // an srcds restart or a crash leaves a match 'live' forever: permanently
  // "no signal" on the live page, and its server row stuck reserved so no new
  // match can ever claim it.
  /**
   * The integrity analysis, in its own process.
   *
   * Absent without a replay directory: there is nothing to analyse and the
   * panel should say so rather than offer a button that cannot work.
   *
   * Spawned rather than called because the analysis is entirely synchronous
   * and would block this loop, which is also serving HTTP, running the bot and
   * taking the live feed. See src/integrity/job.ts.
   */
  const integrityJobs = deps.config.replayDir
    ? new IntegrityJobs({
      spawn: (mode) => spawn(
        'node_modules/.bin/tsx',
        ['scripts/backfill-integrity.ts', ...(mode === 'pending' ? ['--pending'] : [])],
        { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
      busy: () => matchInFlight(deps.db),
    })
    : undefined;

  if (!deps.config.devMode) {
    banSync.start();
    banSync.sweep().catch((err) => console.error('[serverBans] boot sweep failed:', err));
    adminSync.start();
    void adminSync.sync();
  }

  const reaper = setInterval(() => {
    try {
      // Measure rounds nothing has looked at. Until this existed the only
      // caller of the analysis anywhere was a hand-run script, so the board
      // went stale the moment a match was played and stayed that way.
      // Refusals here are fine and need no handling: a match in flight or a
      // run already going means the next sweep, a minute later, tries again.
      if (integrityJobs && pendingRoundCount(deps.db) > 0) integrityJobs.start('pending');
    } catch (err) {
      console.error('[integrity] automatic pass failed:', err);
    }
    try {
      reapOrphanedMatches(deps.db, releaser);
    } catch (err) {
      console.error('[liveView] reaper failed:', err);
    }
    try {
      // Files pulled from a second game server land after that match ended.
      reindexRecentMatches(deps.db, deps.config.demoDir, deps.config.replayDir);
    } catch (err) {
      console.error('[reindex] sweep failed:', err);
    }
    try {
      liftExpiredBans(deps.db);
    } catch (err) {
      console.error('[admin] ban expiry sweep failed:', err);
    }
    try {
      reapNoShowMatches(deps.db, releaser);
    } catch (err) {
      console.error('[noShow] reaper failed:', err);
    }
  }, 60_000);
  reaper.unref();

  // The live board's clocks. Five seconds because the warning it posts is
  // about a countdown measured in tens of seconds; the pass is one indexed
  // read when nobody is dropped, which is nearly always.
  const presenceSweep = setInterval(() => {
    try {
      const events = sweepPresence(deps.db);
      for (const e of events) publishAdminEvent({ kind: 'clock', ...e });
      if (events.length > 0) hub.broadcast('refresh');
    } catch (err) {
      console.error('[presence] sweep failed:', err);
    }
  }, 5_000);
  presenceSweep.unref();

  // Daily replay prune. Interval rather than cron because there is no
  // scheduler here and the exact hour does not matter: the window is 90 days.
  // unref so the timer never holds the process open in tests.
  const pruneTimer = setInterval(() => {
    pruneReplays(deps.db, deps.config.replayDir);
    pruneDemos(deps.db, deps.config.demoDir);
  }, 24 * 60 * 60 * 1000);
  pruneTimer.unref();

  // Demo offload to R2, when it is configured. Hourly rather than daily and on
  // its own timer, because this one RECLAIMS space while the prunes above only
  // stop it growing, and it wants to get ahead of the prune rather than run
  // beside it: a demo already in R2 is one the prune can delete locally without
  // destroying the recording. Bounded per sweep so a backlog does not hold the
  // process; whatever is left is picked up an hour later.
  if (r2) {
    const offloadTimer = setInterval(() => {
      void sweepDemos(deps.db, r2, deps.config.demoDir, { deleteLocal: true })
        .catch((err) => console.error('[demoOffload] sweep failed:', err));
    }, 60 * 60 * 1000);
    offloadTimer.unref();
    app.addHook('onClose', async () => { clearInterval(offloadTimer); });
  }

  // Plus one run shortly after boot. The interval alone means a box that is
  // redeployed or restarted more often than once a day never prunes at all,
  // which is exactly the disk-fill this code exists to prevent. Delayed so it
  // does not compete with startup, and unref'd for the same reason as above.
  // pruneReplays catches everything internally; the try is belt and braces,
  // because an escaping throw inside a timer callback would take the process
  // down rather than merely skip a prune.
  const pruneOnBoot = setTimeout(() => {
    try {
      pruneReplays(deps.db, deps.config.replayDir);
      pruneDemos(deps.db, deps.config.demoDir);
    } catch (err) {
      console.error('[replay] startup prune failed:', err);
    }
  }, 30_000);
  pruneOnBoot.unref();

  // The Discord bot. Not awaited: logging in takes seconds and the website
  // must never wait on, or fail because of, Discord.
  let bot: RunningBot | null = null;
  let adminFeed: AdminFeedPoster | null = null;
  let ticketSync: TicketSync | null = null;
  let ticketMirror: TicketMirror | null = null;
  let reportButton: ReportButton | null = null;
  let reporterChats: ReporterChats | null = null;
  // Only where a real listener exists to feed it. `bot` is read per drop,
  // because the bot logs in some seconds after this line runs, and stays null
  // for good when Discord is not configured: drops are then stored and shown
  // to admins on the site, and nobody is DMed.
  if (logListener) {
    signonDrops = new SignonDropNotifier({
      db: deps.db,
      publicUrl: deps.config.publicUrl,
      dm: () => {
        const transport = bot?.transport;
        return transport ? (userId, payload) => transport.dm(userId, payload) : null;
      },
    });
  }
  // Someone who linked before joining the server is let in the moment they join.
  membership.onAdd((userId) => {
    const p = playerByDiscordId(deps.db, userId);
    if (p && p.status === 'invited' && discordApi) void applyGate(deps.db, discordApi, p.steamid);
  });
  // Someone who readied and then left voice has to press Ready again, so a
  // match never starts with a player outside voice. Only bites during a ready
  // check: unready() is a no-op once the vote is running or for anyone not in
  // a lobby, and the gate itself decides whether voice is required.
  presence.onLeave((userId) => {
    const p = playerByDiscordId(deps.db, userId);
    if (p && matchmaker.readyBlock(p.steamid)) matchmaker.unready(p.steamid);
  });
  if (botEnabled(deps.config)) {
    startBot({
      config: deps.config,
      db: deps.db,
      matchmaker,
      hub,
      connect: () => createDjsTransport(deps.config.discord!),
      controller: {
        banMessage: (steamid) => banMessage(deps.db, steamid),
        queueBlock: (steamid) => {
          const t = activeTimeout(deps.db, steamid);
          return t
            ? `You are on a queue timeout for missed ready checks or no-shows. You can queue again <t:${Math.floor(t.until.getTime() / 1000)}:R>.`
            : null;
        },
      },
      voice: (t) => new VoiceChannels({ db: deps.db, voice: t.voice }),
      membership,
      presence,
      onConnected: (t) => {
        adminFeed = new AdminFeedPoster({ db: deps.db, transport: t, publicUrl: deps.config.publicUrl });
        adminFeed.start();
        // Built before the reconciler so its hook can reach it. Which of the
        // two starts first decides nothing: start() only queues a first pass
        // on each one's own chain, and a thread the reconciler creates has
        // no missed history; its first live message reads the thread anyway.
        const mirror = new TicketMirror({
          db: deps.db,
          transport: t,
          store: new AttachmentStore({ db: deps.db, dir: deps.config.ticketAttachmentsDir, fetcher: httpFetcher }),
          onChange: nudgeTicket,
          // A removal's Discord delete runs on the reconciler's chain: both
          // unarchive a thread, act in it and archive it again, and on two
          // chains they collide. Read per call, because the reconciler is
          // built just below this.
          serialise: (fn) => (ticketSync ? ticketSync.serialise(fn) : fn()),
          // A reporter's own message is fed to the reconciler's chain (pings,
          // relay, close notices), never handled from the mirror's own chain.
          onReporterActivity: (th, m, fresh) => ticketSync?.reporterActivity(th, m, fresh),
        });
        ticketMirror = mirror;
        // After the feed: a problem found on the first pass has somewhere to go.
        ticketSync = new TicketSync({
          db: deps.db,
          transport: t,
          publicUrl: deps.config.publicUrl,
          // The reconciler's first pass deletes forum posts that must not
          // exist. Whatever was written in one while the bot was down is
          // copied onto the site first, or it goes with the post.
          saveBeforeDelete: (threadId) => mirror.catchUp(threadId),
          // And its timer is what retries a removal's Discord delete: a
          // refused one would otherwise wait for the next restart.
          sweepRemovals: () => { void mirror.sweepRemovals(); },
        });
        ticketSync.start();
        mirror.start();
        reportButton = new ReportButton({ db: deps.db, transport: t });
        reportButton.start();
        reporterChats = new ReporterChats({
          db: deps.db, transport: t, publicUrl: deps.config.publicUrl, guildId: deps.config.discord!.guildId,
          isMember: (id) => membership.isMember(id),
          // On the reconciler's chain, like the mirror's removals: both
          // unarchive a thread, act in it and archive it again.
          serialise: (fn) => (ticketSync ? ticketSync.serialise(fn) : fn()),
        });
      },
      extraButtons: {
        'r:': (i) => adminFeed!.handleButton(i),
        't:': (i) => handleTicketButton({ db: deps.db, publicUrl: deps.config.publicUrl, chats: () => deps.reporterChats ?? reporterChats }, i),
        'rp:': (i) => handleReportButton({ db: deps.db, adminSteamIds: deps.config.adminSteamIds, chats: () => deps.reporterChats ?? reporterChats }, i),
      },
      extraModals: {
        't:': (i) => handleTicketModal({ db: deps.db, publicUrl: deps.config.publicUrl, chats: () => deps.reporterChats ?? reporterChats }, i),
        'rp:': (i) => handleReportModal({ db: deps.db, adminSteamIds: deps.config.adminSteamIds, chats: () => deps.reporterChats ?? reporterChats }, i),
      },
      opensModal: (id) => opensTicketModal(id) || opensReportModal(id),
      messageCommands: {
        [REMOVE_COMMAND]: (i) => handleRemoveCommand({
          db: deps.db, attachmentsDir: deps.config.ticketAttachmentsDir, mirror: () => ticketMirror,
        }, i),
      },
      commands: {
        defs: COMMAND_DEFS,
        handle: (i) => handleCommand({
          db: deps.db, matchmaker, publicUrl: deps.config.publicUrl,
          banMessage: (steamid) => banMessage(deps.db, steamid),
          adminSteamIds: deps.config.adminSteamIds,
        }, i),
      },
    })
      .then((b) => { bot = b; })
      .catch((err) => console.error('[discord] bot failed to start; the website carries on without it:', err));
  }

  app.addHook('onClose', async () => {
    reportButton?.stop();
    ticketMirror?.stop();
    ticketSync?.stop();
    offTicketNudge();
    adminFeed?.stop();
    await bot?.stop();
    clearInterval(reaper);
    clearInterval(presenceSweep);
    clearInterval(pruneTimer);
    stopTwitchPoll?.();
    stopSignalRefresh?.();
    clearTimeout(pruneOnBoot);
    banSync.stop();
    adminSync.stop();
    if (logListener) await logListener.close();
    // Where each server's replay check had got to. Best effort: the caller may
    // already have closed the database, and a few seconds of position is all
    // that is lost.
    try { logAuth.flush(); } catch { /* database already closed */ }
  });
  await app.register(apiRoutes, {
    db: deps.db, matchmaker, adminSteamIds: deps.config.adminSteamIds, broadcast: (e) => hub.broadcast(e),
  });
  await app.register(ticketRoutes, {
    db: deps.db, matchmaker, broadcast: (e) => hub.broadcast(e), adminSteamIds: deps.config.adminSteamIds,
    guildId: deps.config.discord?.guildId ?? null,
    attachmentsDir: deps.config.ticketAttachmentsDir,
    afterRemove: () => { void ticketMirror?.sweepRemovals(); },
    moderation: () => deps.discordModeration ?? bot?.transport.moderation ?? null,
    chats: () => deps.reporterChats ?? reporterChats,
  });
  await app.register(adminRoutes, {
    db: deps.db, matchmaker, releaser, broadcast: (e) => hub.broadcast(e), integrityJobs,
    dlc4Probe: deps.dlc4Probe, adminSync, adminSteamIds: deps.config.adminSteamIds, logAuth,
    voice: deps.config.discord !== null ? presence : null,
    logSecretPusher: deps.logSecretPusher ?? (async (server, secret) => {
      const rcon = new RealRcon({ host: server.host, port: server.rcon_port, password: server.rcon_password });
      try {
        await rcon.connect();
        return await pushLogSecret(rcon, secret);
      } finally {
        rcon.close();
      }
    }),
    serverQuery: deps.serverQuery ?? (async (server, command) => {
      const rcon = new RealRcon({ host: server.host, port: server.rcon_port, password: server.rcon_password });
      try {
        await rcon.connect();
        return await rcon.exec(command);
      } finally {
        rcon.close();
      }
    }),
    // Sharing is asked too: the admin may be looking at someone who is in
    // game right now. No match id, so a manual look never posts to the feed.
    refreshSignals: deps.config.steamApiKey
      ? (steamid) => refreshSteamSignals(signalDeps, [steamid], { sharing: true })
      : undefined,
  });
  await app.register(peopleRoutes, { db: deps.db });
  await app.register(statsRoutes, { db: deps.db, demoDir: deps.config.demoDir, r2 });
  await app.register(replayRoutes, { db: deps.db, replayDir: deps.config.replayDir });
  await app.register(campaignRoutes, {
    db: deps.db, addonsDir: deps.config.addonsDir, freeBytes: deps.freeBytes,
    installTargets: deps.installTargets, maxUploadBytes: deps.maxUploadBytes,
    consistencyListPath: deps.consistencyListPath,
  });

  // Registered whether or not dev mode is on, and deliberately NOT inside
  // devRoutes. The dev panel probes this on every page load to decide whether
  // to render itself; when the route existed only in dev mode, every single
  // production page load logged a 404 in the browser console. Answering with
  // the flag costs nothing and leaks nothing: devMode is already obvious from
  // whether the dev endpoints below respond at all.
  app.get('/api/dev/enabled', async () => ({ enabled: deps.config.devMode }));

  if (deps.config.devMode) {
    await app.register(devRoutes, { config: deps.config, db: deps.db, matchmaker, hub });
  }

  // SPA fallback. The frontend uses real URLs (/player/765…, /match/12) rather
  // than hash routes, so a refresh or a pasted link hits the server at a path
  // that has no route and must still be answered with the app shell.
  //
  // Only page navigations get the shell: an unknown /api/, /auth/, or /ws path
  // must keep returning a JSON 404, or a typo'd endpoint would hand the client
  // a 200 full of HTML and fail somewhere much less obvious. Non-GET methods
  // are likewise never a page navigation.
  app.setNotFoundHandler((req, reply) => {
    if (isPageRequest(req.method, req.url)) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: 'not found' });
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    matchmaker: Matchmaker;
  }
}
