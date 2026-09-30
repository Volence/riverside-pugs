import type { FastifyInstance } from 'fastify';
import type { DB } from '../src/db.js';
import { upsertPlayer, activatePlayer } from '../src/players.js';
import { SESSION_COOKIE, sessionValue } from '../src/session.js';
import type { Orchestrator } from '../src/orchestrator.js';

export function authedCookie(
  app: FastifyInstance,
  db: DB,
  steamid: string,
  opts: { active?: boolean } = {},
): Record<string, string> {
  upsertPlayer(db, { steamid, name: `p${steamid.slice(-3)}`, avatar: null }, []);
  if (opts.active !== false) activatePlayer(db, steamid);
  // Issued under the player's current epoch, exactly as a login would be, so
  // a cookie made before a ban or a sign-out is a cookie that no longer works.
  const { session_epoch: epoch } = db.prepare('SELECT session_epoch FROM players WHERE steamid = ?')
    .get(steamid) as { session_epoch: number };
  return { [SESSION_COOKIE]: app.signCookie(sessionValue(steamid, epoch)) };
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
/** The arguments a Source console command reaches a plugin with: quoted
 *  strings kept whole (quotes dropped), and outside quotes the tokenizer's
 *  break characters `{}()':` each stand as an argument of their own, so an
 *  unquoted `7656...:A` becomes three. Confirmed live 2026-08-29
 *  (sm_pug_roster) and 2026-09-29 (sm_side_roster replied roster=0). */
export function sourceArgs(cmd: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      const end = cmd.indexOf('"', i + 1);
      out.push(cmd.slice(i + 1, end < 0 ? cmd.length : end));
      i = end < 0 ? cmd.length : end + 1;
      continue;
    }
    if ("{}()':".includes(ch)) { out.push(ch); i++; continue; }
    let j = i;
    while (j < cmd.length && !/\s/.test(cmd[j]) && !"{}()':\"".includes(cmd[j])) j++;
    out.push(cmd.slice(i, j));
    i = j;
  }
  return out.slice(1);
}

export function pugReply(cmd: string, dumpBody: string | ((cmd: string) => string)): string {
  const name = cmd.split(' ')[0];
  const rest = cmd.slice(name.length).trim();
  // Resolved only for a dump command: callers derive the body from the token in
  // the command, which is meaningless for anything else.
  if (name === 'sm_pug_dump') return typeof dumpBody === 'function' ? dumpBody(cmd) : dumpBody;
  if (name === 'sm_pug_match') return 'PUGOK match=1';
  if (name === 'sm_pug_abort') return 'PUGOK aborted';
  if (name === 'sm_side_stop') return 'PUGOK side stop';
  if (name === 'sm_pug_roster') {
    const arg = rest.startsWith('"') ? rest.slice(1, rest.indexOf('"', 1)) : rest.split(':')[0];
    return /^\d{17}:[ab]$/.test(arg) ? 'PUGOK roster=1' : `PUGERR bad roster arg: ${arg}`;
  }
  return 'ok';
}

/**
 * Record every write that turns a match 'aborted' without an abort_cause in
 * the same statement. The Discord sync reads the two together, and a sync
 * landing between a causeless state write and a later cause write closes the
 * card with no #queue-here line. A trigger, because "the same UPDATE" is the
 * property: checking the row afterwards cannot tell one write from two.
 * Returns the ids caught so far.
 */
export function watchCauselessAborts(db: DB): () => number[] {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS causeless_aborts (match_id INTEGER);
    CREATE TEMP TRIGGER IF NOT EXISTS causeless_abort AFTER UPDATE OF state ON matches
      WHEN NEW.state = 'aborted' AND OLD.state != 'aborted' AND NEW.abort_cause IS NULL AND NEW.voided_at IS NULL
      BEGIN INSERT INTO causeless_aborts (match_id) VALUES (NEW.id); END;
  `);
  return () => (db.prepare('SELECT match_id FROM temp.causeless_aborts').all() as { match_id: number }[]).map((r) => r.match_id);
}
