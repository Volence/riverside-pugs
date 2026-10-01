import type { DB } from '../db.js';
import { getSetting } from '../settings.js';
import { getPlayer } from '../players.js';

/**
 * Whether this viewer may see and use teams, by the staged rollout switch
 * `competitive_enabled` (off | admins | everyone, default off). `viewer` is an
 * active player's SteamID or null. Anything the switch does not recognise
 * reads as off: unlike practice, nothing here is half-built for admins.
 */
export function competitiveAccess(db: DB, viewer: string | null): boolean {
  if (!viewer) return false;
  const mode = getSetting(db, 'competitive_enabled') ?? 'off';
  if (mode === 'everyone') return true;
  if (mode === 'admins') return getPlayer(db, viewer)?.is_admin === 1;
  return false;
}
