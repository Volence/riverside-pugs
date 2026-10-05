import type { DB } from '../db.js';
import { subscribeAdminEvents, type AdminEvent } from '../adminFeed.js';
import { getSetting } from '../settings.js';
import { feedChannel } from './feedRouting.js';
import { getPlayer } from '../players.js';
import { resolveAlias } from '../aliases.js';
import { activeTimeout } from '../penalties.js';
import { hasStaffFlag } from '../tickets/store.js';
import { discordLabel, escapeName, identityOf } from '../identity.js';
import type { BotInteraction, BotTransport, InteractionReply } from './transport.js';

const COLOR = { report: 0xde4e40, action: 0xc9a45c, penalty: 0x8a7f73, account: 0x45b39c, problem: 0xde4e40 };

/** "A", "A and B", or "A, B and C", for naming every matched player in one line. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

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

  /** Steam name and linked Discord side by side, bolded, so a line reads the
   *  same whether the admin recognises the game name or the voice channel. */
  private name(steamid: string): string {
    return discordLabel(identityOf(this.deps.db, steamid));
  }

  /** Where a named player's record lives. Every post that names somebody
   *  links here, so reading the feed and opening the file is one click
   *  rather than a search through the panel. */
  private file(steamid: string): string {
    return `${this.deps.publicUrl}/admin/people/${steamid}`;
  }

  private ticket(id: string | number): string {
    return `${this.deps.publicUrl}/admin/people/tickets/${id}`;
  }

  private async deliver(e: AdminEvent): Promise<void> {
    const channelId = feedChannel(this.deps.db, e);
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
        const link = `[#${e.ticketId}](${this.ticket(e.ticketId)})`;
        const who = e.targetId !== null ? this.name(e.targetId) : escapeName(e.targetName);
        const from = e.reporterId !== null ? this.name(e.reporterId) : escapeName(e.reporterName);
        return {
          text: e.created
            ? `🎫 New ticket ${link}: ${from} reported ${who} (${e.category}).`
            : `🎫 Another report on ticket ${link}: ${from} reported ${who} (${e.category}).`,
          color: COLOR.report,
        };
      }
      case 'appeal': {
        const link = `[#${e.appealId}](${this.deps.publicUrl}/admin/people/appeals/${e.appealId})`;
        // Like a report: with a staff forum, the appeal's own post is the
        // announcement. An automatic denial always posts: nobody else will.
        if (e.what === 'filed') {
          if (getSetting(this.deps.db, 'discord_tickets_forum_id')) return null;
          return { text: `📨 New appeal ${link} from ${escapeName(e.name)}.`, color: COLOR.report };
        }
        return { text: `📨 Appeal ${link} from ${escapeName(e.name)} was denied automatically: ${e.slurs.join(', ')}.`, color: COLOR.problem };
      }
      case 'admin_action': return { text: this.actionText(e), color: COLOR.action };
      case 'penalty': {
        const t = activeTimeout(this.deps.db, e.steamid);
        const what = e.penalty === 'no_show'
          ? `never connected to match${e.matchId ? ` [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})` : ''}`
          : 'missed a ready check';
        const minutes = t ? Math.round((t.until.getTime() - Date.now()) / 60_000) : 0;
        // The timeout is whichever ladder ends later, which need not be the
        // kind this line is about, so it says which one it is counting.
        const timeout = t
          ? ` · ${fmtMinutes(minutes)} queue timeout (${t.kind === 'no_show' ? 'no-show' : 'missed ready check'} ${t.offenses} in the window)`
          : '';
        return { text: `${this.name(e.steamid)} ${what}${timeout}`, color: COLOR.penalty };
      }
      case 'account':
        // this.name() already shows the Discord side once linked, so the line
        // does not also spell out e.discordName: that would say it twice.
        return {
          text: e.what === 'linked'
            ? `${this.name(e.steamid)} linked Discord`
            : `${this.name(e.steamid)} is now active`,
          color: COLOR.account,
        };
      case 'problem':
        return { text: `⚠️ ${e.text}${e.link ? ` [${e.link.label}](${this.deps.publicUrl}${e.link.path})` : ''}`, color: COLOR.problem };
      case 'abandon':
        return {
          text: `🚪 ${this.name(e.steamid)} abandoned match [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId}) (ran out of reconnect time). Match ended with no rating change; banned for ${fmtMinutes(e.minutes)}.`,
          color: COLOR.problem,
        };
      case 'clock': {
        // The board's own URL, with the card to scroll to. The old
        // /admin?live=N form still redirects here, for posts already sent.
        const board = `[live board](${this.deps.publicUrl}/admin/live?live=${e.matchId})`;
        const match = `match [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})`;
        return {
          text: e.what === 'low_allowance'
            ? `${this.name(e.steamid)} has ${e.remainingS} s left to reconnect in ${match}. Hold the clock or add time on the ${board}.`
            : `The hold on ${this.name(e.steamid)}'s reconnect clock in ${match} released itself at the ceiling: ${e.remainingS} s left and counting. ${board}`,
          color: COLOR.problem,
        };
      }
      case 'lilac_flag': {
        const match = e.matchId ? ` in match [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})` : '';
        // "suspected" is LilAC's own word for the soft case and it is the right
        // one: its docs say few and rare suspicions are likely false positives.
        return {
          text: e.banned
            ? `🛑 ${this.name(e.steamid)} was BANNED by Little Anti-Cheat for \`${e.cheat}\`${match}.`
            : `🎛️ ${this.name(e.steamid)} is suspected by Little Anti-Cheat of \`${e.cheat}\`${match}. Few and rare suspicions are usually false positives.`,
          color: COLOR.problem,
        };
      }
      case 'spray_exploit': {
        // Stated as fact: the file failed the VTF header check, which no real
        // spray does (all 89 on Dallas passed on 2026-10-02). It never
        // reached anyone else.
        const server = e.serverId === null ? null : (this.deps.db.prepare('SELECT name FROM servers WHERE id = ?')
          .get(e.serverId) as { name: string } | undefined)?.name ?? null;
        const where = [
          e.matchId ? `in match [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})` : '',
          server ? `on ${server}` : '',
        ].filter(Boolean).join(' ');
        return {
          text: `💣 ${this.name(e.steamid)} tried to use a crash spray${where ? ' ' + where : ''} (file \`${e.crc}\`). `
            + `The server blocked it and kicked them; nobody saw it. [File](${this.file(e.steamid)})`,
          color: COLOR.problem,
        };
      }
      case 'input_flag': {
        // Deliberately worded as something to look at, not as a verdict. The
        // signature is evidence from input timing, and the admin decides.
        const match = e.matchId ? ` in match [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})` : '';
        return {
          text: `🎛️ ${this.name(e.steamid)} tripped the \`${e.signature}\` input check${match} (${e.detail}). Worth a look at the replay.`,
          color: COLOR.problem,
        };
      }
      case 'cvar_flag': {
        // Worded by what the plugin did. With the ready gate on, a Low player
        // cannot ready, so `held` is the common case and nobody has played on
        // it; `live` means they switched after the round went live.
        const who = this.name(e.steamid);
        const match = `[#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})`;
        if (e.act === 'fixed') {
          return {
            text: `✅ ${who} changed Effect Detail off Low (\`${e.cvar} ${e.value}\`) and can ready up for match ${match}.`,
            color: COLOR.account,
          };
        }
        if (e.act === 'held') {
          return {
            text: `🔧 ${who} tried to ready up for match ${match} with Effect Detail on Low (\`${e.cvar} ${e.value}\`), `
              + 'which thins smoke and fire enough to see through. The server took the ready back and is holding ready-up until they change it.',
            color: COLOR.action,
          };
        }
        return {
          text: `🔧 ${who} is on Effect Detail Low (\`${e.cvar} ${e.value}\`) during live play in match ${match}, `
            + 'which thins smoke and fire enough to see through. Ready-up blocks it, so they switched after the round went live. Worth a word.',
          color: COLOR.problem,
        };
      }
      case 'conduct_flag': {
        // Quoted exactly, as inline code so Discord renders nothing inside it:
        // an admin judging a slur needs the letters the player typed.
        const quoted = '`' + e.text.replace(/`/g, "'").slice(0, 200) + '`';
        const server = e.serverId === null ? null : (this.deps.db.prepare('SELECT name FROM servers WHERE id = ?')
          .get(e.serverId) as { name: string } | undefined)?.name ?? null;
        const where = [
          e.matchId ? `in match [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})` : '',
          server ? `on ${server}` : '',
        ].filter(Boolean).join(' ');
        const what = e.slurs.join(', ');
        return {
          text: e.where === 'chat'
            ? `🗯️ ${this.name(e.steamid)} typed ${quoted} in chat${where ? ' ' + where : ''} (${what}). [File](${this.file(e.steamid)})`
            : `🏷️ ${this.name(e.steamid)} is using the name ${quoted}${where ? ' ' + where : ''} (${what}). [File](${this.file(e.steamid)})`,
          color: COLOR.problem,
        };
      }
      case 'steam_signal': {
        // Context, worded as context. A ban in some other game is not a ban
        // in this one, and a borrowed library is how siblings share a PC.
        const match = e.matchId ? ` in match [#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})` : '';
        const who = this.name(e.steamid);
        if (e.signal.what === 'recent_ban') {
          const s = e.signal;
          const parts = [
            s.vacBans ? `${s.vacBans} VAC ban${s.vacBans === 1 ? '' : 's'}` : '',
            s.gameBans ? `${s.gameBans} game ban${s.gameBans === 1 ? '' : 's'}` : '',
          ].filter(Boolean).join(' and ');
          const when = s.daysSinceLastBan === 0 ? 'today' : `${s.daysSinceLastBan} day${s.daysSinceLastBan === 1 ? '' : 's'} ago`;
          return {
            text: `🪪 ${who}${match} has ${parts} on their Steam account, the latest ${when}. Steam does not say which game, so this is context for their [file](${this.file(e.steamid)}), not a finding about this one.`,
            color: COLOR.problem,
          };
        }
        const lender = resolveAlias(this.deps.db, e.signal.lenderId);
        return {
          text: `🪪 ${who}${match} is playing on a copy of the game borrowed through Steam Family Sharing from ${this.name(lender)} (\`${e.signal.lenderId}\`), who is banned here. Could be a shared household; worth a look.`,
          color: COLOR.problem,
        };
      }
      case 'sourcetv_watch': {
        // Worded as a connection match, never as an identity claim: a shared
        // household or a LAN cafe looks exactly like one person spectating
        // their own game. One post names every matched player rather than
        // one post each, since it is the connection that is shared.
        const match = `[#${e.matchId}](${this.deps.publicUrl}/match/${e.matchId})`;
        const who = joinNames(e.steamids.map((id) => this.name(id)));
        const verb = e.steamids.length > 1 ? 'are' : 'is';
        return {
          text: `📡 SourceTV spectator **${escapeName(e.spectatorName)}** is on the same connection as `
            + `${who}, who ${verb} playing match ${match}. Same connection is evidence, not proof.`,
          color: COLOR.problem,
        };
      }
      case 'staff_message': {
        // Not a ping: /mod is the urgent route. A link straight to that
        // server's chat, where a whisper answers them.
        const server = this.deps.db.prepare('SELECT name FROM servers WHERE id = ?').get(e.serverId) as { name: string } | undefined;
        return {
          text: `💬 ${this.name(e.steamid)} messaged staff on ${escapeName(server?.name ?? 'a server')}: "${escapeName(e.text)}". `
            + `[Answer in Server chat](${this.deps.publicUrl}/admin/live?chat=${e.serverId})`,
          color: COLOR.account,
        };
      }
      case 'alt': {
        const desk = `${this.deps.publicUrl}/admin/people/alts`;
        const discord = `**${escapeName(e.discordName)}**`;
        if (e.what === 'discord_swap') {
          return {
            text: `🔁 ${this.name(e.steamid)} swapped Discord accounts, from **${escapeName(e.previousDiscordName ?? 'unknown')}** to ${discord}. `
              + `Reported only, nothing was held. [File](${this.file(e.steamid)}) · [Alts](${desk})`,
            color: COLOR.account,
          };
        }
        const other = e.otherSteamid!;
        const moved = `Discord ${discord} moved to ${this.name(e.steamid)} from ${this.name(other)} ([file](${this.file(other)}))`;
        return e.what === 'hold'
          ? {
            text: `🔒 ${moved}. The new account is **on hold** and cannot queue or play until a moderator lifts it. [Review on Alts](${desk})`,
            color: COLOR.problem,
          }
          : {
            text: `🔒 ${moved}. No hold was placed (this pair was cleared before, or the account is staff). [Alts](${desk})`,
            color: COLOR.problem,
          };
      }
      case 'rename_digest': {
        // One embed for the day. Discord caps a description at 4096
        // characters, so the lines stop short of that and the rest are
        // counted; a busy day is rare and every chain is on the player file.
        const lines: string[] = [];
        let length = 0;
        let left = e.players.length;
        for (const p of e.players) {
          const chain = p.chain.map((n) => `\`${n.replace(/`/g, "'")}\``).join(' -> ');
          const line = `${this.name(p.steamid)}: ${p.earlier > 0 ? `(${p.earlier} earlier) ` : ''}${chain} [File](${this.file(p.steamid)})`;
          if (length + line.length > 3600) break;
          lines.push(line);
          length += line.length + 1;
          left -= 1;
        }
        if (left > 0) lines.push(`and ${left} more.`);
        return { text: `🏷️ New names played under since the last digest:\n${lines.join('\n')}`, color: COLOR.account };
      }
      case 'signon_drop': {
        // Known players get the full identity (both worlds); an unknown
        // steamid has never signed in and has no account to look up, so an
        // admin searching the server log instead needs the name the player
        // was actually using on screen.
        const known = getPlayer(this.deps.db, e.steamid);
        const id = known ? `[${e.steamid}](${this.file(e.steamid)})` : `\`${e.steamid}\``;
        const who = known ? this.name(e.steamid) : `**${escapeName(e.name)}**`;
        const dropped = `${who} (${id}) dropped while connecting ${e.count} times in ten minutes without getting in (${e.total} on record)`;
        // On a custom campaign the consistency list is the unlikely cause: the
        // client drops itself on the server's first message, before that
        // check runs, when its copy of the campaign is missing, stale, or was
        // added without restarting the game ("Your string table differs").
        const why = e.campaign
          ? ` during a match on **${escapeName(e.campaign.name)}**, a custom campaign: likely a missing or out of date copy of it, or a game not restarted after installing it (their screen usually says "Your string table differs from the server's"). The download is on [Custom campaigns](${this.deps.publicUrl}/custom-campaigns).`
          : ': likely rejected for a modified game file; the file name was shown on their screen.';
        return {
          text: `${dropped}${why} A cancelled loading screen looks the same, so this is a hint, not proof.`,
          color: COLOR.problem,
        };
      }
    }
  }

  /** A team's current name, by id (admin_actions.target), for feed lines. */
  private teamName(id: string): string {
    const row = this.deps.db.prepare('SELECT name FROM teams WHERE id = ?').get(Number(id)) as { name: string } | undefined;
    return row?.name ?? `team ${id}`;
  }

  private actionText(e: Extract<AdminEvent, { kind: 'admin_action' }>): string {
    const who = this.name(e.adminId);
    const target = this.name(e.target);
    const d = e.detail;
    const match = `[#${e.target}](${this.deps.publicUrl}/match/${e.target})`;
    switch (e.action) {
      case 'ban': return `${who} banned ${target}: ${escapeName(String(d.reason ?? ''))} (${d.minutes ? fmtMinutes(Number(d.minutes)) : 'permanent'})`;
      case 'unban': return `${who} unbanned ${target}`;
      case 'alt_lift': return `${who} lifted the alt hold on ${target}`;
      case 'alt_ban': return `${who} turned the alt hold on ${target} into a ban: ${escapeName(String(d.reason ?? ''))}`;
      case 'activate': return `${who} activated ${target}`;
      case 'set_admin': return `${who} ${d.isAdmin ? 'made' : 'removed'} ${target} ${d.isAdmin ? 'an admin' : 'as admin'}`;
      case 'set_mod': return `${who} ${d.isMod ? 'made' : 'removed'} ${target} ${d.isMod ? 'a moderator' : 'as moderator'}`;
      case 'set_caster': return `${who} ${d.isCaster ? 'made' : 'removed'} ${target} ${d.isCaster ? 'a caster' : 'as caster'}`;
      case 'unlink_discord': return `${who} unlinked ${target}'s Discord`;
      case 'note': {
        // The note's own words, quoted, so the channel shows what was written
        // rather than that something was. Not for a note about a member of
        // staff: they may well read this channel, and a note about them is
        // for the people who can open their file.
        const words = typeof d.text === 'string' ? d.text.trim() : '';
        if (!words || hasStaffFlag(this.deps.db, e.target)) return `${who} added a note on ${target}`;
        const clipped = words.length > 1500 ? `${words.slice(0, 1500)}...` : words;
        return `${who} added a note on ${target}:\n${clipped.split('\n').map((l) => `> ${escapeName(l)}`).join('\n')}`;
      }
      case 'clear_penalties': return `${who} cleared ${target}'s penalties`;
      case 'abort_match': return `${who} aborted match ${match}${Array.isArray(d.leftOut) && d.leftOut.length ? `, left out of the queue: ${d.leftOut.map((s) => this.name(String(s))).join(', ')}` : ''}`;
      case 'clear_noshows': return `${who} cleared the ${String(d.cleared)} no-show penalties from match ${match}`;
      case 'clear_penalty': return `${who} cleared one of ${target}'s penalties`;
      case 'noshow_extend': return `${who} moved match ${match}'s no-show deadline to ${String(d.extraMinutes)} minutes later than usual`;
      case 'cancel_pop': return `${who} cancelled a pop: ${String(d.requeued)} back in the queue${Array.isArray(d.excluded) && d.excluded.length ? `, left out ${d.excluded.map((s) => this.name(String(s))).join(', ')}` : ''}`;
      case 'void_match': return `${who} voided match ${match}: ${escapeName(String(d.reason ?? ''))}. Season ratings were recomputed.`;
      case 'new_season': return `${who} started a new season: **${escapeName(String(d.name ?? ''))}**. Everyone's rating starts fresh.`;
      case 'rename_season': return `${who} renamed season ${e.target} to **${escapeName(String(d.name ?? ''))}**`;
      case 'server_idle': return `${who} set server ${e.target} idle`;
      case 'server_move': return `${who} moved server ${e.target} ${d.dir === 'up' ? 'up' : 'down'} the pick order`;
      case 'server_restart_after_match':
        return `${who} turned ${d.on ? 'on' : 'off'} restart-after-match for server ${e.target}`;
      case 'server_log_secret':
        return `${who} ${d.rotated ? 'rotated' : 'pushed'} the log secret for server ${e.target}${d.pushed ? '' : ' (it did NOT reach the box)'}`;
      case 'server_log_auth': return `${who} set log signing on server ${e.target} to \`${String(d.mode)}\``;
      case 'queue_remove': return `${who} removed ${target} from the queue`;
      case 'practice_kick': {
        const where = d.kind === 'drill' ? 'a drill server' : d.kind === 'hunter' ? 'a Hunter Training server' : 'the Practice Park';
        const why = d.reason && d.reason !== 'Removed by an admin' ? `: ${escapeName(String(d.reason))}` : '';
        return `${who} kicked ${escapeName(String(d.name ?? target))} from ${where} on ${escapeName(String(d.server ?? ''))}${why}`;
      }
      case 'team_captain': case 'team_rename': case 'team_logo': case 'team_disband': {
        // target is the team id; detail.slug links the page, which outlives a disband.
        const page = `${this.deps.publicUrl}/team/${encodeURIComponent(String(d.slug ?? ''))}`;
        const named = (name: unknown, tag?: unknown) =>
          `**${tag !== undefined ? `[${escapeName(String(tag))}] ` : ''}${escapeName(String(name ?? ''))}**`;
        switch (e.action) {
          case 'team_captain': return `${who} made ${this.name(String(d.to ?? ''))} captain of [${named(this.teamName(e.target))}](${page})`;
          case 'team_rename': {
            const from = (d.from ?? {}) as { name?: unknown; tag?: unknown };
            const to = (d.to ?? {}) as { name?: unknown; tag?: unknown };
            return `${who} renamed ${named(from.name, from.tag)} to [${named(to.name, to.tag)}](${page})`;
          }
          case 'team_logo': return `${who} changed the logo of [${named(this.teamName(e.target))}](${page})`;
          default: return `${who} disbanded [${named(d.name ?? this.teamName(e.target))}](${page})`;
        }
      }
      case 'setting': return 'from' in d
        ? `${who} changed the ${e.target} setting from \`${String(d.from)}\` to \`${String(d.to)}\``
        : `${who} changed the ${e.target} setting`;
      case 'leave_clock': {
        const where = `match [#${String(d.matchId)}](${this.deps.publicUrl}/match/${String(d.matchId)})`;
        if (d.ok === false) {
          return `${who} tried to ${String(d.action)} ${target}'s reconnect clock in ${where}, and it failed: ${escapeName(String(d.error ?? ''))}`;
        }
        switch (d.action) {
          case 'hold': return `${who} put ${target}'s reconnect clock on hold in ${where}`;
          case 'release': return `${who} released the hold on ${target}'s reconnect clock in ${where}`;
          case 'add': return `${who} gave ${target} ${String(d.seconds)} more seconds to reconnect in ${where}`;
          default: return `${who} ended ${target}'s reconnect time in ${where}`;
        }
      }
      case 'appeal_ask': case 'appeal_accept': case 'appeal_shorten': case 'appeal_deny':
      case 'appeal_final': case 'appeal_unfinal': {
        const appealId = Number(d.appealId ?? e.target);
        const link = `[#${appealId}](${this.deps.publicUrl}/admin/people/appeals/${appealId})`;
        switch (e.action) {
          case 'appeal_ask': return `${who} asked a question on appeal ${link}`;
          case 'appeal_accept': return `${who} accepted appeal ${link}`;
          case 'appeal_shorten': return `${who} shortened appeal ${link}`;
          case 'appeal_deny': return `${who} denied appeal ${link}`;
          case 'appeal_final': return `${who} marked the ban on appeal ${link} final`;
          default: return `${who} allowed appeals again on appeal ${link}`;
        }
      }
      case 'ticket_open': case 'ticket_claim': case 'ticket_restrict': case 'ticket_access':
      case 'ticket_close': case 'ticket_reopen': case 'ticket_ban': case 'ticket_remove':
      case 'ticket_discord_sanction': case 'ticket_discord_sanction_lift':
      case 'ticket_contact': case 'ticket_chat_join': case 'ticket_chat_end': {
        const ticket = `ticket [#${e.target}](${this.ticket(e.target)})`;
        switch (e.action) {
          case 'ticket_open': return `${who} opened ${ticket}`;
          case 'ticket_claim': return `${who} ${d.claim === false ? 'released' : 'claimed'} ${ticket}${d.via === 'discord' ? ' from Discord' : ''}`;
          case 'ticket_close': return `${who} closed ${ticket}: ${String(d.outcome ?? '').replace(/_/g, ' ')}${d.via === 'discord' ? ' from Discord' : ''}`;
          case 'ticket_reopen': return `${who} reopened ${ticket}`;
          case 'ticket_ban': return `${who} banned from ${ticket}: ${escapeName(String(d.reason ?? ''))} (${d.minutes ? fmtMinutes(Number(d.minutes)) : 'permanent'})`;
          // Never what was removed, and never for a restricted ticket: that
          // removal is logged quiet and never reaches here.
          case 'ticket_remove': return `${who} removed a message from ${ticket}${d.via === 'discord' ? ' from Discord' : ''}`;
          // Neither the reason nor the Discord id: those go with the ticket
          // itself (and a restricted one logs this quiet anyway), same as
          // ticket_ban leaves the reason out for a player, ticket_remove for
          // a message.
          case 'ticket_discord_sanction':
            return `${who} ${d.kind === 'ban' ? 'banned' : 'timed out'} the Discord member on ${ticket}${d.minutes ? ` (${fmtMinutes(Number(d.minutes))})` : ''}`;
          case 'ticket_discord_sanction_lift':
            return `${who} lifted a Discord ${d.kind === 'ban' ? 'ban' : 'timeout'} on ${ticket}`;
          case 'ticket_contact': return `${who} opened a chat with a reporter on ${ticket}${d.via === 'discord' ? ' from Discord' : ''}`;
          case 'ticket_chat_join': return `${who} joined the reporter chat on ${ticket}${d.via === 'discord' ? ' from Discord' : ''}`;
          case 'ticket_chat_end': return `${who} ended a reporter chat on ${ticket}${d.via === 'discord' ? ' from Discord' : ''}`;
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
      payload: { content: `Reports are tickets now. Open ${this.deps.publicUrl}/admin/people/tickets.`, embeds: [], components: [], mentionUserIds: [] },
    };
  }
}

function fmtMinutes(m: number): string {
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m >= 60 && m % 60 === 0) return `${m / 60} h`;
  return `${m} min`;
}
