import type { DB } from './db.js';
import { getPlayer } from './players.js';
import { getSetting } from './settings.js';
import type { GuildMembership } from './discord/membership.js';

/** Why a player may not queue yet, beyond bans and timeouts. */
export type QueueBlock = 'link_discord' | 'join_discord';

export const QUEUE_BLOCK_MESSAGE: Record<QueueBlock, string> = {
  link_discord: 'link your Discord account first',
  join_discord: 'join the Riverside Discord server first',
};

/**
 * The Discord requirement for queueing: a linked account that is in the server.
 * Off when Discord is not configured at all (nobody could satisfy it) or the
 * require_discord_to_queue setting is off. Unknown membership allows.
 */
export function makeQueueGate(db: DB, discordEnabled: boolean, membership: GuildMembership) {
  return (steamid: string): QueueBlock | null => {
    if (!discordEnabled || getSetting(db, 'require_discord_to_queue') !== '1') return null;
    const player = getPlayer(db, steamid);
    if (!player?.discord_id) return 'link_discord';
    return membership.isMember(player.discord_id) === false ? 'join_discord' : null;
  };
}
