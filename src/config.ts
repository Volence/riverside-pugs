import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** Discord application + bot. Null when any required piece is missing, which
 *  is the tested default: the site then behaves exactly as it did before
 *  Discord existed. The lobby channel is optional here because linking works
 *  without it; the bot itself additionally requires it. */
export interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  botToken: string;
  guildId: string;
  lobbyChannelId: string | null;
}

/** Twitch application. Null when either piece is missing, which is the tested
 *  default: the site then behaves exactly as it did before Twitch existed. No
 *  scopes are ever requested, so the only permission involved is knowing which
 *  account authorised. */
export interface TwitchConfig {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  port: number;
  publicUrl: string;
  dbPath: string;
  cookieSecret: string;
  adminSteamIds: string[];
  devMode: boolean;
  steamApiKey: string | null;
  logListenPort: number;
  logPublicAddress: string;
  /** Directory srcds writes demos into. Empty disables the demo feature
   *  entirely, which is the right default: the backend can only see demos when
   *  it shares a filesystem with the game server. */
  demoDir: string;
  /** Directory the plugin writes .rpl replay files into. Empty disables replay
   *  indexing entirely, the same default and for the same reason as demoDir:
   *  the backend can only see these files when it shares a filesystem with the
   *  game server. */
  replayDir: string;
  /** The game server's addons directory. Empty turns campaign upload off
   *  entirely, the same default and for the same reason as demoDir: a path
   *  guessed from another path is how you write a 300 MB file somewhere
   *  nothing reads it. */
  addonsDir: string;
  /** The game's missions directory, holding the stock campaigns' chapter
   *  lists. Empty means the stock four have no known chapters, which leaves
   *  every campaign on its default stop point: the same reason demoDir and
   *  addonsDir default to empty rather than to a guess. */
  missionsDir: string;
  /** The game's DLC4 missions directory, holding the dlc4 campaigns' chapter
   *  lists. Empty means the dlc4 eight have no known chapters, the same default
   *  and for the same reason as missionsDir: a path guessed from another path
   *  is how you write a lot of wrong behavior into a place nothing reads it. */
  dlc4MissionsDir: string;
  /** Where files posted in ticket threads are kept: outside the web root,
   *  under random names, served only through the ticket's own access check.
   *  Deliberately NOT part of the 6 hourly database backup: removing a file
   *  has to remove every copy the system holds. */
  ticketAttachmentsDir: string;
  /** Where live replay bytes pushed by the game servers are kept while a
   *  round is played. The site's own directory, not the replay directory: on
   *  Dallas the plugin writes its own file into that one, and a pushed copy
   *  beside it must never race it. Created on first push. */
  replayLiveDir: string;
  /** Where scripts/push-manifest.ts drops the fleet view's repo.json and base.json. */
  fleetDir: string;
  discord: DiscordConfig | null;
  twitch: TwitchConfig | null;
}

/**
 * Configured directories that are not on disk, so startup can say so.
 *
 * A REPLAY_DIR or DEMO_DIR pointing somewhere that does not exist fails
 * silently: every lookup simply finds no file and the browser gets a 404 that
 * looks like missing data rather than misconfiguration. That cost an hour on
 * 2026-09-18, when a dev server inherited a stale REPLAY_DIR from an earlier
 * session's scratchpad and the viewer just said "Couldn't load that replay".
 * ADDONS_DIR is here for the same reason and fails a third way: the upload
 * route reports free space as unknown and then the write itself fails, so an
 * admin sees a broken upload rather than a path that does not exist.
 *
 * An empty value is not a mistake: it is how each feature is turned off.
 */
export function missingDirs(cfg: Config): { name: string; path: string }[] {
  const pairs: [string, string][] = [
    ['REPLAY_DIR', cfg.replayDir], ['DEMO_DIR', cfg.demoDir], ['ADDONS_DIR', cfg.addonsDir],
    ['MISSIONS_DIR', cfg.missionsDir], ['DLC4_MISSIONS_DIR', cfg.dlc4MissionsDir],
  ];
  return pairs
    .filter(([, path]) => path && !existsSync(path))
    .map(([name, path]) => ({ name, path }));
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dbPath = env.DB_PATH ?? 'data/pug.db';
  return {
    port: Number(env.PORT ?? 8080),
    publicUrl: env.PUBLIC_URL ?? 'http://localhost:8080',
    dbPath,
    cookieSecret: env.COOKIE_SECRET ?? 'dev-secret-change-me',
    adminSteamIds: (env.ADMIN_STEAMIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    devMode: env.DEV_MODE === '1',
    steamApiKey: env.STEAM_API_KEY ?? null,
    logListenPort: Number(env.LOG_LISTEN_PORT ?? 27500),
    logPublicAddress: env.LOG_PUBLIC_ADDRESS ?? '127.0.0.1:27500',
    demoDir: env.DEMO_DIR ?? '',
    replayDir: env.REPLAY_DIR ?? '',
    addonsDir: env.ADDONS_DIR ?? '',
    missionsDir: env.MISSIONS_DIR ?? '',
    dlc4MissionsDir: env.DLC4_MISSIONS_DIR ?? '',
    ticketAttachmentsDir: env.TICKET_ATTACHMENTS_DIR?.trim() || join(dirname(dbPath), 'ticket-attachments'),
    replayLiveDir: env.REPLAY_LIVE_DIR?.trim() || join(dirname(dbPath), 'replays-live'),
    fleetDir: env.FLEET_DIR?.trim() || join(dirname(dbPath), 'fleet'),
    discord: loadDiscord(env),
    twitch: loadTwitch(env),
  };
}

function loadTwitch(env: Record<string, string | undefined>): TwitchConfig | null {
  const clientId = env.TWITCH_CLIENT_ID?.trim();
  const clientSecret = env.TWITCH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function loadDiscord(env: Record<string, string | undefined>): DiscordConfig | null {
  const clientId = env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  const guildId = env.DISCORD_GUILD_ID?.trim();
  if (!clientId || !clientSecret || !botToken || !guildId) return null;
  return { clientId, clientSecret, botToken, guildId, lobbyChannelId: env.DISCORD_LOBBY_CHANNEL_ID?.trim() || null };
}
