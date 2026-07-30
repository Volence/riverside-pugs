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
import { DevOrchestrator, type Orchestrator } from './orchestrator.js';
import { apiRoutes } from './routes/api.js';

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

  const matchmaker = new Matchmaker(deps.db, {
    broadcast: (event) => hub.broadcast(event),
    orchestrator: deps.orchestrator ?? new DevOrchestrator(),
  });
  app.decorate('matchmaker', matchmaker);
  await app.register(apiRoutes, { db: deps.db, matchmaker });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    matchmaker: Matchmaker;
  }
}
