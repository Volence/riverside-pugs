import type { ServerRow } from './serverPool.js';
import type { ServerCleaner } from './serverRelease.js';
import { abortCommand } from './matchTeardown.js';
import { cvarValue } from './serverSetup.js';
import { publishAdminEvent } from './adminFeed.js';

/** What the cleaner needs from an rcon connection; src/rcon.ts in production. */
export interface CleanerRcon {
  connect(): Promise<void>;
  exec(cmd: string): Promise<string>;
  send(cmd: string): Promise<void>;
  waitClosed(ms: number): Promise<boolean>;
  close(): void;
}

export interface CleanerDeps {
  rcon: (server: ServerRow) => CleanerRcon;
  /** The map a torn-down box is reset to (src/matchTeardown.ts resetMap). */
  resetMap: () => string;
  /** How long to give srcds to drop the session after `exec secrets.cfg`. */
  dropWaitMs?: number;
}

/**
 * The rcon side of releasing a game server after a match: let the plugin go,
 * reload what the match cfg unloaded, and put the standing server password
 * back. The ServerReleaser (src/serverRelease.ts) calls this before any
 * restart; src/server.ts wires it with a real rcon client.
 */
export function makeServerCleaner(deps: CleanerDeps): ServerCleaner {
  return async (server, token, opts) => {
    const rcon = deps.rcon(server);
    try {
      await rcon.connect();
      // Both halves on the one connection, and each guarded on its own so a
      // failure of either still lets the other run. Freeing the row while the
      // plugin still held the match was the gap: after a no-show abort the box
      // was advertised as claimable, players stayed connected, and the plugin
      // went on enforcing a roster and a token the backend had already binned.
      // A stale or unknown token just draws a PUGERR, which is a no-op.
      // pug_match.cfg unloads l4d2_spec_stays_spec for the match; casual play
      // wants it back. Loading an already-loaded plugin is a no-op.
      try {
        await rcon.exec('sm plugins load_unlock; sm plugins load l4d2_spec_stays_spec.smx; sm plugins load_lock');
      } catch (err) {
        console.error(`[serverRelease] spec_stays_spec reload failed on ${server.name} (non-fatal):`, err);
      }
      if (token) {
        try {
          // With teardown the plugin announces, waits for an unpause, kicks
          // everyone and changes to the reset map itself. One command rather
          // than five because exec secrets.cfg below drops the session and
          // each extra command is another thing that can time out first.
          await rcon.exec(abortCommand(token, opts.teardown, deps.resetMap()));
        } catch (err) {
          console.error(`[serverRelease] sm_pug_abort failed on ${server.name} (non-fatal):`, err);
        }
      }
      // RESTORE the configured password, never blank it. This box carries a
      // standing sv_password from secrets.cfg (exec'd by local.cfg) which is
      // how strangers are kept off it; local.cfg's own comment records them
      // walking in when it was not being enforced. Blanking it here, which is
      // what this line did when it only had to undo a per-match password,
      // would have left the server open to the internet the first time any
      // match was released, including an ordinary in-game one.
      //
      // exec is the right shape rather than setting a literal: secrets.cfg is
      // the single source of truth, it lives on the box, it is gitignored, and
      // the backend has no business knowing the value. Re-exec is idempotent
      // and only re-asserts rcon_password to what it already is.
      //
      // And it goes LAST, sent without waiting for an answer: secrets.cfg
      // re-sets rcon_password and srcds drops every rcon session on that, so
      // the answer never comes. From 2026-09-17 to 2026-10-05 this was an
      // `exec` that sat out its 5 s timeout on every single release and was
      // logged as a failure although the cfg had run (the password read back
      // fine). Waiting for the drop, briefly, is so closing our end cannot
      // reset the connection before srcds has read the command. The proof
      // that it took is the read-back below.
      try {
        await rcon.send('exec secrets.cfg');
        await rcon.waitClosed(deps.dropWaitMs ?? 2000);
      } catch (err) {
        console.error(`[serverRelease] sv_password restore failed on ${server.name} (non-fatal):`, err);
      }
    } finally {
      rcon.close();
    }
    await confirmPassword(deps, server);
  };
}

/** Reads sv_password back on a fresh connection. An open server is the one
 *  failure this whole step exists to prevent, so it is checked, not trusted;
 *  anything short of "set" is said out loud and an empty one is raised to the
 *  admin feed. Never throws: the release itself has already succeeded. */
async function confirmPassword(deps: CleanerDeps, server: ServerRow): Promise<void> {
  const check = deps.rcon(server);
  try {
    await check.connect();
    const value = cvarValue(await check.exec('sv_password'), 'sv_password');
    if (value === null) {
      console.error(`[serverRelease] could not read sv_password back on ${server.name} after release`);
    } else if (value === '') {
      console.error(`[serverRelease] sv_password is EMPTY on ${server.name} after release: the box is open to anyone`);
      publishAdminEvent({
        kind: 'problem',
        text: `${server.name} has no server password after its match was released: anyone can join it until secrets.cfg is exec'd again or it restarts.`,
      });
    }
  } catch (err) {
    console.error(`[serverRelease] could not confirm sv_password on ${server.name} (non-fatal):`, err);
  } finally {
    check.close();
  }
}
