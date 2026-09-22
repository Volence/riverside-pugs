import type { DB } from '../db.js';

/**
 * Discord-side sanctions on people who have no player account: a timeout or
 * a ban the bot carried out. Written in phase 3c; read here so a sanctioned
 * Discord-only member cannot file reports, which is their equivalent of
 * inGoodStanding.
 */
export function activeDiscordSanction(
  db: DB, discordId: string, now = new Date(),
): { kind: 'timeout' | 'ban'; until: string | null } | null {
  const row = db.prepare(
    `SELECT kind, until FROM discord_sanctions
     WHERE discord_id = ? AND lifted_at IS NULL AND (until IS NULL OR until > ?)
     ORDER BY id DESC LIMIT 1`,
  ).get(discordId, now.toISOString()) as { kind: 'timeout' | 'ban'; until: string | null } | undefined;
  return row ?? null;
}
