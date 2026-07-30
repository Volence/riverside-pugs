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
  };
}
