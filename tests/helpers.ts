import type { FastifyInstance } from 'fastify';
import type { DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { SESSION_COOKIE } from '../src/session.js';

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
