import type { ServerRow } from './serverPool.js';
import { transportFor, type AddonsTransport } from './addonsTransport.js';

/**
 * Whether a game server carries the L4D2 mappack.
 *
 * Proved by looking at the far side's disk through that server's own configured
 * transport, not asserted by an admin ticking a box. A flag set by hand drifts
 * from the disk, and the cost of that drift is a live match dying on a map the
 * server cannot load. Probing gives one code path across local, ftp and sftp.
 */

/** A file that exists on every correct install and on no incorrect one. The
 *  first chapter of the first campaign, so a partial copy that got as far as
 *  c1m1 and stopped is the only false positive available, and a partial copy
 *  is not a state any of our install paths can leave behind. */
export const DLC4_PROBE_FILE = 'c1m1_hotel.bsp';

/**
 * Where a server keeps its dlc4 maps, derived from where it keeps its addons.
 *
 * Every box lays out as `<gameroot>/left4dead/addons`, so `<gameroot>` is the
 * part before `/left4dead/addons` and the maps sit at
 * `<gameroot>/left4dead_dlc4/maps`. Derived rather than configured because a
 * derived path cannot drift from the transport it is probed with, and a second
 * config field can. Null for anything that does not match, so a layout we
 * cannot reason about reads as "cannot prove it" and fails the gate closed.
 */
export function dlc4MapsDir(addonsDir: string | null | undefined): string | null {
  if (!addonsDir) return null;
  const m = /^(.*)\/left4dead\/addons\/?$/.exec(addonsDir);
  return m ? `${m[1]}/left4dead_dlc4/maps` : null;
}

export async function serverHasDlc4(
  server: ServerRow,
  // Injected so the tests do not need a real box. Production always uses the
  // real transportFor.
  makeTransport: (s: ServerRow, dir: string) => AddonsTransport | null = transportFor,
): Promise<boolean> {
  const dir = dlc4MapsDir((server as ServerRow & { addons_dir?: string | null }).addons_dir);
  if (!dir) return false;
  const t = makeTransport(server, dir);
  if (!t) return false;
  try {
    return (await t.size(DLC4_PROBE_FILE)) !== null;
  } catch {
    // An unreachable box is not a box we may assume is fine, and an exception
    // here must not take down whatever is iterating servers.
    return false;
  }
}
