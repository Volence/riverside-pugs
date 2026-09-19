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
const MAP_RE = /^[a-z0-9_]{1,63}$/i;

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
 *  is the routine post-report abort, unchanged. */
export function abortCommand(token: string, teardown: boolean, map: string): string {
  return teardown ? `sm_pug_abort ${token} teardown ${map}` : `sm_pug_abort ${token}`;
}

/** Admin-feed text for a `PUG <token> PROBLEM code=<code>` line. */
export function problemText(code: string, matchId: number | null): string {
  const m = matchId === null ? 'a match' : `match #${matchId}`;
  switch (code) {
    case 'unpause_timeout':
      return `Tearing down ${m}: the game did not unpause within 10 seconds. Players were kicked and the map `
        + 'changed anyway; if the server is still paused an admin must unpause it in game.';
    default:
      return `Tearing down ${m}: the plugin reported ${code}.`;
  }
}
