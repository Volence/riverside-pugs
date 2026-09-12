import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { verifyLogin as realVerifyLogin, fetchPersona as realFetchPersona } from './steamAuth.js';
import { authRoutes } from './routes/auth.js';
import { Hub } from './ws.js';
import { wsRoutes } from './routes/ws.js';
import { Matchmaker } from './matchmaker.js';
import { DevOrchestrator, RealOrchestrator, type Orchestrator } from './orchestrator.js';
import { LogListener } from './logListener.js';
import { SelfStartedMatches } from './selfStarted.js';
import {
  recordMatchStart, recordMapResult, recordHeartbeat, recordLiveStat, recordLiveEvent,
  recordRoundStart, recordRoundEnd,
  reapOrphanedMatches,
} from './liveView.js';
import { recordMatchDemos, discoverMatchDemos } from './demos.js';
import { recordMatchReplays } from './replays.js';
import { pruneReplays } from './replayPrune.js';
import { apiRoutes } from './routes/api.js';
import { statsRoutes } from './routes/stats.js';
import { devRoutes } from './routes/dev.js';
import { notifyDiscord } from './discord.js';

export interface ServerDeps {
  config: Config;
  db: DB;
  verifyLogin?: typeof realVerifyLogin;
  fetchPersona?: typeof realFetchPersona;
  hub?: Hub;
  orchestrator?: Orchestrator;
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
 *  doing the retrying. Spaced to cover a slow map load and then some. */
const FINISH_RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

async function finishWithRetry(
  db: DB, orchestrator: RealOrchestrator, matchId: number,
): Promise<void> {
  const stillLive = () =>
    (db.prepare('SELECT state FROM matches WHERE id = ?').get(matchId) as
      { state: string } | undefined)?.state === 'live';

  await orchestrator.finishMatch(matchId);
  for (const wait of FINISH_RETRY_MS) {
    if (!stillLive()) return;
    await new Promise((r) => setTimeout(r, wait));
    // Re-check after the wait: another path may have completed it meanwhile.
    if (!stillLive()) return;
    console.warn(`[orchestrator] retrying collection of match ${matchId}`);
    await orchestrator.finishMatch(matchId);
  }
  if (stillLive()) {
    console.error(
      `[orchestrator] match ${matchId} still uncollected after ${FINISH_RETRY_MS.length} retries; ` +
      'the plugin holds the result, so sm_pug_dump can still recover it by hand',
    );
  }
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: deps.config.cookieSecret });
  await app.register(websocket);
  // Vite builds web/ to dist/public (see vite.config.ts). In dev the Vite server
  // owns the browser and proxies here, so this path only matters in production.
  const staticRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'public');
  await app.register(fastifyStatic, { root: staticRoot });

  await app.register(authRoutes, {
    config: deps.config,
    db: deps.db,
    verifyLogin: deps.verifyLogin ?? realVerifyLogin,
    fetchPersona: deps.fetchPersona ?? realFetchPersona,
  });

  const hub = deps.hub ?? new Hub();
  await app.register(wsRoutes, { hub });

  const notify = (msg: string) => notifyDiscord(deps.db, msg);

  let orchestrator = deps.orchestrator;
  let logListener: LogListener | null = null;
  if (!orchestrator) {
    if (deps.config.devMode) {
      orchestrator = new DevOrchestrator();
    } else {
      // Declared before the listener so the message handler can close over it;
      // assigned just below, once the orchestrator it needs exists.
      let selfStarted: SelfStartedMatches | null = null;
      logListener = new LogListener((ev) => {
        if (ev.kind === 'match_end') {
          const row = deps.db.prepare('SELECT id FROM matches WHERE token = ?').get(ev.token) as { id: number } | undefined;
          if (row) void finishWithRetry(deps.db, orchestrator as RealOrchestrator, row.id);
          return;
        }
        if (ev.kind === 'match_create' || ev.kind === 'match_roster' || ev.kind === 'match_create_end') {
          selfStarted?.handle(ev);
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
          else if (ev.kind === 'live_stat') recordLiveStat(deps.db, ev.token, ev.steamid, ev.stats);
          else if (ev.kind === 'live_event') recordLiveEvent(deps.db, ev.token, ev);
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
      orchestrator = new RealOrchestrator({
        db: deps.db,
        listener: logListener,
        logPublicAddress: deps.config.logPublicAddress,
        notify,
        demoDir: deps.config.demoDir,
        replayDir: deps.config.replayDir,
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
      selfStarted = new SelfStartedMatches({
        db: deps.db,
        listener: logListener,
        resolveServerId: () => servers[0]?.id ?? null,
        setMatchId: (token, matchId) =>
          (orchestrator as RealOrchestrator).assignMatchId(servers[0].id, token, matchId),
        adminSteamIds: deps.config.adminSteamIds,
        notify,
      });
    }
  }

  const matchmaker = new Matchmaker(deps.db, {
    broadcast: (event) => hub.broadcast(event),
    orchestrator,
    notify,
  });
  app.decorate('matchmaker', matchmaker);
  // Sweep matches the game server has forgotten. Without it a plugin reload,
  // an srcds restart or a crash leaves a match 'live' forever: permanently
  // "no signal" on the live page, and its server row stuck reserved so no new
  // match can ever claim it.
  const reaper = setInterval(() => {
    try {
      reapOrphanedMatches(deps.db);
    } catch (err) {
      console.error('[liveView] reaper failed:', err);
    }
  }, 60_000);
  reaper.unref();

  // Daily replay prune. Interval rather than cron because there is no
  // scheduler here and the exact hour does not matter: the window is 90 days.
  // unref so the timer never holds the process open in tests.
  const pruneTimer = setInterval(() => pruneReplays(deps.db, deps.config.replayDir), 24 * 60 * 60 * 1000);
  pruneTimer.unref();

  app.addHook('onClose', async () => {
    clearInterval(reaper);
    clearInterval(pruneTimer);
    if (logListener) await logListener.close();
  });
  await app.register(apiRoutes, { db: deps.db, matchmaker });
  await app.register(statsRoutes, { db: deps.db, demoDir: deps.config.demoDir });

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
