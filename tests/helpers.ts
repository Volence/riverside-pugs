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

/** Model the live server's reply to a pug-match console command.
 *
 *  Two behaviours here are load-bearing and were both confirmed against the real
 *  box on 2026-08-29:
 *   1. The plugin answers `PUGOK ...` / `PUGERR ...`, never a bare 'ok'. The
 *      orchestrator now requires PUGOK, so a fake that just echoes 'ok' would
 *      hide a broken setup.
 *   2. Source's console tokenizer splits UNQUOTED arguments on ':', so
 *      `sm_pug_roster 7656...:a` reaches the plugin as a bare steamid and is
 *      rejected. Only a quoted arg survives. Emulating this is what turns the
 *      original unquoted-roster bug into a regression test.
 */
export function pugReply(cmd: string, dumpBody: string | ((cmd: string) => string)): string {
  const name = cmd.split(' ')[0];
  const rest = cmd.slice(name.length).trim();
  // Resolved only for a dump command: callers derive the body from the token in
  // the command, which is meaningless for anything else.
  if (name === 'sm_pug_dump') return typeof dumpBody === 'function' ? dumpBody(cmd) : dumpBody;
  if (name === 'sm_pug_match') return 'PUGOK match=1';
  if (name === 'sm_pug_abort') return 'PUGOK aborted';
  if (name === 'sm_pug_roster') {
    const arg = rest.startsWith('"') ? rest.slice(1, rest.indexOf('"', 1)) : rest.split(':')[0];
    return /^\d{17}:[ab]$/.test(arg) ? 'PUGOK roster=1' : `PUGERR bad roster arg: ${arg}`;
  }
  return 'ok';
}
