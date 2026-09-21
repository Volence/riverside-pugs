import type { ServerRow } from './serverPool.js';
import type { LeaveState } from './presence.js';

/**
 * The website's half of `sm_pug_leave` (plugin/pug-leave.inc, 0.3.4): the
 * console line it sends and the answer it is willing to believe.
 *
 * The answer is the ONLY thing that changes the board. A command the server
 * does not acknowledge leaves the old state up and an error on the card, and
 * nothing is assumed, because the thing being controlled ends a ranked match.
 */

/** Runs one console command on one server and resolves with its reply.
 *  Injected so a test never dials rcon. Must reject when the box cannot be
 *  reached; the caller does the logging. */
export type ServerQuery = (server: ServerRow, command: string) => Promise<string>;

export const LEAVE_ACTIONS = ['hold', 'release', 'add', 'end'] as const;
export type LeaveAction = typeof LEAVE_ACTIONS[number];

/** The plugin refuses more than this in one add, and caps the allowance at it. */
export const LEAVE_ADD_MAX_S = 3600;

export const OLD_PLUGIN_ERROR =
  'This server runs a pug-match older than 0.3.4, which has no clock control. Update the plugin on it to use these.';

export const isUnknownCommand = (body: string): boolean => /unknown command/i.test(body);

/** Asserted rather than trusted: this becomes a line on a game server's
 *  console, where a space or a semicolon is another argument or another
 *  command. Both values come from our own tables, and that is not a reason. */
export function leaveCommand(token: string, steamid: string, action: LeaveAction, seconds?: number): string {
  if (!/^[0-9a-f]{32}$/.test(token)) throw new Error('leaveCommand: not a match token');
  if (!/^\d{17}$/.test(steamid)) throw new Error('leaveCommand: not a steamid');
  if (action !== 'add') return `sm_pug_leave ${token} ${steamid} ${action}`;
  if (seconds === undefined || !Number.isInteger(seconds) || seconds < 1 || seconds > LEAVE_ADD_MAX_S) {
    throw new Error(`leaveCommand: add needs whole seconds between 1 and ${LEAVE_ADD_MAX_S}`);
  }
  return `sm_pug_leave ${token} ${steamid} add ${seconds}`;
}

export type LeaveReply =
  | { ok: true; line: string; steamid: string; state: LeaveState }
  | { ok: false; oldPlugin: boolean; error: string };

const uint = (s: string | undefined): number | null => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);

/** An rcon response carries whatever else reached the console while the
 *  command ran, so the answer is looked for by its opening words, line by line. */
export function parseLeaveReply(body: string): LeaveReply {
  const lines = body.split('\n').map((l) => l.trim());
  const okLine = lines.find((l) => l.startsWith('PUGOK leave '));
  if (okLine) {
    const f: Record<string, string> = {};
    for (const part of okLine.split(/\s+/).slice(2)) {
      const at = part.indexOf('=');
      if (at > 0) f[part.slice(0, at)] = part.slice(at + 1);
    }
    const remaining = uint(f.remaining);
    const flags = (f.absent === '0' || f.absent === '1') && (f.held === '0' || f.held === '1');
    if (/^\d{17}$/.test(f.steamid ?? '') && remaining !== null && flags) {
      const held = f.held === '1';
      return {
        ok: true, line: okLine, steamid: f.steamid,
        state: { absent: f.absent === '1', remaining, held, holdLeft: held ? uint(f.hold_left) : null },
      };
    }
    return { ok: false, oldPlugin: false, error: `unreadable answer: ${okLine.slice(0, 120)}` };
  }
  const errLine = lines.find((l) => l.startsWith('PUGERR'));
  if (errLine) return { ok: false, oldPlugin: false, error: errLine.slice('PUGERR'.length).trim() || 'refused' };
  if (isUnknownCommand(body)) return { ok: false, oldPlugin: true, error: OLD_PLUGIN_ERROR };
  const text = body.trim();
  return { ok: false, oldPlugin: false, error: text ? `unexpected answer: ${text.slice(0, 120)}` : 'no answer' };
}
