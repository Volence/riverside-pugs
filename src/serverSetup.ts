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
 * server.cfg runs server_startup.cfg, which ends by loading the boot mode,
 * and that lands after the first rcon answer. A cfg exec'd in that gap was
 * overwritten by the boot mode (lease 3 on the local rig, 2026-09-28). So
 * setup polls `l4d_game_type_name` until it reports the boot mode
 * (isBootGameType), this many times this far apart, then waits
 * STARTUP_GRACE_MS more.
 */
export const STARTUP_POLLS = 10;
export const STARTUP_POLL_MS = 2_000;
export const STARTUP_GRACE_MS = 4_000;

/** `l4d_game_type_name` once a pool box's own startup has run: the deploy
 *  repo's cfg/server_startup.cfg boots rotoblin_hardcore_4v4. Boxes on
 *  Rotoblin's stock startup (NFO Chicago) boot its Pub mode instead. Until
 *  2026-10-09 the wait looked only for "Pub", which the pool boxes never say,
 *  so every lease and booking setup sat out all STARTUP_POLLS. */
export const BOOT_GAME_TYPE = 'Roto-AZ / 4v4 VS';
export function isBootGameType(type: string): boolean {
  return type === BOOT_GAME_TYPE || type.includes('Pub');
}

/** Written into `l4d_game_type_name` in the same burst as `exec <cfg>`. Every
 *  mode cfg we run sets its own name when it loads, so reading anything else
 *  back proves the exec ran, whichever mode it was (the boot mode included). */
export const SETUP_PENDING_TYPE = 'setup-pending';

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
 *  box that never reports its boot mode may run a different startup cfg, and
 *  the verify step after this is what decides. */
export async function waitForStartup(rcon: BoxRcon, server: ServerRow, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < STARTUP_POLLS; i++) {
    try {
      const [reply] = await rcon(server, ['l4d_game_type_name']);
      if (isBootGameType(cvarValue(reply, 'l4d_game_type_name') ?? '')) break;
    } catch {
      // Still coming up; poll again.
    }
    await sleep(STARTUP_POLL_MS);
  }
  await sleep(STARTUP_GRACE_MS);
}
