import type { DB } from './db.js';
import type { LeaseRcon } from './practiceLeases.js';
import type { ConductPost } from './conductFlags.js';
import { feedChannel } from './discord/feedRouting.js';
import { sendStaffChat } from './staffChatSend.js';

/**
 * Telling a player that staff were just told about their slur (owner,
 * 2026-11-15). One private line per staff post, never per chat line: it rides
 * on handleConduct's own ration (a quiet minute per chat stream, a name once
 * per name), so the player hears exactly as often as staff do.
 *
 * Sent as a staff whisper through sm_pug_staffsay, the path the Live chat
 * drawer uses, so no plugin change was needed and the line lands in that
 * server's chat log like any other staff message. In game it reads
 *   [Staff → you] PUG: Staff were notified about your chat message.
 *   Reply privately with /staff <message>
 *
 * Only when the post had somewhere to go: with the conduct feed switched off
 * or no channel set, nobody was notified and the line would not be true.
 * Never throws: an unreachable box costs the notice and nothing else.
 */

/** The sender name the whisper shows. */
export const CONDUCT_NOTICE_NAME = 'PUG';

export function conductNoticeText(where: 'chat' | 'name'): string {
  return where === 'name'
    ? 'Staff were notified about your name.'
    : 'Staff were notified about your chat message.';
}

export async function sendConductNotice(
  db: DB, rcon: LeaseRcon, post: ConductPost, notify?: () => void,
): Promise<boolean> {
  try {
    if (post.serverId === null) return false;
    if (feedChannel(db, post) === null) return false;
    const r = await sendStaffChat(db, rcon, {
      serverId: post.serverId, sentBy: 'system', name: CONDUCT_NOTICE_NAME,
      target: { to: 'player', steamid: post.steamid }, message: conductNoticeText(post.where),
    });
    try { notify?.(); } catch { /* the drawers catch up on their next load */ }
    return r.ok;
  } catch (err) {
    console.error('[conduct] notice to the player failed:', err);
    return false;
  }
}
