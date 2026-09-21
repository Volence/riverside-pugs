import type { DB } from '../db.js';
import type { Matchmaker } from '../matchmaker.js';
import { QUEUE_SIZE } from '../queue.js';
import { campaignDisplayName } from '../campaignRegistry.js';
import { playerByDiscordId } from '../players.js';
import { statDef } from '../statKeys.js';
import { leaderboardData, profileData } from '../playerQueries.js';
import { fileReport, REPORT_CATEGORIES } from '../tickets/filing.js';
import { linkPrompt } from './controller.js';
import { escapeName } from './presenter.js';
import type { BotInteraction, InteractionReply, MessagePayload, SlashCommandDef } from './transport.js';

export interface CommandDeps {
  db: DB;
  matchmaker: Matchmaker;
  publicUrl: string;
  adminSteamIds?: string[];
}

/** Labels for the report categories, in the order they should list. */
const REPORT_LABELS: Record<string, string> = {
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
    description: 'Privately report a player from a match you played together',
    options: [
      { name: 'player', description: 'Who you are reporting', type: 'user', required: true },
      {
        name: 'reason', description: 'What happened', type: 'string', required: true,
        choices: REPORT_CATEGORIES.map((c) => ({ name: REPORT_LABELS[c], value: c })),
      },
      { name: 'details', description: 'When, which map, what they did', type: 'string' },
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
    embeds: [{ title: player.name, url, color: COLOR, description: lines.join('\n'), fields }],
    components: [[{ kind: 'link', url, label: 'Full profile' }]],
  });
}

function leaderboard(deps: CommandDeps): InteractionReply {
  const data = leaderboardData(deps.db)!;
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
    ? rows.map((m) => `[#${m.id} ${campaign(deps.db, m.campaign)} ${m.teamAScore}-${m.teamBScore}](${deps.publicUrl}/match/${m.id})${m.extra}`).join('\n')
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

/** Always private: nobody else in the channel learns who reported whom. */
function report(deps: CommandDeps, i: Cmd): InteractionReply {
  const reporter = playerByDiscordId(deps.db, i.userId);
  if (!reporter) return linkPrompt({ ...deps }, i.userId, i.userName);
  const target = playerByDiscordId(deps.db, i.options.player ?? '');
  if (!target) {
    return priv({ content: 'That player has not linked Discord, so the bot cannot tell who they are. Use Report on their profile on the website instead.' });
  }
  if (target.steamid === reporter.steamid) return priv({ content: 'You cannot report yourself.' });

  // A match is optional. With none given, attach the latest one you shared in
  // the last 48 hours if there is one, because that is nearly always what the
  // report is about; otherwise file it with no match.
  let matchId: number | null = i.options.match ? Number(i.options.match) : null;
  if (matchId === null) {
    const shared = deps.db.prepare(
      `SELECT m.id FROM matches m
       JOIN match_players a ON a.match_id = m.id AND a.player_id = ?
       JOIN match_players b ON b.match_id = m.id AND b.player_id = ?
       WHERE m.state IN ('live', 'completed', 'aborted')
         AND (m.ended_at IS NULL OR m.ended_at > datetime('now', '-48 hours'))
       ORDER BY m.id DESC LIMIT 1`,
    ).get(reporter.steamid, target.steamid) as { id: number } | undefined;
    matchId = shared?.id ?? null;
  }
  const r = fileReport(deps.db, reporter.steamid, {
    targetId: target.steamid, category: i.options.reason, text: i.options.details ?? '', matchId,
  }, { adminSteamIds: deps.adminSteamIds ?? [] });
  if (!r.ok) return priv({ content: `Could not file the report: ${r.error}.` });
  const about = matchId === null ? '' : ` for match #${matchId}`;
  return priv({ content: `Reported ${escapeName(target.name)}${about}. Thanks, the moderators will look at it. They will not be told who reported them.` });
}
