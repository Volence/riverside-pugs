import type { DB } from './db.js';
import { getServer, type ServerRow } from './serverPool.js';
import { publishAdminEvent } from './adminFeed.js';

/**
 * Restarting a game server between matches.
 *
 * Asked for on 2026-09-21, and the numbers behind it are worth keeping. Dallas
 * runs in bursts: 5 to 13 matches back to back with a median gap of 3 minutes
 * (39 of 64 gaps under 5 minutes), then it goes quiet for a median of 13 hours.
 * So uptime piles up INSIDE a session: 12.1 hours of continuous play on
 * 2026-09-19, and the service reported a 1.6 GB memory peak with 214 MB swapped
 * on a box with 3.9 GB. Restarting only when the box is idle for hours would
 * fire in the quiet period, after the damage, so it is the wrong trigger; one
 * restart per match caps uptime at a single campaign instead.
 *
 * It also fixes a real bug for free. srcds mounts addons/*.vpk at startup only,
 * so a custom campaign installed onto a running server never mounts and its
 * changelevel fails (match #93). A box that has just booted has mounted
 * everything by definition.
 *
 * Six measured restarts on Dallas: 1 to 4 seconds to the first map, 6 to 8
 * seconds to Steam connected and VAC secure. The plugin's EndMatchNow has
 * already stopped the demo and kicked everyone with the result by the time the
 * backend releases the box, so nobody is connected to notice.
 *
 * The mechanism is deliberately `quit` over the rcon connection we already
 * have, not ssh and systemctl. Every box is supervised (Restart=always on
 * Dallas and the two Riverside units; NFO's own supervisor on Chicago), so
 * quit is the one lever that works everywhere with no new credentials, no
 * sudo, and nothing to configure per box. It costs the unit's RestartSec, ten
 * seconds on ours, which against a three minute median gap does not matter.
 *
 * NOT done between MAPS of a match, which is a different thing entirely: the
 * plugin holds per-map scores in globals that are never written to disk, so a
 * mid-match restart would make the final sm_pug_dump report only the maps
 * played since, and the result and everyone's rating with it would be wrong.
 */

/** Gap between readiness probes while waiting for the box to come back. */
export const POLL_MS = 3_000;
/** How long to keep waiting. Generous against a measured 6 to 8 seconds: the
 *  cost of waiting is one box out of the pool, the cost of giving up early is
 *  a box left offline that was about to answer. */
export const TIMEOUT_MS = 180_000;

/** Whether this box is set to restart after each match. Off by default: the
 *  failure mode of asking a box to quit and having nothing bring it back is
 *  that the box is gone until someone opens its host's control panel, so this
 *  is turned on per server by an admin who can watch it. */
export function restartsAfterMatch(db: DB, serverId: number): boolean {
  const row = getServer(db, serverId) as (ServerRow & { restart_after_match?: number }) | undefined;
  return row?.restart_after_match === 1;
}

/** Tries at sending `quit` before giving up on this restart. */
export const QUIT_ATTEMPTS = 4;
/** Gap between those tries. */
export const QUIT_RETRY_MS = 5_000;

/**
 * Thrown by a `quit` dependency when it never got as far as sending quit
 * (connect or auth failed), as opposed to the connection dying after quit went
 * out, which is the normal result. The difference matters: from 2026-09-21 to
 * 09-25 Dallas skipped 7 of 37 between-match restarts this way ("rcon connect
 * timeout"), each logged as a successful quit, and the box that never went down
 * answered the first probe as "back".
 */
export class QuitNotSentError extends Error {
  constructor(readonly cause: unknown) {
    super(`quit not sent: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'QuitNotSentError';
  }
}

export interface ServerRestarter {
  /** True once the box is answering again; false if it never came back, in
   *  which case it has already been reported and must stay out of the pool. */
  restart(server: ServerRow): Promise<boolean>;
}

export interface RconRestarterDeps {
  /** Ask the box to quit. Its supervisor starts it again. Throws
   *  QuitNotSentError when quit never reached the box; any other error means
   *  the connection died after quit went out. */
  quit(server: ServerRow): Promise<void>;
  /** One readiness probe. Resolves true when the box answers as a working pug
   *  server, false when it does not (refused, timed out, still loading). */
  ready(server: ServerRow): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  timeoutMs?: number;
  pollMs?: number;
}

export function rconRestarter(deps: RconRestarterDeps): ServerRestarter {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const pollMs = deps.pollMs ?? POLL_MS;

  return {
    async restart(server) {
      let sent = false;
      for (let attempt = 1; attempt <= QUIT_ATTEMPTS && !sent; attempt++) {
        try {
          await deps.quit(server);
          sent = true;
        } catch (err) {
          if (err instanceof QuitNotSentError) {
            console.warn(`[serverRestart] ${server.name} quit not sent (attempt ${attempt}/${QUIT_ATTEMPTS}):`, err.message);
            if (attempt < QUIT_ATTEMPTS) await sleep(QUIT_RETRY_MS);
            continue;
          }
          // Expected as often as not: the connection dies with the process we
          // just asked to exit, and that is a successful quit, not a failure.
          // Whether it worked is decided by the probe below, never by this.
          console.log(`[serverRestart] ${server.name} dropped the quit connection (normal):`, err instanceof Error ? err.message : err);
          sent = true;
        }
      }
      if (!sent) {
        // Never went down, so the probe below finds it answering and it goes
        // back to the pool unrestarted. That is the right outcome for the next
        // match; it is reported so a box that keeps skipping gets looked at.
        console.error(`[serverRestart] ${server.name} was not restarted: quit could not be sent in ${QUIT_ATTEMPTS} tries`);
        publishAdminEvent({
          kind: 'problem',
          text: `${server.name} was due a restart after its match but did not answer rcon in `
            + `${QUIT_ATTEMPTS} tries, so it was not restarted. It stays in the pool.`,
        });
      }
      const deadline = now() + timeoutMs;
      // Slept BEFORE the first probe on purpose. The old process is still
      // listening for the moment it takes to exit, so probing immediately can
      // answer "ready" from the server we are trying to replace.
      while (now() < deadline) {
        await sleep(pollMs);
        let ok = false;
        try {
          ok = await deps.ready(server);
        } catch {
          ok = false;
        }
        if (ok) {
          console.log(`[serverRestart] ${server.name} is back`);
          return true;
        }
      }
      console.error(`[serverRestart] ${server.name} did not come back within ${timeoutMs / 1000}s`);
      publishAdminEvent({
        kind: 'problem',
        text: `${server.name} was asked to restart after a match and has not come back after `
          + `${timeoutMs / 1000} seconds. It is out of the pool so no match can land on it. `
          + 'Check the box, then put it back with Set idle in the admin panel.',
      });
      return false;
    },
  };
}

/** Between the result kick and `quit`, so the kicks reach clients first. */
export const ENDKICK_BEFORE_QUIT_MS = 2000;

/**
 * Kick everyone with the match result, then quit.
 *
 * Without the first step players saw "Server shutting down" instead of who
 * won: the plugin's own kick waits 8 s so the score can be read in chat, and
 * the restart lands sooner. A plugin older than 0.3.5 answers "Unknown
 * command", which costs nothing, and any failure of the kick still quits.
 */
export async function kickThenQuit(
  rcon: { exec(cmd: string): Promise<string> },
  name: string,
  pauseMs = ENDKICK_BEFORE_QUIT_MS,
): Promise<void> {
  try {
    await rcon.exec('sm_pug_endkick_now');
    await new Promise((r) => setTimeout(r, pauseMs));
  } catch (err) {
    console.log(`[serverRestart] ${name} end kick before quit failed, quitting anyway:`, err instanceof Error ? err.message : err);
  }
  await rcon.exec('quit');
}
