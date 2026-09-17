import type { DB } from '../db.js';
import type { DiscordApi } from './api.js';
import { activatePlayer, getPlayer } from '../players.js';
import { getSetting } from '../settings.js';

/**
 * Discord guild membership as the path to `active`.
 *
 * Only ever activates. Leaving the guild does not deactivate anyone (the
 * owner's call, 2026-09-17): a friend who leaves in a huff and comes back
 * should not lose anything. Banned is never touched, in either direction.
 *
 * Returns whether the player is active afterwards. A Discord API failure is
 * logged and leaves the player as they were, so an outage cannot activate or
 * lock out anyone.
 */
export async function applyGate(db: DB, api: DiscordApi, steamid: string): Promise<boolean> {
  const player = getPlayer(db, steamid);
  if (!player || player.status === 'banned') return false;
  if (player.status === 'active') return true;
  if (!player.discord_id) return false;

  let member: { roles: string[] } | null;
  try {
    member = await api.getGuildMember(player.discord_id);
  } catch (err) {
    console.error(`[discord] gate check failed for ${steamid}:`, err);
    return false;
  }
  if (!member) return false;
  const role = getSetting(db, 'discord_required_role_id') ?? '';
  if (role && !member.roles.includes(role)) return false;
  activatePlayer(db, steamid);
  return true;
}
