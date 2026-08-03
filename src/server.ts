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

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: deps.config.cookieSecret });
  await app.register(websocket);
  await app.register(fastifyStatic, {
    root: join(dirname(fileURLToPath(import.meta.url)), '..', 'public'),
  });

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
      logListener = new LogListener((ev) => {
        if (ev.kind === 'match_end') {
          const row = deps.db.prepare('SELECT id FROM matches WHERE token = ?').get(ev.token) as { id: number } | undefined;
          if (row) void (orchestrator as RealOrchestrator).finishMatch(row.id);
        }
      });
      await logListener.listen(deps.config.logListenPort);
      orchestrator = new RealOrchestrator({
        db: deps.db,
        listener: logListener,
        logPublicAddress: deps.config.logPublicAddress,
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
  app.addHook('onClose', async () => { if (logListener) await logListener.close(); });
  await app.register(apiRoutes, { db: deps.db, matchmaker });
  await app.register(statsRoutes, { db: deps.db });

  if (deps.config.devMode) {
    await app.register(devRoutes, { config: deps.config, db: deps.db, matchmaker, hub });
  }

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    matchmaker: Matchmaker;
  }
}
