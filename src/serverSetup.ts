import type { ServerRow } from './serverPool.js';

/**
 * Box setup helpers shared by everything that borrows a pool server outside a
 * match: practice leases (src/practiceLeases.ts) and bookings
 * (src/bookings/runner.ts). Moved here unchanged from practiceLeases.ts.
 */

/** Runs these commands on one short connection and returns each reply. */
export type BoxRcon = (server: ServerRow, commands: string[]) => Promise<string[]>;

/**
 * A freshly restarted box answers rcon BEFORE its own startup has finished:
 * server.cfg runs server_startup.cfg, which ends in `exec rotoblin_pub.cfg`,
 * and that lands after the first rcon answer. A cfg exec'd in that gap was
 * overwritten by Pub VS (lease 3 on the local rig, 2026-09-28; the live boxes
 * boot the same way). So setup polls `l4d_game_type_name` until it reports
 * the startup config (it contains "Pub"), this many times this far apart,
 * then waits STARTUP_GRACE_MS more.
 */
export const STARTUP_POLLS = 10;
export const STARTUP_POLL_MS = 2_000;
export const STARTUP_GRACE_MS = 4_000;

/** A cvar's value from its console echo (`"name" = "value" ( def. ... )`),
 *  or null when the reply does not carry one (unknown cvar, dropped reply). */
export function cvarValue(reply: string | undefined, name: string): string | null {
  const m = new RegExp(`"${name}"\\s*=\\s*"([^"]*)"`).exec(reply ?? '');
  return m ? m[1] : null;
}

/** Quoted for the console: a URL carries `//`, which starts a comment
 *  unquoted. Quotes and line breaks are refused rather than escaped, since
 *  the Source console has no escape for either. */
export function quoted(v: string): string {
  if (/["\r\n;]/.test(v)) throw new Error(`refusing to send ${JSON.stringify(v)} to a game server console`);
  return `"${v}"`;
}

/** Free text (a team name) made safe for quoted(): printable ASCII only, no
 *  quote or semicolon, at most `max` characters. */
export function consoleText(v: string, max: number): string {
  return v.replace(/["\r\n;]/g, '').replace(/[^\x20-\x7e]/g, '?').slice(0, max);
}

/** Poll until the box's own startup config has run (see STARTUP_POLLS), or
 *  the polls run out, then give it STARTUP_GRACE_MS more. Never throws: a
 *  box that never says "Pub" may run a different startup cfg, and the verify
 *  step after this is what decides. */
export async function waitForStartup(rcon: BoxRcon, server: ServerRow, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < STARTUP_POLLS; i++) {
    try {
      const [reply] = await rcon(server, ['l4d_game_type_name']);
      if ((cvarValue(reply, 'l4d_game_type_name') ?? '').includes('Pub')) break;
    } catch {
      // Still coming up; poll again.
    }
    await sleep(STARTUP_POLL_MS);
  }
  await sleep(STARTUP_GRACE_MS);
}
