import { spawn } from 'node:child_process';
import { pruneDemos } from './demoPrune.js';
import { sweepDemos } from './demoOffload.js';
import { r2FromEnv } from './r2.js';
import { reindexRecentMatches } from './reindex.js';
import { IntegrityJobs, matchInFlight, pendingRoundCount } from './integrity/job.js';
import { handleAbandon } from './abandon.js';
import { AdminFeedPoster } from './discord/adminFeedPoster.js';
import { playerByDiscordId } from './players.js';
import { applyGate } from './discord/gate.js';
import { GuildMembership } from './discord/membership.js';
import { makeQueueGate } from './queueGate.js';
import { publishAdminEvent } from './adminFeed.js';
import { activeTimeout } from './penalties.js';
import { adminRoutes } from './routes/admin.js';
import { banMessage, liftExpiredBans } from './admin/players.js';
import { botEnabled, startBot, type RunningBot } from './discord/index.js';
import { createDjsTransport } from './discord/djsTransport.js';
import { VoiceChannels } from './discord/voice.js';
import { COMMAND_DEFS, handleCommand } from './discord/commands.js';
import { fetchDiscordApi, type DiscordApi } from './discord/api.js';
import { discordAuthRoutes } from './routes/discordAuth.js';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STATUS_CODES } from 'node:http';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { verifyLogin as realVerifyLogin, fetchPersona as realFetchPersona } from './steamAuth.js';
import { backfillPersonas } from './personaBackfill.js';
import { authRoutes } from './routes/auth.js';
import { Hub } from './ws.js';
import { wsRoutes } from './routes/ws.js';
import { Matchmaker } from './matchmaker.js';
import { DevOrchestrator, RealOrchestrator, type Orchestrator } from './orchestrator.js';
import { ServerReleaser, reconcileServers, type ServerCleaner } from './serverRelease.js';
import { resolveServerBySource } from './serverPool.js';
import { PendingMatches } from './pendingMatches.js';
import { RconClient as RealRcon } from './rcon.js';
import { LogListener } from './logListener.js';
import { SelfStartedMatches } from './selfStarted.js';
import {
  recordMatchStart, recordMapResult, recordHeartbeat, recordLiveStat, recordLiveEvent, recordChat,
  recordRoundStart, recordRoundEnd,
  reapOrphanedMatches,
} from './liveView.js';
import { recordPlayerConnect, reapNoShowMatches } from './noShow.js';
import { recordMatchDemos, discoverMatchDemos } from './demos.js';
import { recordMatchReplays } from './replays.js';
import { pruneReplays } from './replayPrune.js';
import { apiRoutes } from './routes/api.js';
import { statsRoutes } from './routes/stats.js';
import { replayRoutes } from './routes/replays.js';
import { devRoutes } from './routes/dev.js';
import { campaignRoutes } from './routes/campaigns.js';
import type { InstallTarget } from './campaignInstall.js';
import { notifyDiscord } from './discord.js';

export interface ServerDeps {
  config: Config;
  db: DB;
  verifyLogin?: typeof realVerifyLogin;
  fetchPersona?: typeof realFetchPersona;
  hub?: Hub;
  orchestrator?: Orchestrator;
  /** Injected in tests; built from config.discord otherwise. */
  discordApi?: DiscordApi;
  /** Injected in tests so releasing a server never dials rcon. */
  serverCleaner?: ServerCleaner;
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

  await orchestrator.finishMatch(matchId);
  for (const wait of delays) {
    if (!stillLive()) return;
    await sleep(wait);
    // Re-check after the wait: another path may have completed it meanwhile.
    if (!stillLive()) return;
    console.warn(`[orchestrator] retrying collection of match ${matchId}`);
    await orchestrator.finishMatch(matchId);
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

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

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
  void backfillPersonas(deps.db, deps.config.steamApiKey)
    .then((n) => { if (n > 0) console.log(`[persona] backfilled ${n} player(s)`); })
    .catch((err) => console.error('[persona] backfill failed:', err));

  await app.register(cookie, { secret: deps.config.cookieSecret });
  await app.register(websocket);
  // Vite builds web/ to dist/public (see vite.config.ts). In dev the Vite server
  // owns the browser and proxies here, so this path only matters in production.
  const staticRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'public');
  await app.register(fastifyStatic, { root: staticRoot });

  const membership = new GuildMembership();
  const discordApi: DiscordApi | null = deps.config.discord
    ? deps.discordApi ?? fetchDiscordApi(deps.config.discord)
    : null;
  await app.register(authRoutes, {
    config: deps.config,
    db: deps.db,
    verifyLogin: deps.verifyLogin ?? realVerifyLogin,
    fetchPersona: deps.fetchPersona ?? realFetchPersona,
    discordApi,
    membership,
  });
  await app.register(discordAuthRoutes, { config: deps.config, db: deps.db, api: discordApi });

  const hub = deps.hub ?? new Hub();
  await app.register(wsRoutes, { hub });

  // With the bot running, the bot's own cards say everything the webhook did
  // (and more), so the webhook would only duplicate them.
  const notify = botEnabled(deps.config) ? () => {} : (msg: string) => notifyDiscord(deps.db, msg);

  // Built unconditionally, not just in the RealOrchestrator branch: the orphan
  // reaper below needs it too, and construction itself dials no rcon.
  const releaser = new ServerReleaser(deps.db, deps.serverCleaner ?? (async (server, token) => {
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
          await rcon.exec(`sm_pug_abort ${token}`);
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
  }));

  let orchestrator = deps.orchestrator;
  let logListener: LogListener | null = null;
  if (!orchestrator) {
    if (deps.config.devMode) {
      orchestrator = new DevOrchestrator();
    } else {
      // Declared before the listener so the message handler can close over it;
      // assigned just below, once the orchestrator it needs exists.
      let selfStarted: SelfStartedMatches | null = null;
      logListener = new LogListener((ev, source) => {
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
        if (ev.kind === 'match_create' || ev.kind === 'match_roster' || ev.kind === 'match_create_end') {
          selfStarted?.handle(ev, source);
          return;
        }
        // Spectator feed. Cosmetic by design, so a throw here must never take
        // down the listener that also carries match_end.
        try {
          if (ev.kind === 'match_start') recordMatchStart(deps.db, ev.token, ev.map);
          else if (ev.kind === 'heartbeat') {
            recordHeartbeat(deps.db, ev.token);
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

              // Keep the current map honest. MATCH_START fires exactly once per
              // match, so current_map froze on map 1 and the page claimed you
              // were still on the opening map three maps later. The plugin
              // names every demo pug_<token>_<ordinal>_<map>.dem INCLUDING the
              // one it is still writing, so the highest-ordinal demo names the
              // map being played right now. Costs one readdir we were already
              // doing, and needs no plugin change.
              const all = discoverMatchDemos(deps.config.demoDir, ev.token);
              if (all.length > 0) {
                const current = all.reduce((a, b) => (b.ordinal > a.ordinal ? b : a));
                recordMatchStart(deps.db, ev.token, current.map);
              }
            }
          }
          else if (ev.kind === 'player' && ev.event === 'connect') {
            recordPlayerConnect(deps.db, ev.token, ev.steamid);
          }
          else if (ev.kind === 'live_stat') recordLiveStat(deps.db, ev.token, ev.steamid, ev.stats);
          else if (ev.kind === 'live_event') recordLiveEvent(deps.db, ev.token, ev);
          else if (ev.kind === 'chat') recordChat(deps.db, ev.token, ev);
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
      logListener.allowMatchCreateWhen((address) => resolveServerBySource(deps.db, address, feedHost) !== null);
      selfStarted = new SelfStartedMatches({
        db: deps.db,
        listener: logListener,
        resolveServerId: (source) => resolveServerBySource(deps.db, source, feedHost),
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
  // Someone who linked before joining the server is let in the moment they join.
  membership.onAdd((userId) => {
    const p = playerByDiscordId(deps.db, userId);
    if (p && p.status === 'invited' && discordApi) void applyGate(deps.db, discordApi, p.steamid);
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
      onConnected: (t) => {
        adminFeed = new AdminFeedPoster({ db: deps.db, transport: t, publicUrl: deps.config.publicUrl });
        adminFeed.start();
      },
      extraButtons: {
        'r:': (i) => adminFeed!.handleButton(i),
      },
      commands: {
        defs: COMMAND_DEFS,
        handle: (i) => handleCommand({ db: deps.db, matchmaker, publicUrl: deps.config.publicUrl }, i),
      },
    })
      .then((b) => { bot = b; })
      .catch((err) => console.error('[discord] bot failed to start; the website carries on without it:', err));
  }

  app.addHook('onClose', async () => {
    adminFeed?.stop();
    await bot?.stop();
    clearInterval(reaper);
    clearInterval(pruneTimer);
    clearTimeout(pruneOnBoot);
    if (logListener) await logListener.close();
  });
  await app.register(apiRoutes, { db: deps.db, matchmaker });
  await app.register(adminRoutes, { db: deps.db, matchmaker, releaser, broadcast: (e) => hub.broadcast(e), integrityJobs });
  await app.register(statsRoutes, { db: deps.db, demoDir: deps.config.demoDir, r2 });
  await app.register(replayRoutes, { db: deps.db, replayDir: deps.config.replayDir });
  await app.register(campaignRoutes, {
    db: deps.db, addonsDir: deps.config.addonsDir, freeBytes: deps.freeBytes,
    installTargets: deps.installTargets, maxUploadBytes: deps.maxUploadBytes,
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
    const isPageRequest =
      (req.method === 'GET' || req.method === 'HEAD') &&
      !req.url.startsWith('/api/') &&
      !req.url.startsWith('/auth/') &&
      !req.url.startsWith('/ws');
    if (isPageRequest) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: 'not found' });
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    matchmaker: Matchmaker;
  }
}
