import { campaignDisplayName } from '../campaignRegistry.js';
import type { DB } from '../db.js';
import { escapeName } from '../identity.js';
import { getPlayer } from '../players.js';
import type { MessagePayload } from './transport.js';

/** A row of skeet_streaks, as read straight off the table. */
export interface SkeetStreakRow {
  match_id: number;
  player_id: string;
  map_ordinal: number;
  half: number;
  t_ms: number;
  count: number;
  span_ms: number;
  message_id: string | null;
  posted_at: string | null;
}

/** "triple skeet" / "quad skeet" up to 4, then "<n>-skeet streak", matched
 *  by the count word used right after it ("3 skeets", "4 skeets", "<n>
 *  skeets"). */
function names(count: number): { streak: string; skeets: string } {
  if (count === 3) return { streak: 'triple skeet', skeets: '3 skeets' };
  if (count === 4) return { streak: 'quad skeet', skeets: '4 skeets' };
  return { streak: `${count}-skeet streak`, skeets: `${count} skeets` };
}

/**
 * The single line posted to the weekly channel for one burst: who, how big,
 * which match and campaign, how fast, and a link to the exact moment in the
 * replay viewer. No emoji, by the owner's ruling, and the name and content
 * carry no ping (mentionUserIds is empty; a player is never @'d for this).
 *
 * The replay link is wrapped in <> to suppress Discord's own link preview
 * for the message, the same way a bare link in the content would otherwise
 * grow an embed under it (see how ticketCard.ts's matchLinks avoids this by
 * only ever appearing inside an embed field, which never previews).
 */
export function renderSkeetStreak(db: DB, row: SkeetStreakRow, publicUrl: string): MessagePayload {
  const player = getPlayer(db, row.player_id);
  const name = escapeName(player?.name ?? row.player_id);
  const match = db.prepare('SELECT campaign FROM matches WHERE id = ?').get(row.match_id) as { campaign: string } | undefined;
  const campaign = campaignDisplayName(db, match?.campaign ?? '');
  const { streak, skeets } = names(row.count);
  const seconds = (row.span_ms / 1000).toFixed(1);
  const link = `${publicUrl}/match/${row.match_id}?ordinal=${row.map_ordinal}&half=${row.half}&t=${row.t_ms}`;
  const content =
    `**${name}** hit a **${streak}** in match ${row.match_id} on ${campaign}, ${skeets} in ${seconds} seconds. `
    + `[Watch it](<${link}>)`;
  return { content, embeds: [], components: [], mentionUserIds: [] };
}
