import type { DB } from './db.js';
import { getPlayer } from './players.js';
import { getSetting } from './settings.js';
import type { VoicePresence } from './discord/voicePresence.js';

/** Why a player may not press Ready yet. */
export type ReadyBlock = 'link_discord' | 'join_voice';

export const READY_BLOCK_MESSAGE: Record<ReadyBlock, string> = {
  link_discord: 'link your Discord account first',
  join_voice: 'join a voice channel in the Riverside Discord first',
};

/**
 * The voice requirement for readying up: a linked account sitting in any voice
 * channel on the Discord server. Off when Discord is not configured at all
 * (nobody could satisfy it) or the require_voice_to_ready setting is off.
 * Unknown presence allows, the same as the queue gate treats membership.
 *
 * Checked when Ready is pressed, on both the site and the Discord card, since
 * both go through Matchmaker.ready. Someone who readies and then leaves voice
 * is un-readied by the matchmaker, so a match never starts with a player
 * outside voice. Nothing watches voice once the match is under way.
 */
export function makeReadyGate(db: DB, discordEnabled: boolean, presence: VoicePresence) {
  return (steamid: string): ReadyBlock | null => {
    if (!discordEnabled || getSetting(db, 'require_voice_to_ready') !== '1') return null;
    const player = getPlayer(db, steamid);
    if (!player?.discord_id) return 'link_discord';
    return presence.inVoice(player.discord_id) === false ? 'join_voice' : null;
  };
}
