import type { DB } from './db.js';
import { getSetting } from './settings.js';

/**
 * The strings the release path needs when a match ends badly.
 *
 * A cancelled match (abandon, no-show, admin abort) leaves its box with the
 * roster still connected, possibly paused, on the match map, and the standing
 * sv_password lets the leaver straight back in. The plugin does the actual
 * work (unpause, kick, changelevel) behind one extra argument to
 * sm_pug_abort; this module owns what the backend sends and what it says when
 * the plugin reports trouble.
 */

export const DEFAULT_RESET_MAP = 'l4d_hospital01_apartment';
// Case-sensitive: Linux map files are case-sensitive, so a mixed-case value
// that passed a case-insensitive check here would still fail changelevel on
// the box, leaving it empty on the match map.
const MAP_RE = /^[a-z0-9_]{1,63}$/;

/** The map an emptied server is sent to. Falls back rather than throws: this
 *  is read on the release path, which must never fail over a setting, and it
 *  ends up on a console line, so anything but a bare map name is refused. */
export function resetMap(db: DB): string {
  const v = (getSetting(db, 'reset_map') ?? '').trim();
  return MAP_RE.test(v) ? v : DEFAULT_RESET_MAP;
}

/** The one command the release path sends the plugin. With `teardown` the
 *  plugin announces, waits for an unpause, kicks everyone and changes to
 *  `map` itself; see Cmd_Abort in plugin/pug-match.sp. Without it, behaviour
 *  is the routine post-report abort, unchanged, and `map` is never sent so it
 *  is never validated.
 *
 *  `map` is checked against the same MAP_RE as resetMap, which is the only
 *  caller today so this never actually rejects anything; it exists so the
 *  plugin's own MapNameOk is a genuine second line of defence rather than
 *  the only one. */
export function abortCommand(token: string, teardown: boolean, map: string): string {
  if (!teardown) return `sm_pug_abort ${token}`;
  if (!MAP_RE.test(map)) throw new Error(`invalid reset map: ${map}`);
  return `sm_pug_abort ${token} teardown ${map}`;
}

/** Admin-feed text for a `PUG <token> PROBLEM code=<code>` line. */
export function problemText(code: string, matchId: number | null): string {
  const m = matchId === null ? 'a match' : `match #${matchId}`;
  switch (code) {
    case 'unpause_timeout':
      return `Tearing down ${m}: the game did not unpause within 10 seconds. Players were kicked and the map `
        + 'change was attempted anyway; if the server is still paused an admin must unpause it in game.';
    default:
      return `Tearing down ${m}: the plugin reported ${code}.`;
  }
}
