import type { LiveBoardFunnel, LiveBoardReason } from './api';

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

/** Whether a countdown reads as nearly out. The threshold is the setting the
 *  admin feed warns at, so the red on the board and the line in the feed mean
 *  one thing; 0 is that warning turned off, and then nothing goes red. */
export const isLow = (leftS: number, thresholdS: number): boolean => thresholdS > 0 && leftS <= thresholdS;

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

/** One short line from the connection funnel, or '' for nothing worth
 *  saying: "loading the map" for someone connected but not in game yet, "in
 *  game, not ready" during a ready-up, and the L4D2 pack when the site has
 *  seen it missing. Never shown to players; the board is staff only. */
export function funnelText(f: LiveBoardFunnel | null | undefined, phase: string | null): string {
  if (!f) return '';
  const parts: string[] = [];
  if (f.stage === 'loading') parts.push('loading the map');
  else if ((f.stage === 'in_game' || f.stage === 'on_team') && phase === 'readyup') parts.push('in game, not ready');
  if (f.pack === 'missing') parts.push('L4D2 map pack missing');
  else if (f.pack === 'suspect' && f.stage !== 'ready') parts.push('may lack the L4D2 map pack');
  return parts.join(', ');
}

/** The match id in /admin/live?live=81, which is what the admin feed's low
 *  allowance warning links to. The old /admin?live=81 form redirects here,
 *  query and all, so the parameter name is part of both. */
export const liveFromUrl = (): number | null => {
  const raw = new URLSearchParams(location.search).get('live');
  const id = raw === null ? NaN : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** The server whose chat drawer ?chat= asks for, from a link on a mod call
 *  card, the admin feed, or In-game calls. */
export function chatFromUrl(search: string = typeof location === 'undefined' ? '' : location.search): number | null {
  const v = new URLSearchParams(search).get('chat');
  return v !== null && /^\d{1,6}$/.test(v) ? Number(v) : null;
}
