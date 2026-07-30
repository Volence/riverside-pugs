import type { FastifyInstance } from 'fastify';
import type { DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { SESSION_COOKIE } from '../src/session.js';
import type { Orchestrator } from '../src/orchestrator.js';

export function authedCookie(
  app: FastifyInstance,
  db: DB,
  steamid: string,
  opts: { active?: boolean } = {},
): Record<string, string> {
  upsertPlayer(db, { steamid, name: `p${steamid.slice(-3)}`, avatar: null }, []);
  if (opts.active !== false) activatePlayer(db, steamid);
  return { [SESSION_COOKIE]: app.signCookie(steamid) };
}

/** No-op orchestrator for tests that don't exercise match orchestration.
 *  Injecting it makes buildServer skip binding the UDP log listener. */
export function stubOrchestrator(): Orchestrator {
  return { setupMatch: async () => {}, finishMatch: async () => {} };
}
