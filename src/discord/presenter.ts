import type { ActionRow, Button, Embed, MessagePayload } from './transport.js';
import { ENDORSE_KINDS, ENDORSE_LABEL, type EndorseKind } from '../endorsements.js';

/**
 * Pure renderers: state in, Discord message payload out.
 *
 * Nothing here reads the database or talks to Discord, so every message the
 * bot can post is covered by a unit test. sync.ts builds the views.
 */

const COLOR = {
  accent: 0xb3261e, // the site's red rule
  gold: 0xc9a45c,
  win: 0x45b39c,
  muted: 0x4a4540,
};

export interface PlayerView {
  name: string;
  discordId: string | null;
  sr: number | null;
}

// Square brackets are in here too: without them, a name that is itself a
// markdown link, [x](http://evil.example), renders as a live, attacker-chosen
// link wherever a "plain" name is shown in an embed. A backslash-escaped
// bracket still renders as a bracket, so nothing visible changes.
const MARKDOWN = /([\\*_~`|>[\]])/g;

/** A plain name with Discord markdown neutralised, so "b*o_b" is not italic
 *  and "[x](evil)" is not a link. */
export function escapeName(name: string): string {
  return name.replace(MARKDOWN, '\\$1');
}

/** Mention when linked (Discord shows their server nickname), else the Steam
 *  name. SR in brackets when the player has one. */
export function playerLabel(p: PlayerView): string {
  const who = p.discordId ? `<@${p.discordId}>` : escapeName(p.name);
  return p.sr === null ? who : `${who} (${p.sr})`;
}

const link = (url: string, label: string): Button => ({ kind: 'link', url, label });

// ---------- queue panel ----------

export interface PanelView {
  publicUrl: string;
  size: number;
  players: PlayerView[];
  /** A lobby is running, so the panel can say a game is being set up. */
  phase: 'ready_check' | 'map_vote' | 'done' | 'failed' | null;
  /** The opt-in alert role, when one is configured. Drives whether the panel
   *  offers a Notify me toggle at all. */
  alertRoleId?: string;
}

export function renderPanel(v: PanelView): MessagePayload {
  const lines = v.players.length
    ? v.players.map((p, i) => `\`${String(i + 1).padStart(2, ' ')}\` ${playerLabel(p)}`).join('\n')
    : '_The queue is empty. Be the first in._';
  const status = v.phase === 'ready_check'
    ? '\nA queue just popped: ready check in progress.'
    : v.phase === 'map_vote'
      ? '\nA queue just popped: campaign vote in progress.'
      : '';
  const embed: Embed = {
    title: 'Riverside PUG Queue',
    url: `${v.publicUrl}/`,
    color: COLOR.accent,
    description: `**${v.players.length}/${v.size}** in queue${status}\n\n${lines}`,
    footer: 'Ranked 4v4 Left 4 Dead. Queue here or on the website, it is the same queue.',
  };
  return {
    embeds: [embed],
    components: [[
      { kind: 'button', customId: 'q:join', label: 'Join Queue', style: 'success' },
      { kind: 'button', customId: 'q:leave', label: 'Leave Queue', style: 'danger' },
      // Only when an alert role is configured. Offering a toggle that silently
      // does nothing is worse than not offering it.
      ...(v.alertRoleId
        ? [{ kind: 'button' as const, customId: 'q:notify', label: 'Notify me', style: 'secondary' as const }]
        : []),
      link(`${v.publicUrl}/`, 'Website'),
      link(`${v.publicUrl}/leaderboard`, 'Leaderboard'),
    ]],
    mentionUserIds: [],
  };
}

/**
 * The "queue is filling up" announcement.
 *
 * This is the whole cold-start mechanism. A PUG queue that nobody can see does
 * not fill: people will not sit at 6/8 waiting on the off chance, so somebody
 * has to be told. The panel cannot do it, because it is edited in place and an
 * edit never notifies anyone.
 *
 * Pings a role people opt into rather than @here, so it reaches exactly the
 * people who want to be pulled into a game and nobody who is just chatting.
 * That distinction is what makes it survivable to fire several times an
 * evening; an @here at 6/8 twice a night gets the bot muted.
 */
export interface QueueAlertView {
  count: number;
  size: number;
  roleId: string;
  publicUrl: string;
}

export function renderQueueAlert(v: QueueAlertView): MessagePayload {
  const need = Math.max(0, v.size - v.count);
  return {
    content: `<@&${v.roleId}> **${v.count}/${v.size}** in the queue`
      + (need === 1 ? ', one more and it pops.' : `, ${need} more needed.`),
    embeds: [],
    components: [[
      { kind: 'button', customId: 'q:join', label: 'Join Queue', style: 'success' },
      link(`${v.publicUrl}/`, 'Website'),
    ]],
    // The role is the only thing this message may ping. Nothing else in it is
    // user-controlled text, but the allowlist stays explicit either way.
    mentionUserIds: [],
    mentionRoleIds: [v.roleId],
  };
}

// ---------- lobby (ready check, vote) ----------

export interface LobbyView {
  lobbyId: string;
  phase: 'ready_check' | 'map_vote';
  deadlineMs: number;
  /** `blocked`: they may not press Ready yet (not in voice, or no Discord
   *  linked), shown with a muted marker so the team can see who to chase. */
  players: (PlayerView & { ready: boolean; blocked?: boolean })[];
  options: { campaign: string; name: string; votes: number }[];
  /** Whether the voice requirement is on, which changes the footer. */
  voiceRequired?: boolean;
}

const pings = (players: PlayerView[]) => players.filter((p) => p.discordId).map((p) => p.discordId!);

export function renderLobby(v: LobbyView): MessagePayload {
  const deadline = `<t:${Math.floor(v.deadlineMs / 1000)}:R>`;
  const readyCount = v.players.filter((p) => p.ready).length;
  const roster = v.players.map((p) => `${p.ready ? '✅' : '⬜'} ${p.blocked ? '🔇 ' : ''}${playerLabel(p)}`).join('\n');
  const mentions = pings(v.players);

  if (v.phase === 'ready_check') {
    const footer = v.voiceRequired
      ? 'Join a voice channel on this server to ready up (🔇 is not in one yet). Anyone not ready in time goes back out; everyone who readied keeps their place at the front.'
      : 'Anyone not ready in time goes back out; everyone who readied keeps their place at the front.';
    return {
      content: mentions.length ? mentions.map((id) => `<@${id}>`).join(' ') : undefined,
      embeds: [{
        title: 'Queue popped! Ready up',
        color: COLOR.gold,
        description: `Ready check ends ${deadline}. **${readyCount}/${v.players.length}** ready.\n\n${roster}`,
        footer,
      }],
      components: [[{ kind: 'button', customId: `l:${v.lobbyId}:ready`, label: 'Ready', style: 'success' }]],
      mentionUserIds: mentions,
    };
  }

  const votes = v.options.map((o) => `**${o.name}**: ${o.votes}`).join('  ·  ');
  const rows: ActionRow[] = [];
  for (let i = 0; i < v.options.length && rows.length < 5; i += 5) {
    rows.push(v.options.slice(i, i + 5).map((o) => ({
      kind: 'button' as const,
      customId: `l:${v.lobbyId}:vote:${o.campaign}`,
      label: `${o.name} (${o.votes})`,
      style: 'primary' as const,
    })));
  }
  return {
    content: mentions.length ? mentions.map((id) => `<@${id}>`).join(' ') : undefined,
    embeds: [{
      title: 'Everyone is ready. Vote a campaign',
      color: COLOR.gold,
      description: `Vote ends ${deadline}.\n${votes}\n\n${v.players.map((p) => playerLabel(p)).join('\n')}`,
    }],
    components: rows,
    // Already pinged at the ready check; edits never re-ping anyway.
    mentionUserIds: [],
  };
}

export function renderLobbyFailed(v: { ready: PlayerView[]; notReady: PlayerView[] }): MessagePayload {
  const missing = v.notReady.map((p) => playerLabel(p)).join(', ') || 'nobody';
  return {
    embeds: [{
      title: 'Ready check failed',
      color: COLOR.muted,
      description: `Not ready: ${missing}.\n${v.ready.length} ready player${v.ready.length === 1 ? '' : 's'} went back to the front of the queue.`,
    }],
    components: [],
    mentionUserIds: [],
  };
}

export function renderCancelled(): MessagePayload {
  return {
    embeds: [{
      title: 'Lobby cancelled',
      color: COLOR.muted,
      description: 'The site restarted while this lobby was open, so it was dropped. Queue again from the panel.',
    }],
    components: [],
    mentionUserIds: [],
  };
}

// ---------- match card ----------

export type MatchCardState = 'configuring' | 'waiting' | 'live' | 'finished' | 'aborted';

export interface MatchView {
  matchId: number;
  campaignName: string;
  publicUrl: string;
  state: MatchCardState;
  teamA: PlayerView[];
  teamB: PlayerView[];
  voice: { teamAId: string; teamBId: string } | null;
  /** Names of rostered players with no linked Discord, who cannot be moved. */
  unlinked: string[];
  /** True when the match's server has SourceTV, so anyone can watch it. */
  canSpectate?: boolean;
}

const STATE_LINE: Record<MatchCardState, string> = {
  configuring: 'Setting up the server...',
  waiting: 'Waiting for a server to free up. You will be pinged here when it is ready.',
  live: 'Server is ready. Press **Connect** for the address and password.',
  finished: 'Finished. The result is posted below.',
  aborted: 'Match aborted. No result, no rating change. The roster and how far it got are on the match page.',
};

export function renderMatch(v: MatchView): MessagePayload {
  const team = (players: PlayerView[]) => players.map((p) => playerLabel(p)).join('\n') || '_nobody_';
  const extra: string[] = [];
  if (v.voice && (v.state === 'configuring' || v.state === 'waiting' || v.state === 'live')) {
    extra.push(`Voice: Team A <#${v.voice.teamAId}>, Team B <#${v.voice.teamBId}>`);
    if (v.unlinked.length) {
      extra.push(`Discord not linked, so not moved: ${v.unlinked.map(escapeName).join(', ')}`);
    }
  }
  const open = v.state === 'configuring' || v.state === 'waiting' || v.state === 'live';
  const row: Button[] = [];
  if (v.state === 'live') row.push({ kind: 'button', customId: `m:${v.matchId}:connect`, label: 'Connect', style: 'success' });
  if (v.state === 'live' && v.canSpectate) {
    row.push({ kind: 'button', customId: `m:${v.matchId}:spectate`, label: 'Watch', style: 'secondary' });
  }
  row.push(link(`${v.publicUrl}/match/${v.matchId}`, 'Match page'));
  return {
    embeds: [{
      title: `Riverside PUG #${v.matchId}: ${v.campaignName}`,
      url: `${v.publicUrl}/match/${v.matchId}`,
      color: v.state === 'aborted' || v.state === 'finished' ? COLOR.muted : open ? COLOR.accent : COLOR.muted,
      description: [STATE_LINE[v.state], ...extra].join('\n'),
      fields: [
        { name: 'Team A', value: team(v.teamA), inline: true },
        { name: 'Team B', value: team(v.teamB), inline: true },
      ],
    }],
    components: [row],
    mentionUserIds: [],
  };
}

// ---------- result ----------

export interface ResultPlayer extends PlayerView {
  srBefore: number | null;
  srAfter: number | null;
}

export interface ResultView {
  matchId: number;
  campaignName: string;
  publicUrl: string;
  scoreA: number;
  scoreB: number;
  winner: 'a' | 'b' | 'draw';
  teamA: ResultPlayer[];
  teamB: ResultPlayer[];
}

function srChange(p: ResultPlayer): string {
  const who = p.discordId ? `<@${p.discordId}>` : escapeName(p.name);
  if (p.srBefore === null || p.srAfter === null) return `${who} (not rated)`;
  const d = p.srAfter - p.srBefore;
  return `${who} ${p.srAfter} (${d >= 0 ? '+' : ''}${d})`;
}

export function renderResult(v: ResultView): MessagePayload {
  const headline = v.winner === 'draw' ? 'Draw' : `Team ${v.winner.toUpperCase()} wins`;
  return {
    embeds: [{
      title: `PUG #${v.matchId} result: ${v.campaignName}`,
      url: `${v.publicUrl}/match/${v.matchId}`,
      color: COLOR.win,
      description: `**${headline}**, ${v.scoreA} to ${v.scoreB}`,
      fields: [
        { name: `Team A · ${v.scoreA}`, value: v.teamA.map(srChange).join('\n') || '_nobody_', inline: true },
        { name: `Team B · ${v.scoreB}`, value: v.teamB.map(srChange).join('\n') || '_nobody_', inline: true },
      ],
    }],
    // Endorse rides the card the bot already posts, and everything after the
    // click is ephemeral. No DM, nothing added to the channel: a player who
    // never clicks it is never contacted about it.
    components: [[
      link(`${v.publicUrl}/match/${v.matchId}`, 'Match page'),
      { kind: 'button', customId: `m:${v.matchId}:endorse`, label: 'Endorse', style: 'secondary' },
    ]],
    mentionUserIds: [],
  };
}

// ---------- endorsements (ephemeral) ----------

export interface EndorsePickerView {
  matchId: number;
  budget: number;
  remaining: number;
  /** What just happened, shown above the prompt. Already safe to print. */
  notice?: string;
  candidates: { steamid: string; name: string; given: EndorseKind | null }[];
}

/** Discord refuses a button label over 80 characters. */
const LABEL_MAX = 80;

/**
 * The seven other players as buttons. Seven is two rows, well inside
 * Discord's five by five, so this needs no new component type.
 *
 * Button labels are plain text, not markdown, so names are not escaped here.
 */
export function renderEndorsePicker(v: EndorsePickerView): MessagePayload {
  const head = v.remaining > 0
    ? `**Endorse players from PUG #${v.matchId}.** ${v.remaining} of ${v.budget} left. It is anonymous: nobody is told who endorsed them.`
    : `You have given all your endorsements for PUG #${v.matchId}. Thanks.`;
  const rows: ActionRow[] = [];
  for (let i = 0; i < v.candidates.length && rows.length < 5; i += 5) {
    rows.push(v.candidates.slice(i, i + 5).map((c) => ({
      kind: 'button' as const,
      customId: `e:${v.matchId}:p:${c.steamid}`,
      label: (c.given ? `${c.name || c.steamid}: ${ENDORSE_LABEL[c.given]}` : (c.name || c.steamid)).slice(0, LABEL_MAX),
      style: c.given ? 'success' as const : 'secondary' as const,
      disabled: c.given !== null || v.remaining <= 0,
    })));
  }
  return {
    content: v.notice ? `${v.notice}\n${head}` : head,
    embeds: [],
    components: rows,
    mentionUserIds: [],
  };
}

/** Step two: which kind. There is no negative option, by design. */
export function renderEndorseKinds(v: { matchId: number; steamid: string; name: string }): MessagePayload {
  return {
    content: `Endorse **${escapeName(v.name)}** for:`,
    embeds: [],
    components: [[
      ...ENDORSE_KINDS.map((k) => ({
        kind: 'button' as const, customId: `e:${v.matchId}:k:${v.steamid}:${k}`, label: ENDORSE_LABEL[k], style: 'primary' as const,
      })),
      { kind: 'button' as const, customId: `m:${v.matchId}:endorse`, label: 'Back', style: 'secondary' as const },
    ]],
    mentionUserIds: [],
  };
}
