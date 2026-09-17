import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { QUEUE_SIZE } from '../queue.js';
import { CAMPAIGNS } from '../campaigns.js';
import { playerByDiscordId } from '../players.js';
import { statDef } from '../statKeys.js';
import { leaderboardData, profileData } from '../playerQueries.js';
import { linkPrompt } from './controller.js';
import { escapeName } from './presenter.js';
import type { BotInteraction, InteractionReply, MessagePayload, SlashCommandDef } from './transport.js';

export interface CommandDeps {
  db: DB;
  matchmaker: Matchmaker;
  publicUrl: string;
}

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

const campaign = (slug: string) => CAMPAIGNS[slug]?.name ?? slug;

type Cmd = Extract<BotInteraction, { kind: 'command' }>;

export async function handleCommand(deps: CommandDeps, i: Cmd): Promise<InteractionReply> {
  switch (i.name) {
    case 'profile': return profile(deps, i);
    case 'leaderboard': return leaderboard(deps);
    case 'matches': return matches(deps, i);
    case 'queue': return queue(deps);
    case 'link': return link(deps, i);
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
    return `\`${r}\` [${campaign(m.campaign)} ${m.teamAScore}-${m.teamBScore}](${deps.publicUrl}/match/${m.id})${sr}`;
  });
  if (recentLines.length) fields.push({ name: 'Recent matches', value: recentLines.join('\n') });

  return pub({
    embeds: [{ title: player.name, url, color: COLOR, description: lines.join('\n'), fields }],
    components: [[{ kind: 'link', url, label: 'Full profile' }]],
  });
}

function leaderboard(deps: CommandDeps): InteractionReply {
  const data = leaderboardData(deps.db);
  const ranked = data.rows.filter((r) => r.ranked).slice(0, 10);
  const url = `${deps.publicUrl}/leaderboard`;
  const body = ranked.length
    ? ranked.map((r, n) => `\`${String(n + 1).padStart(2, ' ')}\` **${r.sr}** ${escapeName(r.name)} · ${r.wins}W ${r.losses}L`).join('\n')
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
    title = `Recent matches · ${data.player.name}`;
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
    ? rows.map((m) => `[#${m.id} ${campaign(m.campaign)} ${m.teamAScore}-${m.teamBScore}](${deps.publicUrl}/match/${m.id})${m.extra}`).join('\n')
    : 'No finished matches yet.';
  return pub({ embeds: [{ title, url: `${deps.publicUrl}/matches`, color: COLOR, description: body }] });
}

function queue(deps: CommandDeps): InteractionReply {
  const q = deps.matchmaker.publicQueue();
  const names = q.players.map((p, n) => `\`${n + 1}\` ${escapeName(p.name)}`).join('\n') || '_empty_';
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
