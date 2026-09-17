import type { DiscordConfig } from '../config.js';

const API = 'https://discord.com/api/v10';
const USER_AGENT = 'RiversidePUG (https://riversidepug.com, 1)';

/** The Discord REST calls the web side needs. An interface so routes and the
 *  gate are tested against a fake and never touch the network. */
export interface DiscordApi {
  /** Trade an OAuth authorization code for a user access token. */
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>;
  getCurrentUser(accessToken: string): Promise<{ id: string; username: string; globalName: string | null }>;
  /** The guild member, or null when the user is not in the guild. Throws on
   *  any other failure, so "Discord is down" is never read as "not a member". */
  getGuildMember(userId: string): Promise<{ roles: string[] } | null>;
}

type FetchFn = typeof fetch;

export function fetchDiscordApi(cfg: DiscordConfig, fetchFn: FetchFn = fetch): DiscordApi {
  const call = async (path: string, init: RequestInit = {}): Promise<Response> =>
    fetchFn(`${API}${path}`, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(10_000),
    });

  return {
    async exchangeCode(code, redirectUri) {
      const res = await call('/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
      });
      if (!res.ok) throw new Error(`discord token exchange failed: ${res.status}`);
      const body = (await res.json()) as { access_token: string };
      return { accessToken: body.access_token };
    },
    async getCurrentUser(accessToken) {
      const res = await call('/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error(`discord users/@me failed: ${res.status}`);
      const u = (await res.json()) as { id: string; username: string; global_name: string | null };
      return { id: u.id, username: u.username, globalName: u.global_name ?? null };
    },
    async getGuildMember(userId) {
      const res = await call(`/guilds/${cfg.guildId}/members/${userId}`, {
        headers: { Authorization: `Bot ${cfg.botToken}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`discord guild member lookup failed: ${res.status}`);
      const m = (await res.json()) as { roles: string[] };
      return { roles: m.roles };
    },
  };
}
