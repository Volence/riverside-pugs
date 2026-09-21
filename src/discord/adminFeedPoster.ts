import type { DB } from '../db.js';
import { FEED_SETTING, subscribeAdminEvents, type AdminEvent } from '../adminFeed.js';
import { getSetting } from '../settings.js';
import { getPlayer } from '../players.js';
import { activeTimeout } from '../penalties.js';
import { escapeName } from './presenter.js';
import type { BotInteraction, BotTransport, InteractionReply } from './transport.js';

const COLOR = { report: 0xde4e40, action: 0xc9a45c, penalty: 0x8a7f73, account: 0x45b39c, problem: 0xde4e40 };

/**
 * Posts the admin feed to the private admin channel.
 *
 * A report is one plain line, and only while no tickets forum is set: once
 * there is a forum the ticket's own post is the announcement (TicketSync
 * decides which). There is no card and nothing to edit.
 * Everything else is one short line per event too. Posts go out one at a
 * time so the channel keeps event order.
 */
export class AdminFeedPoster {
  private chain: Promise<void> = Promise.resolve();
  private off: (() => void) | null = null;

  constructor(private deps: { db: DB; transport: BotTransport; publicUrl: string }) {}

  start(): void {
    this.off = subscribeAdminEvents((e) => {
      this.chain = this.chain.then(() => this.deliver(e)).catch((err) => console.error('[discord] admin feed post failed:', err));
    });
  }

  stop(): void {
    this.off?.();
  }

  /** Resolves once every event published so far has been delivered (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  private channel(kind: AdminEvent['kind']): string | null {
    const id = getSetting(this.deps.db, 'discord_admin_channel_id') ?? '';
    if (!id) return null;
    return getSetting(this.deps.db, FEED_SETTING[kind]) === '0' ? null : id;
  }

  private name(steamid: string): string {
    return escapeName(getPlayer(this.deps.db, steamid)?.name ?? steamid);
  }

  private async deliver(e: AdminEvent): Promise<void> {
    const channelId = this.channel(e.kind);
    if (!channelId) return;
    const line = this.line(e);
    if (!line) return;
    await this.deps.transport.send(channelId, {
      embeds: [{ description: line.text, color: line.color }], components: [], mentionUserIds: [],
    });
  }

  private line(e: AdminEvent): { text: string; color: number } | null {
    switch (e.kind) {
      case 'report': {
        const link = `[#${e.ticketId}](${this.deps.publicUrl}/admin?ticket=${e.ticketId})`;
        return {
          text: e.created
            ? `🎫 New ticket ${link} about **${this.name(e.targetId)}** (${e.category}).`
            : `🎫 Another report on ticket ${link} about **${this.name(e.targetId)}** (${e.category}).`,
          color: COLOR.report,
        };
      }
      case 'admin_action': return { text: this.actionText(e), color: COLOR.action };
      case 'penalty': {
        const t = activeTimeout(this.deps.db, e.steamid);
        const what = e.penalty === 'no_show'
          ? `never connected to match${e.matchId ? ` [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})` : ''}`
          : 'missed a ready check';
        const minutes = t ? Math.round((t.until.getTime() - Date.now()) / 60_000) : 0;
        const timeout = t ? ` · ${fmtMinutes(minutes)} queue timeout (offense ${t.offenses} this week)` : '';
        return { text: `**${this.name(e.steamid)}** ${what}${timeout}`, color: COLOR.penalty };
      }
      case 'account':
        return {
          text: e.what === 'linked'
            ? `**${this.name(e.steamid)}** linked Discord${e.discordName ? ` (${escapeName(e.discordName)})` : ''}`
            : `**${this.name(e.steamid)}** is now active`,
          color: COLOR.account,
        };
      case 'problem':
        return { text: `⚠️ ${e.text}`, color: COLOR.problem };
      case 'abandon':
        return {
          text: `🚪 **${this.name(e.steamid)}** abandoned match [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId}) (ran out of reconnect time). Match ended with no rating change; banned for ${fmtMinutes(e.minutes)}.`,
          color: COLOR.problem,
        };
      case 'lilac_flag': {
        const match = e.matchId ? ` in match [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})` : '';
        // "suspected" is LilAC's own word for the soft case and it is the right
        // one: its docs say few and rare suspicions are likely false positives.
        return {
          text: e.banned
            ? `🛑 **${this.name(e.steamid)}** was BANNED by Little Anti-Cheat for \`${e.cheat}\`${match}.`
            : `🎛️ **${this.name(e.steamid)}** is suspected by Little Anti-Cheat of \`${e.cheat}\`${match}. Few and rare suspicions are usually false positives.`,
          color: COLOR.problem,
        };
      }
      case 'input_flag': {
        // Deliberately worded as something to look at, not as a verdict. The
        // signature is evidence from input timing, and the admin decides.
        const match = e.matchId ? ` in match [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})` : '';
        return {
          text: `🎛️ **${this.name(e.steamid)}** tripped the \`${e.signature}\` input check${match} (${e.detail}). Worth a look at the replay.`,
          color: COLOR.problem,
        };
      }
      case 'signon_drop': {
        // The in-game name, not this.name(): most of these steamids have never
        // signed in, and an admin searching the server log needs the name the
        // player was actually using.
        const known = getPlayer(this.deps.db, e.steamid);
        const id = known ? `[${e.steamid}](${this.deps.publicUrl}/player/${e.steamid})` : `\`${e.steamid}\``;
        return {
          text: `**${escapeName(e.name)}** (${id}) dropped while connecting ${e.count} times in ten minutes without getting in (${e.total} on record): likely rejected for a modified game file; the file name was shown on their screen. A cancelled loading screen looks the same, so this is a hint, not proof.`,
          color: COLOR.problem,
        };
      }
    }
  }

  private actionText(e: Extract<AdminEvent, { kind: 'admin_action' }>): string {
    const who = `**${this.name(e.adminId)}**`;
    const target = `**${this.name(e.target)}**`;
    const d = e.detail;
    const match = `[#${e.target}](${this.deps.publicUrl}/match/${e.target})`;
    switch (e.action) {
      case 'ban': return `${who} banned ${target}: ${escapeName(String(d.reason ?? ''))} (${d.minutes ? fmtMinutes(Number(d.minutes)) : 'permanent'})`;
      case 'unban': return `${who} unbanned ${target}`;
      case 'activate': return `${who} activated ${target}`;
      case 'set_admin': return `${who} ${d.isAdmin ? 'made' : 'removed'} ${target} ${d.isAdmin ? 'an admin' : 'as admin'}`;
      case 'set_mod': return `${who} ${d.isMod ? 'made' : 'removed'} ${target} ${d.isMod ? 'a moderator' : 'as moderator'}`;
      case 'unlink_discord': return `${who} unlinked ${target}'s Discord`;
      case 'note': return `${who} added a note on ${target}`;
      case 'clear_penalties': return `${who} cleared ${target}'s penalties`;
      case 'abort_match': return `${who} aborted match ${match}`;
      case 'void_match': return `${who} voided match ${match}: ${escapeName(String(d.reason ?? ''))}. Season ratings were recomputed.`;
      case 'new_season': return `${who} started a new season: **${escapeName(String(d.name ?? ''))}**. Everyone's rating starts fresh.`;
      case 'rename_season': return `${who} renamed season ${e.target} to **${escapeName(String(d.name ?? ''))}**`;
      case 'server_idle': return `${who} set server ${e.target} idle`;
      case 'server_restart_after_match':
        return `${who} turned ${d.on ? 'on' : 'off'} restart-after-match for server ${e.target}`;
      case 'queue_remove': return `${who} removed ${target} from the queue`;
      case 'setting': return 'from' in d
        ? `${who} changed the ${e.target} setting from \`${String(d.from)}\` to \`${String(d.to)}\``
        : `${who} changed the ${e.target} setting`;
      case 'ticket_open': case 'ticket_claim': case 'ticket_restrict': case 'ticket_access':
      case 'ticket_close': case 'ticket_reopen': case 'ticket_ban': {
        const ticket = `ticket [#${e.target}](${this.deps.publicUrl}/admin?ticket=${e.target})`;
        switch (e.action) {
          case 'ticket_open': return `${who} opened ${ticket}`;
          case 'ticket_claim': return `${who} ${d.claim === false ? 'released' : 'claimed'} ${ticket}${d.via === 'discord' ? ' from Discord' : ''}`;
          case 'ticket_close': return `${who} closed ${ticket}: ${String(d.outcome ?? '').replace(/_/g, ' ')}${d.via === 'discord' ? ' from Discord' : ''}`;
          case 'ticket_reopen': return `${who} reopened ${ticket}`;
          case 'ticket_ban': return `${who} banned from ${ticket}: ${escapeName(String(d.reason ?? ''))} (${d.minutes ? fmtMinutes(Number(d.minutes)) : 'permanent'})`;
          default: return `${who} updated ${ticket}`;
        }
      }
      default: return `${who} ${e.action.replace(/_/g, ' ')} ${e.target}`;
    }
  }

  /** Report cards posted before tickets existed still carry Resolve and
   *  Dismiss. They must answer, not time out. */
  async handleButton(_i: Extract<BotInteraction, { kind: 'button' }>): Promise<InteractionReply> {
    return {
      ephemeral: true,
      payload: { content: `Reports are tickets now. Open ${this.deps.publicUrl}/admin and use the Tickets tab.`, embeds: [], components: [], mentionUserIds: [] },
    };
  }
}

function fmtMinutes(m: number): string {
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m >= 60 && m % 60 === 0) return `${m / 60} h`;
  return `${m} min`;
}
