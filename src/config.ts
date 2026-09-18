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
  discord: DiscordConfig | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    publicUrl: env.PUBLIC_URL ?? 'http://localhost:8080',
    dbPath: env.DB_PATH ?? 'data/pug.db',
    cookieSecret: env.COOKIE_SECRET ?? 'dev-secret-change-me',
    adminSteamIds: (env.ADMIN_STEAMIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    devMode: env.DEV_MODE === '1',
    steamApiKey: env.STEAM_API_KEY ?? null,
    logListenPort: Number(env.LOG_LISTEN_PORT ?? 27500),
    logPublicAddress: env.LOG_PUBLIC_ADDRESS ?? '127.0.0.1:27500',
    demoDir: env.DEMO_DIR ?? '',
    replayDir: env.REPLAY_DIR ?? '',
    addonsDir: env.ADDONS_DIR ?? '',
    discord: loadDiscord(env),
  };
}

function loadDiscord(env: Record<string, string | undefined>): DiscordConfig | null {
  const clientId = env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  const guildId = env.DISCORD_GUILD_ID?.trim();
  if (!clientId || !clientSecret || !botToken || !guildId) return null;
  return { clientId, clientSecret, botToken, guildId, lobbyChannelId: env.DISCORD_LOBBY_CHANNEL_ID?.trim() || null };
}
