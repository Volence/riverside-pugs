import type { LiveBoardReason } from './api';

/** Shown on a disabled clock button, and as its title, when the match's
 *  server cannot do what the button asks. */
export const OLD_PLUGIN_REASON =
  'This server runs a pug-match older than 0.3.4, which cannot hold the clock. Update the plugin on it to use these.';

/** The same, for a match the site never set up: pug-leave.inc runs no
 *  reconnect clock for one that was started in game, so every clock control
 *  would answer PUGERR. */
export const SELF_STARTED_REASON =
  'This match was started in game, so the server is not tracking reconnect time for it.';

/** A figure the server gave in seconds, counted down by the whole seconds
 *  since the payload arrived. `running` false is a held clock, which stands
 *  still. Null in, null out: an allowance the server did not know is not 0. */
export function countdown(startS: number | null, running: boolean, elapsedS: number): number | null {
  if (startS === null) return null;
  if (!running) return startS;
  return Math.max(0, startS - Math.floor(elapsedS));
}

/** The same, upward: "dropped 0:42 ago", "1:30 since the pop". */
export function countUp(startS: number, elapsedS: number): number {
  return startS + Math.floor(elapsedS);
}

/** Why someone is missing, in the spec's words. Empty when nothing on record
 *  says: the board never guesses. */
export function reasonText(r: LiveBoardReason | null): string {
  if (!r) return '';
  if (r.kind === 'not_in_voice') return 'not in a voice channel';
  const at = new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `rejected by the file check at ${at}`;
}

/** The match id in /admin?live=81, which is what the admin feed's low
 *  allowance warning links to. Moves to /admin/live with the routing plan. */
export const liveFromUrl = (): number | null => {
  const raw = new URLSearchParams(location.search).get('live');
  const id = raw === null ? NaN : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};
