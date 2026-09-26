import type { DB } from './db.js';
import { publishAdminEvent } from './adminFeed.js';
import { getPlayer } from './players.js';
import { markEntered, recordSignonDrop, STREAK_WINDOW_MS, type SignonDropInput } from './signonDrops.js';
import type { MessagePayload } from './discord/transport.js';
import { campaignRegistry } from './campaignRegistry.js';

/** Where the DM and the help link point. A page on the Preact site. */
export const CONSISTENCY_HELP_PATH = '/help/consistency';

/** Where a custom campaign's download lives. */
export const CUSTOM_CAMPAIGNS_PATH = '/custom-campaigns';

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
 * The DM for a drop during a match on a custom campaign. There the client
 * drops itself on the server's very first message, before the consistency
 * check can run, when its copy of the campaign does not match: missing, an
 * older version, or dropped into addons while the game was running (a VPK
 * mounts only at game start). Root-caused on Suicide Blitz in match 108.
 */
export function customCampaignDropDm(campaignName: string, downloadUrl: string): MessagePayload {
  return {
    content: [
      `The Riverside L4D server dropped your connection while you were loading into a match on ${campaignName}, a custom campaign.`,
      'That usually means your copy of the campaign does not match the server\'s, and your game showed:',
      '> Your string table differs from the server\'s.',
      `1. Download ${campaignName} from ${downloadUrl} and put the .vpk in left4dead/addons, replacing any older copy.`,
      '2. Fully quit and restart Left 4 Dead. A campaign added while the game is running is not loaded.',
      '3. Still dropped? Verify your game files in Steam, and delete left4dead/stringtable_dictionary_fallback.dct (the game makes a fresh one), then restart again.',
      'If you only cancelled the loading screen, ignore this message.',
    ].join('\n'),
    embeds: [],
    components: [[{ kind: 'link', url: downloadUrl, label: 'Custom campaigns' }]],
    mentionUserIds: [],
  };
}

/**
 * The custom campaign a server's live match is on, or null for a stock one,
 * no live match, or an unknown server. Keyed on the match's campaign rather
 * than match_live.current_map, because the drops that matter happen while the
 * match's players first connect, before any round has started to set the map.
 * A match is flipped live right after its changelevel, so by the time anyone
 * connects the server is already on that campaign.
 */
export function customCampaignOnServer(db: DB, serverId: number | null): { slug: string; name: string } | null {
  if (serverId === null) return null;
  const row = db.prepare(
    "SELECT campaign FROM matches WHERE server_id = ? AND state = 'live' ORDER BY id DESC LIMIT 1",
  ).get(serverId) as { campaign: string } | undefined;
  if (!row) return null;
  const entry = campaignRegistry(db).get(row.campaign);
  return entry?.custom ? { slug: entry.slug, name: entry.name } : null;
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

  /** Resolves once the DM, if any, has been sent or has failed. Never rejects.
   *  `serverId` is the game server the line came from, when known; it only
   *  picks the wording (custom campaign or modified file). */
  async onDrop(d: SignonDropInput, now = new Date(), serverId: number | null = null): Promise<void> {
    const rec = recordSignonDrop(this.deps.db, d, now);
    if (!rec) return;
    let campaign: { slug: string; name: string } | null = null;
    try {
      campaign = customCampaignOnServer(this.deps.db, serverId);
    } catch (err) {
      console.warn('[consistency] could not look up the campaign for a connect drop:', err);
    }

    const posted = this.lastPost.get(d.steamid);
    if (rec.streak >= 2 && (posted === undefined || now.getTime() - posted >= STREAK_WINDOW_MS)) {
      this.lastPost.set(d.steamid, now.getTime());
      publishAdminEvent({
        kind: 'signon_drop', steamid: d.steamid, name: d.name, count: rec.streak, total: rec.total,
        ...(campaign ? { campaign } : {}),
      });
    }

    const discordId = getPlayer(this.deps.db, d.steamid)?.discord_id;
    const dm = this.deps.dm();
    if (!discordId || !dm) return;
    const sent = this.lastDm.get(d.steamid);
    if (sent !== undefined && now.getTime() - sent < DM_EVERY_MS) return;
    this.lastDm.set(d.steamid, now.getTime());
    try {
      await dm(discordId, campaign
        ? customCampaignDropDm(campaign.name, `${this.deps.publicUrl}${CUSTOM_CAMPAIGNS_PATH}`)
        : signonDropDm(`${this.deps.publicUrl}${CONSISTENCY_HELP_PATH}`));
    } catch (err) {
      console.warn(`[consistency] could not DM ${d.steamid} about a connect drop, not retrying:`, err);
    }
  }

  /** The steamid was seen in game: close their open drops and their streak. */
  onEntered(steamid: string, now = new Date()): void {
    if (markEntered(this.deps.db, steamid, now) > 0) this.lastPost.delete(steamid);
  }
}
