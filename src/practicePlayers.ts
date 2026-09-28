/**
 * Who is on a practice server, for the admin live board's Practice servers
 * panel, and removing one of them.
 *
 * Read from the leased box over rcon, never from the log feed: a practice
 * server runs no match, so the site has no roster for it. Two commands on
 * one connection, because srcds drops every OTHER rcon connection the moment
 * one closes (src/rcon.ts): the engine's `status` for who is connected, and
 * the practice plugin's `sm_practice_who` for each client's team and
 * trainer. The second is optional; a box whose plugin predates it answers
 * "Unknown command" and the players simply come back without a team.
 */
import type { DB } from './db.js';
import { steamId64Of } from './steamId.js';

/** One human on a practice server. */
export interface PracticePlayer {
  userid: number;
  /** The client index `sm_practice_who` reports by. Not the userid. */
  index: number;
  name: string;
  /** Null for a LAN or not-yet-validated id (STEAM_ID_LAN, STEAM_ID_PENDING). */
  steamid64: string | null;
  /** As the engine prints it: "05:09", or "1:02:03" past the hour. */
  connectedFor: string;
  ping: number;
  /** 1 spectator, 2 survivor, 3 infected; null when the plugin did not say. */
  team: number | null;
  /** The practice trainer running for this client: 1 skeet, 2 crown,
   *  3 rocks; null for none or unknown. */
  trainer: number | null;
}

/**
 * The humans in an engine `status` reply.
 *
 * A human's line carries two numbers, the userid and then the client index,
 * where a bot's carries one and the word BOT for its id (seen on the local
 * rig, 2026-09-2x):
 *
 *   #  2 1 "Mal" STEAM_1:1:35074132 01:12 33 0 active 128000 192.168.4.85:27005
 *   # 3 "Bill" BOT active
 *
 * so requiring both numbers and a non-BOT id is what leaves the bots and
 * SourceTV out. The name is matched greedily up to the last `" ` before the
 * id, since a name may itself contain quotes.
 */
export function parseStatusPlayers(status: string): Omit<PracticePlayer, 'team' | 'trainer'>[] {
  const out: Omit<PracticePlayer, 'team' | 'trainer'>[] = [];
  const re = /^#\s*(\d+)\s+(\d+)\s+"(.*)"\s+(\S+)\s+(\d+(?::\d+){1,2})\s+(\d+)\s+\d+\s+\S+/;
  for (const line of status.split('\n')) {
    const m = re.exec(line.trim());
    if (!m) continue;
    const id = m[4];
    if (id === 'BOT') continue;
    out.push({
      userid: Number(m[1]),
      index: Number(m[2]),
      name: m[3],
      steamid64: steamId64Of(id),
      connectedFor: m[5],
      ping: Number(m[6]),
    });
  }
  return out;
}

/**
 * Team and trainer per client index from `sm_practice_who`, which prints
 *
 *   WHO <client> <name> team=<n>                        (spectators, unassigned)
 *   WHO <client> <name> team=<n> bot=<0|1> ... trainer=<n> ...
 *
 * The name is free text, so the fields are read by key from after the first
 * ` team=`. An empty map when the command is missing.
 */
export function parseWho(body: string): Map<number, { team: number; bot: boolean; trainer: number | null }> {
  const out = new Map<number, { team: number; bot: boolean; trainer: number | null }>();
  for (const line of body.split('\n')) {
    const m = /^WHO (\d+) .*? team=(\d+)(.*)$/.exec(line.trim());
    if (!m) continue;
    const rest = m[3];
    const bot = /(?:^|\s)bot=1(?:\s|$)/.test(rest);
    const t = /(?:^|\s)trainer=(\d+)(?:\s|$)/.exec(rest);
    const trainer = t && Number(t[1]) > 0 ? Number(t[1]) : null;
    out.set(Number(m[1]), { team: Number(m[2]), bot, trainer });
  }
  return out;
}

/** The two replies, joined into the humans on the box. */
export function practicePlayers(status: string, who: string): PracticePlayer[] {
  const teams = parseWho(who);
  return parseStatusPlayers(status).map((p) => {
    const w = teams.get(p.index);
    return { ...p, team: w ? w.team : null, trainer: w ? w.trainer : null };
  });
}

/** A kick reason as it may go into `sm_kick #<userid> "<reason>"`: no
 *  quotes, semicolons or line breaks (the console has no escape for them),
 *  trimmed to a length a kick screen shows whole. */
export function kickReason(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.replace(/["\r\n;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  return v || 'Removed by an admin';
}

/** For the admin panel: whether the site knows each player, so their name
 *  can link to a profile and to their People file. */
export function knownOnSite(db: DB, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = db.prepare(`SELECT steamid FROM players WHERE steamid IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as { steamid: string }[];
  return new Set(rows.map((r) => r.steamid));
}
