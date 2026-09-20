import type { DB } from './db.js';
import { publishAdminEvent } from './adminFeed.js';
import { getPlayer } from './players.js';
import { markEntered, recordSignonDrop, STREAK_WINDOW_MS, type SignonDropInput } from './signonDrops.js';
import type { MessagePayload } from './discord/transport.js';

/** Where the DM and the help link point. A page on the Preact site. */
export const CONSISTENCY_HELP_PATH = '/help/consistency';

/** At most one DM per steamid in this long. */
const DM_EVERY_MS = 60 * 60_000;

export type DmFn = (discordUserId: string, payload: MessagePayload) => Promise<void>;

export function signonDropDm(helpUrl: string): MessagePayload {
  return {
    content: [
      'The Riverside L4D server dropped your connection while you were loading in.',
      'That usually means it rejected a modified game file. The server checks a list of game files (special infected models and skins, trees and plants, weapon and infected sounds, smoke and bile effects), and your game showed a dialog naming the one that did not match:',
      '> Server is enforcing consistency for this file: ...',
      `Remove the addon that changes that file, or verify your game files in Steam, then connect again. Step by step: ${helpUrl}`,
      'If you only cancelled the loading screen, ignore this message.',
    ].join('\n'),
    embeds: [],
    components: [[{ kind: 'link', url: helpUrl, label: 'How to fix it' }]],
    mentionUserIds: [],
  };
}

/**
 * What the web does about a SIGNON_DROP line, beyond storing it.
 *
 * - The player is told at once, on the FIRST drop: they already have the file
 *   name on their screen and lack only the explanation. At most one DM per
 *   steamid per hour, and the hour is charged BEFORE the send, so a DM that
 *   fails (closed DMs, not in the guild) is logged and never retried.
 * - Admins are told only when it repeats: the second drop inside ten minutes
 *   with no entry between. One cancelled loading screen posts nothing. At most
 *   one post per steamid per ten minutes, so someone retrying over and over is
 *   one line and then another ten minutes later, not a line per attempt.
 *
 * Both limiters are in memory. A restart forgets them, and the cost of that is
 * one extra DM or one extra line, which is not worth a column.
 */
export class SignonDropNotifier {
  private lastDm = new Map<string, number>();
  private lastPost = new Map<string, number>();

  constructor(private deps: {
    db: DB;
    publicUrl: string;
    /** The bot's DM call, or null while the bot is not running. Read per drop,
     *  because the bot connects some seconds after the listener starts. */
    dm: () => DmFn | null;
  }) {}

  /** Resolves once the DM, if any, has been sent or has failed. Never rejects. */
  async onDrop(d: SignonDropInput, now = new Date()): Promise<void> {
    const rec = recordSignonDrop(this.deps.db, d, now);
    if (!rec) return;

    const posted = this.lastPost.get(d.steamid);
    if (rec.streak >= 2 && (posted === undefined || now.getTime() - posted >= STREAK_WINDOW_MS)) {
      this.lastPost.set(d.steamid, now.getTime());
      publishAdminEvent({ kind: 'signon_drop', steamid: d.steamid, name: d.name, count: rec.streak, total: rec.total });
    }

    const discordId = getPlayer(this.deps.db, d.steamid)?.discord_id;
    const dm = this.deps.dm();
    if (!discordId || !dm) return;
    const sent = this.lastDm.get(d.steamid);
    if (sent !== undefined && now.getTime() - sent < DM_EVERY_MS) return;
    this.lastDm.set(d.steamid, now.getTime());
    try {
      await dm(discordId, signonDropDm(`${this.deps.publicUrl}${CONSISTENCY_HELP_PATH}`));
    } catch (err) {
      console.warn(`[consistency] could not DM ${d.steamid} about a connect drop, not retrying:`, err);
    }
  }

  /** The steamid was seen in game: close their open drops and their streak. */
  onEntered(steamid: string, now = new Date()): void {
    if (markEntered(this.deps.db, steamid, now) > 0) this.lastPost.delete(steamid);
  }
}
