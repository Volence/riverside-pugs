import type { DB } from '../db.js';
import { FEED_SETTING, subscribeAdminEvents, type AdminEvent } from '../adminFeed.js';
import { getSetting } from '../settings.js';
import { getPlayer, playerByDiscordId } from '../players.js';
import { getReport, resolveReport } from '../reports.js';
import { activeTimeout } from '../penalties.js';
import { logAdmin } from '../admin/audit.js';
import { campaignDisplayName } from '../campaignRegistry.js';
import { escapeName } from './presenter.js';
import { getMessage, saveMessage } from './messageStore.js';
import type { BotInteraction, BotTransport, InteractionReply, MessagePayload } from './transport.js';

const COLOR = { report: 0xde4e40, action: 0xc9a45c, penalty: 0x8a7f73, account: 0x45b39c, problem: 0xde4e40 };

/**
 * Posts the admin feed to the private admin channel.
 *
 * Reports get a card with Resolve / Dismiss buttons, and that card is edited
 * in place whenever the report is settled, from Discord or from the website,
 * so the channel never carries a stale open report. Everything else is one
 * short line per event. Posts go out one at a time so the channel keeps event
 * order.
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
    // A settled report edits its card whatever the toggles say: the card is
    // already in the channel and must not be left showing buttons.
    if (e.kind === 'admin_action' && e.action === 'resolve_report') {
      await this.refreshReport(Number(e.target));
      return;
    }
    const channelId = this.channel(e.kind);
    if (!channelId) return;
    if (e.kind === 'report') {
      const payload = this.reportCard(e.reportId);
      if (!payload) return;
      const messageId = await this.deps.transport.send(channelId, payload);
      saveMessage(this.deps.db, { kind: 'report', ref: String(e.reportId), channelId, messageId });
      return;
    }
    const line = this.line(e);
    if (!line) return;
    await this.deps.transport.send(channelId, {
      embeds: [{ description: line.text, color: line.color }], components: [], mentionUserIds: [],
    });
  }

  private reportCard(id: number): MessagePayload | null {
    const r = getReport(this.deps.db, id);
    if (!r) return null;
    const match = `[#${r.matchId}${r.campaign ? ` ${campaignDisplayName(this.deps.db, r.campaign)}` : ''}](${this.deps.publicUrl}/match/${r.matchId})`;
    const lines = [
      `**${escapeName(r.targetName ?? r.targetId)}** reported for **${r.category}** by ${escapeName(r.reporterName ?? r.reporterId)} in ${match}`,
    ];
    if (r.text) lines.push(`> ${escapeName(r.text).replace(/\n/g, '\n> ')}`);
    if (r.status !== 'open') {
      lines.push(`**${r.status === 'resolved' ? 'Resolved' : 'Dismissed'}** by ${this.name(r.resolvedBy ?? '')}${r.resolutionNote ? `: ${escapeName(r.resolutionNote)}` : ''}`);
    }
    return {
      embeds: [{ title: `Report #${r.id}`, url: `${this.deps.publicUrl}/admin`, description: lines.join('\n'), color: r.status === 'open' ? COLOR.report : 0x4a4540 }],
      components: r.status === 'open'
        ? [[
          { kind: 'button', customId: `r:${r.id}:resolve`, label: 'Resolve', style: 'success' },
          { kind: 'button', customId: `r:${r.id}:dismiss`, label: 'Dismiss', style: 'secondary' },
          { kind: 'link', url: `${this.deps.publicUrl}/admin`, label: 'Admin panel' },
        ]]
        : [],
      mentionUserIds: [],
    };
  }

  private async refreshReport(id: number): Promise<void> {
    const stored = getMessage(this.deps.db, 'report', String(id));
    const payload = this.reportCard(id);
    if (!stored || !payload) return;
    await this.deps.transport.edit(stored.channel_id, stored.message_id, payload);
  }

  private line(e: Exclude<AdminEvent, { kind: 'report' }>): { text: string; color: number } | null {
    switch (e.kind) {
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
      default: return `${who} ${e.action.replace(/_/g, ' ')} ${e.target}`;
    }
  }

  /** Resolve / Dismiss from the report card. Admins only. */
  async handleButton(i: Extract<BotInteraction, { kind: 'button' }>): Promise<InteractionReply> {
    const say = (content: string): InteractionReply => ({ ephemeral: true, payload: { content, embeds: [], components: [], mentionUserIds: [] } });
    const [, idRaw, action] = i.customId.split(':');
    const admin = playerByDiscordId(this.deps.db, i.userId);
    if (!admin || admin.is_admin !== 1 || admin.status !== 'active') return say('Admins only.');
    const id = Number(idRaw);
    const report = getReport(this.deps.db, id);
    if (!report) return say('That report no longer exists.');
    if (report.status !== 'open') return say(`Already ${report.status}.`);
    const status = action === 'dismiss' ? 'dismissed' : 'resolved';
    resolveReport(this.deps.db, id, admin.steamid, status, '');
    logAdmin(this.deps.db, admin.steamid, 'resolve_report', id, { status, note: '', via: 'discord' });
    return say(`Report #${id} ${status}. Add a note in the admin panel if you want one on record.`);
  }
}

function fmtMinutes(m: number): string {
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m >= 60 && m % 60 === 0) return `${m / 60} h`;
  return `${m} min`;
}
