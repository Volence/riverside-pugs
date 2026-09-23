import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { QUEUE_SIZE } from '../queue.js';
import { campaignDisplayName } from '../campaignRegistry.js';
import { playerByDiscordId } from '../players.js';
import { statDef } from '../statKeys.js';
import { leaderboardData, profileData } from '../playerQueries.js';
import { fileReport, latestSharedMatch, REPORT_CATEGORIES, type ReportCategory, type DiscordReporter } from '../tickets/filing.js';
import { linkPrompt, resolve } from './controller.js';
import { escapeName } from './presenter.js';
import { chatButton } from './ticketCard.js';
import { identityOf, plainLabelEscaped, type Identity } from '../identity.js';
import type { BotInteraction, InteractionReply, MessagePayload, SlashCommandDef } from './transport.js';

export interface CommandDeps {
  db: DB;
  matchmaker: Matchmaker;
  publicUrl: string;
  /** The ban explanation (reason, expiry), as the button controller has it. */
  banMessage?: (steamid: string) => string;
  adminSteamIds?: string[];
}

/** Labels for the report categories, in the order they should list. */
export const REPORT_LABELS: Record<ReportCategory, string> = {
  griefing: 'Griefing / throwing',
  cheating: 'Cheating',
  toxicity: 'Toxicity / harassment',
  afk: 'AFK / left the game',
  unsafe: 'Safety concern (handled privately)',
  other: 'Something else',
};

export const COMMAND_DEFS: SlashCommandDef[] = [
  {
    name: 'profile',
    description: 'SR, record, per-match stats and recent matches',
    options: [{ name: 'user', description: 'Whose profile (default: yours)', type: 'user' }],
  },
  { name: 'leaderboard', description: 'Top 10 ranked players this season' },
  {
    name: 'matches',
    description: 'Recent matches, overall or for one player',
    options: [{ name: 'user', description: 'Only matches this player played', type: 'user' }],
  },
  { name: 'queue', description: 'Who is in the queue right now' },
  { name: 'link', description: 'Link your Discord to your Steam account' },
  {
    name: 'report',
    description: 'Privately report someone, in a game or in the Discord',
    options: [
      { name: 'player', description: 'Who you are reporting', type: 'user', required: true },
      {
        name: 'reason', description: 'What happened', type: 'string', required: true,
        choices: REPORT_CATEGORIES.map((c) => ({ name: REPORT_LABELS[c], value: c })),
      },
      { name: 'details', description: 'What happened, in your own words', type: 'string' },
      { name: 'match', description: 'Match number (default: your latest match together)', type: 'integer' },
    ],
  },
];

const COLOR = 0xb3261e;

const pub = (payload: Partial<MessagePayload>): InteractionReply => ({
  ephemeral: false, payload: { embeds: [], components: [], mentionUserIds: [], ...payload },
});
const priv = (payload: Partial<MessagePayload>): InteractionReply => ({
  ephemeral: true, payload: { embeds: [], components: [], mentionUserIds: [], ...payload },
});

/** Labels for the fixed, non-registry keys a standing can carry. */
const FIXED_LABELS: Record<string, string> = {
  winrate: 'Win rate', sidmg: 'SI damage / match', sikill: 'SI kills / match', ck: 'Commons / match',
  rev: 'Revives / match', boomer_rate: 'Boomer %',
};
const standingLabel = (key: string) => FIXED_LABELS[key] ?? `${statDef(key)?.label ?? key} / match`;

// Module scope, so it takes the db explicitly rather than closing over one.
const campaign = (db: DB, slug: string) => campaignDisplayName(db, slug);

/** A player row this module already has, as an Identity: avoids a second
 *  lookup for a steamid we just fetched. */
const idOf = (p: { steamid: string; name: string; discord_id: string | null; discord_name: string | null }): Identity =>
  ({ steamid: p.steamid, steamName: p.name, discordId: p.discord_id, discordName: p.discord_name });

type Cmd = Extract<BotInteraction, { kind: 'command' }>;

export async function handleCommand(deps: CommandDeps, i: Cmd): Promise<InteractionReply> {
  switch (i.name) {
    case 'profile': return profile(deps, i);
    case 'leaderboard': return leaderboard(deps);
    case 'matches': return matches(deps, i);
    case 'queue': return queue(deps);
    case 'link': return link(deps, i);
    case 'report': return report(deps, i);
    default: return priv({ content: 'Unknown command.' });
  }
}

/** The player a command is about: the `user` option, else the caller. */
function target(deps: CommandDeps, i: Cmd): { steamid: string } | { reply: InteractionReply } {
  const discordId = i.options.user ?? i.userId;
  const player = playerByDiscordId(deps.db, discordId);
  if (player) return { steamid: player.steamid };
  if (discordId === i.userId) return { reply: linkPrompt({ ...deps }, i.userId, i.userName) };
  return { reply: priv({ content: 'That user has not linked a Steam account, so there is no profile to show.' }) };
}

function profile(deps: CommandDeps, i: Cmd): InteractionReply {
  const who = target(deps, i);
  if ('reply' in who) return who.reply;
  const data = profileData(deps.db, who.steamid, null);
  if (!data) return priv({ content: 'No such player.' });
  const { player, rating, totals, matches: recent, statTotals, standings } = data;
  const url = `${deps.publicUrl}/player/${player.steamid}`;
  const games = totals.games;
  const lines: string[] = [];
  if (rating) {
    const decided = rating.wins + rating.losses;
    const wr = decided > 0 ? ` (${Math.round((rating.wins / decided) * 100)}%)` : '';
    lines.push(`**SR ${rating.sr}** · ${rating.wins}W ${rating.losses}L${wr} · ${games} matches`);
  } else {
    lines.push(`No rated matches yet · ${games} matches`);
  }
  const per = (n: number) => (games > 0 ? Math.round(n / games) : null);
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  const add = (name: string, v: number | string | null) => { if (v !== null) fields.push({ name, value: String(v), inline: true }); };
  add('SI dmg / match', per(totals.siDamage));
  add('Commons / match', per(totals.commonKills));
  if ((statTotals.boomer_spawns ?? 0) > 0) {
    add('Boomer %', `${Math.round(((statTotals.boom_successes ?? 0) / statTotals.boomer_spawns) * 100)}%`);
  }
  if (statTotals.tank_damage && games > 0) add('Tank dmg / match', Math.round(statTotals.tank_damage / games));
  if (statTotals.skeets && games > 0) add('Skeets / match', (statTotals.skeets / games).toFixed(1));

  const top = Object.entries(standings ?? {})
    .sort(([, a], [, b]) => a.rank - b.rank)
    .slice(0, 6)
    .map(([k, s]) => `#${s.rank} ${standingLabel(k)}`);
  if (top.length) fields.push({ name: 'Top 5 this season', value: top.join('\n') });

  const recentLines = recent.slice(0, 5).map((m) => {
    const r = m.result === 'win' ? 'W' : m.result === 'loss' ? 'L' : 'D';
    const sr = m.srDelta ? ` (${m.srDelta > 0 ? '+' : ''}${m.srDelta})` : '';
    return `\`${r}\` [${campaign(deps.db, m.campaign)} ${m.teamAScore}-${m.teamBScore}](${deps.publicUrl}/match/${m.id})${sr}`;
  });
  if (recentLines.length) fields.push({ name: 'Recent matches', value: recentLines.join('\n') });

  return pub({
    embeds: [{ title: plainLabelEscaped(identityOf(deps.db, player.steamid)), url, color: COLOR, description: lines.join('\n'), fields }],
    components: [[{ kind: 'link', url, label: 'Full profile' }]],
  });
}

function leaderboard(deps: CommandDeps): InteractionReply {
  const data = leaderboardData(deps.db)!;
  const ranked = data.rows.filter((r) => r.ranked).slice(0, 10);
  const url = `${deps.publicUrl}/leaderboard`;
  const body = ranked.length
    // Escaped plain form, not a mention: a row of up to ten of these next to
    // each other is noisy as mentions, and this is an embed description,
    // which still renders markdown, so the name still needs escaping.
    ? ranked.map((r, n) => `\`${String(n + 1).padStart(2, ' ')}\` **${r.sr}** ${plainLabelEscaped(identityOf(deps.db, r.steamid))} · ${r.wins}W ${r.losses}L`).join('\n')
    : 'Nobody is ranked yet. It takes 3 matches.';
  return pub({
    embeds: [{ title: `Leaderboard · ${data.season.name}`, url, color: COLOR, description: body }],
    components: [[{ kind: 'link', url, label: 'Full leaderboard' }]],
  });
}

function matches(deps: CommandDeps, i: Cmd): InteractionReply {
  let rows: { id: number; campaign: string; teamAScore: number; teamBScore: number; extra: string }[];
  let title = 'Recent matches';
  if (i.options.user) {
    const who = target(deps, i);
    if ('reply' in who) return who.reply;
    const data = profileData(deps.db, who.steamid, null)!;
    title = `Recent matches · ${plainLabelEscaped(identityOf(deps.db, data.player.steamid))}`;
    rows = data.matches.slice(0, 5).map((m) => ({
      id: m.id, campaign: m.campaign, teamAScore: m.teamAScore, teamBScore: m.teamBScore,
      extra: m.result === 'win' ? ' · won' : m.result === 'loss' ? ' · lost' : ' · draw',
    }));
  } else {
    rows = (deps.db.prepare(
      `SELECT id, campaign, team_a_score AS teamAScore, team_b_score AS teamBScore, winner
       FROM matches WHERE state = 'completed' ORDER BY id DESC LIMIT 5`,
    ).all() as { id: number; campaign: string; teamAScore: number; teamBScore: number; winner: string }[])
      .map((m) => ({ ...m, extra: m.winner === 'draw' ? ' · draw' : ` · Team ${m.winner.toUpperCase()} won` }));
  }
  const body = rows.length
    ? rows.map((m) => `[#${m.id} ${campaign(deps.db, m.campaign)} ${m.teamAScore}-${m.teamBScore}](${deps.publicUrl}/match/${m.id})${m.extra}`).join('\n')
    : 'No finished matches yet.';
  return pub({ embeds: [{ title, url: `${deps.publicUrl}/matches`, color: COLOR, description: body }] });
}

function queue(deps: CommandDeps): InteractionReply {
  const q = deps.matchmaker.publicQueue();
  // Escaped plain form, same reasoning as /leaderboard: an embed description
  // still renders markdown, and a queue of eight mentions is noisy.
  const names = q.players.map((p, n) => `\`${n + 1}\` ${plainLabelEscaped(identityOf(deps.db, p.steamid))}`).join('\n') || '_empty_';
  return priv({
    embeds: [{ title: `Queue ${q.count}/${QUEUE_SIZE}`, color: COLOR, description: names }],
  });
}

function link(deps: CommandDeps, i: Cmd): InteractionReply {
  const player = playerByDiscordId(deps.db, i.userId);
  if (player) {
    return priv({ content: `You are linked to **${escapeName(player.name)}**. Disconnect from your profile on the website if that is wrong.` });
  }
  return linkPrompt({ ...deps }, i.userId, i.userName);
}

/** Always private: nobody else in the channel learns who reported whom. */
function report(deps: CommandDeps, i: Cmd): InteractionReply {
  // A linked presser goes through the same door as the buttons (standing,
  // bans, merges). Someone only in the Discord files as themselves; fileReport
  // holds them to the Discord-side rules.
  const linked = playerByDiscordId(deps.db, i.userId);
  let reporter: string | DiscordReporter;
  if (linked) {
    const who = resolve(deps, i);
    if ('reply' in who) return who.reply;
    reporter = who.player.steamid;
  } else {
    reporter = { kind: 'discord', discordId: i.userId, name: i.userName, timedOutUntil: i.presserTimedOutUntil };
  }
  const pick = i.picked.player;
  if (!pick) return priv({ content: 'Pick the person you are reporting.' });
  const targetPlayer = playerByDiscordId(deps.db, pick.id);

  // A match is optional, and only exists between two players.
  const matchId: number | null = i.options.match
    ? Number(i.options.match)
    : typeof reporter === 'string' && targetPlayer ? latestSharedMatch(deps.db, reporter, targetPlayer.steamid) : null;
  const r = fileReport(deps.db, reporter, {
    category: i.options.reason, text: i.options.details ?? '', matchId,
  }, {
    adminSteamIds: deps.adminSteamIds ?? [],
    targetDiscord: { discordId: pick.id, name: pick.name, bot: pick.bot, administrator: pick.administrator },
  });
  if (!r.ok) return priv({ content: `Could not file the report: ${r.error}.` });
  const about = matchId === null ? '' : ` for match #${matchId}`;
  const name = targetPlayer ? plainLabelEscaped(idOf(targetPlayer)) : escapeName(pick.name);
  return priv({
    content: `Reported ${name}${about}. Thanks, the moderators will look at it. The person you reported is never told who filed it.`,
    components: [[chatButton(r.reportId)]],
  });
}
