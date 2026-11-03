/**
 * One-time Discord DM telling each regular their Season Wrapped is ready
 * (owner, 2026-11-03). Run on the box, from /home/pug/app, as the pug user:
 *
 *   npx tsx scripts/wrapped-dm.ts --season 1                      # dry run: who, and each message
 *   npx tsx scripts/wrapped-dm.ts --season 1 --only <steamid> --send   # one test DM
 *   npx tsx scripts/wrapped-dm.ts --season 1 --send --everyone    # everyone, paced
 *
 * Who: matches >= --min (10) in that season, Discord linked, not banned
 * (status or an active ban). Each person's numbers come from their frozen
 * deck, or a live computeWrapped on today's standings while the season is
 * still open (the test DM before the flip), as the staff preview does. Everyone sent to is written to a log as it goes, and a
 * rerun skips them, so a stopped run can just be started again. A closed-DM
 * user (Discord 50007) is logged too and never retried.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadDotEnv } from './dotenv.js';
import { openDb, type DB } from '../src/db.js';
import { computeWrapped, frozenPlayer, type WrappedPlayer } from '../src/seasonWrapped.js';
import { activeBanAt } from '../src/fingerprintSigns.js';
import { finalStandings } from '../src/seasons.js';

const API = 'https://discord.com/api/v10';
const SITE = 'https://riversidepug.com';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n = (x: number) => x.toLocaleString('en-US');

export function message(p: WrappedPlayer, seasonId: number, seasonName: string): string {
  const parts = [`You played ${n(p.numbers.matches)} matches (${n(Math.round(p.numbers.hours))} hours)`];
  const s = p.standing;
  // A ladder place is only news near the top; below it, the peak reads better.
  if (s?.finalRank && s.finalRank <= 25) parts.push(`finished #${s.finalRank} of ${s.ofRanked} on the ladder`);
  else if (s) parts.push(`peaked at ${n(s.peakSr)} SR`);
  const lines = [`${seasonName} is over, and your ${seasonName} Wrapped is ready.`, '', `${parts.join(' and ')}.`];
  const top = p.signature?.[0];
  if (top && top.rank <= 10) lines.push(`Your standout: #${top.rank} of ${top.of} for ${top.label} per game.`);
  lines.push('', `See the rest: ${SITE}/wrapped/${seasonId}/${p.steamid}`, '',
    'Season 1: Wrong Way is live now. This is a one-time message from Riverside PUGs.');
  return lines.join('\n');
}

interface Target { steamid: string; discordId: string; player: WrappedPlayer }

function targets(db: DB, seasonId: number, min: number): Target[] {
  const now = new Date();
  const rows = db.prepare(
    `SELECT steamid, discord_id FROM players WHERE discord_id IS NOT NULL AND status != 'banned'`,
  ).all() as { steamid: string; discord_id: string }[];
  const frozen = (db.prepare('SELECT COUNT(*) c FROM season_wrapped WHERE season_id = ?').get(seasonId) as { c: number }).c > 0;
  const live = frozen ? null : new Map(computeWrapped(db, seasonId, now, { standings: finalStandings(db, seasonId, now) }).players.map((p) => [p.steamid, p]));
  const out: Target[] = [];
  for (const r of rows) {
    if (activeBanAt(db, r.steamid, now)) continue;
    const p = frozen ? frozenPlayer(db, seasonId, r.steamid, now) : live!.get(r.steamid) ?? null;
    if (!p || p.numbers.matches < min) continue;
    out.push({ steamid: r.steamid, discordId: r.discord_id, player: p });
  }
  return out.sort((a, b) => b.player.numbers.matches - a.player.numbers.matches);
}

async function discord(token: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  for (;;) {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 429) { await sleep(Math.ceil((json.retry_after ?? 5) * 1000) + 250); continue; }
    return { status: res.status, json };
  }
}

async function dm(token: string, discordId: string, content: string): Promise<'sent' | 'closed' | string> {
  const ch = await discord(token, '/users/@me/channels', { recipient_id: discordId });
  if (ch.status !== 200) return `channel ${ch.status} ${ch.json.code ?? ''}`;
  const m = await discord(token, `/channels/${ch.json.id}/messages`, { content, allowed_mentions: { parse: [] } });
  if (m.status === 200) return 'sent';
  if (m.json.code === 50007) return 'closed';
  return `message ${m.status} ${m.json.code ?? ''}`;
}

async function main(): Promise<void> {
  loadDotEnv();
  const seasonId = Number(arg('season'));
  if (!Number.isInteger(seasonId) || seasonId < 1) throw new Error('--season <id> is required');
  const min = Number(arg('min') ?? 10);
  const delay = Number(arg('delay') ?? 4000);
  const only = arg('only');
  const send = flag('send');
  const logPath = arg('log') ?? `data/wrapped-dm-season${seasonId}.json`;

  const db = openDb(process.env.DB_PATH ?? 'data/pug.db');
  const season = db.prepare('SELECT name FROM seasons WHERE id = ?').get(seasonId) as { name: string } | undefined;
  if (!season) throw new Error(`no season ${seasonId}`);
  let list = targets(db, seasonId, min);
  if (only) list = list.filter((t) => t.steamid === only);
  // Owner, before the test DM: it must never reach everyone. Without --only,
  // sending needs --everyone as well; with --only, exactly one person or none.
  if (send && !only && !flag('everyone')) throw new Error('refusing: --send without --only needs --everyone');
  // Links only open once the season's decks are frozen (at the flip); before
  // that only a single test DM may go out, or everyone would get a dead link.
  const frozen = (db.prepare('SELECT COUNT(*) c FROM season_wrapped WHERE season_id = ?').get(seasonId) as { c: number }).c > 0;
  if (send && !only && !frozen) throw new Error(`refusing: ${season.name} Wrapped is not frozen yet, so the links would not open`);
  if (only && list.length > 1) throw new Error(`refusing: --only matched ${list.length} people`);
  const log: Record<string, string> = existsSync(logPath) ? JSON.parse(readFileSync(logPath, 'utf8')) : {};
  const todo = list.filter((t) => !log[t.steamid]);
  console.log(`${list.length} eligible, ${list.length - todo.length} already done, ${todo.length} to send${send ? '' : ' (dry run)'}`);

  if (!send) {
    for (const t of todo) console.log(`\n--- ${t.player.name} (${t.steamid}, ${t.player.numbers.matches} matches)\n${message(t.player, seasonId, season.name)}`);
    return;
  }
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');
  for (const [i, t] of todo.entries()) {
    const result = await dm(token, t.discordId, message(t.player, seasonId, season.name));
    console.log(`${i + 1}/${todo.length} ${t.player.name}: ${result}`);
    if (result === 'sent' || result === 'closed') {
      log[t.steamid] = `${result} ${new Date().toISOString()}`;
      writeFileSync(logPath, JSON.stringify(log, null, 1));
    }
    if (i < todo.length - 1) await sleep(delay);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
